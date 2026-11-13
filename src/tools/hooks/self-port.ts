import { isIP } from 'node:net';

export interface SelfServer { port: number; origins: readonly string[] }

const LOOPBACK_NAME = /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$/u;
const ADDRESS = /(?:\b(https?|wss?):\/\/)?(\[[^\]\s]+\]|[^\s:/\\?#@[\]=,;()<>|&*!$^{}~+]+)(?::(\d+))?/giu;
const PORT = /:(\d+)/gu;
const HOST_TAIL = /[^\s/\\?#@]*$/u;
const EXPANDING = /[{}[\]]/u;
const IPV6_LITERAL = /^\[[^[\]]+\]$/u;
const DEFAULT_PORT: Record<string, number> = { http: 80, ws: 80, https: 443, wss: 443 };

function loopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/gu, '').toLowerCase();
  if (LOOPBACK_NAME.test(bare)) return true;
  if (/^0x[0-9a-f]+$/u.test(bare) || /^\d{8,10}$/u.test(bare)) {
    const value = Number(bare);
    return Number.isSafeInteger(value) && (value >>> 24 === 127 || value === 0);
  }
  if (isIP(bare) === 4) return bare.startsWith('127.') || bare === '0.0.0.0';
  if (isIP(bare) === 6) return /^(?:0{0,4}:){2,7}0{0,4}1?$/u.test(bare) || /^::ffff:127\./u.test(bare) || /^::ffff:7f[0-9a-f]{2}:/u.test(bare) || bare === '::';
  return false;
}

function normalHost(host: string): string | undefined {
  try { return new URL(`http://${host}/`).hostname.replace(/\.+$/u, '').toLowerCase(); } catch { return undefined; }
}

export function selfPortsOf(server: SelfServer): { ports: Set<number>; hosts: string[] } {
  const ports = new Set<number>([server.port]);
  const hosts: string[] = [];
  for (const origin of server.origins) {
    let url: URL;
    try { url = new URL(origin); } catch { continue; }
    const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol.replace(/:$/u, '')];
    if (port !== undefined) ports.add(port);
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (host && !loopbackHost(host)) hosts.push(host);
  }
  return { ports, hosts };
}

export function selfTarget(text: string, server: SelfServer): string | undefined {
  const { ports, hosts } = selfPortsOf(server);
  const plain = text.replace(/["'`]/gu, '');
  const lower = plain.toLowerCase();
  for (const host of hosts) {
    const at = new RegExp(`(?:^|[^a-z0-9.-])${host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.*(?![a-z0-9-])`, 'u').exec(lower);
    if (at) return host;
  }
  for (const match of plain.matchAll(PORT)) {
    if (!ports.has(Number(match[1]))) continue;
    const word = HOST_TAIL.exec(plain.slice(Math.max(0, match.index - 256), match.index))![0];
    if (EXPANDING.test(word) && !(IPV6_LITERAL.test(word) && isIP(word.slice(1, -1)) === 6)) return `${word}${match[0]}`;
  }
  for (const match of plain.matchAll(ADDRESS)) {
    const [whole, scheme, host, port] = match;
    if (!host) continue;
    const normal = normalHost(host);
    if (normal === undefined) continue;
    if (hosts.includes(normal)) return whole;
    const number = port !== undefined ? Number(port) : scheme ? DEFAULT_PORT[scheme.toLowerCase()] : undefined;
    if (number !== undefined && ports.has(number) && loopbackHost(normal)) return whole;
  }
  return undefined;
}
