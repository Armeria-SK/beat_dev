import assert from 'node:assert/strict';
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { builtinTools } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { SCOUT_TOOLS } from '../src/engine/chat.ts';
import { guardText } from '../src/shared/messages/guard.ts';
import { BrowserFailure, PlaywrightBrowser } from '../src/tools/browser/driver.ts';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from '../src/tools/browser/egress-proxy.ts';
import { allowedLoopbackUrl, browserPageUrl, deniedLoopbackPorts, fetchSiteAllows, grantOf, loopbackHost, loopbackOrigin, tunnelVerdict, TUNNEL_HEAD_MAX, type BrowserGrant } from '../src/tools/browser/loopback.ts';
import { routeVerdict } from '../src/tools/browser/route.ts';
import { BrowserSession, MAX_TABS_TOTAL, type BrowserSessionDeps } from '../src/tools/browser/session.ts';
import { browserClick, browserClose, browserOpen, browserRead, browserScreenshot, browserType } from '../src/tools/builtin/browser.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { FakeBrowserDriver, type FakeBrowser } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// 9-1a: 作業用のブラウザの文脈と、製品の開発サーバー（ループバック）。脅威の表の T1〜T10・T17・T18 と、段の試験の一覧（PLAN.md 9-1a）

const PUBLIC = '93.184.216.34';
const DEV = 'http://localhost:5173';
const auth = (password = 'pw', username = 'beat'): string => `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString('base64')}\r\n`;
const status = (response: string): number => Number(/^HTTP\/1\.\d (\d{3})/u.exec(response)?.[1] ?? 0);

async function listen(server: Server | HttpServer, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>(done => server.listen(0, host, done));
  return (server.address() as AddressInfo).port;
}

// 生の要求を送り、応答を文字で返す（切れるまで、または少し待って）
function raw(port: number, text: string, waitMs = 300): Promise<string> {
  return new Promise(done => {
    const socket = connect(port, '127.0.0.1');
    let out = '';
    socket.on('data', chunk => { out += chunk.toString('latin1'); });
    socket.on('error', () => {});
    socket.on('connect', () => socket.write(text));
    socket.on('close', () => done(out));
    setTimeout(() => { socket.destroy(); }, waitMs);
  });
}

// CONNECT して 200 が来たら head を送る。CONNECT の応答の状態・そのあとに届いたもの・相手から切られたか
function tunnel(port: number, target: string, head: Buffer | string, password = 'pw', waitMs = 400): Promise<{ status: number; after: string; closed: boolean; socket: Socket }> {
  return new Promise(done => {
    const socket = connect(port, '127.0.0.1');
    let out = ''; let sent = false; let closed = false;
    socket.on('data', chunk => {
      out += chunk.toString('latin1');
      if (!sent && out.includes('\r\n\r\n')) { sent = true; if (status(out) === 200 && head.length > 0) socket.write(head); }
    });
    socket.on('error', () => {});
    socket.on('close', () => { closed = true; });
    socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth(password)}\r\n`));
    setTimeout(() => {
      const end = out.indexOf('\r\n\r\n');
      done({ status: status(out), after: end < 0 ? '' : out.slice(end + 4), closed, socket });
    }, waitMs);
  });
}

const wsHead = (target: string, origin: string | undefined): string =>
  `GET /hmr HTTP/1.1\r\nHost: ${target}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin === undefined ? '' : `Origin: ${origin}\r\n`}\r\n`;

interface Hit { method: string; url: string; headers: IncomingHttpHeaders; body: string }

// 受け口（開発サーバーに見立てる）。届いた要求と WebSocket の始まりを記録する。WebSocket は 101 を返して、あとは受けたものを返す
async function sink(t: TestContext, hits: Hit[], host = '127.0.0.1'): Promise<number> {
  const upgraded = new Set<import('node:stream').Duplex>();
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('sink'); });
  });
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    hits.push({ method: 'UPGRADE', url: req.url ?? '', headers: req.headers, body: '' });
    socket.on('error', () => {});
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', chunk => socket.write(chunk));
  });
  const port = await listen(server, host);
  t.after(() => { server.close(); server.closeAllConnections(); for (const socket of upgraded) socket.destroy(); });
  return port;
}

interface LoopRig {
  proxy: EgressProxy;
  config: AppConfig;
  hits: Hit[];
  beatHits: Hit[];
  sinkPort: number;
  beatPort: number;
  connected: Array<[string, number, number]>;
  resolved: string[];
}

// 許しのある中継（loopback あり）。断るポートは deniedLoopbackPorts（server.port を beat に見立てた受け口のポートにする）
async function loopRig(t: TestContext, extra: Partial<EgressProxyOptions> = {}, withLoopback = true): Promise<LoopRig> {
  const hits: Hit[] = [];
  const beatHits: Hit[] = [];
  const sinkPort = await sink(t, hits);
  const beatPort = await sink(t, beatHits);
  const config = testConfig();
  config.server.port = beatPort;
  const connected: LoopRig['connected'] = [];
  const resolved: string[] = [];
  let selfPort = 0;
  const proxy = await startEgressProxy({
    username: 'beat', password: 'pw',
    resolve: async host => { resolved.push(host); return [PUBLIC]; },
    // 公開の番地は受け口へ、ループバックの番地（::1 も）は 127.0.0.1 の同じポートへ
    connect: (address, port, family) => { connected.push([address, port, family]); return connect(address === PUBLIC ? sinkPort : port, '127.0.0.1'); },
    ...(withLoopback ? { loopback: { denyPorts: () => deniedLoopbackPorts(config, [selfPort]) } } : {}),
    ...extra,
  });
  selfPort = proxy.port;
  t.after(() => proxy.close());
  return { proxy, config, hits, beatHits, sinkPort, beatPort, connected, resolved };
}

const get = (target: string, headers: Record<string, string> = {}, password = 'pw'): string =>
  `GET http://${target}/ HTTP/1.1\r\nHost: ${target}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}${auth(password)}\r\n`;

// ---------------------------------------------------------------- 純関数

test('grantOf: 考える実行・振り返りは undefined。持ち主が見ているのは kind chat だけ。製品の作業フォルダがあれば loopback', () => {
  const base = { conversationId: 'c1', runId: 'r1' };
  assert.equal(grantOf({ ...base, kind: 'chat', scout: true }), undefined);
  assert.equal(grantOf({ ...base, kind: 'review' }), undefined);
  assert.deepEqual(grantOf({ ...base, kind: 'chat' }), { ...base, attended: true, loopback: false });
  assert.deepEqual(grantOf({ ...base, kind: 'task', project: { id: 'p1', root: 'C:\\shop' } }), { ...base, attended: false, loopback: true, productId: 'p1' });
  assert.deepEqual(grantOf({ ...base, kind: 'agent', project: { id: 'p1', root: 'C:\\shop' } }), { ...base, attended: false, loopback: true, productId: 'p1' });
  assert.equal(grantOf({ ...base, kind: 'chat', project: { id: 'p1' } })!.loopback, false, '作業フォルダの無い製品は loopback なし');
});

test('loopbackHost: 正規化したあとのループバックの書き方だけ。localhost は 127.0.0.1 → ::1 の順。名前は引かない', () => {
  assert.deepEqual(loopbackHost('localhost'), { connect: ['127.0.0.1', '::1'] });
  assert.deepEqual(loopbackHost('localhost.'), { connect: ['127.0.0.1', '::1'] });
  assert.deepEqual(loopbackHost('127.0.0.1'), { connect: ['127.0.0.1'] });
  assert.deepEqual(loopbackHost('127.255.0.9'), { connect: ['127.255.0.9'] });
  assert.deepEqual(loopbackHost('[::1]'), { connect: ['::1'] });
  for (const host of ['rebind.example', 'foo.localhost', 'localhost.localdomain', '0.0.0.0', '[::]', '[::ffff:7f00:1]', '127.0.0.256', '10.0.0.1', '']) assert.equal(loopbackHost(host), undefined, host);
});

test('loopbackOrigin: http のループバックの出どころだけ（null・無し・https・パス付き・公開は false）', () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://localhost']) assert.equal(loopbackOrigin(origin), true, origin);
  for (const origin of [undefined, 'null', '', 'https://localhost:5173', 'http://localhost:5173/', 'http://pub.example', 'http://localhost.localdomain', 'not a url']) assert.equal(loopbackOrigin(origin), false, String(origin));
});

test('T7: deniedLoopbackPorts は beat のポート・origins・4777・中継・提供元と MCP の http のループバックの宛先（ポートの無い http は 80）', () => {
  const config = testConfig();
  config.server.port = 4898;
  config.server.origins = ['http://localhost:4899', 'https://beat.tail1234.ts.net'];
  config.providers = [
    { id: 'a', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8081/v1', maxParallel: 1, timeoutMs: 600_000 },
    { id: 'b', kind: 'openai_compatible', baseUrl: 'http://localhost/v1', maxParallel: 1, timeoutMs: 600_000 },
    { id: 'c', kind: 'openai_compatible', baseUrl: 'https://api.example.com/v1', maxParallel: 1, timeoutMs: 600_000 },
  ];
  config.mcp.servers = [
    { id: 'm1', transport: 'http', enabled: true, tools: {}, env: {}, headers: {}, url: 'http://127.0.0.1:9123/mcp' },
    { id: 'm2', transport: 'stdio', enabled: true, tools: {}, env: {}, headers: {}, command: ['x'] },
  ];
  const denied = deniedLoopbackPorts(config, [50001, 50002]);
  for (const port of [4898, 4899, 443, 4777, 50001, 50002, 8081, 80, 9123]) assert.ok(denied.has(port), String(port));
  assert.equal(denied.has(5173), false);
});

test('T7: 提供元と MCP の http の宛先が公開の名前・公開の IP でなければ（0.0.0.0・LAN・localhost.localdomain・ドットの無い名前・.local・IPv6）そのポートも断る。公開の宛先のポートは断らない', () => {
  const config = testConfig();
  const provider = (id: string, baseUrl: string) => ({ id, kind: 'openai_compatible' as const, baseUrl, maxParallel: 1, timeoutMs: 600_000 });
  config.providers = [
    provider('a', 'http://0.0.0.0:11434/v1'), provider('b', 'http://192.168.1.20:8001/v1'), provider('c', 'http://localhost.localdomain:8002/v1'),
    provider('d', 'http://llmbox:8003/v1'), provider('e', 'http://gpu.local:8004/v1'), provider('f', 'http://[fe80::1]:8005/v1'),
    provider('g', 'https://api.example.com:8443/v1'), provider('h', 'http://8.8.8.8:8444/v1'),
  ];
  config.mcp.servers = [{ id: 'm1', transport: 'http', enabled: true, tools: {}, env: {}, headers: {}, url: 'http://10.0.0.5:9200/mcp' }];
  const denied = deniedLoopbackPorts(config, []);
  for (const port of [11434, 8001, 8002, 8003, 8004, 8005, 9200]) assert.ok(denied.has(port), String(port));
  for (const port of [8443, 8444]) assert.equal(denied.has(port), false, String(port));
});

test('T6: browserPageUrl は正規化してから決める（127.1・0x7f000001・2130706433・0177.0.0.1・127.0.0.1. は 127.0.0.1。断るポートが効く）', () => {
  const grant: BrowserGrant = { conversationId: 'c1', runId: 'r1', attended: true, loopback: true };
  const denied = new Set([4777]);
  for (const host of ['127.1', '0x7f000001', '2130706433', '0177.0.0.1', '127.0.0.1.']) {
    assert.throws(() => browserPageUrl(`http://${host}:4777/`, grant, denied), /Port 4777/u, host);
    const opened = browserPageUrl(`http://${host}:5173/`, grant, denied);
    assert.equal(opened.kind, 'loopback', host);
    assert.equal(opened.url.hostname, '127.0.0.1', host);
  }
  // ループバックでない書き方は公開の決まり（明示のポートは断る。ポートが無くても内向きの番地・名前は断る）
  for (const host of ['0.0.0.0', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'foo.localhost', 'localhost.localdomain']) {
    assert.throws(() => browserPageUrl(`http://${host}:5173/`, grant, denied), host);
    if (host !== 'localhost.localdomain') assert.throws(() => browserPageUrl(`http://${host}/`, grant, denied), host);
  }
  // localhost.localdomain はふつうの名前として公開の決まりを通る（ループバックにはしない）。中継が引いた番地（127.0.0.1）で断る（下の中継の T6）
  assert.equal(browserPageUrl('http://localhost.localdomain/', grant, denied).kind, 'public');
});

test('browserPageUrl: 許しが無ければループバックは断る。https のループバック・合言葉付きは断る。公開の URL は今の pageUrl', () => {
  const product: BrowserGrant = { conversationId: 'c1', runId: 'r1', attended: true, loopback: true };
  const none: BrowserGrant = { ...product, loopback: false };
  const denied = new Set<number>();
  assert.throws(() => browserPageUrl(`${DEV}/`, none, denied), new RegExp(guardText('en', 'browser.loopback.not_product').slice(0, 30).replace(/[()]/gu, '.'), 'u'));
  assert.throws(() => browserPageUrl('https://localhost:5173/', product, denied), /https on this PC/u);
  assert.throws(() => browserPageUrl('http://u:p@localhost:5173/', product, denied));
  assert.deepEqual(browserPageUrl('https://example.com/a', product, denied).kind, 'public');
  assert.throws(() => browserPageUrl('https://example.com:8443/', product, denied));
});

test('作業用の文脈でも file: / chrome: / view-source: / data: の遷移は browserPageUrl と横取りの両方で断る', () => {
  const grant: BrowserGrant = { conversationId: 'c1', runId: 'r1', attended: false, loopback: true };
  for (const url of ['file:///C:/Windows/win.ini', 'chrome://settings', 'view-source:http://localhost:5173/', 'data:text/html,<b>x</b>']) {
    assert.throws(() => browserPageUrl(url, grant, new Set()), url);
    assert.equal(routeVerdict({ url, navigation: true, mainFrame: true, pageUrl: `${DEV}/`, allowed: () => true }).allow, false, url);
  }
});

test('T4a（純）: fetchSiteAllows は none・same-origin・same-site と、cross-site でループバックの Origin だけ', () => {
  for (const site of ['none', 'same-origin', 'same-site', ' Same-Origin ']) assert.equal(fetchSiteAllows({ secFetchSite: site }), true, site);
  assert.equal(fetchSiteAllows({ secFetchSite: 'cross-site', origin: 'http://localhost:3000' }), true);
  for (const origin of ['http://pub.example', 'null', undefined, 'https://localhost:3000']) assert.equal(fetchSiteAllows({ secFetchSite: 'cross-site', origin }), false, String(origin));
  assert.equal(fetchSiteAllows({}), false, '見出しが無いものは断る');
  assert.equal(fetchSiteAllows({ secFetchSite: 'weird' }), false);
});

test('T4b（純）: tunnelVerdict はループバックの Origin の WebSocket の始まりだけ ok。TLS・HTTP でない・公開や無しの Origin・長すぎは refuse。足りなければ more', () => {
  const target = 'localhost:5173';
  assert.equal(tunnelVerdict(Buffer.from(wsHead(target, 'http://localhost:5173'))), 'ok');
  assert.equal(tunnelVerdict(Buffer.from(wsHead(target, 'http://pub.example'))), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from(wsHead(target, undefined))), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from(wsHead(target, 'null'))), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from([0x16, 0x03, 0x01, 0x00])), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from('SSH-2.0-OpenSSH\r\n')), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from('POST /x HTTP/1.1\r\n\r\n')), 'refuse');
  assert.equal(tunnelVerdict(Buffer.from(`GET /x HTTP/1.1\r\nHost: ${target}\r\nOrigin: http://localhost:5173\r\n\r\n`)), 'refuse', 'Upgrade の無い GET');
  assert.equal(tunnelVerdict(Buffer.from('GE')), 'more');
  assert.equal(tunnelVerdict(Buffer.from('GET /hmr HTTP/1.1\r\nHost: x\r\n')), 'more');
  assert.equal(tunnelVerdict(Buffer.from(`GET /x HTTP/1.1\r\nX: ${'a'.repeat(TUNNEL_HEAD_MAX)}`)), 'refuse');
  assert.equal(tunnelVerdict(Buffer.alloc(0)), 'more');
});

// ---------------------------------------------------------------- 中継（生のソケット）

test('T1: 許しのある中継でも、beat のポート（いろいろな書き方）と 4777 は CONNECT も平の http も 403。受け口に届かず、つなぎもしない', async t => {
  const r = await loopRig(t);
  const forms = ['127.0.0.1', 'localhost', 'localhost.', '[::1]', '127.1', '2130706433'];
  let blocked = r.proxy.stats().blocked;
  for (const host of forms) {
    const target = `${host}:${r.beatPort}`;
    assert.equal((await tunnel(r.proxy.port, target, wsHead(target, `http://localhost:${r.sinkPort}`))).status, 403, `CONNECT ${target}`);
    assert.equal(status(await raw(r.proxy.port, get(target, { 'Sec-Fetch-Site': 'none' }))), 403, `GET ${target}`);
    blocked += 2;
    assert.equal(r.proxy.stats().blocked, blocked, target);
  }
  assert.equal((await tunnel(r.proxy.port, '127.0.0.1:4777', '')).status, 403);
  assert.equal(status(await raw(r.proxy.port, get('localhost:4777', { 'Sec-Fetch-Site': 'none' }))), 403);
  assert.deepEqual(r.beatHits, []);
  assert.deepEqual(r.connected, [], '断るポートへは 1 本もつながない');
  // 同じ形で、断るポートでない受け口には届く（断るのはポートのせい）
  assert.equal(status(await raw(r.proxy.port, get(`127.0.0.1:${r.sinkPort}`, { 'Sec-Fetch-Site': 'none' }))), 200);
  assert.equal(r.hits.length, 1);
});

test('T2: server.origins のホスト（denyHosts）は、中継が名前を引く前に 403。denyHosts が無ければ同じ要求は通る', async t => {
  const config = testConfig();
  config.server.origins = ['https://beat.tail1234.ts.net', 'https://Beat.Funnel.example'];
  const deny = await loopRig(t, { denyHosts: () => config.server.origins.map(origin => new URL(origin).hostname) });
  for (const target of ['beat.tail1234.ts.net:443', 'BEAT.tail1234.ts.net.:443', 'beat.funnel.example:443']) {
    assert.equal((await tunnel(deny.proxy.port, target, '')).status, 403, target);
  }
  assert.equal(status(await raw(deny.proxy.port, get('beat.tail1234.ts.net'))), 403);
  assert.deepEqual(deny.resolved, []);
  assert.deepEqual(deny.connected, []);
  const open = await loopRig(t);
  assert.equal((await tunnel(open.proxy.port, 'beat.tail1234.ts.net:443', '')).status, 200);
});

test('T3(3): 許しの無い中継（loopback なし）は、ループバックへの CONNECT も平の http も今の公開の決まりで 403', async t => {
  const r = await loopRig(t, {}, false);
  assert.equal((await tunnel(r.proxy.port, `localhost:${r.sinkPort}`, wsHead(`localhost:${r.sinkPort}`, `http://localhost:${r.sinkPort}`))).status, 403);
  assert.equal(status(await raw(r.proxy.port, get(`127.0.0.1:${r.sinkPort}`, { 'Sec-Fetch-Site': 'none' }))), 403);
  assert.equal(status(await raw(r.proxy.port, get('localhost', { 'Sec-Fetch-Site': 'none' }))), 403);
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.connected, []);
});

test('T4a: 平の http は Sec-Fetch-Site / Origin で、公開のページから来た要求を 403（受け口に届かない）。開発サーバーのページから来たものは通る', async t => {
  const r = await loopRig(t);
  const target = `127.0.0.1:${r.sinkPort}`;
  const refused: Array<Record<string, string>> = [
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://pub.example' },
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    {},
  ];
  for (const headers of refused) assert.equal(status(await raw(r.proxy.port, get(target, headers))), 403, JSON.stringify(headers));
  assert.deepEqual(r.hits, []);
  const allowed: Array<Record<string, string>> = [
    { 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'same-site' },
    { 'Sec-Fetch-Site': 'cross-site', Origin: 'http://localhost:3000' },
  ];
  for (const headers of allowed) assert.equal(status(await raw(r.proxy.port, get(target, headers))), 200, JSON.stringify(headers));
  assert.equal(r.hits.length, allowed.length);
});

test('T4b: ループバックの CONNECT は 200 のあと始めの要求を確かめ、公開・無しの Origin・TLS・HTTP でない・長すぎ・届かない頭は上流につながず切る', async t => {
  const r = await loopRig(t, { headTimeoutMs: 150 });
  const target = `localhost:${r.sinkPort}`;
  const bad: Array<[string, Buffer | string]> = [
    ['public origin', wsHead(target, 'http://pub.example')],
    ['no origin', wsHead(target, undefined)],
    ['tls', Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00])],
    ['not http', 'SSH-2.0-OpenSSH_9\r\n'],
    ['too long', `GET /x HTTP/1.1\r\nX: ${'a'.repeat(TUNNEL_HEAD_MAX + 10)}`],
    ['silent', ''],
  ];
  for (const [label, head] of bad) {
    const before = r.proxy.stats().blocked;
    const out = await tunnel(r.proxy.port, target, head, 'pw', 500);
    assert.equal(out.status, 200, label);
    assert.equal(out.closed, true, `${label}: 切られる`);
    assert.equal(r.proxy.stats().blocked, before + 1, `${label}: 断った数に入る`);
  }
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.connected, []);
  // 開発サーバーのページからの WebSocket は通り、読んだ頭がそのまま上流に届く
  const head = wsHead(target, `http://localhost:${r.sinkPort}`);
  const ok = await tunnel(r.proxy.port, target, head);
  assert.equal(ok.status, 200);
  assert.match(ok.after, /^HTTP\/1\.1 101 /u);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.method, 'UPGRADE');
  assert.equal(r.hits[0]!.headers.origin, `http://localhost:${r.sinkPort}`);
  ok.socket.destroy();
});

test('T5: 引くと 127.0.0.1 になる公開の名前は、許しのある中継でも 403（ループバックは書き方だけで決め、名前は引いてもつながない）', async t => {
  const r = await loopRig(t, { resolve: async () => ['127.0.0.1'] });
  assert.equal((await tunnel(r.proxy.port, 'rebind.example:443', '')).status, 403);
  assert.equal(status(await raw(r.proxy.port, get('rebind.example', { 'Sec-Fetch-Site': 'none' }))), 403);
  assert.equal((await tunnel(r.proxy.port, `rebind.example:${r.sinkPort}`, '')).status, 403);
  assert.deepEqual(r.connected, []);
});

test('T6: 中継も正規化してから決める。127.1 などの書き方でも断るポートが効き、0.0.0.0・[::]・[::ffff:…]・foo.localhost・localhost.localdomain はどのポートでも 403', async t => {
  // 名前の解決はこの PC の hosts と同じ形（localhost.localdomain → 127.0.0.1）
  const r = await loopRig(t, { resolve: async host => (host === 'localhost.localdomain' ? ['127.0.0.1'] : [PUBLIC]) });
  for (const host of ['127.1', '0x7f000001', '2130706433', '0177.0.0.1', '127.0.0.1.']) {
    assert.equal((await tunnel(r.proxy.port, `${host}:${r.beatPort}`, '')).status, 403, host);
    assert.equal(status(await raw(r.proxy.port, get(`${host}:${r.beatPort}`, { 'Sec-Fetch-Site': 'none' }))), 403, host);
  }
  for (const host of ['0.0.0.0', '[::]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', 'foo.localhost', 'localhost.localdomain']) {
    for (const port of [r.sinkPort, 80]) {
      assert.equal((await tunnel(r.proxy.port, `${host}:${port}`, '')).status, 403, `CONNECT ${host}:${port}`);
      assert.equal(status(await raw(r.proxy.port, get(`${host}:${port}`, { 'Sec-Fetch-Site': 'none' }))), 403, `GET ${host}:${port}`);
    }
  }
  assert.deepEqual(r.hits, []);
  assert.deepEqual(r.beatHits, []);
  assert.deepEqual(r.connected, []);
});

test('T8: 許しはループバックだけ。LAN・Tailscale・リンクローカル・IPv6 のリンクローカルは許しのある中継でも 403', async t => {
  const r = await loopRig(t);
  for (const target of ['100.101.102.103:80', '192.168.1.1:80', '10.0.0.1:5173', '169.254.169.254:80', '[fe80::1]:80']) {
    assert.equal((await tunnel(r.proxy.port, target, '')).status, 403, `CONNECT ${target}`);
    assert.equal(status(await raw(r.proxy.port, get(target, { 'Sec-Fetch-Site': 'none' }))), 403, `GET ${target}`);
  }
  assert.deepEqual(r.connected, []);
});

test('中継: ループバックの平の http は POST の本文（Content-Length・chunked）をそのまま届け、Upgrade つきは 400', async t => {
  const r = await loopRig(t);
  const target = `127.0.0.1:${r.sinkPort}`;
  const head = `Host: ${target}\r\nSec-Fetch-Site: same-origin\r\nOrigin: http://${target}\r\n${auth()}`;
  assert.equal(status(await raw(r.proxy.port, `POST http://${target}/save HTTP/1.1\r\n${head}Content-Type: text/plain\r\nContent-Length: 11\r\n\r\nhello world`)), 200);
  assert.equal(status(await raw(r.proxy.port, `PUT http://${target}/chunk HTTP/1.1\r\n${head}Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n`)), 200);
  assert.deepEqual(r.hits.map(h => [h.method, h.url, h.body]), [['POST', '/save', 'hello world'], ['PUT', '/chunk', 'hello world']]);
  assert.equal(r.hits[0]!.headers['content-length'], '11');
  assert.equal(r.hits[0]!.headers.host, target);
  assert.equal(status(await raw(r.proxy.port, `GET http://${target}/ws HTTP/1.1\r\n${head}Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)), 400);
  assert.equal(r.hits.length, 2);
});

test('中継: localhost は 127.0.0.1 でつなげなければ ::1 へつなぐ（family 6）', async t => {
  const hits: Hit[] = [];
  const sinkPort = await sink(t, hits);
  const closedPort = await (async () => { const s = createServer(); const p = await listen(s); await new Promise<void>(done => s.close(() => done())); return p; })();
  const seen: Array<[string, number]> = [];
  const proxy = await startEgressProxy({
    username: 'beat', password: 'pw', loopback: { denyPorts: () => new Set() },
    connect: (address, port, family) => { seen.push([address, family]); return connect(address === '::1' ? sinkPort : closedPort, '127.0.0.1'); },
  });
  t.after(() => proxy.close());
  assert.equal(status(await raw(proxy.port, get('localhost:5173', { 'Sec-Fetch-Site': 'none' }))), 200);
  assert.deepEqual(seen, [['127.0.0.1', 4], ['::1', 6]]);
  assert.equal(hits.length, 1);
});

test('中継: ループバックのトンネルは無通信でも切れず、公開のトンネルは今どおり無通信で切れる', async t => {
  const r = await loopRig(t, { idleMs: 150 });
  const target = `localhost:${r.sinkPort}`;
  const local = await tunnel(r.proxy.port, target, wsHead(target, `http://localhost:${r.sinkPort}`), 'pw', 600);
  assert.equal(local.status, 200);
  assert.equal(local.closed, false, 'ループバックのトンネルは 150ms の無通信で切れない');
  const echoed = await new Promise<string>(done => { local.socket.once('data', chunk => done(chunk.toString())); local.socket.write('ping'); });
  assert.equal(echoed, 'ping');
  local.socket.destroy();
  const remote = await tunnel(r.proxy.port, 'example.net:443', '', 'pw', 600);
  assert.equal(remote.status, 200);
  assert.equal(remote.closed, true, '公開のトンネルは無通信で切れる');
});

// ---------------------------------------------------------------- 横取り（偽の BrowserContext / Route / Frame）

interface FFrame { url: () => string; parentFrame: () => FFrame | null; page: () => FPage }
interface FPage { on: () => void; url: () => string; opener: () => Promise<FPage | null>; mainFrame: () => FFrame }

function fakePage(url: string, opener: FPage | null = null): FPage {
  const page: FPage = { on: () => {}, url: () => url, opener: async () => opener, mainFrame: () => frame };
  const frame: FFrame = { url: () => url, parentFrame: () => null, page: () => page };
  return page;
}
const childFrame = (parent: FFrame, url: string): FFrame => ({ url: () => url, parentFrame: () => parent, page: () => parent.page() });

async function routeRig(allowed: ((url: string) => boolean) | undefined) {
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = { on: () => {}, route: async (_pattern: string, fn: (route: Route) => Promise<void>) => { handler = fn; }, pages: () => [] as Page[] } as unknown as BrowserContext;
  const browser = new PlaywrightBrowser(context, () => [], allowed);
  await browser.install();
  const fire = async (frame: FFrame, url: string, over: { navigation?: boolean; redirectedFrom?: string } = {}): Promise<string> => {
    let result = '';
    const request = {
      url: () => url, isNavigationRequest: () => over.navigation !== false, frame: () => frame,
      redirectedFrom: () => (over.redirectedFrom === undefined ? null : { url: () => over.redirectedFrom }),
    };
    await handler!({ request: () => request, continue: async () => { result = 'continue'; }, abort: async () => { result = 'abort'; } } as unknown as Route);
    return result;
  };
  return { browser, fire };
}

test('T4c: 横取りは公開のページから来たループバックへの要求を断る（fetch・img・リンク・リダイレクト・空の窓・空の iframe）。遷移なら理由 loopback', async () => {
  const r = await routeRig(url => allowedLoopbackUrl(url, new Set([4777])));
  // http の公開のページ（https のページからの http への遷移は、先に downgrade で断る）
  const pub = fakePage('http://pub.example/');
  const wrapper = r.browser.wrap(pub as unknown as Page);
  assert.equal(await r.fire(pub.mainFrame(), `${DEV}/api`, { navigation: false }), 'abort', 'fetch');
  assert.equal(await r.fire(pub.mainFrame(), `${DEV}/a.png`, { navigation: false }), 'abort', 'img');
  assert.equal(await r.fire(pub.mainFrame(), `${DEV}/`), 'abort', 'link');
  assert.equal(wrapper.lastRefusal(), 'loopback');
  const fresh = fakePage('about:blank');
  const freshWrapper = r.browser.wrap(fresh as unknown as Page);
  freshWrapper.entry = 'https://pub.example/go';
  assert.equal(await r.fire(fresh.mainFrame(), `${DEV}/`, { redirectedFrom: 'https://pub.example/go' }), 'abort', 'redirect');
  assert.equal(freshWrapper.lastRefusal(), 'loopback');
  const popup = fakePage('about:blank', pub);
  r.browser.wrap(popup as unknown as Page);
  assert.equal(await r.fire(popup.mainFrame(), `${DEV}/`), 'abort', '公開のページが開いた空の窓');
  assert.equal(await r.fire(childFrame(pub.mainFrame(), 'about:blank'), `${DEV}/frame`), 'abort', '公開の親の中の空の iframe');
  assert.equal(await r.fire(childFrame(pub.mainFrame(), 'about:srcdoc'), `${DEV}/x`, { navigation: false }), 'abort', '空の iframe の中の fetch');
});

test('T4c: 入口の URL（goto の最中）と、開発サーバーのページの中の移動・fetch・WebSocket は通す。断るポートはページの中からも断る', async () => {
  const r = await routeRig(url => allowedLoopbackUrl(url, new Set([4777])));
  const blank = fakePage('about:blank');
  const wrapper = r.browser.wrap(blank as unknown as Page);
  wrapper.entry = `${DEV}/`;
  assert.equal(await r.fire(blank.mainFrame(), `${DEV}/`), 'continue', '入口');
  const dev = fakePage(`${DEV}/`);
  r.browser.wrap(dev as unknown as Page);
  assert.equal(await r.fire(dev.mainFrame(), `${DEV}/about`), 'continue');
  assert.equal(await r.fire(dev.mainFrame(), `${DEV}/@vite/client`, { navigation: false }), 'continue');
  assert.equal(await r.fire(dev.mainFrame(), 'ws://localhost:5173/', { navigation: false }), 'continue');
  assert.equal(await r.fire(dev.mainFrame(), `${DEV}/b`, { redirectedFrom: `${DEV}/a` }), 'continue', 'ループバックの中のリダイレクト');
  assert.equal(await r.fire(childFrame(dev.mainFrame(), 'about:blank'), `${DEV}/frame`), 'continue', '開発サーバーの中の空の iframe');
  assert.equal(await r.fire(dev.mainFrame(), 'http://localhost:4777/api/settings', { navigation: false }), 'abort', '断るポート');
  // 許しの無い文脈（持ち主のプロファイル・製品の無い実行）は、ループバックを全部断る
  const none = await routeRig(undefined);
  const page = fakePage(`${DEV}/`);
  none.browser.wrap(page as unknown as Page);
  assert.equal(await none.fire(page.mainFrame(), `${DEV}/x`, { navigation: false }), 'abort');
});

// ---------------------------------------------------------------- 道具（偽の driver）

interface ToolRig {
  driver: FakeBrowserDriver;
  session: BrowserSession;
  config: AppConfig;
  ctx(over?: Partial<ToolContext>): ToolContext;
}

const PRODUCT = { project: { id: 'p1', root: 'C:\\work\\shop' } };

function toolRig(t: TestContext, change: (config: AppConfig) => void = () => undefined, deps: Partial<BrowserSessionDeps> = {}): ToolRig {
  const config = testConfig();
  config.tools.browser.enabled = true;
  change(config);
  const driver = new FakeBrowserDriver();
  const session = new BrowserSession({ driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' }, ...deps });
  t.after(() => session.close());
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, workspace: 'C:\\work',
    taint: { tainted: false, sources: [] }, log: () => undefined, services: { browser: session }, model: { id: 'm', vision: true }, ...over,
  } as unknown as ToolContext);
  return { driver, session, config, ctx };
}

test('道具の一覧: 8 つとも会話・タスク・子の担当（押す・入れるは 9-1b から）。振り返りと考える実行には browser_* が無い（T9 の一覧の壁）', () => {
  const tools = builtinTools();
  const browserNames = (kind: string) => tools.filter(tool => tool.name.startsWith('browser_') && (tool.allowedIn as readonly string[]).includes(kind)).map(tool => tool.name).sort();
  assert.deepEqual(browserNames('chat'), ['browser_act', 'browser_click', 'browser_close', 'browser_find', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_type']);
  assert.deepEqual(browserNames('task'), ['browser_act', 'browser_click', 'browser_close', 'browser_find', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_type']);
  assert.deepEqual(browserNames('agent'), ['browser_act', 'browser_click', 'browser_close', 'browser_find', 'browser_open', 'browser_read', 'browser_screenshot', 'browser_type']);
  assert.deepEqual(browserNames('review'), []);
  assert.deepEqual([...SCOUT_TOOLS].filter(name => name.startsWith('browser_')), []);
});

test('T9: 考える実行・振り返りの文脈では、6 つの道具とも事前の判定と実行の頭で断る（grantOf の壁）。ブラウザは起動しない', async t => {
  const r = toolRig(t);
  const inputs: Array<[ToolDef, unknown]> = [[browserOpen, { url: 'https://example.com/' }], [browserRead, {}], [browserScreenshot, {}], [browserClose, {}], [browserClick, { ref: 'e1' }], [browserType, { ref: 'e1', text: 'a' }]];
  for (const over of [{ scout: true as const }, { kind: 'review' as const }]) {
    for (const [tool, input] of inputs) {
      const check = await tool.preCheck!(input as never, r.ctx(over));
      assert.equal(check.decision, 'deny', `${tool.name} ${JSON.stringify(over)}`);
      const out = await tool.execute(input as never, r.ctx(over));
      assert.equal(out.isError, true, tool.name);
      assert.equal(out.content, guardText('en', 'browser.no_grant'), tool.name);
    }
  }
  assert.equal(r.driver.launches + r.driver.workLaunches, 0);
});

test('T1: 製品の会話でも browser_open http://localhost:<beat のポート> と 4777 は事前の判定でも実行でも断る（ブラウザを起動しない）', async t => {
  const r = toolRig(t, c => { c.server.port = 4898; });
  for (const url of ['http://localhost:4898/', 'http://127.0.0.1:4898/api/settings', 'http://[::1]:4898/', 'http://localhost:4777/', 'http://127.1:4777/']) {
    const check = await browserOpen.preCheck!({ url }, r.ctx(PRODUCT));
    assert.equal(check.decision, 'deny', url);
    assert.match(check.reasons[0]!, /belongs to beat itself/u, url);
    const out = await browserOpen.execute({ url }, r.ctx(PRODUCT));
    assert.equal(out.isError, true, url);
  }
  assert.equal(r.driver.launches + r.driver.workLaunches, 0);
});

test('T3(1): 製品に属さない会話と製品の無いタスクの browser_open http://localhost:<port> は断る（ブラウザを起動しない）', async t => {
  const r = toolRig(t);
  for (const over of [{}, { kind: 'task' as const }, { kind: 'agent' as const }]) {
    const check = await browserOpen.preCheck!({ url: `${DEV}/` }, r.ctx(over));
    assert.equal(check.decision, 'deny', JSON.stringify(over));
    assert.match(check.reasons[0]!, /belongs to a product/u);
    const out = await browserOpen.execute({ url: `${DEV}/` }, r.ctx(over));
    assert.equal(out.isError, true);
  }
  assert.equal(r.driver.launches + r.driver.workLaunches, 0);
});

test('T3(2): 製品の会話の持ち主のタブ（公開のページ）がループバックへ移ると断り、タブを閉じる', async t => {
  const r = toolRig(t);
  r.driver.site('https://example.com/go', { title: 'go', text: 'x', finalUrl: `${DEV}/` });
  const out = await browserOpen.execute({ url: 'https://example.com/go' }, r.ctx(PRODUCT));
  assert.equal(out.isError, true);
  assert.equal(out.content, guardText('en', 'browser.blocked_loopback'));
  assert.equal(r.driver.launches, 1, '持ち主のブラウザで開いた');
  assert.equal(r.session.tabCount('c1'), 0);
});

test('T3(3): 偽の driver で、持ち主の中継・土台の中継・製品の無い文脈の中継に loopback が無く、製品の文脈の中継と文脈の選択だけが持つ', async t => {
  const made: EgressProxyOptions[] = [];
  const r = toolRig(t, () => undefined, { startProxy: options => { made.push(options); return startEgressProxy(options); } });
  r.driver.site('https://example.com/', { title: 'x', text: 'x' }).site(`${DEV}/`, { title: 'dev', text: 'dev' });
  await browserOpen.execute({ url: 'https://example.com/' }, r.ctx(PRODUCT));
  assert.equal(made.length, 1);
  assert.equal(made[0]!.loopback, undefined, '持ち主の中継');
  await browserOpen.execute({ url: 'https://example.com/' }, r.ctx({ kind: 'task', conversationId: 'c2' }));
  assert.equal(made.length, 3);
  assert.equal(made[1]!.loopback, undefined, '土台の中継');
  assert.equal(made[2]!.loopback, undefined, '製品の無いタスクの文脈の中継');
  assert.equal(r.driver.context!.contextOptions!.loopback, undefined);
  const opened = await browserOpen.execute({ url: `${DEV}/` }, r.ctx(PRODUCT));
  assert.equal(opened.isError, undefined, opened.content);
  assert.equal(made.length, 4);
  assert.ok(made[3]!.loopback, '製品の文脈の中継');
  assert.equal(typeof r.driver.context!.contextOptions!.loopback, 'function');
});

test('T17: タスクと会話の子の browser_open https://<公開>/ は作業用の文脈で開き、持ち主のブラウザを 1 回も起動しない', async t => {
  const r = toolRig(t);
  r.driver.site('https://example.com/', { title: 'x', text: 'hello' });
  for (const over of [{ kind: 'task' as const, conversationId: 't1' }, { kind: 'agent' as const, conversationId: 'a1' }, { kind: 'task' as const, conversationId: 't2', ...PRODUCT }]) {
    const out = await browserOpen.execute({ url: 'https://example.com/' }, r.ctx(over));
    assert.equal(out.isError, undefined, out.content);
    assert.ok(out.content.includes('hello'));
  }
  assert.equal(r.driver.launches, 0, '持ち主のブラウザは起動しない');
  assert.equal(r.driver.workLaunches, 1);
  assert.equal(r.driver.work!.contexts.length, 3, '会話ごとの文脈');
});

test('文脈の選び方: 持ち主が見ている会話の公開の URL → 持ち主のブラウザ、同じ会話のループバック → 作業用。tab の種類違いは断り、そのタブは閉じない', async t => {
  const r = toolRig(t);
  r.driver.site('https://example.com/', { title: 'pub', text: 'pub' }).site(`${DEV}/`, { title: 'dev', text: 'dev' });
  const pub = await browserOpen.execute({ url: 'https://example.com/' }, r.ctx(PRODUCT));
  assert.match(pub.content, /Tab t1/u);
  assert.equal(r.driver.launches, 1);
  assert.equal(r.driver.workLaunches, 0);
  const dev = await browserOpen.execute({ url: `${DEV}/` }, r.ctx(PRODUCT));
  assert.equal(dev.isError, undefined, dev.content);
  assert.equal(r.driver.workLaunches, 1);
  assert.deepEqual(r.driver.context!.pageList[0]!.gotos, [`${DEV}/`]);
  // 持ち主のタブ t1 でループバックを開こうとする / 作業用のタブ t2 で公開のページを開こうとする
  const wrong1 = await browserOpen.preCheck!({ url: `${DEV}/`, tab: 't1' }, r.ctx(PRODUCT));
  assert.equal(wrong1.decision, 'deny');
  assert.equal(wrong1.reasons[0], guardText('en', 'browser.tab_kind', { tab: 't1' }));
  const wrong2 = await browserOpen.execute({ url: 'https://example.com/', tab: 't2' }, r.ctx(PRODUCT));
  assert.equal(wrong2.isError, true);
  assert.equal(wrong2.content, guardText('en', 'browser.tab_kind', { tab: 't2' }));
  assert.equal(r.session.tabCount('c1'), 2, '種類違いで断ったタブは閉じない');
});

test('T10: 別の会話のタブの ID を渡すと no_tab。会話ごとに別の文脈・別の中継。会話 B の呼び出しの間に文脈 A のページが開いた窓は B のタブにならず閉じる', async t => {
  const r = toolRig(t);
  r.driver.site(`${DEV}/`, { title: 'dev', text: 'dev' });
  await browserOpen.execute({ url: `${DEV}/` }, r.ctx({ ...PRODUCT, kind: 'task', conversationId: 'A' }));
  const other = await browserRead.execute({ tab: 't1' }, r.ctx({ ...PRODUCT, kind: 'task', conversationId: 'B' }));
  assert.equal(other.isError, true);
  assert.equal(other.noRemoteContent, true);
  assert.match(other.content, /t1/u);
  await browserOpen.execute({ url: `${DEV}/` }, r.ctx({ ...PRODUCT, kind: 'task', conversationId: 'B' }));
  const [contextA, contextB] = r.driver.work!.contexts as [FakeBrowser, FakeBrowser];
  assert.notEqual(contextA, contextB);
  assert.notEqual(contextA.contextOptions!.proxy.server, contextB.contextOptions!.proxy.server, '中継も別');
  // 会話 B の呼び出しの間に、文脈 A のページが窓を開く
  const grantB: BrowserGrant = { conversationId: 'B', runId: 'r1', attended: false, loopback: true, productId: 'p1' };
  const result = await r.session.run({ grant: grantB, signal: new AbortController().signal }, api => api.withPopups(async () => { contextA.popup(); return 'x'; }));
  assert.deepEqual(result.opened, []);
  assert.equal(r.session.tabCount('B'), 1);
  assert.equal(r.session.tabCount('A'), 1);
  assert.equal(contextA.pageList.length, 1, '文脈 A の窓は閉じた');
  // 同じ会話の文脈の窓は、その会話のタブになる
  const own = await r.session.run({ grant: grantB, signal: new AbortController().signal }, api => api.withPopups(async () => { contextB.popup(); return 'y'; }));
  assert.equal(own.opened.length, 1);
  assert.equal(own.opened[0]!.kind, 'work');
});

// ---------------------------------------------------------------- session（偽の driver・偽の時計）

interface SessionRig {
  session: BrowserSession;
  driver: FakeBrowserDriver;
  config: AppConfig;
  advance(ms: number): void;
  proxies: Array<{ options: EgressProxyOptions; proxy: EgressProxy }>;
  connected: Array<[string, number]>;
}

// 中継の公開の宛先はつながらない（ポート 1）。ループバックの宛先は 127.0.0.1 の同じポートへ本当につなぐ
function sessionRig(t: TestContext, change: (config: AppConfig) => void = () => undefined, refuseProxy: (options: EgressProxyOptions) => boolean = () => false): SessionRig {
  const config = testConfig();
  config.tools.browser.enabled = true;
  change(config);
  const driver = new FakeBrowserDriver();
  const clock = { now: 1_000_000, timers: [] as Array<{ at: number; fn: () => void; live: boolean }> };
  const proxies: SessionRig['proxies'] = [];
  const connected: SessionRig['connected'] = [];
  const session = new BrowserSession({
    driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' },
    now: () => clock.now,
    schedule: (fn, ms) => { const timer = { at: clock.now + ms, fn, live: true }; clock.timers.push(timer); return () => { timer.live = false; }; },
    canShowWindow: () => true,
    startProxy: async options => {
      if (refuseProxy(options)) throw new Error('proxy failed');
      const proxy = await startEgressProxy({ ...options, resolve: async () => [PUBLIC], connect: (address, port) => { connected.push([address, port]); return connect(address === PUBLIC ? 1 : port, '127.0.0.1'); } });
      proxies.push({ options, proxy });
      return proxy;
    },
  });
  t.after(() => session.close());
  const advance = (ms: number) => {
    clock.now += ms;
    for (const timer of clock.timers.filter(x => x.live && x.at <= clock.now)) { timer.live = false; timer.fn(); }
  };
  return { session, driver, config, advance, proxies, connected };
}

const grantOfTest = (conversationId = 'c1', over: Partial<BrowserGrant> = {}): BrowserGrant => ({ conversationId, runId: 'r1', attended: true, loopback: false, ...over });
const callOf = (grant: BrowserGrant) => ({ grant, signal: new AbortController().signal });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const portOf = (server: string): number => Number(new URL(server).port);

test('許しの違う呼び出しで文脈が作り直される（loopback・productId）。古い文脈とそのタブは閉じる', async t => {
  const r = sessionRig(t);
  const product = grantOfTest('c1', { loopback: true, productId: 'p1' });
  await r.session.run(callOf(product), async api => { await api.openTab('work'); });
  const first = r.driver.context!;
  assert.equal(typeof first.contextOptions!.loopback, 'function');
  await r.session.run(callOf({ ...product, loopback: false, productId: undefined }), async api => {
    assert.deepEqual(api.tabs(), [], '古いタブは消えた');
    await api.openTab('work');
  });
  assert.equal(first.closed, true);
  const second = r.driver.context!;
  assert.notEqual(second, first);
  assert.equal(second.contextOptions!.loopback, undefined);
  await r.session.run(callOf({ ...product, productId: 'p2' }), async api => { await api.openTab('work'); });
  assert.equal(second.closed, true, '製品が違えば作り直す');
  // 許しが同じなら作り直さない
  const third = r.driver.context!;
  await r.session.run(callOf({ ...product, productId: 'p2' }), async api => { await api.openTab('work'); });
  assert.equal(r.driver.context, third);
  assert.equal(third.closed, false);
});

test('片づけ: idleCloseMinutes で文脈が閉じ、最後の文脈が閉じると作業用のブラウザも閉じる。次の呼び出しで作り直す', async t => {
  const r = sessionRig(t, c => { c.tools.browser.limits.idleCloseMinutes = 10; });
  await r.session.run(callOf(grantOfTest('c1', { attended: false })), async api => { await api.openTab('work'); });
  r.advance(5 * 60_000);
  await r.session.run(callOf(grantOfTest('c2', { attended: false })), async api => { await api.openTab('work'); });
  const work = r.driver.work!;
  const [c1, c2] = work.contexts as [FakeBrowser, FakeBrowser];
  r.advance(5 * 60_000 + 1000);
  await tick();
  assert.equal(c1.closed, true, 'c1 はアイドルで閉じた');
  assert.equal(c2.closed, false);
  assert.equal(work.closed, false, 'まだ文脈があるので作業用のブラウザは動いたまま');
  r.advance(5 * 60_000);
  await tick();
  assert.equal(c2.closed, true);
  assert.equal(work.closed, true, '最後の文脈が閉じたので作業用のブラウザも閉じた');
  assert.equal(r.session.status().running, false);
  await r.session.run(callOf(grantOfTest('c1', { attended: false })), async api => { await api.openTab('work'); });
  assert.equal(r.driver.workLaunches, 2);
  // 文脈を閉じたら、その中継も閉じた
  assert.equal(r.proxies.filter(p => p.options.loopback === undefined).length >= 3, true);
});

test('片づけ: closeConversation・closeAll・withStopped・applyConfig（無効）は 2 つのブラウザとも閉じる。openLogin は作業用を止めない', async t => {
  const r = sessionRig(t);
  const both = async (conversationId = 'c1') => {
    await r.session.run(callOf(grantOfTest(conversationId)), async api => { await api.openTab('owner'); });
    await r.session.run(callOf(grantOfTest(conversationId, { loopback: true })), async api => { await api.openTab('work'); });
    return { owner: r.driver.current!, work: r.driver.work!, context: r.driver.context! };
  };
  let opened = await both();
  await r.session.closeConversation(['c1']);
  assert.equal(opened.context.closed, true);
  assert.equal(opened.work.closed, true, '最後の文脈なので作業用のブラウザも閉じる');
  assert.equal(r.session.tabCount('c1'), 0);
  assert.equal(opened.owner.pageList.length, 0, 'c1 の持ち主のタブも閉じた');

  opened = await both();
  await r.session.closeAll();
  assert.equal(opened.owner.closed && opened.work.closed, true, 'closeAll');
  opened = await both();
  await r.session.withStopped(async () => undefined);
  assert.equal(opened.owner.closed && opened.work.closed, true, 'withStopped');
  opened = await both();
  r.config.tools.browser.enabled = false;
  await r.session.applyConfig(r.config);
  assert.equal(opened.owner.closed && opened.work.closed, true, 'applyConfig');
  r.config.tools.browser.enabled = true;

  opened = await both();
  await r.session.openLogin();
  assert.equal(opened.owner.closed, true, 'ログイン用の窓のために持ち主のブラウザは止める');
  assert.equal(opened.work.closed, false, '作業用は動いたまま');
  assert.equal(opened.context.closed, false);
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { assert.equal(api.tabs().length, 1); await api.openTab('work'); });
  await assert.rejects(r.session.run(callOf(grantOfTest('c1')), async api => { await api.openTab('owner'); }), (e: unknown) => e instanceof BrowserFailure && e.code === 'login_open');
});

test('タブの数: 会話ごとに maxTabs（持ち主のタブと作業用のタブを合わせて）、全体で 16。ページの窓も同じ上限で閉じる', async t => {
  const r = sessionRig(t, c => { c.tools.browser.limits.maxTabs = 8; });
  for (const id of ['c1', 'c2']) {
    await r.session.run(callOf(grantOfTest(id, { loopback: true })), async api => {
      await api.openTab('owner');
      for (let i = 0; i < 7; i++) await api.openTab('work');
      await assert.rejects(api.openTab('work'), (e: unknown) => e instanceof BrowserFailure && e.code === 'tab_limit' && /8/u.test(e.text('en')));
    });
  }
  assert.equal(r.session.status().tabs, MAX_TABS_TOTAL);
  await assert.rejects(r.session.run(callOf(grantOfTest('c3', { attended: false })), async api => { await api.openTab('work'); }),
    (e: unknown) => e instanceof BrowserFailure && e.code === 'tab_limit' && e.text('en') === guardText('en', 'browser.tab_limit_total', { max: MAX_TABS_TOTAL }));
  // c1 のタブを 1 つ閉じてから c3 が 1 つ開くと、全体は 16。c1 の窓は会話ごとの上限の手前でも全体の上限で閉じる
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.closeTab(api.tabs()[0]!.id); });
  await r.session.run(callOf(grantOfTest('c3', { attended: false })), async api => { await api.openTab('work'); });
  const popped = await r.session.run(callOf(grantOfTest('c1', { loopback: true })), api => api.withPopups(async () => {
    const context = r.driver.work!.contexts.find(c => c.contextOptions && typeof c.contextOptions.loopback === 'function' && !c.closed)!;
    context.popup();
    return 'x';
  }));
  assert.deepEqual([popped.opened.length, popped.closed], [0, 1]);
});

test('人のいない呼び出しは持ち主のタブを見ない・開けない（tab_kind）。持ち主のアイドルを数え直さない', async t => {
  const r = sessionRig(t);
  await r.session.run(callOf(grantOfTest('c1')), async api => { await api.openTab('owner'); });
  await r.session.run(callOf(grantOfTest('c1', { attended: false })), async api => {
    assert.deepEqual(api.tabs(), []);
    assert.throws(() => api.tab('t1'), (e: unknown) => e instanceof BrowserFailure && e.code === 'no_tab');
    await assert.rejects(api.openTab('owner'), (e: unknown) => e instanceof BrowserFailure && e.code === 'blocked');
  });
  assert.equal(r.driver.launches, 1);
});

test('proxyDelta は、持ち主の中継とその会話の文脈の中継の、断った数を足す', async t => {
  const r = sessionRig(t);
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => {
    await api.openTab('owner');
    await api.openTab('work');
    const owner = r.proxies.find(p => p.proxy.port === portOf(r.driver.current!.options.proxy.server))!;
    const context = r.proxies.find(p => p.proxy.port === portOf(r.driver.context!.contextOptions!.proxy.server))!;
    assert.equal(status(await raw(owner.proxy.port, `CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: x\r\n${auth(owner.options.password)}\r\n`)), 403);
    assert.equal(status(await raw(context.proxy.port, `CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: x\r\n${auth(context.options.password)}\r\n`)), 403);
    assert.equal(status(await raw(context.proxy.port, `CONNECT 127.0.0.1:4777 HTTP/1.1\r\nHost: x\r\n${auth(context.options.password)}\r\n`)), 403);
    assert.deepEqual(api.proxyDelta(), { blocked: 3, busy: 0 });
  });
  assert.equal(r.session.status().running, true);
  assert.deepEqual(Object.keys(r.session.status()).sort(), ['canShowWindow', 'enabled', 'loginOpen', 'pausedMinutes', 'running', 'tabs']);
});

test('T2: 持ち主の中継・土台の中継・文脈の中継のどれも server.origins のホストを 403（名前を引かない）', async t => {
  const r = sessionRig(t, c => { c.server.origins = ['https://beat.tail1234.ts.net']; });
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('owner'); await api.openTab('work'); });
  assert.equal(r.proxies.length, 3);
  for (const { options, proxy } of r.proxies) {
    assert.equal(status(await raw(proxy.port, `CONNECT beat.tail1234.ts.net:443 HTTP/1.1\r\nHost: x\r\n${auth(options.password)}\r\n`)), 403);
    assert.equal(status(await raw(proxy.port, `GET http://beat.tail1234.ts.net/ HTTP/1.1\r\nHost: beat.tail1234.ts.net\r\n${auth(options.password)}\r\n`)), 403);
  }
  assert.deepEqual(r.connected, []);
});

test('T7: 文脈の中継は、自分・持ち主の中継・別の文脈の中継・提供元・MCP の http のループバックのポートを 403', async t => {
  const r = sessionRig(t, c => {
    c.providers = [{ id: 'a', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8081/v1', maxParallel: 1, timeoutMs: 600_000 }, { id: 'b', kind: 'openai_compatible', baseUrl: 'http://localhost/v1', maxParallel: 1, timeoutMs: 600_000 }];
    c.mcp.servers = [{ id: 'm1', transport: 'http', enabled: true, tools: {}, env: {}, headers: {}, url: 'http://127.0.0.1:9123/mcp' }];
  });
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('owner'); await api.openTab('work'); });
  await r.session.run(callOf(grantOfTest('c2', { loopback: true })), async api => { await api.openTab('work'); });
  const [c1, c2] = r.driver.work!.contexts as [FakeBrowser, FakeBrowser];
  const p1 = r.proxies.find(p => p.proxy.port === portOf(c1.contextOptions!.proxy.server))!;
  const ports = [p1.proxy.port, portOf(r.driver.current!.options.proxy.server), portOf(c2.contextOptions!.proxy.server), portOf(r.driver.work!.options.proxy.server), 8081, 80, 9123];
  for (const port of ports) {
    assert.equal(status(await raw(p1.proxy.port, `GET http://127.0.0.1:${port}/ HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: none\r\n${auth(p1.options.password)}\r\n`)), 403, String(port));
  }
  assert.equal(status(await raw(p1.proxy.port, `GET http://localhost/ HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: none\r\n${auth(p1.options.password)}\r\n`)), 403, 'ポートの無い localhost は 80');
  assert.deepEqual(r.connected, []);
});

test('T18: 文脈を開いたまま server.port・提供元の baseUrl・server.origins を変えると、次の要求から新しいポート・ホストが 403', async t => {
  const hits: Hit[] = [];
  const port = await sink(t, hits);
  const providerPort = await sink(t, hits);
  const r = sessionRig(t);
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); });
  const context = r.proxies.find(p => p.proxy.port === portOf(r.driver.context!.contextOptions!.proxy.server))!;
  const ask = (target: number) => raw(context.proxy.port, `GET http://127.0.0.1:${target}/ HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: none\r\n${auth(context.options.password)}\r\n`);
  assert.equal(status(await ask(providerPort)), 200, '変える前は開発サーバーとして届く');
  hits.length = 0;
  r.connected.length = 0;
  r.config.server.port = port;
  assert.equal(status(await ask(port)), 403, 'server.port');
  r.config.providers = [...r.config.providers, { id: 'z', kind: 'openai_compatible', baseUrl: `http://localhost:${providerPort}/v1`, maxParallel: 1, timeoutMs: 600_000 }];
  assert.equal(status(await ask(providerPort)), 403, 'baseUrl');
  assert.deepEqual(hits, []);
  r.config.server.origins = ['https://new.tail1234.ts.net'];
  assert.equal(status(await raw(context.proxy.port, `CONNECT new.tail1234.ts.net:443 HTTP/1.1\r\nHost: x\r\n${auth(context.options.password)}\r\n`)), 403, 'origins');
  assert.deepEqual(r.connected, []);
});

test('T1（動いているポート）: server.port を保存しただけで反映していないあいだも、起動したときの beat のポートは 403（受け口に届かない）', async t => {
  const hits: Hit[] = [];
  const running = await sink(t, hits);
  const r = sessionRig(t, c => { c.server.port = running; });
  r.config.server.port = 4898;
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); });
  const context = r.proxies.find(p => p.proxy.port === portOf(r.driver.context!.contextOptions!.proxy.server))!;
  assert.equal(status(await raw(context.proxy.port, `GET http://127.0.0.1:${running}/api/conversations HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: none\r\n${auth(context.options.password)}\r\n`)), 403);
  assert.equal(r.session.loopbackDenied().has(running), true);
  assert.equal(r.session.loopbackDenied().has(4898), true, '保存した新しいポートも断る');
  assert.deepEqual(hits, []);
  assert.deepEqual(r.connected, []);
});

test('T1（動いているポート）: 呼び出しのあいだに保存して反映したポート（その次の保存の反映が失敗して動いたまま）も 403', async t => {
  const hits: Hit[] = [];
  const boot = await sink(t, hits);
  const running = await sink(t, hits);
  const r = sessionRig(t, c => { c.server.port = boot; });
  r.config.server.port = running;
  await r.session.applyConfig(r.config);
  r.config.server.port = 4898;
  await r.session.applyConfig(r.config);
  assert.equal(r.session.loopbackDenied().has(running), true);
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); });
  const context = r.proxies.find(p => p.proxy.port === portOf(r.driver.context!.contextOptions!.proxy.server))!;
  assert.equal(status(await raw(context.proxy.port, `GET http://127.0.0.1:${running}/api/conversations HTTP/1.1\r\nHost: x\r\nSec-Fetch-Site: none\r\n${auth(context.options.password)}\r\n`)), 403);
  assert.deepEqual(hits, []);
  assert.deepEqual(r.connected, []);
});

test('片づけ: 文脈の中継・文脈づくりが失敗し、文脈が 1 つも無ければ、作業用のブラウザと土台の中継を閉じる（次の呼び出しで起動し直す）', async t => {
  let refuse = true;
  const r = sessionRig(t, () => undefined, options => refuse && options.loopback !== undefined);
  await assert.rejects(r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); }), (e: unknown) => e instanceof BrowserFailure && e.code === 'launch_failed');
  assert.equal(r.driver.workLaunches, 1);
  assert.equal(r.driver.work!.closed, true, '中継の失敗: 作業用のブラウザを閉じた');
  assert.equal(r.proxies.length, 1);
  assert.equal(await raw(r.proxies[0]!.proxy.port, get('example.com')), '', '中継の失敗: 土台の中継も閉じた');
  assert.equal(r.session.status().running, false);

  refuse = false;
  r.driver.contextFailures.push(new Error('newContext failed'));
  await assert.rejects(r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); }), (e: unknown) => e instanceof BrowserFailure && e.code === 'launch_failed');
  assert.equal(r.driver.workLaunches, 2);
  assert.equal(r.driver.work!.closed, true, '文脈づくりの失敗: 作業用のブラウザを閉じた');
  for (const { proxy } of r.proxies.slice(1)) assert.equal(await raw(proxy.port, get('example.com')), '', '文脈づくりの失敗: 土台と文脈の中継を閉じた');
  assert.equal(r.session.status().running, false);

  // 別の文脈が動いているときは、作業用のブラウザを閉じない
  await r.session.run(callOf(grantOfTest('c1', { loopback: true })), async api => { await api.openTab('work'); });
  r.driver.contextFailures.push(new Error('newContext failed'));
  await assert.rejects(r.session.run(callOf(grantOfTest('c2', { loopback: true })), async api => { await api.openTab('work'); }));
  assert.equal(r.driver.work!.closed, false);
  assert.equal(r.driver.context!.closed, false);
});
