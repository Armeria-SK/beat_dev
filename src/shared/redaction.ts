const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|or-v1)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // 前に語の文字がくっついた鍵（`x` + `sk-ant-…`）。頭の `\b` が無いので、ふつうの語に出ない頭だけにする（ただの `sk-` には付けない）
  /(?:sk-ant-|sk-proj-|sk-or-v1-|sk-svcacct-)[A-Za-z0-9_-]{8,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
];
const URL_CREDENTIAL = /(?:https?:\/\/)[^\s/@:]+:[^\s/]+@/gi;
const URL_USERINFO_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/?#@:[]*:)(?:[^\s/?#]+@|(?!\d*(?:[/?#"',)\]}\\]|$))[^\s@]{1,256}@)/gi;
const URL_USERINFO_TOKEN = /\b(https?:\/\/)[^\s/?#@:]{20,}@/gi;
const URL_PARAM = /(?<=[?&#;]|\\u0026)((?:[A-Za-z0-9_.[\]-]|%[0-9A-Fa-f]{2})+)=((?:[^\s&#"'`<>\\]|\\\/)+(?:["'`<>](?=[A-Za-z0-9])(?:[^\s&#"'`<>\\]|\\\/)*)*)/g;
const ENCODED_URL_PARAM = /(?<=%3F|%26|%23)([A-Za-z0-9_.-]+)%3D(?:(?!%26|%23)[^\s&#"'`<>\\])+/gi;
const URL_ONLY_SECRET_NAME = /^(?:PASS|PWD|SID|OTP|J?SESSION_?ID|PHPSESSID)$|(?:^|_)SIGNATURE$/;
const URL_LONG_SECRET_NAME = /^(?:KEY|SIG|CODE)$/;
const URL_LONG_SECRET_MIN = 16;
const URL_PARAM_SEPARATOR = /(?:[?&#;]|\\u0026)$/;
const PRIVATE_KEY_MARKER = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const ASSIGNMENT_HEAD = /(?<![A-Za-z0-9_-])[0-9-]*["']?([A-Za-z_][A-Za-z0-9_-]*)(?:\\*["'])?\s*[:=][ \t]*(?:\r?\n[ \t]+)?/g;
const ASSIGNMENT_VALUE = /\\*"[^"\r\n]*"|\\*'[^'\r\n]*'|[^\s,;}\r\n]+/y;
const AUTH_SCHEME = /^(?:Basic|Bearer|Digest|Negotiate|NTLM|Token)$/i;
const AUTH_SCHEME_VALUE = /[ \t]+[^\s,;}"'\\]+/y;
const COOKIE_NAME = /cookies?$/i;
const COOKIE_VALUE = /[^"'\\\r\n]+/y;
const FLAG_HEAD = /(?<![A-Za-z0-9_-])--?([A-Za-z][A-Za-z0-9_-]*)[ \t]+(?!-)/g;
const USER_FLAG = /(?<![A-Za-z0-9_-])((?:-u|--user|--proxy-user)(?:[ \t]+|=)["']?([^\s:"'=\\]+):)([^\s"'\\]+)/g;
const FLAG_VALUE = /\\*"[^"\r\n]*"(?=\s|$)|\\*'[^'\r\n]*'(?=\s|$)|[^\s,;}"'\\]+/y;
const MYSQL_PASSWORD = /(\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\r\n|;&]{0,300}?\s-p)(?:"[^"\r\n]*"(?=\s|$)|'[^'\r\n]*'(?=\s|$)|[^\s"'\\-][^\s"'\\]*)/g;
const SENSITIVE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|[A-Z]*PASSWORD|[A-Z]*PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY|SESSION_KEY|SIGNING_KEY|AUTH|AUTHORIZATION|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|JWT|HMAC|OAUTH_VERIFIER)(?:_|$)|[A-Z0-9]_(?:PASS|PWD)$/;
const NOT_SECRET_SUFFIX = /_(?:TYPE|COUNT|LIMIT|BUDGET|USAGE|ENDPOINT|URL|URI|EXPIRES|EXPIRES_IN|EXPIRY|TTL|LENGTH)$/;

export interface SanitizedModelInputText {
  readonly text: string;
  readonly redaction_count: number;
}

function normalizeName(input: string): string {
  return input.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase();
}

export function isSensitiveName(input: string): boolean {
  const normalized = normalizeName(input);
  return SENSITIVE_NAME.test(normalized) && !NOT_SECRET_SUFFIX.test(normalized);
}

export function isSensitiveEnvName(input: string): boolean {
  return SENSITIVE_NAME.test(normalizeName(input));
}

function lastNamePart(input: string): string {
  return input.trim().split(/[.[\]]+/u).filter(part => part !== '').at(-1) ?? '';
}

function isSensitiveKey(key: string): boolean {
  return isSensitiveName(lastNamePart(key));
}

function redactUrlParam(match: string, rawName: string, rawValue: string): string {
  let decoded = rawName;
  if (rawName.includes('%')) { try { decoded = decodeURIComponent(rawName); } catch { decoded = rawName; } }
  const name = lastNamePart(decoded);
  const normalized = normalizeName(name);
  const tail = rawValue.endsWith(')') && !rawValue.includes('(') ? ')' : '';
  const length = rawValue.length - tail.length;
  const secret = isSensitiveName(name) || URL_ONLY_SECRET_NAME.test(normalized) || (URL_LONG_SECRET_NAME.test(normalized) && length >= URL_LONG_SECRET_MIN);
  return secret && length > 0 ? `${rawName}=[REDACTED]${tail}` : match;
}

const masked = (matched: string, keepLines: boolean): string => (keepLines ? `[REDACTED]${'\n'.repeat(matched.split('\n').length - 1)}` : '[REDACTED]');

export function sanitizeModelInputText(input: string, keepLines = false): SanitizedModelInputText {
  let text = input;
  let redactionCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, matched => {
      redactionCount += 1;
      return masked(matched, keepLines);
    });
  }
  const jwt = redactJwt(text);
  text = jwt.text;
  redactionCount += jwt.redaction_count;
  text = text.replace(URL_CREDENTIAL, matched => { redactionCount += 1; return masked(matched, keepLines); });
  const keys = redactPrivateKeys(text, keepLines);
  text = keys.text;
  redactionCount += keys.redaction_count;
  return Object.freeze({ text, redaction_count: redactionCount });
}

interface Segment { readonly start: number; readonly end: number; readonly last_word_end: number; readonly candidate?: number; }

function redactJwt(input: string): SanitizedModelInputText {
  const ranges: Array<readonly [number, number]> = [];
  let cursor = 0;
  let previous: Segment[] = [];
  while (cursor < input.length) {
    if (!isBase64Url(input.charCodeAt(cursor))) { cursor += 1; continue; }
    const start = cursor;
    let candidate: number | undefined, lastWordEnd = start;
    while (cursor < input.length && isBase64Url(input.charCodeAt(cursor))) {
      if (candidate === undefined && input.startsWith('eyJ', cursor) && !isWord(input.charCodeAt(cursor - 1))) candidate = cursor;
      if (isWord(input.charCodeAt(cursor))) lastWordEnd = cursor + 1;
      cursor += 1;
    }
    const segment: Segment = { start, end: cursor, last_word_end: lastWordEnd, ...(candidate === undefined || candidate + 3 >= cursor ? {} : { candidate }) };
    const last = previous.at(-1);
    if (last === undefined || start !== last.end + 1 || input[last.end] !== '.') previous = [];
    previous.push(segment);
    if (previous.length < 3) continue;
    const first = previous[0]!;
    if (first.candidate !== undefined && segment.last_word_end > segment.start) {
      ranges.push([first.candidate, segment.last_word_end]);
      previous = [];
    } else previous.shift();
  }
  return replaceRanges(input, ranges);
}

function privateKeyRanges(input: string, opened: boolean): { ranges: Array<readonly [number, number]>; open: boolean } {
  const ranges: Array<readonly [number, number]> = [];
  let start: number | undefined = opened ? 0 : undefined;
  for (const match of input.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'BEGIN' && start === undefined) start = match.index;
    else if (match[1] === 'END' && start !== undefined) {
      ranges.push([start, match.index + match[0].length]);
      start = undefined;
    }
  }
  return { ranges, open: start !== undefined };
}

const PEM_HEADER = /^[A-Za-z][A-Za-z0-9-]*:/u;

function blankLineStarts(input: string): number[] {
  const starts: number[] = [];
  for (let pos = 0; pos <= input.length;) {
    const newline = input.indexOf('\n', pos);
    const lineEnd = newline < 0 ? input.length : newline;
    if (input.slice(pos, lineEnd).trim() === '') starts.push(pos);
    if (newline < 0) break;
    pos = newline + 1;
  }
  return starts;
}

function openKeyEnd(input: string, from: number, blanks: () => readonly number[]): number {
  for (let pos = from; ;) {
    const newline = input.indexOf('\n', pos);
    const lineEnd = newline < 0 ? input.length : newline;
    const line = input.slice(pos, lineEnd).trim();
    if (line !== '' && !PEM_HEADER.test(line)) {
      const list = blanks();
      let low = 0;
      let high = list.length;
      while (low < high) { const mid = (low + high) >> 1; if (list[mid]! > pos) high = mid; else low = mid + 1; }
      const blank = list[low];
      if (blank === undefined) return input.length;
      return input[blank - 2] === '\r' ? blank - 2 : blank - 1;
    }
    if (newline < 0) return input.length;
    pos = newline + 1;
  }
}

function strayEndStart(input: string, at: number, floor: number): number {
  let start = at;
  let lineEnd = at;
  for (;;) {
    const lineStart = Math.max(floor, input.lastIndexOf('\n', lineEnd - 1) + 1);
    if (lineEnd !== at && input.slice(lineStart, lineEnd).trim() === '') return start;
    start = lineStart;
    if (lineStart <= floor) return start;
    lineEnd = lineStart - 1;
  }
}

function redactPrivateKeys(input: string, keepLines = false): SanitizedModelInputText {
  const ranges: Array<readonly [number, number]> = [];
  let open: { start: number; bodyFrom: number; end?: number } | undefined;
  let blankList: number[] | undefined;
  const blanks = (): readonly number[] => (blankList ??= blankLineStarts(input));
  const openEnd = (key: { bodyFrom: number; end?: number }): number => (key.end ??= openKeyEnd(input, key.bodyFrom, blanks));
  for (const match of input.matchAll(PRIVATE_KEY_MARKER)) {
    const end = match.index + match[0].length;
    if (match[1] === 'BEGIN') {
      if (open) {
        if (match.index < openEnd(open)) continue;
        ranges.push([open.start, openEnd(open)]);
      }
      open = { start: match.index, bodyFrom: end };
      continue;
    }
    ranges.push([open?.start ?? strayEndStart(input, match.index, ranges.at(-1)?.[1] ?? 0), end]);
    open = undefined;
  }
  if (open) ranges.push([open.start, openEnd(open)]);
  return replaceRanges(input, ranges, keepLines);
}

export function redactKeyEcho(echo: string): { text: string; open: boolean } {
  const { ranges, open } = privateKeyRanges(echo, false);
  return { text: replaceRanges(echo, ranges).text.replace(PRIVATE_KEY_MARKER, '[REDACTED]'), open };
}

export function redactOpenKey(output: string): string {
  const first = privateKeyRanges(output, true).ranges[0];
  return first ? `[REDACTED]${output.slice(first[1])}` : output;
}
function replaceRanges(input: string, ranges: readonly (readonly [number, number])[], keepLines = false): SanitizedModelInputText {
  if (ranges.length === 0) return { text: input, redaction_count: 0 };
  const parts: string[] = [];
  let start = 0;
  for (const [from, to] of ranges) { parts.push(input.slice(start, from), masked(input.slice(from, to), keepLines)); start = to; }
  parts.push(input.slice(start));
  return { text: parts.join(''), redaction_count: ranges.length };
}
function isWord(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95;
}
function isBase64Url(code: number): boolean { return isWord(code) || code === 45; }

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

// 鍵そのものを伏せる。鍵の途中の空白は、2 つ以上・改行・タブなど並びが変わっていても同じ鍵として伏せる（相手が空白をそろえて返しても残さない）。
// JSON の文字列の中の書き方（\ と " のエスケープ）も伏せる。長い鍵から先に伏せる（短い鍵が長い鍵の一部のとき、断片を残さない）
export function redactExact(input: string, exactSecrets: readonly string[], keepLines = false): string {
  const forms = new Set<string>();
  for (const secret of exactSecrets) {
    if (secret.trim().length === 0) continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  let redacted = input;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    const pattern = form.split(/\s+/u).map(part => part.replace(REGEX_SPECIAL, '\\$&')).join('\\s+');
    redacted = redacted.replace(new RegExp(pattern, 'gu'), matched => masked(matched, keepLines));
  }
  return redacted;
}

export function redactSecrets(input: string, exactSecrets: readonly string[] = [], options: { keepLines?: boolean } = {}): string {
  const keepLines = options.keepLines === true;
  let redacted = redactExact(input, exactSecrets, keepLines);
  redacted = sanitizeModelInputText(redacted, keepLines).text;
  redacted = redacted.replace(URL_USERINFO_PASSWORD, '$1[REDACTED]@');
  redacted = redacted.replace(URL_USERINFO_TOKEN, '$1[REDACTED]@');
  redacted = redacted.replace(URL_PARAM, redactUrlParam);
  redacted = redacted.replace(ENCODED_URL_PARAM, (match, name: string) => (isSensitiveName(name) ? `${name}%3D[REDACTED]` : match));
  redacted = redactFlagValues(redactAssignments(redacted));
  redacted = redacted.replace(USER_FLAG, (match, head: string, user: string, password: string) =>
    /^\d+$/u.test(user) && /^\d+$/u.test(password) ? match : `${head}[REDACTED]`);
  return redacted.replace(MYSQL_PASSWORD, '$1[REDACTED]');
}

function redactFlagValues(input: string): string {
  const head = new RegExp(FLAG_HEAD.source, FLAG_HEAD.flags);
  const value = new RegExp(FLAG_VALUE.source, FLAG_VALUE.flags);
  const parts: string[] = [];
  let copied = 0;
  for (let match = head.exec(input); match !== null; match = head.exec(input)) {
    if (!isSensitiveName(match[1]!)) continue;
    value.lastIndex = head.lastIndex;
    if (!value.test(input)) continue;
    parts.push(input.slice(copied, head.lastIndex), '[REDACTED]');
    copied = head.lastIndex = value.lastIndex;
  }
  parts.push(input.slice(copied));
  return parts.join('');
}

function redactAssignments(input: string): string {
  const head = new RegExp(ASSIGNMENT_HEAD.source, ASSIGNMENT_HEAD.flags);
  const value = new RegExp(ASSIGNMENT_VALUE.source, ASSIGNMENT_VALUE.flags);
  const scheme = new RegExp(AUTH_SCHEME_VALUE.source, AUTH_SCHEME_VALUE.flags);
  const cookie = new RegExp(COOKIE_VALUE.source, COOKIE_VALUE.flags);
  const parts: string[] = [];
  let copied = 0;
  // A name is scanned only from its start. Leading digits stay in the head because
  // the legacy matcher also recognized assignments in e.g. `1api_key=value`.
  for (let match = head.exec(input); match !== null; match = head.exec(input)) {
    if (!isSensitiveName(match[1]!)) continue;
    const valueStart = head.lastIndex;
    if (input.startsWith('[REDACTED]', valueStart) && URL_PARAM_SEPARATOR.test(input.slice(Math.max(0, match.index - 6), match.index))) {
      head.lastIndex = valueStart + '[REDACTED]'.length;
      continue;
    }
    value.lastIndex = valueStart;
    let end = value.test(input) ? value.lastIndex : -1;
    if (COOKIE_NAME.test(match[1]!)) {
      cookie.lastIndex = valueStart;
      const line = cookie.test(input) ? cookie.lastIndex : -1;
      if (line >= end || /^[\\"']+$/u.test(input.slice(Math.max(line, valueStart), end))) end = line;
      else if (line >= 0) { cookie.lastIndex = end; if (cookie.test(input)) end = cookie.lastIndex; }
    } else if (end >= 0 && AUTH_SCHEME.test(input.slice(valueStart, end))) {
      scheme.lastIndex = end;
      if (scheme.test(input)) end = scheme.lastIndex;
    }
    if (end < 0) continue;
    parts.push(input.slice(copied, valueStart), '[REDACTED]');
    copied = head.lastIndex = end;
  }
  parts.push(input.slice(copied));
  return parts.join('');
}

const JSON_DEPTH_LIMIT = 100;

function redactJson(value: unknown, keys: boolean, depth: number): unknown {
  if (typeof value === 'string') return value.length < 6 && !/[=:@]/u.test(value) ? value : redactSecrets(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= JSON_DEPTH_LIMIT) return '[REDACTED]';
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && isSensitiveKey(value[0])) return [value[0], '[REDACTED]'];
    return value.map(item => redactJson(item, keys, depth + 1));
  }
  const named = Object.entries(value).some(([key, item]) => (key === 'name' || key === 'key') && typeof item === 'string' && isSensitiveKey(item));
  const renamed = new Map(Object.keys(value).map(key => [key, keys ? redactSecrets(key) : key]));
  const taken = new Set([...renamed].filter(([key, masked]) => masked === key).map(([key]) => key));
  const keyOf = (key: string): string => {
    const masked = renamed.get(key)!;
    if (masked === key) return key;
    let name = masked;
    for (let n = 2; taken.has(name); n++) name = `${masked} (${n})`;
    taken.add(name);
    return name;
  };
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [keyOf(key), isSensitiveKey(key) || (named && key === 'value') ? '[REDACTED]' : redactJson(item, keys, depth + 1)]));
}

export function redactJsonValue(value: unknown, depth = 0): unknown {
  return redactJson(value, true, depth);
}

export function redactJsonValues(value: unknown): unknown {
  return redactJson(value, false, 0);
}
