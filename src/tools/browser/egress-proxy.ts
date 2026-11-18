// ブラウザの外向きの通信の中継（守りの本体）。ブラウザはこの中継経由でしか外に出られない（起動引数 --proxy-bypass-list=<-loopback> と、
// 作業用の文脈の proxy.bypass '<-loopback>' で、ループバックも中継に通す）。
// 中継が決めること:
// - 待ち受けは 127.0.0.1 だけ。合言葉（Proxy-Authorization の Basic）が合わない要求は 407
// - 受けるのは CONNECT host:port と、絶対形の GET http://... だけ（本文つき＝Content-Length > 0・Transfer-Encoding は 400。content-length・expect も上流へ渡さない）。ほかは 400
// - ポートは 80 / 443 だけ。ほかは 403
// - IP の直書きは公開 IPv4 だけ。IPv6 は断る。名前は publicHostName（ページを読む道具と同じ規則）を通ったものだけ
// - 名前は、ここで 1 回だけ引く。返った番地が 1 つでも公開 IPv4 でなければ断る（混在も、IPv6 だけの名前も）。つなぐのは確かめた番地で、引き直さない（再束縛を許さない）
// - 無通信 60 秒で切る。同時 64 本まで（超えたら 503）。1 分の通信量が上限を超えたら、新しいつなぎを 503
// - denyHosts（beat 自身の名前。server.origins のホスト）は、どの中継でも 403
// - loopback（製品の実行の作業用の文脈の中継だけが持つ）があるときだけ、ループバックの書き方（loopback.ts。正規化したあとのホスト。名前は引かない）の宛先を、
//   断るポート（denyPorts。要求のたびに読む）以外へ通す。平の http は方法と本文をそのまま流し、Sec-Fetch-Site / Origin で公開のページから来たものを断る。
//   CONNECT は 200 のあと始めの要求（ループバックのページからの WebSocket の始まりだけ）を確かめてからつなぐ。https / wss（TLS）は断る。ループバックは無通信でも切らない
// node:* と public-page.ts・loopback.ts の規則だけに頼る（ブラウザの部品は import しない）

import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, isIPv4, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { publicHostName, publicIPv4 } from '../web/public-page.ts';
import { fetchSiteAllows, loopbackHost, normalHost, portOf, tunnelVerdict } from './loopback.ts';

export interface EgressProxyOptions {
  username: string;
  password: string;
  log?: (line: string) => void;
  // 試験用: 名前の解決（すべての番地を返す。IPv6 も含む）と、番地へのつなぎ方
  resolve?: (host: string) => Promise<string[]>;
  connect?: (address: string, port: number, family: 4 | 6) => Socket;
  idleMs?: number;
  maxConnections?: number;
  maxBytesPerMinute?: number;
  connectTimeoutMs?: number;
  now?: () => number;
  // ループバックを通す許し（製品の実行の作業用の文脈の中継だけ）。denyPorts は要求のたびに呼ぶ
  loopback?: { denyPorts: () => ReadonlySet<number> } | undefined;
  // どの中継でも断るホスト（beat 自身の名前）。要求のたびに呼ぶ
  denyHosts?: (() => readonly string[]) | undefined;
  // 試験用: ループバックのトンネルの始めの要求を待つ時間（既定 10 秒）
  headTimeoutMs?: number;
}

export interface EgressProxyStats {
  // 断った数（403 と、トンネルの始めの要求で切ったもの。合言葉違い・形の誤りは含めない）
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
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'expect']);
// ループバックの平の http は本文を流すので content-length は渡す（transfer-encoding は Node が付け直す）
const LOOPBACK_HOP_BY_HOP = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'expect']);

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
const defaultResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map(item => item.address);
const defaultConnect = (address: string, port: number, family: 4 | 6): Socket => netConnect({ host: address, port, family });
const bareHost = (host: string): string => host.replace(/^\[|\]$/gu, '').replace(/\.+$/u, '').toLowerCase();
const headerOf = (req: IncomingMessage, name: string): string | undefined => { const value = req.headers[name]; return Array.isArray(value) ? value.join(', ') : value; };

type Verdict = { ok: true; addresses: string[] } | { ok: false; status: 403 | 502; reason: string };

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const log = options.log ?? (() => {});
  const resolve = options.resolve ?? defaultResolve;
  const connect = options.connect ?? defaultConnect;
  const idleMs = options.idleMs ?? 60_000;
  const maxConnections = options.maxConnections ?? 64;
  const maxBytes = options.maxBytesPerMinute ?? 50 * 1024 * 1024;
  const connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
  const headTimeoutMs = options.headTimeoutMs ?? 10_000;
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

  // beat 自身の名前（server.origins のホスト）か。書いたままと正規化したものの両方で比べる
  const deniedHost = (host: string): boolean => {
    const list = options.denyHosts?.() ?? [];
    if (list.length === 0) return false;
    const normal = normalHost(host);
    const forms = new Set([bareHost(host), ...(normal === undefined ? [] : [bareHost(normal)])]);
    return list.some(entry => forms.has(bareHost(entry)));
  };

  // ループバックの宛先なら、つなぐ番地の順（許しの無い中継では undefined = 今までの公開の決まりで断る）
  const loopbackTarget = (host: string): readonly string[] | undefined => {
    if (!options.loopback) return undefined;
    const normal = normalHost(host);
    return normal === undefined ? undefined : loopbackHost(normal)?.connect;
  };
  const loopbackPortDenied = (port: number): boolean => port < 1 || port > 65535 || options.loopback!.denyPorts().has(port);

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
    // つなぐのは IPv4 だけ（公開の宛先は family 4）。IPv6 の番地は使わないので判定から外す
    // （ふつうのサイトは AAAA も返す）。IPv4 が 1 つも無い名前、IPv4 に公開でないものが 1 つでも混ざる名前は断る
    const v4 = addresses.filter(address => isIPv4(address));
    if (v4.length === 0 || v4.some(address => !publicIPv4(address))) return { ok: false, status: 403, reason: 'address' };
    return { ok: true, addresses: [...new Set(v4)] };
  }

  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(idleMs, () => socket.destroy());
  };

  // 確かめた番地へ順につなぐ（番地は確かめたものだけ。IPv6 の番地はループバックの ::1 だけ）。全部だめなら undefined
  async function connectAny(addresses: readonly string[], port: number): Promise<Socket | undefined> {
    for (const address of addresses) {
      if (closed) return undefined;
      const socket = connect(address, port, address.includes(':') ? 6 : 4);
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
  const AUTH_CHALLENGE = 'Proxy-Authenticate: Basic realm="beat"\r\n';

  // トンネルの始めの要求を、決まるまで（16 KiB・headTimeoutMs まで）読む。通すなら読んだ分、断るなら undefined。読んだあとは流れを止めておく
  function readHead(socket: Socket, initial: Buffer): Promise<Buffer | undefined> {
    return new Promise(settle => {
      let buffer = initial;
      const first = tunnelVerdict(buffer);
      if (first !== 'more') { settle(first === 'ok' ? buffer : undefined); return; }
      const finish = (result: Buffer | undefined): void => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.pause();
        settle(result);
      };
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        const verdict = tunnelVerdict(buffer);
        if (verdict !== 'more') finish(verdict === 'ok' ? buffer : undefined);
      };
      const onClose = (): void => finish(undefined);
      const timer = setTimeout(() => finish(undefined), headTimeoutMs);
      socket.on('data', onData);
      socket.once('close', onClose);
    });
  }

  // ループバックの CONNECT（WebSocket だけ）。200 を返してから始めの要求を確かめ、通れば上流へつなぎ、読んだ分を渡してから流す。無通信では切らない
  async function tunnelLoopback(socket: Socket, head: Buffer, host: string, port: number, addresses: readonly string[]): Promise<void> {
    if (loopbackPortDenied(port)) { block(host, port, 'port'); rawReply(socket, 403, REASONS[403]!); return; }
    const release = admit();
    if (!release) { rawReply(socket, 503, REASONS[503]!); return; }
    try {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const first = await readHead(socket, head);
      if (!first) { block(host, port, 'tunnel'); socket.destroy(); release(); return; }
      const upstream = await connectAny(addresses, port);
      if (!upstream || socket.destroyed) { upstream?.destroy(); socket.destroy(); release(); return; }
      counters.accepted += 1;
      socket.setTimeout(0);
      upstream.setTimeout(0);
      const finish = (): void => { socket.destroy(); upstream.destroy(); release(); };
      socket.once('close', finish);
      upstream.once('close', finish);
      socket.on('data', chunk => count(chunk.length));
      upstream.on('data', chunk => count(chunk.length));
      count(first.length);
      upstream.write(first);
      socket.pipe(upstream);
      upstream.pipe(socket);
    } catch (error) {
      release();
      socket.destroy();
      throw error;
    }
  }

  async function handleConnect(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    if (!authorized(req.headers['proxy-authorization'])) { rawReply(socket, 407, REASONS[407]!, AUTH_CHALLENGE); return; }
    const match = TARGET.exec(req.url ?? '');
    if (!match) { rawReply(socket, 400, REASONS[400]!); return; }
    const host = (match[1] ?? '').toLowerCase();
    const port = Number(match[2]);
    if (deniedHost(host)) { block(host, port, 'self'); rawReply(socket, 403, REASONS[403]!); return; }
    const loopback = loopbackTarget(host);
    if (loopback) { await tunnelLoopback(socket, head, host, port, loopback); return; }
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

  // 上流の応答をそのまま返す（Proxy-* と接続の見出しは外す）
  const relay = (res: ServerResponse) => (response: IncomingMessage): void => {
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
  };

  // ループバックの平の http。方法と本文をそのまま流す。公開のページから来た要求（Sec-Fetch-Site / Origin）は断る
  async function forwardLoopback(req: IncomingMessage, res: ServerResponse, url: URL, addresses: readonly string[], reply: (status: number) => void): Promise<void> {
    const port = portOf(url) ?? 80;
    if (loopbackPortDenied(port)) { req.resume(); block(url.hostname, port, 'port'); reply(403); return; }
    if (req.headers.upgrade !== undefined) { req.resume(); reply(400); return; }
    if (!fetchSiteAllows({ secFetchSite: headerOf(req, 'sec-fetch-site'), origin: headerOf(req, 'origin') })) { req.resume(); block(url.hostname, port, 'origin'); reply(403); return; }
    const release = admit();
    if (!release) { req.resume(); reply(503); return; }
    res.once('close', release);
    const socket = await connectAny(addresses, port);
    if (!socket) { req.resume(); reply(502); return; }
    socket.setTimeout(0);
    req.socket.setTimeout(0);
    counters.accepted += 1;
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (/^proxy-/iu.test(name) || LOOPBACK_HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers.host = url.host;
    headers.connection = 'close';
    const agent = new HttpAgent({ keepAlive: false });
    (agent as unknown as { createConnection: () => Socket }).createConnection = () => socket;
    const upstream = httpRequest({ method: req.method, host: addresses[0], port, path: `${url.pathname}${url.search}`, headers, agent }, relay(res));
    upstream.on('error', () => { if (res.headersSent) res.destroy(); else reply(502); });
    res.once('close', () => upstream.destroy());
    req.on('data', (chunk: Buffer) => count(chunk.length));
    req.pipe(upstream);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, extra: OutgoingHttpHeaders = {}): void => {
      res.writeHead(status, REASONS[status], { ...extra, connection: 'close', 'content-length': '0' });
      res.end();
    };
    if (!authorized(req.headers['proxy-authorization'])) { req.resume(); reply(407, { 'proxy-authenticate': 'Basic realm="beat"' }); return; }
    let url: URL | undefined;
    if (/^http:\/\//iu.test(req.url ?? '')) { try { url = new URL(req.url ?? ''); } catch { url = undefined; } }
    if (url && deniedHost(url.hostname)) { req.resume(); block(url.hostname, portOf(url) ?? 80, 'self'); reply(403); return; }
    const loopback = url ? loopbackTarget(url.hostname) : undefined;
    if (url && loopback) { await forwardLoopback(req, res, url, loopback, reply); return; }
    req.resume();
    if (req.method !== 'GET' || !url) { reply(400); return; }
    // 本文つきの要求（Content-Length > 0・Transfer-Encoding）は受けない。上流へ本文を渡さず、要求の形を食い違わせない（要求の密輸を許さない）
    const length = req.headers['content-length'];
    if (req.headers['transfer-encoding'] !== undefined || (length !== undefined && !/^0+$/u.test(length.trim()))) { reply(400); return; }
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
    (agent as unknown as { createConnection: () => Socket }).createConnection = () => { const socket = connect(address, port, 4); track(socket); return socket; };
    const upstream = httpRequest({
      method: 'GET', host: address, port, path: `${url.pathname}${url.search}`, headers, agent,
    }, relay(res));
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
