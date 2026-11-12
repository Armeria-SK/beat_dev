const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:sk|or-v1)-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
];
const URL_CREDENTIAL = /(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const URL_USERINFO_PASSWORD = /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s/?#@:]*:)[^\s/?#@]+@/gi;
const URL_PARAM = /(?<=[?&#]|&amp;|\\u0026)([A-Za-z_][A-Za-z0-9_.-]*)=[^\s&#"'`<>\\]+/g;
const URL_PARAM_SECRET_NAME = /^(?:key|sig|code)$|(?:^|[_-])signature$/i;
const URL_PARAM_SEPARATOR = /(?:[?&#]|&amp;|\\u0026)$/;
const PRIVATE_KEY_MARKER = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/g;
const ASSIGNMENT_HEAD = /(?<![A-Za-z0-9_])[0-9]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*/g;
const ASSIGNMENT_VALUE = /"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+/y;
const SENSITIVE_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|SESSION_KEY|AUTH|AUTHORIZATION|COOKIE|COOKIES|CREDENTIAL|CREDENTIALS|PRIVATE_KEY)(?:_|$)/i;

export interface SanitizedModelInputText {
  readonly text: string;
  readonly redaction_count: number;
}

export function isSensitiveName(input: string): boolean {
  const normalized = input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toUpperCase();
  return SENSITIVE_NAME.test(normalized);
}

export function sanitizeModelInputText(input: string): SanitizedModelInputText {
  let text = input;
  let redactionCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return '[REDACTED]';
    });
  }
  const jwt = redactJwt(text);
  text = jwt.text;
  redactionCount += jwt.redaction_count;
  text = text.replace(URL_CREDENTIAL, () => { redactionCount += 1; return '[REDACTED]'; });
  const keys = redactPrivateKeys(text);
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

function redactPrivateKeys(input: string): SanitizedModelInputText {
  const ranges: Array<readonly [number, number]> = [];
  let start: number | undefined;
  for (const match of input.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'BEGIN' && start === undefined) start = match.index;
    else if (match[1] === 'END' && start !== undefined) {
      ranges.push([start, match.index + match[0].length]);
      start = undefined;
    }
  }
  return replaceRanges(input, ranges);
}
function replaceRanges(input: string, ranges: readonly (readonly [number, number])[]): SanitizedModelInputText {
  if (ranges.length === 0) return { text: input, redaction_count: 0 };
  const parts: string[] = [];
  let start = 0;
  for (const [from, to] of ranges) { parts.push(input.slice(start, from), '[REDACTED]'); start = to; }
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
export function redactExact(input: string, exactSecrets: readonly string[]): string {
  const forms = new Set<string>();
  for (const secret of exactSecrets) {
    if (secret.trim().length === 0) continue;
    forms.add(secret);
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  let redacted = input;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    const pattern = form.split(/\s+/u).map(part => part.replace(REGEX_SPECIAL, '\\$&')).join('\\s+');
    redacted = redacted.replace(new RegExp(pattern, 'gu'), '[REDACTED]');
  }
  return redacted;
}

export function redactSecrets(input: string, exactSecrets: readonly string[] = []): string {
  let redacted = redactExact(input, exactSecrets);
  redacted = sanitizeModelInputText(redacted).text;
  redacted = redacted.replace(URL_USERINFO_PASSWORD, '$1[REDACTED]@');
  redacted = redacted.replace(URL_PARAM, (match, name: string) =>
    isSensitiveName(name) || URL_PARAM_SECRET_NAME.test(name) ? `${name}=[REDACTED]` : match);
  return redactAssignments(redacted);
}

function redactAssignments(input: string): string {
  const head = new RegExp(ASSIGNMENT_HEAD.source, ASSIGNMENT_HEAD.flags);
  const value = new RegExp(ASSIGNMENT_VALUE.source, ASSIGNMENT_VALUE.flags);
  const parts: string[] = [];
  let copied = 0;
  // A name is scanned only from its start. Leading digits stay in the head because
  // the legacy matcher also recognized assignments in e.g. `1api_key=value`.
  for (let match = head.exec(input); match !== null; match = head.exec(input)) {
    if (!isSensitiveName(match[1]!)) continue;
    const valueStart = head.lastIndex;
    value.lastIndex = valueStart;
    if (!value.test(input)) continue;
    if (input.startsWith('[REDACTED]', valueStart) && URL_PARAM_SEPARATOR.test(input.slice(Math.max(0, match.index - 6), match.index))) continue;
    parts.push(input.slice(copied, valueStart), '[REDACTED]');
    copied = head.lastIndex = value.lastIndex;
  }
  parts.push(input.slice(copied));
  return parts.join('');
}

export function redactDisplaySnapshot(input: string): string {
  const assignment=/(?:["']?)([A-Za-z_][A-Za-z0-9_-]*)(?:["']?)\s*[:=]\s*(["'])/g;
  for(const match of input.matchAll(assignment)) {
    if(!isSensitiveName(match[1]!))continue;
    let closed=false;
    for(let i=match.index!+match[0].length;i<input.length;i++) {
      if(input[i]==='\\'){i++;continue;}
      if(input[i]===match[2]){closed=true;break;}
    }
    if(!closed)return redactSecrets(input.slice(0,match.index))+'[REDACTED]';
  }
  return redactSecrets(input);
}
