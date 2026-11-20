import { toolText, type ToolMessageKey } from '../../../shared/messages/tools.ts';
import { decodeText, fetchPublic, RetrievalFailure, type PageNetwork } from '../public-page.ts';
import { searchFailure } from '../search.ts';
import { normalizeUrl, readSafely, type SearchEngine, type SearchHit } from './engine.ts';
import { searchHeaders, searchNetworkFor, type SearchRequestHeaders } from './disguise.ts';
import type { EngineHealth, EngineOutcome } from './health.ts';

// 1 つの組に入れる先の数・組の数・1 回の検索の全体の時間
export const GROUP_SIZE = 2;
export const MAX_GROUPS = 3;
export const TOTAL_MS = 20_000;
const REQUEST_MS = 15_000;
// 止められたことを示す HTTP の状態（202 は DuckDuckGo の「自動アクセスの確認」）
const BLOCKED_STATUSES = new Set([202, 401, 403, 429]);

export interface MetasearchOptions {
  query: string;
  limit: number;
  region: string;
  engines: readonly SearchEngine[];
  health: EngineHealth;
  signal?: AbortSignal | undefined;
  // 決まった通信（試験・アプリへの差し込み）。あれば頭の行は付けずに全部の先でこれを使う
  network?: PageNetwork | undefined;
  // 頭の行から通信を作る（既定は disguise.ts の searchNetworkFor）
  networkFor?: ((request: SearchRequestHeaders) => PageNetwork) | undefined;
  // 調べる実行の検索: 転送は有効な先のホストの中だけをたどる
  onlySearchHosts?: boolean | undefined;
  totalMs?: number | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface MetasearchResult { hits: SearchHit[]; engines: string[] }

type Attempt = { engine: SearchEngine; outcome: EngineOutcome | 'timeout' | 'aborted'; hits: SearchHit[] };

// 有効な先のホストの和（ワイルドカードにしない。完全な名前だけ）
export function searchHosts(engines: readonly SearchEngine[], region: string): Set<string> {
  return new Set(engines.flatMap(engine => engine.hosts(region).map(host => host.toLowerCase())));
}

const realSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', onAbort, { once: true });
});

// 最近止められた・つながらなかった先を後に、形が読めなかった先をさらに後に。同じ段の中は検索ごとにずらした並び（成功した先ばかりに偏らせない）
function ordered(engines: readonly SearchEngine[], health: EngineHealth, turn: number): SearchEngine[] {
  const start = engines.length ? turn % engines.length : 0;
  const rotated = [...engines.slice(start), ...engines.slice(0, start)];
  const tier = (engine: SearchEngine) => { const last = health.last(engine); return last === undefined || last === 'ok' || last === 'empty' ? 0 : last === 'unknown' ? 2 : 1; };
  return rotated.map((engine, index) => ({ engine, index, tier: tier(engine) })).sort((a, b) => a.tier - b.tier || a.index - b.index).map(x => x.engine);
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export async function metasearch(options: MetasearchOptions): Promise<MetasearchResult> {
  const { health, limit, region } = options;
  const sleep = options.sleep ?? realSleep;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('search timed out')), options.totalMs ?? TOTAL_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  const turn = health.nextTurn();
  const hosts = options.onlySearchHosts ? searchHosts(options.engines, region) : undefined;
  const queue = ordered(options.engines, health, turn);
  const attempts: Attempt[] = [];
  const merged = new Map<string, { hit: SearchHit; count: number; group: number; position: number; order: number }>();

  const ask = async (engine: SearchEngine): Promise<Attempt> => {
    const wait = health.reserve(engine);
    try {
      if (wait) await sleep(wait, signal);
      signal.throwIfAborted();
    } catch { return { engine, outcome: signal.aborted && !options.signal?.aborted ? 'timeout' : 'aborted', hits: [] }; }
    const transport = options.network ?? (options.networkFor ?? searchNetworkFor)(searchHeaders(engine, region, turn));
    try {
      const page = await fetchPublic(engine.request(options.query, region).href, signal, transport, REQUEST_MS, undefined, hosts);
      const read = readSafely(engine, decodeText(page.body, page.contentType), page.contentType, limit, page.url);
      health.record(engine, read.state);
      return { engine, outcome: read.state, hits: read.hits };
    } catch (error) {
      if (signal.aborted) return { engine, outcome: options.signal?.aborted ? 'aborted' : 'timeout', hits: [] };
      const blocked = error instanceof RetrievalFailure && (error.code === 'refused' || (error.status !== undefined && BLOCKED_STATUSES.has(error.status)));
      health.record(engine, blocked ? 'blocked' : 'error');
      return { engine, outcome: blocked ? 'blocked' : 'error', hits: [] };
    }
  };

  try {
    for (let group = 0; group < MAX_GROUPS && !signal.aborted; group++) {
      const picked: SearchEngine[] = [];
      for (const engine of queue) {
        if (picked.length >= GROUP_SIZE) break;
        if (attempts.some(a => a.engine.id === engine.id) || picked.some(p => p.provider === engine.provider)) continue;
        if (health.restingFor(engine) > 0 || health.overHourLimit(engine)) continue;
        picked.push(engine);
      }
      if (!picked.length) break;
      const results = await Promise.all(picked.map(ask));
      attempts.push(...results);
      for (const attempt of results) {
        const order = options.engines.indexOf(attempt.engine);
        attempt.hits.forEach((found, position) => {
          const key = normalizeUrl(found.url);
          const seen = merged.get(key);
          if (!seen) { merged.set(key, { hit: { ...found }, count: 1, group, position, order }); return; }
          seen.count += 1;
          if (found.snippet.length > seen.hit.snippet.length) seen.hit.snippet = found.snippet;
        });
      }
      if (merged.size >= limit) break;
    }
  } finally { clearTimeout(timer); }

  if (options.signal?.aborted) throw searchFailure('fetch.aborted');
  const hits = [...merged.values()]
    .sort((a, b) => b.count - a.count || a.group - b.group || a.position - b.position || a.order - b.order)
    .slice(0, limit).map(x => x.hit);
  if (hits.length || attempts.some(a => a.outcome === 'empty')) {
    const engines = [...new Set(attempts.filter(a => a.hits.length).map(a => a.engine.label))];
    return { hits, engines };
  }
  throw searchFailure('search.all_unavailable', { details: unavailableDetails(options.engines, attempts, health) });
}

// 「全部使えない」の中身: 先の名前・理由・分だけ（相手の文字は入れない）
function unavailableDetails(engines: readonly SearchEngine[], attempts: readonly Attempt[], health: EngineHealth): string {
  const lines: string[] = [];
  for (const engine of engines) {
    const attempt = attempts.find(a => a.engine.id === engine.id);
    const rest = health.restingFor(engine);
    let key: ToolMessageKey | undefined;
    if (attempt) key = attempt.outcome === 'blocked' ? 'search.reason.blocked' : attempt.outcome === 'unknown' ? 'search.reason.unknown' : attempt.outcome === 'timeout' || attempt.outcome === 'aborted' ? 'search.reason.timeout' : attempt.outcome === 'error' ? 'search.reason.error' : undefined;
    else if (rest > 0) key = 'search.reason.resting';
    else if (health.overHourLimit(engine)) key = 'search.reason.hour_limit';
    if (key) lines.push(toolText('en', key, { engine: engine.label, minutes: minutes(rest) }));
  }
  return lines.join('; ') || toolText('en', 'search.reason.none');
}
