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
const AUTHORITY_POOL = 200_000;
// 引用符で囲んだ 1 つの語（bash -c "curl 127.0.0.1:4[0-9]…"）には空白・; | & ( ) < > で分かれる語が入っているので、2 回目の確かめはその語ごとにする
const TOKEN_SPLIT = /[\s;&|()<>]+/u;
// 文字列をシェルがもう一度読む書き方: eval・source・. （コマンドの位置）・シェルの名前。シェルの名前は広く取る: 名前（/ や \ より後ろ）が sh で終わる語（bash・rbash・mksh・ksh93・posh・yash・ash・bash-5.2・sh5・pwsh…）と busybox・powershell・cmd・$SHELL。
// 広く取りすぎて（push・flush など）読み直しと数えても、縮めた JSON の除外が外れるだけ。:// のある語（URL）は数えない
const REPARSE_DOT = /(?:^|[;&|(\n])\s*\.\s/u;
const REPARSE_NAME = /^(?:eval|source|busybox|cmd|powershell|\$\{?shell\}?|[a-z]*sh)[\d.-]*(?:\.exe)?$/iu;
const REPARSE_SPLIT = /[\s;&|()<>"'`=]+/u;
const PREFIX = /^(?:-{1,2}[A-Za-z][\w-]*[=:])?([a-z][a-z0-9+.-]*:\/{1,3})?/iu;
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
    // 刻みや端が大きすぎて並べられない範囲（{4777..4777..-9007199254740993} は bash では 4777 だけ）は、中身が分からないので、並べきれなかったことにする
    if (span && !items) budget.cut = true;
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

interface Authority { text: string; host: string; hostGroup: boolean; hidden: boolean }

// 語の「ホスト:ポート」の部分（--url=・ユーザー情報・最初の括弧の外の / ? # 以降を除く。scheme:// は残す＝既定ポートも確かめられる）。
// 展開の括弧があり、scheme:// か :ポート か 括弧の中の : @ のある、ホストの形の語だけ。それ以外は undefined
// host はホストの部分から括弧を除いた文字（[::1] の IPv6 はそのまま）、hostGroup はホストの部分に展開の括弧があるか、
// hidden は括弧の中に : か @ があるか（括弧の外から見ると区切りが見えず、ホストとポートの境目が決まらない）
function authorityOf(word: string): Authority | undefined {
  const prefix = PREFIX.exec(word)!;
  const text = word.slice(prefix[0].length);
  let depth = 0;
  let start = 0;
  let from = 0;
  let end = text.length;
  let host = '';
  let hostGroup = false;
  let group = false;
  let hidden = false;
  let port = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (depth > 0) {
      if (ch === '{' || ch === '[') depth++;
      else if ((ch === '}' || ch === ']') && --depth === 0) { group = true; hostGroup ||= !port; hidden ||= /[:@]/u.test(text.slice(from, i)); }
      continue;
    }
    if (ch === '/' || ch === '?' || ch === '#') { end = i; break; }
    if (ch === '@') { start = i + 1; host = ''; hostGroup = false; group = false; hidden = false; port = false; continue; }
    if (ch === ':') { port = true; continue; }
    if (ch === '[') {
      const close = text.indexOf(']', i);
      if (close > i && isIP(text.slice(i + 1, close)) === 6) {
        if (!port) host += text.slice(i, close + 1);
        i = close;
        continue;
      }
    }
    if (ch === '{' || ch === '[') { depth = 1; from = i + 1; }
    else if (!port) host += ch;
  }
  return group && (port || hidden || prefix[1] !== undefined) && HOST_TEXT.test(host) ? { text: (prefix[1] ?? '') + text.slice(start, end), host, hostGroup, hidden } : undefined;
}

// 縮めた JSON の本文（'…' か "…" で丸ごと囲んだ { } か [ ] の JSON。-d'…'・--data='…' のように旗がくっついた形も）。キーと値の : が括弧の中に並ぶだけで、宛先ではない
function jsonPayload(raw: string): boolean {
  const quoted = /^(?:-{1,2}[A-Za-z][\w-]*=?)?(?:'([^']*)'|"((?:[^"\\]|\\.)*)")$/u.exec(raw);
  const body = quoted?.[1] ?? quoted?.[2]?.replace(/\\(["\\])/gu, '$1');
  if (body === undefined || !/^\s*[{[]/u.test(body)) return false;
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null;
  } catch { return false; }
}

function selfHost(host: string, hosts: readonly string[]): boolean {
  const normal = normalHost(host.replace(ZONE, '$1]'));
  return normal !== undefined && (loopbackHost(normal) || hosts.includes(normal));
}

// 広げきれなかった語（budget.cut）の「ホスト:ポート」の部分だけをもう一度広げる。全部を広げ終えて beat 自身でなければ通す。
// 括弧の組み合わせが多すぎて全部を作れないときは、残りの組み合わせの中に beat 自身があるかを言えないので、ホストに括弧がある（何に広がるか分からない）か、
// 括弧の中に : や @ がある（ホストとポートの境目が決まらない）か、括弧を外したホストが手元か beat の別名なら当たりとする
function authorityHit(word: string, ports: ReadonlySet<number>, hosts: readonly string[], own: Budget): boolean {
  const target = authorityOf(word);
  if (target === undefined) return false;
  for (const form of expandedForms(target.text, ports, own)) {
    if (form === target.text) continue;
    own.left -= form.length;
    if (own.left < 0) { own.cut = true; break; }
    if (literalTarget(form, ports, hosts) !== undefined) return true;
  }
  return own.cut && (target.hostGroup || target.hidden || selfHost(target.host, hosts));
}

// 2 回目の確かめにかける語の分け方。空白・; & | ( ) < > で分けた語（引用符の文の中の語）を、さらに括弧の外の , と = で分ける:
// PowerShell の配列 "-s","127.0.0.1:…" や代入 U=127.0.0.1:… のホストは , = の直後にある。括弧は閉じて対になったものだけ数える（閉じない { が , = の分けを止めない）。
// 分ける前の語もそのまま残す（http://user,x@{x,l}ocalhost/… のようにスキームを含む書き方を、これまでどおり確かめる）
function tokensOf(word: string): string[] {
  return word.split(TOKEN_SPLIT).flatMap(chunk => {
    const open: number[] = [];
    const paired = new Set<number>();
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (ch === '{' || ch === '[') open.push(i);
      else if ((ch === '}' || ch === ']') && open.length > 0 && chunk[open[open.length - 1]!] === (ch === '}' ? '{' : '[')) { paired.add(open.pop()!); paired.add(i); }
    }
    const pieces: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (paired.has(i)) depth += ch === '{' || ch === '[' ? 1 : -1;
      else if (depth === 0 && (ch === ',' || ch === '=')) { pieces.push(chunk.slice(start, i)); start = i + 1; }
    }
    return pieces.length === 0 ? [chunk] : [chunk, ...pieces, chunk.slice(start)];
  });
}

// 文字列をシェルがもう一度読む書き方があるか（JSON の本文を除いた文を見る）
function readsAgain(rest: string): boolean {
  return REPARSE_DOT.test(rest) || rest.split(REPARSE_SPLIT).some(token => !token.includes('://') && REPARSE_NAME.test(token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1)));
}

export function selfTarget(text: string, server: SelfServer): string | undefined {
  const { ports, hosts } = selfPortsOf(server);
  const plain = text.replace(/["'`]/gu, '');
  const literal = literalTarget(plain, ports, hosts);
  if (literal !== undefined) return literal;
  const grouped = new Map<string, boolean>();
  // JSON の本文を取り除いた文（語の位置から 1 回で作る。JSON が何万語あっても読む量は文の長さだけ）
  let rest = '';
  let tail = 0;
  let hasJson = false;
  for (const found of text.matchAll(SHELL_WORD)) {
    const quoted = found[0];
    const word = quoted.replace(/["'`]/gu, '');
    if (!/[{}[\]]/u.test(word)) continue;
    if (word.includes('://') && /[{}[\]]/u.test(word.replace(BRACKETED, group => (isIP(group.slice(1, -1)) === 6 ? '' : group)))) {
      for (const match of word.matchAll(PORT)) if (ports.has(Number(match[1]))) return word;
    }
    const json = jsonPayload(quoted);
    if (json) { hasJson = true; rest += `${text.slice(tail, found.index)} `; tail = found.index + quoted.length; }
    grouped.set(word, (grouped.get(word) ?? true) && json);
  }
  rest += text.slice(tail);
  // 縮めた JSON の本文を 2 回目の確かめから外すのは、その文字列をシェルが読み直さないときだけ。eval・シェルの -c・シェルへの pipe などがあると、
  // JSON の { } と , が括弧の展開に読まれて "http":"//127.0.0.1":"4777/…" が http://127.0.0.1:4777/… になる。JSON の外の部分に読み直す書き方があれば外さない
  const reads = hasJson && readsAgain(rest);
  const exempt = (word: string): boolean => grouped.get(word) === true && !reads;
  const budget: Budget = { left: 0, cut: false };
  let spare = WORK_BUDGET;
  let waiting = grouped.size;
  const unfinished: string[] = [];
  for (const word of [...grouped.keys()].sort((a, b) => a.length - b.length)) {
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
    if (budget.cut && !exempt(word)) unfinished.push(word);
  }
  // 2 回目の確かめは 1 回目が全部終わってから、専用の仕事量で行う（1 回目の語ごとの仕事量を減らさない）。引用符の文の中の語（curl 127.0.0.1:…）も、分けた語ごとに確かめる
  let pool = AUTHORITY_POOL;
  for (const word of unfinished) {
    for (const token of tokensOf(word)) {
      if (!/[{}[\]]/u.test(token)) continue;
      const own: Budget = { left: Math.min(AUTHORITY_BUDGET, pool), cut: false };
      pool -= own.left;
      if (authorityHit(token, ports, hosts, own)) return word;
      pool += Math.max(0, own.left);
    }
  }
  for (const match of plain.matchAll(PORT)) {
    if (!ports.has(Number(match[1]))) continue;
    const word = expandingHost(plain.slice(Math.max(0, match.index - 256), match.index));
    if (word !== undefined) return `${word}${match[0]}`;
  }
  return undefined;
}
