import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublic, RetrievalFailure, type PageNetwork } from '../src/tools/web/public-page.ts';
import type { EngineState, SearchEngine } from '../src/tools/web/search/engine.ts';
import { EngineHealth } from '../src/tools/web/search/health.ts';
import { SearchImpersonation, type ImpitInit, type ImpitModuleLike, type ImpitOptionsLike, type ImpitResponseLike } from '../src/tools/web/search/impersonate.ts';
import { metasearch } from '../src/tools/web/search/metasearch.ts';
import { SEARCH_MAX_BYTES, type SearchRequestHeaders } from '../src/tools/web/search/disguise.ts';
import type { PinProxy } from '../src/tools/web/search/pin-proxy.ts';

// 偽の impit・偽の中継・偽の名前引きだけ。本当の通信はしない

type Answer = (url: string, init: ImpitInit) => ImpitResponseLike | Promise<ImpitResponseLike>;

function fakeProxy() {
  const live = new Map<string, string>();
  const registered: { host: string; address: string }[] = [];
  let closed = 0;
  const proxy: PinProxy = {
    url: 'http://beat:secret@127.0.0.1:1', port: 1,
    register(host, address) { registered.push({ host, address }); live.set(host, address); return () => { live.delete(host); }; },
    close: async () => { closed += 1; },
  };
  return { proxy, live, registered, closed: () => closed };
}

function fakeImpit(answer: Answer, proxy: ReturnType<typeof fakeProxy>) {
  const options: ImpitOptionsLike[] = [];
  const calls: { url: string; init: ImpitInit; pinned: string | undefined }[] = [];
  const module: ImpitModuleLike = {
    Impit: class {
      constructor(o: ImpitOptionsLike) { options.push(o); }
      async fetch(url: string, init: ImpitInit) {
        calls.push({ url, init, pinned: proxy.live.get(new URL(url).hostname) });
        return answer(url, init);
      }
    },
  };
  return { module, options, calls };
}

const respond = (status: number, body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'text/html' }): ImpitResponseLike => {
  const response = new Response(body, { status, headers });
  return { status: response.status, headers: response.headers, body: response.body };
};

function fakeFallback() {
  const gets: string[] = [];
  const fallback = (_request: SearchRequestHeaders): PageNetwork => ({
    resolve: async () => ['93.184.216.34'],
    get: async url => { gets.push(url.href); return { status: 200, contentType: 'text/html', body: Buffer.from('fallback') }; },
  });
  return { fallback, gets };
}

function setup(answer: Answer, extra: { load?: () => Promise<ImpitModuleLike>; resolve?: PageNetwork['resolve'] } = {}) {
  const proxy = fakeProxy();
  const impit = fakeImpit(answer, proxy);
  const fb = fakeFallback();
  const logs: string[] = [];
  let loads = 0;
  const impersonation = new SearchImpersonation({
    load: async () => { loads += 1; return extra.load ? extra.load() : impit.module; },
    startProxy: async () => proxy.proxy,
    log: line => logs.push(line),
    fallback: fb.fallback,
  });
  const request: SearchRequestHeaders = { accept: 'text/html', headers: { 'user-agent': 'Chrome/148 test' } };
  const base = impersonation.networkFor(request);
  const network: PageNetwork = { resolve: extra.resolve ?? (async () => ['93.184.216.34']), get: base.get };
  return { proxy, impit, fb, logs, loads: () => loads, impersonation, network };
}

test('a name that resolves to a LAN or loopback address never reaches impit', async () => {
  for (const address of ['127.0.0.1', '192.168.1.10', '10.0.0.5']) {
    const s = setup(() => respond(200, '<html></html>'), { resolve: async () => [address] });
    await assert.rejects(fetchPublic('https://www.bing.com/search?q=x', undefined, s.network), (e: RetrievalFailure) => e.code === 'policy_blocked');
    assert.equal(s.impit.calls.length, 0);
    assert.equal(s.proxy.registered.length, 0);
  }
});

test('impit gets chrome151, the relay, manual redirects, no cookies, no header overrides; the host is pinned only while the request runs', async () => {
  const s = setup(() => respond(200, '<html>ok</html>', { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br' }));
  const page = await fetchPublic('https://www.bing.com/search?q=x', undefined, s.network);
  assert.equal(page.body.toString(), '<html>ok</html>');
  assert.deepEqual(s.impit.options, [{ browser: 'chrome151', proxyUrl: 'http://beat:secret@127.0.0.1:1', timeout: 15_000, followRedirects: false, vanillaFallback: false, http3: false }]);
  assert.equal(s.impit.calls.length, 1);
  const call = s.impit.calls[0]!;
  assert.equal(call.init.redirect, 'manual');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.equal('headers' in call.init, false, 'impit keeps its own Chrome headers (no beat or CHROME_AGENTS user-agent)');
  assert.equal(call.pinned, '93.184.216.34', 'registered before the fetch, with the verified address');
  assert.equal(s.proxy.live.size, 0, 'released afterwards');
});

test('a 3xx comes back with its location; followPublic follows inside the search hosts and refuses the rest', async () => {
  const s = setup(url => url.includes('/first')
    ? respond(302, null, { location: 'https://lite.duckduckgo.com/lite/?q=x' })
    : url.includes('lite.duckduckgo.com') ? respond(200, '<html>lite</html>') : respond(301, null, { location: 'https://evil.example.net/' }));
  const hosts = new Set(['html.duckduckgo.com', 'lite.duckduckgo.com']);
  const page = await fetchPublic('https://html.duckduckgo.com/first', undefined, s.network, 15_000, undefined, hosts);
  assert.equal(page.url, 'https://lite.duckduckgo.com/lite/?q=x');
  assert.deepEqual(s.proxy.registered.map(r => r.host), ['html.duckduckgo.com', 'lite.duckduckgo.com']);
  await assert.rejects(fetchPublic('https://html.duckduckgo.com/away', undefined, s.network, 15_000, undefined, hosts), (e: RetrievalFailure) => e.code === 'policy_blocked');
  assert.equal(s.impit.calls.filter(c => c.url.includes('evil')).length, 0);
});

test('a body over 512 KiB is cut at the cap and reading stops', async () => {
  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const stream = () => new ReadableStream<Uint8Array>({
    pull(controller) { pulls += 1; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const s = setup(() => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: stream() }));
  const page = await fetchPublic('https://www.bing.com/search?q=x', undefined, s.network);
  assert.equal(page.body.length, SEARCH_MAX_BYTES);
  assert.equal(page.truncated, true);
  assert.ok(pulls <= SEARCH_MAX_BYTES / chunk.length + 2, `pulled ${pulls} chunks`);
  assert.equal(cancelled, true);
});

test('aborting while the body streams stops the read', async () => {
  let cancelled = false;
  const stop = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('<html>')); setTimeout(() => stop.abort(), 10); },
    cancel() { cancelled = true; },
  });
  const s = setup(() => ({ status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: stream }));
  await assert.rejects(fetchPublic('https://www.bing.com/search?q=x', stop.signal, s.network), (e: RetrievalFailure) => e.code === 'aborted');
  assert.equal(cancelled, true);
  assert.equal(s.proxy.live.size, 0);
});

test('a wrong content type and a blocking status fail the same way as the header-only path', async () => {
  const s = setup(url => url.includes('json-ish') ? respond(200, 'x', { 'content-type': 'text/plain' }) : respond(429, 'slow down'));
  await assert.rejects(fetchPublic('https://www.bing.com/json-ish', undefined, s.network), (e: RetrievalFailure) => e.code === 'invalid_response' && e.key === 'fetch.type');
  await assert.rejects(fetchPublic('https://www.bing.com/search', undefined, s.network), (e: RetrievalFailure) => e.code === 'refused' && e.status === 429);
  const s202 = setup(() => respond(202, ''));
  await assert.rejects(fetchPublic('https://html.duckduckgo.com/html/', undefined, s202.network), (e: RetrievalFailure) => e.status === 202);
});

test('when impit cannot be loaded, it is logged once and the header-only path answers; no retry in this run', async () => {
  const s = setup(() => respond(200, '<html></html>'), { load: async () => { throw new Error('Cannot find native binding'); } });
  const one = await fetchPublic('https://www.bing.com/search?q=x', undefined, s.network);
  const two = await fetchPublic('https://www.bing.com/search?q=y', undefined, s.network);
  assert.equal(one.body.toString(), 'fallback');
  assert.equal(two.body.toString(), 'fallback');
  assert.equal(s.loads(), 1);
  assert.equal(s.logs.length, 1);
  assert.match(s.logs[0]!, /header-only/u);
  assert.equal(s.impit.calls.length, 0);
});

test('when the relay cannot start, the header-only path answers', async () => {
  const fb = fakeFallback();
  const logs: string[] = [];
  const impersonation = new SearchImpersonation({ load: async () => ({ Impit: class { constructor() { throw new Error('must not run'); } } as unknown as ImpitModuleLike['Impit'] }), startProxy: async () => { throw new Error('EADDRINUSE'); }, log: line => logs.push(line), fallback: fb.fallback });
  const page = await fetchPublic('https://www.bing.com/search?q=x', undefined, impersonation.networkFor({ accept: 'text/html', headers: {} }));
  assert.equal(page.body.toString(), 'fallback');
  assert.equal(logs.length, 1);
});

test('nothing is loaded before the first request, and close() shuts the relay', async () => {
  const s = setup(() => respond(200, '<html></html>'));
  assert.equal(s.loads(), 0);
  await fetchPublic('https://www.bing.com/search?q=x', undefined, s.network);
  await s.impersonation.close();
  assert.equal(s.proxy.closed(), 1);
});

// metasearch: disguise: true の先だけが似せる通信を通る
function engine(id: string, disguise: boolean): SearchEngine {
  return {
    id, label: id, provider: id, minIntervalMs: 0, maxPerHour: 30, disguise, ...(disguise ? {} : { userAgent: 'beat/0.1' }),
    hosts: () => [`${id}.searchsite.net`],
    request: query => new URL(`https://${id}.searchsite.net/search?q=${encodeURIComponent(query)}`),
    read: body => ({ state: 'ok' as EngineState, hits: [{ title: id, url: `https://${body}.example.org/`, snippet: '' }] }),
  };
}

test('metasearch sends only disguise: true engines through the impersonated network; Wikipedia-style engines stay honest', async () => {
  const used: string[] = [];
  const net = (kind: string) => (request: SearchRequestHeaders): PageNetwork => ({
    resolve: async () => ['93.184.216.34'],
    get: async url => { used.push(`${kind}:${url.hostname.split('.')[0]}:${request.headers['user-agent'] === 'beat/0.1' ? 'beat' : 'other'}`); return { status: 200, contentType: 'text/html', body: Buffer.from(kind) }; },
  });
  await metasearch({ query: 'q', limit: 5, region: 'jp-jp', engines: [engine('wiki', false), engine('bing', true)], health: new EngineHealth(), sleep: async () => undefined, networkFor: net('plain'), impersonatedFor: net('impit') });
  assert.deepEqual(used.sort(), ['impit:bing:other', 'plain:wiki:beat']);
});

