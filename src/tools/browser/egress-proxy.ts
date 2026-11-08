// ブラウザの外向きの通信の中継（守りの本体）。ブラウザはこの中継経由でしか外に出られない（起動引数 --proxy-bypass-list=<-loopback> で、ループバックも中継に通す）。
// 中継が決めること:
// - 待ち受けは 127.0.0.1 だけ。合言葉（Proxy-Authorization の Basic）が合わない要求は 407
// - 受けるのは CONNECT host:port と、絶対形の GET http://... だけ。ほかは 400
// - ポートは 80 / 443 だけ。ほかは 403
// - IP の直書きは公開 IPv4 だけ。IPv6 は断る。名前は publicHostName（ページを読む道具と同じ規則）を通ったものだけ
// - 名前は、ここで 1 回だけ引く。返った番地が 1 つでも公開 IPv4 でなければ断る（混在も、IPv6 だけの名前も）。つなぐのは確かめた番地で、引き直さない（再束縛を許さない）
// - 無通信 60 秒で切る。同時 64 本まで（超えたら 503）。1 分の通信量が上限を超えたら、新しいつなぎを 503
// node:* と public-page.ts の規則だけに頼る（ブラウザの部品は import しない）

import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIPv4, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { publicHostName, publicIPv4 } from '../web/public-page.ts';

export interface EgressProxyOptions {
  username: string;
  password: string;
  log?: (line: string) => void;
  // 試験用: 名前の解決（すべての番地を返す。IPv6 も含む）と、番地へのつなぎ方
  resolve?: (host: string) => Promise<string[]>;
  connect?: (address: string, port: number) => Socket;
  idleMs?: number;
  maxConnections?: number;
  maxBytesPerMinute?: number;
  connectTimeoutMs?: number;
  now?: () => number;
}

export interface EgressProxyStats {
  // 断った数（403。合言葉違い・形の誤りは含めない）
  blocked: number;
  // 通した数
  accepted: number;
  // 同時数・通信量の上限で断った数（503）
  busy: number;
  active: number;
  bytesInWindow: number;
}

export interface EgressProxy {
  readonly host: '127.0.0.1';
  readonly port: number;
  stats(): EgressProxyStats;
  close(): Promise<void>;
}

const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443]);
const TARGET = /^(\[[0-9a-fA-F:.]+\]|[^:\s/[\]]+):(\d{1,5})$/u;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map(item => item.address);
const defaultConnect = (address: string, port: number): Socket => netConnect({ host: address, port, family: 4 });

type Verdict = { ok: true; addresses: string[] } | { ok: false; status: 403 | 502; reason: string };

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const log = options.log ?? (() => {});
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? defaultConnect;
  const idleMs = options.idleMs ?? 60_000;
  const maxConnections = options.maxConnections ?? 64;
  const maxBytes = options.maxBytesPerMinute ?? 50 * 1024 * 1024;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const now = options.now ?? Date.now;
  const expected = digest(`${options.username}:${options.password}`);
  const sockets = new Set<Socket>();
  const counters = { blocked: 0, accepted: 0, busy: 0, active: 0 };
  let windowStart = now();
  let windowBytes = 0;
  let closed = false;

  const roll = (): void => {
    if (now() - windowStart >= 60_000) { windowStart = now(); windowBytes = 0; }
  };
  const count = (bytes: number): void => { roll(); windowBytes += bytes; };

  const authorized = (header: string | undefined): boolean => {
    const match = header ? /^Basic\s+(\S+)$/iu.exec(header) : null;
    if (!match) return false;
    return timingSafeEqual(digest(Buffer.from(match[1] ?? '', 'base64').toString('utf8')), expected);
  };

  // 同時数と通信量の確かめ。通れば、終わったときに呼ぶ release を返す
  const admit = (): (() => void) | undefined => {
    roll();
    if (counters.active >= maxConnections || windowBytes >= maxBytes) { counters.busy += 1; return undefined; }
    counters.active += 1;
    let done = false;
    return () => { if (!done) { done = true; counters.active -= 1; } };
  };

  const shown = (host: string): string => host.replace(/[^\x21-\x7e]/gu, '?').slice(0, 100);
  const block = (host: string, port: number, reason: string): void => {
    counters.blocked += 1;
    log(`[browser] blocked ${shown(host)}:${port} ${reason}`);
  };

  // 行き先の確かめ。通れば、つなぐ番地（確かめたもの）を返す
  async function vet(rawHost: string, port: number): Promise<Verdict> {
    // 末尾のドット（localhost. など）は、内向きの名前の見分けをすり抜けないよう外してから確かめる
    const host = rawHost.replace(/\.+$/u, '');
    if (!ALLOWED_PORTS.has(port)) return { ok: false, status: 403, reason: 'port' };
    if (host.startsWith('[') || host.includes(':')) return { ok: false, status: 403, reason: 'ipv6' };
    if (/^[\d.]+$/u.test(host)) return isIPv4(host) && publicIPv4(host) ? { ok: true, addresses: [host] } : { ok: false, status: 403, reason: 'address' };
    if (!publicHostName(host)) return { ok: false, status: 403, reason: 'name' };
    let addresses: string[];
    try { addresses = await resolve(host); } catch { return { ok: false, status: 502, reason: 'resolve' }; }
    if (addresses.length === 0) return { ok: false, status: 502, reason: 'resolve' };
    if (addresses.some(address => !publicIPv4(address))) return { ok: false, status: 403, reason: 'address' };
    return { ok: true, addresses: [...new Set(addresses)] };
  }

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(idleMs, () => socket.destroy());
  };

  // 確かめた番地へ順につなぐ（番地は確かめたものだけ）。全部だめなら undefined
  async function connectAny(addresses: string[], port: number): Promise<Socket | undefined> {
    for (const address of addresses) {
      if (closed) return undefined;
      const socket = connect(address, port);
      track(socket);
      const ok = await new Promise<boolean>(settle => {
        const timer = setTimeout(() => { socket.destroy(); settle(false); }, connectTimeoutMs);
        socket.once('connect', () => { clearTimeout(timer); settle(true); });
        socket.once('close', () => { clearTimeout(timer); settle(false); });
      });
      if (ok) return socket;
    }
    return undefined;
  }

  const rawReply = (socket: Duplex, status: number, text: string, extra = ''): void => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const REASONS: Record<number, string> = { 400: 'Bad Request', 403: 'Forbidden', 407: 'Proxy Authentication Required', 502: 'Bad Gateway', 503: 'Service Unavailable' };
  const AUTH_CHALLENGE = 'Proxy-Authenticate: Basic realm="clive"\r\n';

  async function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (!authorized(req.headers['proxy-authorization'])) { rawReply(socket, 407, REASONS[407]!, AUTH_CHALLENGE); return; }
    const match = TARGET.exec(req.url ?? '');
    if (!match) { rawReply(socket, 400, REASONS[400]!); return; }
    const host = (match[1] ?? '').toLowerCase();
    const port = Number(match[2]);
    const release = admit();
    if (!release) { rawReply(socket, 503, REASONS[503]!); return; }
    try {
      const verdict = await vet(host, port);
      if (!verdict.ok) {
        if (verdict.status === 403) block(host, port, verdict.reason);
        rawReply(socket, verdict.status, REASONS[verdict.status]!);
        release(); return;
      }
      const upstream = await connectAny(verdict.addresses, port);
      if (!upstream || socket.destroyed) { upstream?.destroy(); if (!socket.destroyed) rawReply(socket, 502, REASONS[502]!); release(); return; }
      counters.accepted += 1;
      // http の部品は CONNECT を渡すときに時間切れを 0 に戻すので、つないだあとで掛け直す
      socket.setTimeout(idleMs);
      const finish = (): void => { socket.destroy(); upstream.destroy(); release(); };
      socket.once('close', finish);
      upstream.once('close', finish);
      socket.on('data', chunk => count(chunk.length));
      upstream.on('data', chunk => count(chunk.length));
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) { count(head.length); upstream.write(head); }
      socket.pipe(upstream);
      upstream.pipe(socket);
    } catch (error) {
      release();
      socket.destroy();
      throw error;
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, extra: OutgoingHttpHeaders = {}): void => {
      res.writeHead(status, REASONS[status], { ...extra, connection: 'close', 'content-length': '0' });
      res.end();
    };
    req.resume();
    if (!authorized(req.headers['proxy-authorization'])) { reply(407, { 'proxy-authenticate': 'Basic realm="clive"' }); return; }
    let url: URL | undefined;
    if (req.method === 'GET' && /^http:\/\//iu.test(req.url ?? '')) { try { url = new URL(req.url ?? ''); } catch { url = undefined; } }
    if (!url) { reply(400); return; }
    const port = url.port === '' ? 80 : Number(url.port);
    const release = admit();
    if (!release) { reply(503); return; }
    res.once('close', release);
    const verdict = await vet(url.hostname.toLowerCase(), port);
    if (!verdict.ok) {
      if (verdict.status === 403) block(url.hostname, port, verdict.reason);
      reply(verdict.status);
      return;
    }
    const address = verdict.addresses[0]!;
    counters.accepted += 1;
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (/^proxy-/iu.test(name) || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers.host = url.host;
    headers.connection = 'close';
    // つなぎ方は専用の Agent で差し替える（agent: false だと createConnection が無視され、Node が自分で名前を引いてしまう）。
    // 念のため host にも確かめた番地を入れ、差し替えが効かなくても名前の解決には行かないようにする
    const agent = new HttpAgent({ keepAlive: false });
    (agent as unknown as { createConnection: () => Socket }).createConnection = () => { const socket = connect(address, port); track(socket); return socket; };
    const upstream = httpRequest({
      method: 'GET', host: address, port, path: `${url.pathname}${url.search}`, headers, agent,
    }, response => {
      const out: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (/^proxy-/iu.test(name) || name === 'connection' || name === 'keep-alive') continue;
        out[name] = value;
      }
      out.connection = 'close';
      res.writeHead(response.statusCode ?? 502, response.statusMessage, out);
      response.on('data', (chunk: Buffer) => count(chunk.length));
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(idleMs, () => upstream.destroy());
    upstream.on('error', () => { if (res.headersSent) res.destroy(); else reply(502); });
    res.once('close', () => upstream.destroy());
    upstream.end();
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch(() => { if (res.headersSent) res.destroy(); else { res.writeHead(502, { connection: 'close', 'content-length': '0' }); res.end(); } });
  });
  server.on('connect', (req, duplex, head) => {
    const socket = duplex as Socket;
    handleConnect(req, socket, head).catch(() => socket.destroy());
  });
  server.on('connection', track);
  server.keepAliveTimeout = 1000;
  server.maxConnections = maxConnections * 2;

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('egress proxy did not bind a port'); }

  return {
    host: '127.0.0.1',
    port: address.port,
    stats() { roll(); return { ...counters, bytesInWindow: windowBytes }; },
    close() {
      closed = true;
      return new Promise<void>(done => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
