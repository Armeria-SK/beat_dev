import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from '../src/tools/browser/egress-proxy.ts';

// T-02: ブラウザの外向きの通信の中継。名前の解決・つなぎは偽物に差し替えて、実際のネットワークには出ない

const PUBLIC = '93.184.216.34';
const AUTH = `Proxy-Authorization: Basic ${Buffer.from('beat:pw').toString('base64')}\r\n`;

interface Rig {
  proxy: EgressProxy;
  logs: string[];
  resolved: string[];
  connected: Array<[string, number]>;
  table: Record<string, string[]>;
  upstreamPort: number;
  seen: Array<{ url: string; headers: IncomingHttpHeaders }>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

// 上流は 127.0.0.1 の 1 つの待ち受け（受けた HTTP 要求を記録し、CONNECT のあとの生のバイトはそのまま返す）
async function rig(t: TestContext, extra: Partial<EgressProxyOptions> = {}): Promise<Rig> {
  const seen: Rig['seen'] = [];
  const upstream = createHttpServer((req, res) => { seen.push({ url: req.url ?? '', headers: req.headers }); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello from upstream'); });
  // http の上流（80 番へのつなぎ先）と、CONNECT のあとの生のバイトを返す echo（443 番へのつなぎ先）は別のサーバー
  const echo = createServer(socket => { socket.on('data', chunk => socket.write(chunk)); socket.on('error', () => {}); });
  const upstreamPort = await listen(upstream);
  const echoPort = await listen(echo);
  const logs: string[] = [];
  const resolved: string[] = [];
  const connected: Array<[string, number]> = [];
  const table: Record<string, string[]> = {};
  const proxy = await startEgressProxy({
    username: 'beat', password: 'pw', log: line => logs.push(line),
    resolve: async host => { resolved.push(host); return table[host] ?? [PUBLIC]; },
    connect: (address, port) => { connected.push([address, port]); return connect(port === 80 ? upstreamPort : echoPort, '127.0.0.1'); },
    ...extra,
  });
  t.after(async () => { await proxy.close(); upstream.close(); upstream.closeAllConnections(); echo.close(); });
  return { proxy, logs, resolved, connected, table, upstreamPort, seen };
}

// 生の要求を送り、応答（切れるまで、または少し待って）を文字で返す
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
const status = (response: string): number => Number(/^HTTP\/1\.\d (\d{3})/u.exec(response)?.[1] ?? 0);
const CONNECT = (target: string, auth = AUTH): string => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`;

test('待ち受けは 127.0.0.1 だけ（T-02）', async t => {
  const r = await rig(t);
  assert.equal(r.proxy.host, '127.0.0.1');
  assert.ok(r.proxy.port > 0);
  assert.equal(status(await raw(r.proxy.port, CONNECT(`${PUBLIC}:443`))), 200);
});

test('合言葉が無い・違う要求は 407 で、解決もつなぎもしない', async t => {
  const r = await rig(t);
  const bad = [
    '', `Proxy-Authorization: Basic ${Buffer.from('beat:wrong').toString('base64')}\r\n`,
    `Proxy-Authorization: Basic ${Buffer.from('other:pw').toString('base64')}\r\n`,
    `Proxy-Authorization: Basic ${Buffer.from('beat:pw-longer').toString('base64')}\r\n`,
    `Proxy-Authorization: Basic ${Buffer.from('c').toString('base64')}\r\n`,
    'Proxy-Authorization: Bearer pw\r\n', 'Proxy-Authorization: Basic\r\n', 'Proxy-Authorization: Basic !!!\r\n',
  ];
  for (const auth of bad) {
    const connectResponse = await raw(r.proxy.port, CONNECT('example.net:443', auth));
    assert.equal(status(connectResponse), 407, JSON.stringify(auth));
    assert.match(connectResponse, /Proxy-Authenticate/iu);
    assert.equal(status(await raw(r.proxy.port, `GET http://example.net/ HTTP/1.1\r\nHost: example.net\r\n${auth}\r\n`)), 407, JSON.stringify(auth));
  }
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.connected, []);
  assert.equal(r.proxy.stats().blocked, 0, '合言葉違いは「断った（403）」には数えない');
});

test('CONNECT と絶対形の GET http:// 以外は 400', async t => {
  const r = await rig(t);
  const cases = [
    `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n${AUTH}\r\n`,
    `GET /path HTTP/1.1\r\nHost: example.net\r\n${AUTH}\r\n`,
    `GET https://example.net/ HTTP/1.1\r\nHost: example.net\r\n${AUTH}\r\n`,
    `POST http://example.net/ HTTP/1.1\r\nHost: example.net\r\nContent-Length: 0\r\n${AUTH}\r\n`,
    `PUT http://example.net/ HTTP/1.1\r\nHost: example.net\r\nContent-Length: 0\r\n${AUTH}\r\n`,
    `OPTIONS * HTTP/1.1\r\nHost: example.net\r\n${AUTH}\r\n`,
    `GET ftp://example.net/ HTTP/1.1\r\nHost: example.net\r\n${AUTH}\r\n`,
    `GET http:// HTTP/1.1\r\nHost: x\r\n${AUTH}\r\n`,
    CONNECT('example.net'),
    CONNECT('example.net:abc'),
    CONNECT('example.net:443/path'),
    CONNECT(':443'),
  ];
  for (const text of cases) assert.equal(status(await raw(r.proxy.port, text)), 400, JSON.stringify(text.split('\r\n')[0]));
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.connected, []);
});

test('ポートは 80 / 443 だけ。ほかは 403 で、解決もつなぎもしない', async t => {
  const r = await rig(t);
  for (const port of [22, 25, 53, 8080, 8443, 3000, 1, 65535, 0, 99999]) {
    assert.equal(status(await raw(r.proxy.port, CONNECT(`example.net:${port}`))), 403, `CONNECT :${port}`);
  }
  assert.equal(status(await raw(r.proxy.port, `GET http://example.net:8080/ HTTP/1.1\r\nHost: example.net:8080\r\n${AUTH}\r\n`)), 403);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.connected, []);
  assert.ok(r.logs.every(line => /^\[browser\] blocked example\.net:\d+ port$/u.test(line)), r.logs.join('\n'));
  assert.equal(r.proxy.stats().blocked, 11);
});

test('IP の直書きは公開 IPv4 だけ（私的・ループバック・リンクローカル・メタデータ・IPv6 は断る）', async t => {
  const r = await rig(t);
  const blocked = ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '1.2.3', '1.2.3.4.5', '256.1.1.1'];
  for (const ip of blocked) assert.equal(status(await raw(r.proxy.port, CONNECT(`${ip}:443`))), 403, ip);
  for (const v6 of ['[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[2606:4700::1111]']) {
    assert.equal(status(await raw(r.proxy.port, CONNECT(`${v6}:443`))), 403, v6);
  }
  assert.deepEqual(r.resolved, [], 'IP の直書きは名前の解決をしない');
  assert.deepEqual(r.connected, []);
  assert.equal(status(await raw(r.proxy.port, CONNECT(`${PUBLIC}:443`))), 200);
  assert.deepEqual(r.connected, [[PUBLIC, 443]]);
  assert.deepEqual(r.resolved, []);
});

test('内向きの名前・ドットの無い名前は、引く前に断る', async t => {
  const r = await rig(t);
  for (const name of ['localhost', 'foo.localhost', 'printer.local', 'intranet', 'a.internal', 'x.home', 'nas.lan', 'x.test', 'x.invalid', 'x.example', 'abc.onion', '1.0.0.127.in-addr.arpa', 'localhost.']) {
    assert.equal(status(await raw(r.proxy.port, CONNECT(`${name}:443`))), 403, name);
  }
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.connected, []);
});

test('名前を引いて返った番地が 1 つでも公開 IPv4 でなければ断る（私的・混在・IPv6 だけ）', async t => {
  const r = await rig(t);
  r.table['loop.example.net'] = ['127.0.0.1'];
  r.table['lan.example.net'] = ['10.0.0.5'];
  r.table['meta.example.net'] = ['169.254.169.254'];
  r.table['mixed.example.net'] = [PUBLIC, '10.0.0.5'];
  r.table['mixed2.example.net'] = ['192.168.0.9', PUBLIC];
  r.table['v6.example.net'] = ['2606:4700::1111'];
  r.table['v6local.example.net'] = ['::1'];
  r.table['mapped.example.net'] = ['::ffff:127.0.0.1'];
  for (const name of Object.keys(r.table)) assert.equal(status(await raw(r.proxy.port, CONNECT(`${name}:443`))), 403, name);
  assert.deepEqual(r.connected, [], '断ったものへは 1 度もつながない');
  assert.equal(r.resolved.length, Object.keys(r.table).length);
  assert.equal(r.logs.length, Object.keys(r.table).length);
  assert.ok(r.logs.every(line => /^\[browser\] blocked [a-z0-9.]+\.example\.net:443 address$/u.test(line)), r.logs.join('\n'));
  assert.equal(status(await raw(r.proxy.port, `GET http://lan.example.net/ HTTP/1.1\r\nHost: lan.example.net\r\n${AUTH}\r\n`)), 403, 'http も同じ');
});

test('IPv4 と IPv6 の両方を返す名前（ふつうのサイト）は通し、つなぐのは確かめた公開 IPv4 だけ', async t => {
  const r = await rig(t);
  r.table['dual.example.net'] = ['2606:4700::1111', PUBLIC, '::1'];
  assert.equal(status(await raw(r.proxy.port, CONNECT('dual.example.net:443'))), 200);
  assert.deepEqual(r.connected, [[PUBLIC, 443]], 'IPv6 の番地へはつながない');
  r.table['dualmixed.example.net'] = ['2606:4700::1111', PUBLIC, '10.0.0.5'];
  assert.equal(status(await raw(r.proxy.port, CONNECT('dualmixed.example.net:443'))), 403, 'IPv4 に私的なものが混ざれば IPv6 があっても断る');
});

test('引けない名前・番地の無い名前は 502（断りではない）', async t => {
  const r = await rig(t, { resolve: async host => { if (host === 'none.example.net') return []; throw new Error('ENOTFOUND'); } });
  assert.equal(status(await raw(r.proxy.port, CONNECT('nx.example.net:443'))), 502);
  assert.equal(status(await raw(r.proxy.port, CONNECT('none.example.net:443'))), 502);
  assert.equal(r.proxy.stats().blocked, 0);
  assert.deepEqual(r.connected, []);
});

test('名前は 1 回だけ引き、確かめた番地へつなぐ（引き直さない = 再束縛を許さない）', async t => {
  const answers = [[PUBLIC], ['127.0.0.1']];
  let calls = 0;
  const r = await rig(t, { resolve: async () => answers[Math.min(calls++, 1)]! });
  const response = await raw(r.proxy.port, CONNECT('rebind.example.net:443'));
  assert.equal(status(response), 200);
  assert.equal(calls, 1, '解決は 1 回だけ');
  assert.deepEqual(r.connected, [[PUBLIC, 443]], '確かめた番地へつなぐ');
});

test('通すときは 200 のあとに、両方向へそのまま流す（先に送られたバイトも）', async t => {
  const r = await rig(t);
  const reply = await new Promise<string>(done => {
    const socket: Socket = connect(r.proxy.port, '127.0.0.1');
    let out = '';
    socket.on('data', chunk => {
      out += chunk.toString('latin1');
      if (out.includes('\r\n\r\n') && !out.includes('PING')) socket.write('PING-2');
      if (out.includes('PING-1') && out.includes('PING-2')) { socket.destroy(); done(out); }
    });
    socket.on('error', () => {});
    socket.write(`${CONNECT('example.net:443')}PING-1`);
    setTimeout(() => { socket.destroy(); done(out); }, 1500);
  });
  assert.equal(status(reply), 200);
  assert.match(reply, /Connection Established/u);
  assert.ok(reply.includes('PING-1') && reply.includes('PING-2'), reply);
  assert.deepEqual(r.resolved, ['example.net']);
  assert.equal(r.proxy.stats().accepted, 1);
});

test('http の GET は Host を付けて確かめた番地へ送り、Proxy-* の見出しは相手へ送らない', async t => {
  const r = await rig(t);
  const response = await raw(r.proxy.port, `GET http://example.net/path/a?q=1 HTTP/1.1\r\nHost: example.net\r\nProxy-Connection: keep-alive\r\nX-Test: 1\r\nAccept: text/html\r\n${AUTH}\r\n`, 1000);
  assert.equal(status(response), 200);
  assert.match(response, /hello from upstream/u);
  assert.doesNotMatch(response, /proxy-authorization/iu);
  assert.deepEqual(r.connected, [[PUBLIC, 80]]);
  assert.deepEqual(r.resolved, ['example.net']);
  assert.equal(r.seen.length, 1);
  const seen = r.seen[0]!;
  assert.equal(seen.url, '/path/a?q=1');
  assert.equal(seen.headers.host, 'example.net');
  assert.equal(seen.headers['x-test'], '1');
  assert.equal(seen.headers.accept, 'text/html');
  for (const name of Object.keys(seen.headers)) assert.doesNotMatch(name, /^proxy-/iu, name);
  assert.equal(JSON.stringify(seen.headers).includes('Basic'), false, '合言葉を相手へ送らない');
});

test('本文つきの GET（Content-Length > 0・Transfer-Encoding）は 400 で、解決もつなぎもしない', async t => {
  const r = await rig(t);
  const withLength = await raw(r.proxy.port, `GET http://example.net/a HTTP/1.1\r\nHost: example.net\r\nContent-Length: 5\r\n${AUTH}\r\nhello`, 600);
  assert.equal(status(withLength), 400);
  const chunked = await raw(r.proxy.port, `GET http://example.net/a HTTP/1.1\r\nHost: example.net\r\nTransfer-Encoding: chunked\r\n${AUTH}\r\n5\r\nhello\r\n0\r\n\r\n`, 600);
  assert.equal(status(chunked), 400);
  assert.deepEqual(r.resolved, []);
  assert.deepEqual(r.connected, []);
  assert.equal(r.seen.length, 0);
});

test('Content-Length: 0 の GET は通すが、content-length・transfer-encoding・expect は相手へ渡さない', async t => {
  const r = await rig(t);
  const response = await raw(r.proxy.port, `GET http://example.net/a HTTP/1.1\r\nHost: example.net\r\nContent-Length: 0\r\nExpect: 100-continue\r\n${AUTH}\r\n`, 1000);
  // 中継自身の http の部品が先に「100 Continue」を返すので、最終の応答（200）が含まれることを見る
  assert.match(response, /HTTP\/1\.1 200 /u);
  assert.equal(r.seen.length, 1);
  const names = Object.keys(r.seen[0]!.headers);
  for (const name of ['content-length', 'transfer-encoding', 'expect']) assert.equal(names.includes(name), false, name);
});

test('断りのログは「ホスト:ポート 理由」だけ（道筋・問い合わせ・合言葉を書かない）。断った数は stats に出る', async t => {
  const r = await rig(t);
  await raw(r.proxy.port, `GET http://127.0.0.1/secret/path?token=abc123 HTTP/1.1\r\nHost: 127.0.0.1\r\n${AUTH}\r\n`);
  await raw(r.proxy.port, CONNECT('10.1.2.3:443'));
  await raw(r.proxy.port, CONNECT('example.net:22'));
  assert.deepEqual(r.logs, ['[browser] blocked 127.0.0.1:80 address', '[browser] blocked 10.1.2.3:443 address', '[browser] blocked example.net:22 port']);
  const all = r.logs.join('\n');
  assert.doesNotMatch(all, /secret|token|abc123|pw|Basic/u);
  assert.equal(r.proxy.stats().blocked, 3);
});

test('無通信 60 秒（試験では短くする）で切る', async t => {
  const r = await rig(t, { idleMs: 150 });
  const started = Date.now();
  const closedAfter = await new Promise<number>(done => {
    const socket = connect(r.proxy.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.resume();
    socket.on('connect', () => socket.write(CONNECT('example.net:443')));
    socket.on('close', () => done(Date.now() - started));
    setTimeout(() => { socket.destroy(); done(-1); }, 3000);
  });
  assert.ok(closedAfter > 0 && closedAfter < 2500, `切れるまで ${closedAfter}ms`);
  await new Promise(done => setTimeout(done, 100));
  assert.equal(r.proxy.stats().active, 0, '切れたら同時数から外れる');
});

test('同時 64 本まで（試験では 2 本）。超えたら 503 で、閉じたらまた通る', async t => {
  const r = await rig(t, { maxConnections: 2 });
  const open = (): Promise<Socket> => new Promise(done => {
    const socket = connect(r.proxy.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.on('data', () => done(socket));
    socket.write(CONNECT('example.net:443'));
  });
  const a = await open();
  const b = await open();
  assert.equal(r.proxy.stats().active, 2);
  assert.equal(status(await raw(r.proxy.port, CONNECT('example.net:443'))), 503);
  assert.equal(r.proxy.stats().busy, 1);
  a.destroy();
  await new Promise(done => setTimeout(done, 200));
  assert.equal(status(await raw(r.proxy.port, CONNECT('example.net:443'))), 200);
  b.destroy();
});

test('1 分の通信量が上限を超えたら新しいつなぎを 503 にし、1 分たてばまた通す', async t => {
  let clock = 1_000_000;
  const r = await rig(t, { maxBytesPerMinute: 1000, now: () => clock });
  const socket = await new Promise<Socket>(done => {
    const s = connect(r.proxy.port, '127.0.0.1');
    s.on('error', () => {});
    let sent = false;
    s.on('data', () => { if (!sent) { sent = true; s.write(Buffer.alloc(1500, 97)); setTimeout(() => done(s), 200); } });
    s.write(CONNECT('example.net:443'));
  });
  assert.ok(r.proxy.stats().bytesInWindow >= 1000, `${r.proxy.stats().bytesInWindow}`);
  assert.equal(status(await raw(r.proxy.port, CONNECT('example.net:443'))), 503);
  clock += 61_000;
  assert.equal(status(await raw(r.proxy.port, CONNECT('example.net:443'))), 200);
  socket.destroy();
});

test('close() で待ち受けも通っているつなぎも閉じる', async t => {
  const r = await rig(t);
  const socket = await new Promise<Socket>(done => {
    const s = connect(r.proxy.port, '127.0.0.1');
    s.on('error', () => {});
    s.on('data', () => done(s));
    s.write(CONNECT('example.net:443'));
  });
  const closed = new Promise<void>(done => socket.on('close', () => done()));
  await r.proxy.close();
  await closed;
  await assert.rejects(new Promise((_, fail) => { const s = connect(r.proxy.port, '127.0.0.1'); s.on('error', fail); s.on('connect', () => { s.destroy(); }); }));
});

test('中継のソースは node:* と public-page.ts の規則だけを import し、外へ出る別の道（fetch・https の直接のつなぎ）を持たない', () => {
  const source = readFileSync(new URL('../src/tools/browser/egress-proxy.ts', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gmu)].map(m => m[1]);
  for (const from of imports) assert.ok(from?.startsWith('node:') || from === '../web/public-page.ts', `import ${from}`);
  assert.doesNotMatch(source, /\bfetch\(|playwright|'0\.0\.0\.0'|listen\([^)]*,\s*'(?!127\.0\.0\.1)/u);
  assert.match(source, /listen\(0, '127\.0\.0\.1'/u);
  assert.match(source, /timingSafeEqual/u);
});
