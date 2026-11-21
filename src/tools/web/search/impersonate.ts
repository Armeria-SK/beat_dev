import { mediaTypeOf, RetrievalFailure, type PageNetwork, type PageResponse } from '../public-page.ts';
import { toolText } from '../../../shared/messages/tools.ts';
import { CHROME_AGENTS, SEARCH_MAX_BYTES, SEARCH_TYPES, searchNetworkFor, type SearchRequestHeaders } from './disguise.ts';
import { startPinProxy, type PinProxy } from './pin-proxy.ts';

// 検索の頼みを TLS・HTTP/2 の段まで Chrome に似せる通信（impit）。disguise: true の先だけが通る（metasearch.ts）。
// 名前引き・公開アドレスの確かめ・転送のたどりは今の道（public-page.ts の followPublic）のまま。impit は pin-proxy.ts の中継を通り、
// 確かめ済みのアドレスへだけつなぐ。impit が読めない（部品が無い platform など）・中継が立たないときは、頭の行だけの道に戻る

// 0.14.9 の表で最新の Chrome（'chrome' は Chrome 124 の型）の TLS・HTTP/2 の形
const BROWSER = 'chrome151';
// 名乗り（User-Agent・sec-ch-ua の版）は頭の行だけの道と同じ今の Chrome（Windows）。151 のままの名乗りだと Bing は検索語と関係のない結果を返す
const AGENT = CHROME_AGENTS[0]!;
const AGENT_MAJOR = /Chrome\/(\d+)\./u.exec(AGENT)![1]!;
const IDENTITY = { 'user-agent': AGENT, 'sec-ch-ua': `"Not=A?Brand";v="99", "Google Chrome";v="${AGENT_MAJOR}", "Chromium";v="${AGENT_MAJOR}"` };
const IMPIT_TIMEOUT_MS = 15_000;

export interface ImpitResponseLike { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }
export interface ImpitInit { redirect: 'manual'; signal: AbortSignal; timeout: number }
export interface ImpitOptionsLike { browser: typeof BROWSER; headers: Record<string, string>; proxyUrl: string; timeout: number; followRedirects: false; vanillaFallback: false; http3: false }
export interface ImpitModuleLike { Impit: new (options: ImpitOptionsLike) => { fetch(url: string, init: ImpitInit): Promise<ImpitResponseLike> } }

export interface ImpersonationDeps {
  load?: (() => Promise<ImpitModuleLike>) | undefined;
  startProxy?: (() => Promise<PinProxy>) | undefined;
  log?: ((line: string) => void) | undefined;
  // 頭の行だけの道（既定は disguise.ts の searchNetworkFor）
  fallback?: ((request: SearchRequestHeaders) => PageNetwork) | undefined;
}

type Backend = { impit: ImpitModuleLike; proxy: PinProxy };

const loadImpit = async (): Promise<ImpitModuleLike> => await import('impit') as unknown as ImpitModuleLike;

function statusFailure(status: number): RetrievalFailure {
  const code = status === 404 ? 'not_found' : [401, 403, 429].includes(status) ? 'refused' : 'http_failure';
  return new RetrievalFailure(code, toolText('en', 'fetch.http_status', { status }), status, 'fetch.http_status', { status });
}

function typeFailure(contentType: string, status: number): RetrievalFailure {
  const type = mediaTypeOf(contentType) ?? toolText('en', 'fetch.type_unknown');
  return new RetrievalFailure('invalid_response', toolText('en', 'fetch.type', { type }), status, 'fetch.type', { type });
}

// 本文を読みながら上限で止める（impit は gzip・br を展開して流すので、上限は展開後の大きさに効く）
async function readCapped(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<{ body: Buffer; truncated: boolean }> {
  if (!body) return { body: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const step = await reader.read();
      signal.throwIfAborted();
      if (step.done) return { body: Buffer.concat(chunks), truncated: false };
      const chunk = Buffer.from(step.value);
      if (size + chunk.length > SEARCH_MAX_BYTES) {
        chunks.push(chunk.subarray(0, SEARCH_MAX_BYTES - size));
        void reader.cancel().catch(() => undefined);
        return { body: Buffer.concat(chunks), truncated: true };
      }
      size += chunk.length; chunks.push(chunk);
    }
  } finally { signal.removeEventListener('abort', onAbort); }
}

async function impersonatedGet(backend: Backend, url: URL, address: string, signal: AbortSignal): Promise<PageResponse> {
  const release = backend.proxy.register(url.hostname, address);
  try {
    const client = new backend.impit.Impit({ browser: BROWSER, headers: IDENTITY, proxyUrl: backend.proxy.url, timeout: IMPIT_TIMEOUT_MS, followRedirects: false, vanillaFallback: false, http3: false });
    const response = await client.fetch(url.href, { redirect: 'manual', signal, timeout: IMPIT_TIMEOUT_MS });
    const status = response.status;
    const contentType = response.headers.get('content-type') ?? '';
    if (status >= 300 && status < 400) {
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      return { status, contentType, body: Buffer.alloc(0), ...(location ? { location } : {}) };
    }
    if (status !== 200 || !SEARCH_TYPES.test(contentType)) {
      void response.body?.cancel().catch(() => undefined);
      throw status !== 200 ? statusFailure(status) : typeFailure(contentType, status);
    }
    const read = await readCapped(response.body, signal);
    return { status, contentType, body: read.body, ...(read.truncated ? { truncated: true } : {}) };
  } finally { release(); }
}

export class SearchImpersonation {
  readonly #deps: ImpersonationDeps;
  #backend: Promise<Backend | undefined> | undefined;
  #closed = false;

  constructor(deps: ImpersonationDeps = {}) { this.#deps = deps; }

  // 最初の検索で 1 回だけ読む。失敗したらこの実行のあいだは頭の行だけの道（再挑戦しない）
  #ready(): Promise<Backend | undefined> {
    this.#backend ??= (async () => {
      if (this.#closed) return undefined;
      try {
        const impit = await (this.#deps.load ?? loadImpit)();
        const proxy = await (this.#deps.startProxy ?? (() => startPinProxy()))();
        if (this.#closed) { await proxy.close(); return undefined; }
        return { impit, proxy };
      } catch (error) {
        this.#deps.log?.(`[WARN] Search impersonation is unavailable; using header-only requests: ${(error as Error).message}`);
        return undefined;
      }
    })();
    return this.#backend;
  }

  // metasearch の networkFor と同じ形。https でない頼みと、部品が読めないときは今の道
  readonly networkFor = (request: SearchRequestHeaders): PageNetwork => {
    const fallback = (this.#deps.fallback ?? searchNetworkFor)(request);
    return {
      resolve: fallback.resolve,
      get: async (url, address, signal) => {
        const backend = url.protocol === 'https:' ? await this.#ready() : undefined;
        return backend ? impersonatedGet(backend, url, address, signal) : fallback.get(url, address, signal);
      },
    };
  };

  async close(): Promise<void> {
    this.#closed = true;
    const backend = await this.#backend;
    await backend?.proxy.close();
  }
}
