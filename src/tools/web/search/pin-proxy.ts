import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';

// 似せる通信（impersonate.ts）だけが使う、loopback の CONNECT 中継。impit は自分で名前を引くので、そのままでは
// 「確かめたアドレス」と「つなぐアドレス」がずれる。中継は名前を引かず、その時に登録された host を、登録したアドレスの 443 へだけつなぐ。
// TLS は impit と相手の間で端から端まで（中継は中を見ない）。起動ごとの合言葉が合わない・CONNECT 以外・443 以外・登録の無い host は即切る

const HEAD_MAX_BYTES = 8 * 1024;
const HEAD_MS = 10_000;
const CONNECT_MS = 10_000;
const IDLE_MS = 30_000;

export interface PinProxyOptions {
  // つなぐ関数（試験が差し替える）。既定は node:net の connect
  connect?: ((port: number, address: string) => Socket) | undefined;
  headMs?: number | undefined;
  connectMs?: number | undefined;
  idleMs?: number | undefined;
}

export interface PinProxy {
  // impit の proxyUrl（http://beat:<合言葉>@127.0.0.1:<番号>）
  readonly url: string;
  readonly port: number;
  // host を確かめ済みのアドレスで登録する。返した関数で外す
  register(host: string, address: string): () => void;
  close(): Promise<void>;
}

const USER = 'beat';

function reply(socket: Socket, status: number, reason: string, extra = ''): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  const match = header ? /^Basic\s+([A-Za-z0-9+/=]+)\s*$/u.exec(header) : null;
  if (!match) return false;
  const given = Buffer.from(Buffer.from(match[1]!, 'base64').toString('utf8'));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startPinProxy(options: PinProxyOptions = {}): Promise<PinProxy> {
  const secret = randomBytes(32).toString('hex');
  const expected = Buffer.from(`${USER}:${secret}`);
  const connect = options.connect ?? ((port: number, address: string) => netConnect({ port, host: address, family: 4 }));
  const headMs = options.headMs ?? HEAD_MS;
  const connectMs = options.connectMs ?? CONNECT_MS;
  const idleMs = options.idleMs ?? IDLE_MS;
  // host → 登録したアドレス（同じ host の頼みが重なっても、外すのは自分の分だけ）
  const routes = new Map<string, { address: string }[]>();
  const sockets = new Set<Socket>();

  const handle = (client: Socket) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const headTimer = setTimeout(() => client.destroy(), headMs);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > HEAD_MAX_BYTES) { clearTimeout(headTimer); client.off('data', onData); reply(client, 431, 'Request Header Fields Too Large'); }
        return;
      }
      clearTimeout(headTimer);
      client.off('data', onData);
      client.pause();
      const rest = head.subarray(end + 4);
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const [method, target] = (lines[0] ?? '').split(' ');
      const headers = new Map(lines.slice(1).map(line => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()] as const;
      }));
      if (!authorized(headers.get('proxy-authorization'), expected)) { reply(client, 407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="beat"\r\n'); return; }
      if (method !== 'CONNECT') { reply(client, 405, 'Method Not Allowed'); return; }
      const match = /^([a-z0-9.-]+):(\d{1,5})$/iu.exec(target ?? '');
      if (!match || match[2] !== '443') { reply(client, 403, 'Forbidden'); return; }
      const address = routes.get(match[1]!.toLowerCase())?.at(-1)?.address;
      if (!address) { reply(client, 403, 'Forbidden'); return; }
      tunnel(client, address, rest);
    };
    client.on('data', onData);
  };

  const tunnel = (client: Socket, address: string, rest: Buffer) => {
    const upstream = connect(443, address);
    sockets.add(upstream);
    const closeBoth = () => { client.destroy(); upstream.destroy(); };
    const connectTimer = setTimeout(closeBoth, connectMs);
    upstream.on('close', () => { sockets.delete(upstream); clearTimeout(connectTimer); client.destroy(); });
    client.on('close', () => { clearTimeout(connectTimer); upstream.destroy(); });
    upstream.on('error', closeBoth);
    upstream.once('connect', () => {
      clearTimeout(connectTimer);
      upstream.setTimeout(idleMs, closeBoth);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const { address: host, port } = server.address() as { address: string; port: number };

  return {
    url: `http://${USER}:${secret}@${host}:${port}`,
    port,
    register(host, address) {
      const key = host.toLowerCase();
      const entry = { address };
      routes.set(key, [...(routes.get(key) ?? []), entry]);
      return () => {
        const left = (routes.get(key) ?? []).filter(item => item !== entry);
        if (left.length) routes.set(key, left); else routes.delete(key);
      };
    },
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      routes.clear();
      server.close(() => resolve());
    }),
  };
}
