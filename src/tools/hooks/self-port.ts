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
const SEQUENCE = /^(?:(\d+)\.\.(\d+)|([a-z])\.\.([a-z]))(?:\.\.(-?\d+))?$/iu;
const FULL_SPAN = 64;
const SPAN_DIGITS = 10;
const SPAN_TEXT = 32;
const MAX_FORMS = 512;
const MAX_DEPTH = 6;
const WORK_BUDGET = 300_000;
const AUTHORITY_BUDGET = 20_000;
const PREFIX = /^(?:-{1,2}[A-Za-z][\w-]*=)?([a-z][a-z0-9+.-]*:\/{1,3})?/iu;
const HOST_TEXT = new RegExp(String.raw`^(?:${HOST_CHAR}|[:[\]])*$`, 'u');
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
  // bash は刻みの符号を見ない（{4779..4775..-2} は 4779 4777 4775）。向きは両端で決まる
  const step = Math.abs(Number(match[5] ?? 1)) || 1;
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

// cut: 組み合わせを全部は作らずに終わった（512 を超えて括弧を 1 つずつ動かした・仕事量が尽きた・深さの上限で括弧が残った）。1 つの括弧だけを 1 つずつ動かすのは全部を作るので数えない
interface Budget { left: number; cut: boolean }

const hasGroup = (form: string): boolean => /[{[]/u.test(form.replace(BRACKETED, group => (isIP(group.slice(1, -1)) === 6 ? '' : group)));

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
    if (budget.left < 0) { budget.cut = true; return false; }
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
    budget.cut ||= choices.length > 1;
    varied: for (let turn = 0; turn < choices.length; turn++) {
      for (const item of choices[turn]!) if (!build(index => (index === turn ? item : choices[index]![0]!))) break varied;
    }
  }
  if (depth >= MAX_DEPTH) {
    budget.cut ||= [...built].some(hasGroup);
    return [...built];
  }
  const out: string[] = [];
  for (const form of built) {
    if (budget.left < 0) { budget.cut = true; break; }
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

interface Authority { text: string; host: string; hostGroup: boolean }

// 語の「ホスト:ポート」の部分（--url=・scheme://・ユーザー情報・最初の括弧の外の / ? # 以降を除く）。展開の括弧があり、scheme:// か :ポート のある、ホストの形の語だけ。それ以外は undefined
// host はホストの部分から括弧を除いた文字（[::1] の IPv6 はそのまま）、hostGroup はホストの部分に展開の括弧があるか
function authorityOf(word: string): Authority | undefined {
  const prefix = PREFIX.exec(word)!;
  const text = word.slice(prefix[0].length);
  let depth = 0;
  let start = 0;
  let end = text.length;
  let host = '';
  let hostGroup = false;
  let group = false;
  let port = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (depth > 0) {
      if (ch === '{' || ch === '[') depth++;
      else if ((ch === '}' || ch === ']') && --depth === 0) { group = true; hostGroup ||= !port; }
      continue;
    }
    if (ch === '/' || ch === '?' || ch === '#') { end = i; break; }
    if (ch === '@') { start = i + 1; host = ''; hostGroup = false; group = false; port = false; continue; }
    if (ch === ':') { port = true; continue; }
    if (ch === '[') {
      const close = text.indexOf(']', i);
      if (close > i && isIP(text.slice(i + 1, close)) === 6) {
        if (!port) host += text.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    if (ch === '{' || ch === '[') depth = 1;
    else if (!port) host += ch;
  }
  return group && (port || prefix[1] !== undefined) && HOST_TEXT.test(host) ? { text: text.slice(start, end), host, hostGroup } : undefined;
}

function selfHost(host: string, hosts: readonly string[]): boolean {
  const normal = normalHost(host.replace(ZONE, '$1]'));
  return normal !== undefined && (loopbackHost(normal) || hosts.includes(normal));
}

// 広げきれなかった語（budget.cut）の「ホスト:ポート」の部分だけをもう一度広げる。全部を広げ終えて beat 自身でなければ通す。
// 括弧の組み合わせが多すぎて全部を作れないときは、残りの組み合わせの中に beat 自身があるかを言えないので、ホストに括弧がある（何に広がるか分からない）か、括弧を外したホストが手元か beat の別名なら当たりとする
function authorityHit(word: string, ports: ReadonlySet<number>, hosts: readonly string[], own: Budget): boolean {
  const target = authorityOf(word);
  if (target === undefined) return false;
  for (const form of expandedForms(target.text, ports, own)) {
    if (form === target.text) continue;
    own.left -= form.length;
    if (own.left < 0) { own.cut = true; break; }
    if (literalTarget(form, ports, hosts) !== undefined) return true;
  }
  return own.cut && (target.hostGroup || selfHost(target.host, hosts));
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
  const budget: Budget = { left: 0, cut: false };
  let spare = WORK_BUDGET;
  let waiting = grouped.size;
  for (const word of [...grouped].sort((a, b) => a.length - b.length)) {
    budget.left = Math.floor(spare / waiting--);
    budget.cut = false;
    spare -= budget.left;
    for (const form of expandedForms(word, ports, budget)) {
      if (form === word) continue;
      budget.left -= form.length;
      if (budget.left < 0) { budget.cut = true; break; }
      if (literalTarget(form, ports, hosts) !== undefined) return word;
    }
    spare += Math.max(0, budget.left);
    if (!budget.cut) continue;
    const own: Budget = { left: Math.min(AUTHORITY_BUDGET, spare), cut: false };
    spare -= own.left;
    if (authorityHit(word, ports, hosts, own)) return word;
    spare += Math.max(0, own.left);
  }
  for (const match of plain.matchAll(PORT)) {
    if (!ports.has(Number(match[1]))) continue;
    const word = expandingHost(plain.slice(Math.max(0, match.index - 256), match.index));
    if (word !== undefined) return `${word}${match[0]}`;
  }
  return undefined;
}
