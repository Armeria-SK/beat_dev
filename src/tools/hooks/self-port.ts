import { isIP } from 'node:net';

export interface SelfServer { port: number; origins: readonly string[] }

const LOOPBACK_NAME = /^(?:localhost|(?:[a-z0-9-]+\.)+localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$/u;
const ADDRESS = /(?:\b(https?|wss?):\/{1,3})?(\[[^[\]\s]+\]|[^\s:/\\?#@[\]=,;()<>|&*!$^{}~+]+)(?::(\d+))?/giu;
const PORT = /:(\d+)/gu;
const HOST_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[^\s:/\\?#@[\]=,;()<>|&*!^{}~+%])`;
const EXPANDING_HOST = new RegExp(String.raw`(?:^|[\s/@=])((?:${HOST_CHAR}|\{[^{}\s]*\}|\[[^[\]\s]*\])+)$`, 'u');
const GROUP = /\{[^{}]*\}|\[[^[\]]*\]/gu;
const BRACE_BODY = new RegExp(`^(?:${HOST_CHAR}|[,:])*$`, 'u');
const BRACKET_BODY = new RegExp(`^(?:${HOST_CHAR}|:)*$`, 'u');
const SHELL_WORD = /(?:[^\s"'`]|"[^"]*"|'[^']*'|`[^`]*`)+/gu;
const BRACKETED = /\[[^[\]]+\]/gu;
const NUMBER_WORD =/^[0-9a-fx.]+$/iu;
const ZONE = /^(\[[^%\]]+)%[^\]]*\]$/u;
const IPV6_LITERAL = /^\[[^[\]]+\]$/u;
const GROUP_AT = /\{([^{}]*)\}|\[([^[\]]*)\]/gu;
const SPAN = /^(?:(\d+)-(\d+)|([a-z])-([a-z]))(?::(\d+))?$/iu;
const SEQUENCE = /^(?:(\d+)\.\.(\d+)|([a-z])\.\.([a-z]))(?:\.\.(\d+))?$/iu;
const FULL_SPAN = 64;
const SPAN_DIGITS = 10;
const SPAN_TEXT = 32;
const MAX_FORMS = 512;
const MAX_DEPTH = 6;
const WORK_BUDGET = 300_000;
const DEFAULT_PORT: Record<string, number> = { http: 80, ws: 80, https: 443, wss: 443 };

export function loopbackHost(host: string): boolean {
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

function expandingHost(before: string): string | undefined {
  const word = EXPANDING_HOST.exec(before)?.[1];
  if (word === undefined || (IPV6_LITERAL.test(word) && isIP(word.slice(1, -1)) === 6)) return undefined;
  const groups = word.match(GROUP) ?? [];
  const closed = groups.length > 0 && groups.every(group => {
    const body = group.slice(1, -1);
    return group.startsWith('{') ? BRACE_BODY.test(body) : BRACKET_BODY.test(body) && /[-.:]/u.test(body);
  });
  return closed ? word : undefined;
}

function spanItems(match: RegExpExecArray, ports: ReadonlySet<number>): string[] | undefined {
  const step = Number(match[5] ?? 1) || 1;
  if (!Number.isSafeInteger(step)) return undefined;
  if (match[3] !== undefined) {
    const [from, to] = [match[3].charCodeAt(0), match[4]!.charCodeAt(0)];
    return Array.from({ length: Math.floor(Math.abs(to - from) / step) + 1 }, (_, i) => String.fromCharCode(from + Math.sign(to - from) * i * step));
  }
  const ends = [match[1]!, match[2]!];
  if (ends.some(end => end.length > SPAN_TEXT || end.replace(/^0+(?=\d)/u, '').length > SPAN_DIGITS)) return undefined;
  const [first, last] = ends.map(Number) as [number, number];
  const way = last < first ? -1 : 1;
  const count = Math.floor(Math.abs(last - first) / step) + 1;
  const width = /^0\d/u.test(ends[0]!) ? ends[0]!.length : 0;
  const show = (value: number): string => String(value).padStart(width, '0');
  if (count <= FULL_SPAN) return Array.from({ length: count }, (_, i) => show(first + way * i * step));
  const near = new Set<number>([first, 0, 1, 127]);
  for (const port of ports) {
    const digits = String(port);
    for (let i = 0; i < digits.length; i++) for (let j = i + 1; j <= digits.length; j++) near.add(Number(digits.slice(i, j)));
  }
  return [...near].filter(value => value >= Math.min(first, last) && value <= Math.max(first, last) && Math.abs(value - first) % step === 0).map(show);
}

interface Budget { left: number }

function expandedForms(word: string, ports: ReadonlySet<number>, budget: Budget, depth = 0): string[] {
  const group = new RegExp(GROUP_AT.source, 'gu');
  const texts: string[] = [];
  const choices: string[][] = [];
  let at = 0;
  for (let match = group.exec(word); match; match = group.exec(word)) {
    const span = match[1] !== undefined ? SEQUENCE.exec(match[1]) : SPAN.exec(match[2]!);
    const items = span ? spanItems(span, ports) : match[1]?.split(',');
    if (!items?.length) { group.lastIndex = match.index + 1; continue; }
    texts.push(word.slice(at, match.index));
    choices.push([...new Set(items)]);
    at = group.lastIndex;
  }
  if (!choices.length) return [word];
  const tail = word.slice(at);
  const built = new Set<string>();
  const build = (pick: (index: number) => string): boolean => {
    const form = choices.map((_, index) => texts[index]! + pick(index)).join('') + tail;
    budget.left -= form.length + 1;
    if (budget.left < 0) return false;
    built.add(form);
    return true;
  };
  const total = choices.reduce((product, items) => Math.min(product * items.length, MAX_FORMS + 1), 1);
  if (total <= MAX_FORMS) {
    const picked = choices.map(() => 0);
    for (let n = 0; n < total; n++) {
      if (!build(index => choices[index]![picked[index]!]!)) break;
      for (let index = choices.length - 1; index >= 0 && ++picked[index]! === choices[index]!.length; index--) picked[index] = 0;
    }
  } else {
    varied: for (let turn = 0; turn < choices.length; turn++) {
      for (const item of choices[turn]!) if (!build(index => (index === turn ? item : choices[index]![0]!))) break varied;
    }
  }
  if (depth >= MAX_DEPTH) return [...built];
  const out: string[] = [];
  for (const form of built) {
    if (budget.left < 0) break;
    if (/[{[]/u.test(form)) out.push(...expandedForms(form, ports, budget, depth + 1)); else out.push(form);
  }
  return out;
}

function literalTarget(plain: string, ports: ReadonlySet<number>, hosts: readonly string[]): string | undefined {
  const lower = plain.toLowerCase();
  for (const host of hosts) {
    const at = new RegExp(`(?:^|[^a-z0-9.-])${host.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.*(?![a-z0-9-])`, 'u').exec(lower);
    if (at) return host;
  }
  for (const match of plain.matchAll(ADDRESS)) {
    const [whole, scheme, host, port] = match;
    if (!host) continue;
    const normal = normalHost(host.replace(ZONE, '$1]'));
    if (normal === undefined) continue;
    const plainNumber = scheme === undefined && port === undefined && NUMBER_WORD.test(host) && !ports.has(80) && !ports.has(443) &&!/[/?#:]/u.test(plain[match.index + whole.length] ?? '');
    if (hosts.includes(normal) && !plainNumber) return whole;
    const number = port !== undefined ? Number(port) : scheme ? DEFAULT_PORT[scheme.toLowerCase()] : undefined;
    if (number !== undefined && ports.has(number) && loopbackHost(normal)) return whole;
  }
  return undefined;
}

export function selfTarget(text: string, server: SelfServer): string | undefined {
  const { ports, hosts } = selfPortsOf(server);
  const plain = text.replace(/["'`]/gu, '');
  const literal = literalTarget(plain, ports, hosts);
  if (literal !== undefined) return literal;
  const grouped = new Set<string>();
  for (const [quoted] of text.matchAll(SHELL_WORD)) {
    const word = quoted.replace(/["'`]/gu, '');
    if (!/[{}[\]]/u.test(word)) continue;
    if (word.includes('://') && /[{}[\]]/u.test(word.replace(BRACKETED, group => (isIP(group.slice(1, -1)) === 6 ? '' : group)))) {
      for (const match of word.matchAll(PORT)) if (ports.has(Number(match[1]))) return word;
    }
    grouped.add(word);
  }
  const budget: Budget = { left: 0 };
  let spare = WORK_BUDGET;
  let waiting = grouped.size;
  for (const word of [...grouped].sort((a, b) => a.length - b.length)) {
    budget.left = Math.floor(spare / waiting--);
    spare -= budget.left;
    for (const form of expandedForms(word, ports, budget)) {
      if (form === word) continue;
      budget.left -= form.length;
      if (budget.left < 0) break;
      if (literalTarget(form, ports, hosts) !== undefined) return word;
    }
    spare += Math.max(0, budget.left);
  }
  for (const match of plain.matchAll(PORT)) {
    if (!ports.has(Number(match[1]))) continue;
    const word = expandingHost(plain.slice(Math.max(0, match.index - 256), match.index));
    if (word !== undefined) return `${word}${match[0]}`;
  }
  return undefined;
}
