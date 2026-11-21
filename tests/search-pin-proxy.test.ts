import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect, createServer, Socket, type Server } from 'node:net';
import { test } from 'node:test';
import { MAX_CONNECTIONS, startPinProxy, type PinProxyOptions } from '../src/tools/web/search/pin-proxy.ts';

// 上流は試験の中の偽のサーバ（TLS でない、受けた行をそのまま返す）。中継の connect を差し替え、本当の 443 へは出ない
async function echoServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); socket.on('error', () => undefined); socket.pipe(socket); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as { port: number }).port, sockets };
}

async function setup(extra: PinProxyOptions = {}) {
  const echo = await echoServer();
  const connects: { port: number; address: string }[] = [];
  const proxy = await startPinProxy({
    connect: (port, address) => { connects.push({ port, address }); return connect(echo.port, '127.0.0.1'); },
    ...extra,
  });
  const secret = new URL(proxy.url).password;
  const auth = `Proxy-Authorization: Basic ${Buffer.from(`beat:${secret}`).toString('base64')}\r\n`;
  const done = async () => { await proxy.close(); echo.server.close(); for (const s of echo.sockets) s.destroy(); };
  return { proxy, echo, connects, auth, done };
}

// 中継へ生の頭の行を送り、最初の返事（頭の行）と、その socket を返す
async function send(port: number, head: string): Promise<{ status: number; text: string; socket: Socket }> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  socket.write(head);
  let text = '';
  await new Promise<void>(resolve => {
    socket.on('data', chunk => { text += chunk.toString('latin1'); if (text.includes('\r\n\r\n')) resolve(); });
    socket.on('close', () => resolve());
  });
  return { status: Number(/^HTTP\/1\.1 (\d{3})/u.exec(text)?.[1] ?? 0), text, socket };
}

const closed = (socket: Socket) => socket.destroyed || socket.readyState === 'closed' ? Promise.resolve() : once(socket, 'close').then(() => undefined);

test('the relay listens on 127.0.0.1 only, on a random port, with a per-launch secret', async () => {
  const a = await setup();
  const b = await setup();
  try {
    const url = new URL(a.proxy.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.username, 'beat');
    assert.match(url.password, /^[0-9a-f]{64}$/u);
    assert.notEqual(url.password, new URL(b.proxy.url).password);
    assert.notEqual(a.proxy.port, 0);
  } finally { await a.done(); await b.done(); }
});

test('a missing or wrong secret gets 407 and no upstream connection', async () => {
  const s = await setup();
  try {
    s.proxy.register('www.bing.com', '93.184.216.34');
    const none = await send(s.proxy.port, 'CONNECT www.bing.com:443 HTTP/1.1\r\nHost: www.bing.com:443\r\n\r\n');
    assert.equal(none.status, 407);
    await closed(none.socket);
    const wrong = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from('beat:nope').toString('base64')}\r\n\r\n`);
    assert.equal(wrong.status, 407);
    assert.deepEqual(s.connects, []);
  } finally { await s.done(); }
});

test('anything but CONNECT gets 405, including an absolute-form GET', async () => {
  const s = await setup();
  try {
    s.proxy.register('www.bing.com', '93.184.216.34');
    const get = await send(s.proxy.port, `GET http://www.bing.com/ HTTP/1.1\r\nHost: www.bing.com\r\n${s.auth}\r\n`);
    assert.equal(get.status, 405);
    assert.deepEqual(s.connects, []);
  } finally { await s.done(); }
});

test('a port other than 443 and an unregistered host get 403 and no upstream connection', async () => {
  const s = await setup();
  try {
    s.proxy.register('www.bing.com', '93.184.216.34');
    assert.equal((await send(s.proxy.port, `CONNECT www.bing.com:80 HTTP/1.1\r\n${s.auth}\r\n`)).status, 403);
    assert.equal((await send(s.proxy.port, `CONNECT 10.0.0.1:443 HTTP/1.1\r\n${s.auth}\r\n`)).status, 403);
    assert.equal((await send(s.proxy.port, `CONNECT lite.duckduckgo.com:443 HTTP/1.1\r\n${s.auth}\r\n`)).status, 403);
    assert.deepEqual(s.connects, []);
  } finally { await s.done(); }
});

test('a registered host connects only to the registered address on 443 and relays both ways', async () => {
  const s = await setup();
  try {
    const release = s.proxy.register('WWW.Bing.com', '93.184.216.34');
    const ok = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\nHost: www.bing.com:443\r\n${s.auth}\r\n`);
    assert.equal(ok.status, 200);
    assert.deepEqual(s.connects, [{ port: 443, address: '93.184.216.34' }]);
    const echoed = once(ok.socket, 'data');
    ok.socket.write('ping');
    assert.equal(String((await echoed)[0]), 'ping');
    ok.socket.destroy();
    release();
    assert.equal((await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`)).status, 403);
    assert.equal(s.connects.length, 1);
  } finally { await s.done(); }
});

test('overlapping registrations for one host release only their own entry', async () => {
  const s = await setup();
  try {
    const first = s.proxy.register('www.bing.com', '93.184.216.34');
    const second = s.proxy.register('www.bing.com', '93.184.216.35');
    second();
    const ok = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`);
    assert.equal(ok.status, 200);
    assert.deepEqual(s.connects, [{ port: 443, address: '93.184.216.34' }]);
    ok.socket.destroy();
    first();
    assert.equal((await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`)).status, 403);
  } finally { await s.done(); }
});

test('when the client goes away, the upstream socket is closed too', async () => {
  const s = await setup();
  try {
    s.proxy.register('www.bing.com', '93.184.216.34');
    const ok = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`);
    assert.equal(ok.status, 200);
    while (!s.echo.sockets.length) await new Promise(resolve => setTimeout(resolve, 5));
    const upstream = s.echo.sockets[0]!;
    ok.socket.resetAndDestroy();
    await closed(upstream);
  } finally { await s.done(); }
});

test('an idle tunnel and a slow request head are cut on time', { timeout: 5000 }, async () => {
  const s = await setup({ idleMs: 50, headMs: 50 });
  try {
    s.proxy.register('www.bing.com', '93.184.216.34');
    const ok = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`);
    assert.equal(ok.status, 200);
    while (!s.echo.sockets.length) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.all([closed(ok.socket), closed(s.echo.sockets[0]!)]);
    const slow = connect(s.proxy.port, '127.0.0.1');
    slow.on('error', () => undefined);
    await once(slow, 'connect');
    slow.write('CONNECT www.bing.com:443 HTTP/1.1\r\n');
    await closed(slow);
    assert.equal(s.connects.length, 1);
  } finally { await s.done(); }
});

test('an upstream that never connects is cut on time', { timeout: 5000 }, async () => {
  const proxy = await startPinProxy({ connectMs: 50, connect: () => new Socket() });
  try {
    proxy.register('www.bing.com', '93.184.216.34');
    const secret = new URL(proxy.url).password;
    const socket = connect(proxy.port, '127.0.0.1');
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    socket.write(`CONNECT www.bing.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`beat:${secret}`).toString('base64')}\r\n\r\n`);
    await closed(socket);
  } finally { await proxy.close(); }
});

test('close cuts open tunnels', { timeout: 5000 }, async () => {
  const s = await setup();
  s.proxy.register('www.bing.com', '93.184.216.34');
  const ok = await send(s.proxy.port, `CONNECT www.bing.com:443 HTTP/1.1\r\n${s.auth}\r\n`);
  assert.equal(ok.status, 200);
  await s.proxy.close();
  await closed(ok.socket);
  await s.done();
});

test('connections beyond the cap are dropped at once, while waiting for the secret', { timeout: 10_000 }, async () => {
  const s = await setup();
  const held: Socket[] = [];
  try {
    for (let i = 0; i < MAX_CONNECTIONS; i++) {
      const socket = connect(s.proxy.port, '127.0.0.1');
      socket.on('error', () => undefined);
      await once(socket, 'connect');
      held.push(socket);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    const extra = connect(s.proxy.port, '127.0.0.1');
    extra.on('error', () => undefined);
    await closed(extra);
    assert.ok(held.every(socket => !socket.destroyed), 'the held connections stay open');
  } finally { for (const socket of held) socket.destroy(); await s.done(); }
});

test('after close the port is free again', async () => {
  const s = await setup();
  const port = s.proxy.port;
  await s.done();
  const server = createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  server.close();
});
