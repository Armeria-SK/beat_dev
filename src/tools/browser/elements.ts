// ページの「触れるもの」の一覧。元は Playwright の公開の API（page.ariaSnapshot({ mode: 'ai' })）の文。各行に Playwright の印 [ref=…] が付く。
// 番号（P3a）: beat の番号は Playwright の印（要素そのもの）に結ぶ。さらに要素ごとに、モデルに見せたときの周りの中身（手がかり）を覚え、
//   同じ文書・同じ印・同じ役割と名前・同じ手がかりのあいだだけ同じ番号。どれか 1 つでも違えば、その要素の番号だけ使えなくして新しい番号を振る。
//   文書が変わったら（主フレームの移動・再読み込み）全部使えなくする。番号は会話のタブで共通の続きの数で、振り直さない
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Language } from '../../config/schema.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { pageUrl as publicPageUrl } from '../web/public-page.ts';
import { BrowserFailure } from './driver.ts';
import { sentText } from './sent.ts';

export const NUMBERED_ROLES: ReadonlySet<string> = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
]);
// 見せるのは 300 件まで（道具の結果の上限に収まる分だけ。番号を振るのは見せる要素だけ）
export const MAX_ELEMENTS = 300;
// 番号は e1〜e999999。使い切ったら断る
export const REF_MAX = 999_999;
// beat の起動ごとの番号の始まり（1〜9,000 のどこか）。起動し直したあとに、前の起動の番号が同じ番号の別の要素に当たりにくくする。
// 始まりが最大でも、使い切るまで 990,000 個以上ある
const REF_START_SPAN = 9_000;
export const randomRefStart = (): number => 1 + randomInt(REF_START_SPAN);
const NAME_SHOWN = 100;
// 子から作った名前の長さの上限（字）
const DERIVED_NAME_MAX = 900;
// 組の最初の要素の前・最後の要素のあとに、手がかりに入れる行の数
const EDGE_LINES = 8;
// 使えなくなった番号を覚えておく数（断る文を「使えなくなりました」にするため）
const RETIRED_KEPT = 20_000;
// 値（ariaSnapshot の「: 値」）を持つ入力欄。ふだんは値を手がかりに入れず、この欄を中に持つ行の名前（値を含む）も入れない
const VALUE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
// 手がかりに入れない印（焦点・カーソル・位置で変わるもの、と Playwright の印そのもの）
const VOLATILE_ATTR = /^(?:ref=.*|active|cursor=.*|box=.*)$/u;
const MARKS = / \[(?:ref=[^\]]*|active|cursor=[^\]]*|box=[^\]]*)\]/gu;
// あいだの行のまとめ（鍵つきの多項式。鍵は起動ごとの乱数）
const MOD = (1n << 61n) - 1n;
const BASE = BigInt(`0x${randomBytes(8).toString('hex')}`) % (MOD - 2n) + 2n;

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  // Playwright の印（その表の、その要素そのもの。page.getByRef で引く）。モデルには見せない
  pwRef: string;
  // 別のホストの iframe の中には番号を振らないので、いまは main frame（undefined）だけ
  frameUrl: string | undefined;
}

export interface ListedElement extends ElementRef {
  // pageUrl を通ったリンク先（無ければ undefined）
  href: string | undefined;
  states: string[];
}

export interface ElementTable {
  // 読んだときのページの URL。遷移して URL が変わったら、この表は捨てる
  url: string;
  // 番号のある要素（show: 見せる要素。check: 前の番号がまだ使える要素）
  items: ListedElement[];
  // 表に入れなかった要素の数（300 件と道具の結果の上限を超えた分。差分の形では、番号を振れなかった変化の数）
  omitted: number;
  // diff で読んだときだけ: 差分の形か、移動・大きすぎる差分で表の形に落としたか
  diff?: DiffResult | undefined;
}

// 差分。新しい番号（items）は増えた要素だけ。dead: 見せた番号のうち使えなくなったもの（present: 要素はまだあるが中身が変わった）。
// 中身が変わった要素には新しい番号を渡さず、読み直させる（同じ印の要素でも、周りの中身が入れ替わると別の意味の要素になりうる）
export type DiffResult =
  | { form: 'diff'; dead: ReadonlyArray<{ ref: string; present: boolean }> }
  | { form: 'table'; reason: 'navigated' | 'too_big' };

// 会話のブラウザに 1 つの続きの数（タブで共通）
export interface RefCounter { next: number }

// 1 つの beat の番号が結ぶもの
interface RefRecord { ref: string; role: string; name: string; clue: string }

// タブごとの番号の対応。URL か文書が変わったら全部使えなくする（数は続きから）
export interface RefBook {
  readonly counter: RefCounter;
  url: string | undefined;
  document: number | undefined;
  // Playwright の印 → beat の番号の記録
  readonly records: Map<string, RefRecord>;
  // 使えなくなった番号
  readonly retired: Set<string>;
  // モデルに見せた番号（表の 300 件・差分・find）。見せていない番号は押せない
  readonly shown: Set<string>;
  // 差分の元（P3b）。view: 見せた番号 → Playwright の印（使えなくなったと差分で知らせるまで残す）。
  // seen: 最後に見せる形（show / diff）で読んだときの要素（印 → 役割と名前）。押す前の取り直し（check）では変えない
  readonly view: Map<string, string>;
  readonly seen: Map<string, string>;
}

export function newRefBook(counter: RefCounter = { next: 1 }): RefBook {
  return { counter, url: undefined, document: undefined, records: new Map(), retired: new Set(), shown: new Set(), view: new Map(), seen: new Map() };
}

const KEY = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)$/u;
const TAIL = /^(?::(?: (.*))?)?$/u;
const ITEM = /^( *)- (.*)$/u;
const URL_LINE = /^\/url: (.*)$/u;
const STATES = new Set(['disabled', 'checked', 'selected', 'expanded', 'pressed']);

function unquote(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

function resolveHref(raw: string, base: string): string | undefined {
  try { return publicPageUrl(new URL(raw.trim(), base).href).href; } catch { return undefined; }
}

const flatText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

// ariaSnapshot の 1 行。attrs は手がかりに入れる [checked] などの並び、url はその行の下の /url:（リンク先）、parent は親の行。
// raw: 読めなかった行の生の文（印を外したもの。役割は空）
interface Line { indent: number; role: string; name: string; attrs: string; inline: string; url: string; pwRef: string | undefined; raw: string | undefined; hasInput: boolean; inFrame: boolean; parent: number }
interface Entry { role: string; name: string; pwRef: string | undefined; href: string | undefined; states: string[]; line: number; derived: boolean }

// 「- 」のあとの中身を、役割・名前・印・値に分ける。行全体が YAML の一重引用（名前に「: 」などを含む）なら、'' を ' に戻してから読む
function parseItem(body: string): { role: string; name: string; attrs: string[]; inline: string } | undefined {
  let key = body;
  let tail = '';
  if (body.startsWith('\'')) {
    let out = '';
    let i = 1;
    for (;;) {
      if (i >= body.length) return undefined;
      const ch = body[i]!;
      if (ch === '\'') {
        if (body[i + 1] === '\'') { out += '\''; i += 2; continue; }
        break;
      }
      out += ch; i += 1;
    }
    key = out;
    tail = body.slice(i + 1);
  } else {
    const colon = /^((?:[a-z]+)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)(.*)$/u.exec(body);
    if (!colon) return undefined;
    key = colon[1]!;
    tail = colon[2]!;
  }
  const k = KEY.exec(key);
  const t = TAIL.exec(tail);
  if (!k || !t) return undefined;
  const attrs = [...(k[3] ?? '').matchAll(/ \[([^\]]*)\]/gu)].map(m => m[1]!);
  return { role: k[1]!, name: unquote(k[2] ?? ''), attrs, inline: t[1] ?? '' };
}

// 行の手がかりの形。withValues: 入力欄の値と、値を含む行の名前も入れる（値を除くと見分けられない組だけ）
function token(line: Line, withValues: boolean): string {
  if (line.raw !== undefined) return flatText(line.raw);
  const text = VALUE_ROLES.has(line.role) ? `${line.role} ${line.name}${line.attrs} ${withValues ? line.inline : ''}`
    : line.hasInput && !withValues ? `${line.role}${line.attrs}`
      : `${line.role} ${line.name}${line.attrs} ${line.inline} ${line.url}`;
  return flatText(text);
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

// 1 回の読みのまとめ（値なし・値ありの 2 つ。要るときだけ、ページの行の数に比例する手間で 1 回作る）。
// sub: その行と下の全部の行のまとめ / chain: 根からその行までの行の並びのまとめ / prefix: iframe の外の行の多項式のまとめの累積
interface Digest { sub: string[]; chain: string[]; prefix: bigint[] }
interface Page { lines: readonly Line[]; end: readonly number[]; outside: readonly number[]; power: bigint[]; digests: [Digest | undefined, Digest | undefined] }

function digestOf(page: Page, withValues: boolean): Digest {
  const cached = page.digests[withValues ? 1 : 0];
  if (cached) return cached;
  const { lines } = page;
  const own = lines.map(line => (line.inFrame ? '' : sha(token(line, withValues))));
  const chain = new Array<string>(lines.length);
  const prefix: bigint[] = [0n];
  lines.forEach((line, i) => {
    chain[i] = line.inFrame ? '' : sha(`${line.parent >= 0 ? chain[line.parent] : ''}|${own[i]}`);
    if (!line.inFrame) prefix.push((prefix[prefix.length - 1]! * BASE + BigInt(`0x${own[i]!.slice(0, 15)}`)) % MOD);
  });
  const sub = new Array<string>(lines.length);
  const kids: string[][] = lines.map(() => []);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.inFrame) continue;
    sub[i] = sha(`${own[i]}:${kids[i]!.reverse().join(',')}`);
    if (line.parent >= 0) kids[line.parent]!.push(sub[i]!);
  }
  const digest: Digest = { sub, chain, prefix };
  page.digests[withValues ? 1 : 0] = digest;
  return digest;
}

// 行 from〜to（両端を含む）のうち iframe の外の行のまとめ。行の数も入れる
function between(page: Page, digest: Digest, from: number, to: number): string {
  if (from > to) return '0';
  const a = page.outside[from]!;
  const b = page.outside[to + 1]!;
  while (page.power.length <= b - a) page.power.push(page.power[page.power.length - 1]! * BASE % MOD);
  const value = ((digest.prefix[b]! - digest.prefix[a]! * page.power[b - a]!) % MOD + MOD) % MOD;
  return `${b - a}:${value}`;
}

// 組の最初の要素の窓の頭: 入れ物の 8 行前か、入れ物の親の最初の子の、早い方。最後の要素の窓の終わりは、その逆（入れ物の 8 行あとか、入れ物の親の終わりの、遅い方）
function edgeFrom(page: Page, top: number): number {
  const up = page.lines[top]!.parent;
  return Math.max(0, Math.min(top - EDGE_LINES, up >= 0 ? up + 1 : 0));
}
function edgeTo(page: Page, top: number): number {
  const up = page.lines[top]!.parent;
  return Math.min(page.lines.length - 1, Math.max(page.end[top]! + EDGE_LINES, up >= 0 ? page.end[up]! : page.lines.length - 1));
}

// 要素の入れ物: 組のほかの要素を中に持たない、いちばん上の親（無ければ要素の行そのもの）。prev / next は組の前後の要素の行
function itemOf(page: Page, at: number, prev: number, next: number): number {
  let top = at;
  for (let up = page.lines[at]!.parent; up >= 0 && up > prev && page.end[up]! < next; up = page.lines[up]!.parent) top = up;
  return top;
}

// 組の要素ごとの手がかり。
// 1 つだけ: 自分の行。2 つ以上: 自分の行 + 根からの親の行の並び + 入れ物の下の全部の行 + 前の要素の入れ物の終わりから次の要素の入れ物の頭までの全部の行
//   （最初の要素は入れ物の前の 8 行か入れ物の親の頭から、最後の要素は入れ物のあとの 8 行か入れ物の親の終わりまで。edgeFrom / edgeTo）。
//   入れ物の中身（値を除く）が同じ要素があれば、その組だけ入力欄の値も入れる
function cluesOf(members: readonly Entry[], page: Page): string[] {
  if (members.length === 1) return [`1|${token(page.lines[members[0]!.line]!, false)}`];
  const tops = members.map((member, k) => itemOf(page, member.line, members[k - 1]?.line ?? -1, members[k + 1]?.line ?? Infinity));
  const plain = digestOf(page, false);
  const withValues = new Set(tops.map(top => plain.sub[top])).size < members.length;
  const digest = withValues ? digestOf(page, true) : plain;
  return members.map((member, k) => {
    const line = page.lines[member.line]!;
    const from = k > 0 ? page.end[tops[k - 1]!]! + 1 : edgeFrom(page, tops[k]!);
    const to = k < members.length - 1 ? tops[k + 1]! - 1 : edgeTo(page, tops[k]!);
    const chain = line.parent >= 0 ? digest.chain[line.parent] : '';
    return `${members.length > 1 ? 'n' : '1'}${withValues ? 'v' : ''}|${token(line, withValues)}|${chain}|${digest.sub[tops[k]!]}|${between(page, digest, from, to)}`;
  });
}

function retire(book: RefBook, ref: string): void {
  book.retired.add(ref);
  book.shown.delete(ref);
  if (book.retired.size > RETIRED_KEPT) book.retired.delete(book.retired.values().next().value!);
}

function retireAll(book: RefBook): void {
  for (const record of book.records.values()) retire(book, record.ref);
  book.records.clear();
  book.view.clear();
  book.seen.clear();
}

function parseLines(snapshot: string, url: string): { lines: Line[]; entries: Entry[]; end: number[] } {
  const lines: Line[] = [];
  const entries: Entry[] = [];
  let skipBelow: number | undefined;
  let link: { indent: number; entry: Entry } | undefined;
  const open: number[] = [];
  for (const text of snapshot.split(/\r?\n/u)) {
    if (text.trim() === '') continue;
    const item = ITEM.exec(text);
    const indent = item ? item[1]!.length : text.length - text.trimStart().length;
    const body = item ? item[2]! : text.trimStart();
    while (open.length > 0 && lines[open[open.length - 1]!]!.indent >= indent) open.pop();
    const owner = open.length > 0 ? open[open.length - 1]! : -1;
    let inFrame = false;
    if (skipBelow !== undefined) {
      if (indent > skipBelow) inFrame = true;
      else skipBelow = undefined;
    }
    const hrefLine = item ? URL_LINE.exec(body) : null;
    if (hrefLine && owner >= 0 && lines[owner]!.url === '' && lines[owner]!.raw === undefined) {
      lines[owner]!.url = hrefLine[1]!.trim();
      if (link && indent > link.indent && !inFrame && link.entry.href === undefined) link.entry.href = resolveHref(hrefLine[1]!, url);
      continue;
    }
    const parsed = item && !body.startsWith('/') ? parseItem(body) : undefined;
    const kept = parsed ? parsed.attrs.filter(attr => !VOLATILE_ATTR.test(attr)) : [];
    const pwRef = parsed?.attrs.find(attr => attr.startsWith('ref='))?.slice(4);
    const line: Line = parsed
      ? { indent, role: parsed.role, name: parsed.name, attrs: kept.map(attr => ` [${attr}]`).join(''), inline: parsed.inline, url: '', pwRef, raw: undefined, hasInput: false, inFrame, parent: owner }
      // 読めない行は番号を振らず、印を外した生の文を手がかりにする（変化を見落とさない）
      : { indent, role: '', name: '', attrs: '', inline: '', url: '', pwRef: undefined, raw: text.replace(MARKS, ''), hasInput: false, inFrame, parent: owner };
    if (parsed && VALUE_ROLES.has(parsed.role)) for (const parent of open) lines[parent]!.hasInput = true;
    open.push(lines.length);
    lines.push(line);
    if (inFrame || !parsed) continue;
    // iframe の中は、どのホストの枠か分からないので、番号を振らず、手がかりにも入れない
    if (line.role === 'iframe' || line.role === 'frame') { skipBelow = indent; link = undefined; continue; }
    // 名前の無い行は、印があれば下の行から名前を作る（ai の形は、子の要素から来る名前を親の行に書かない）
    if (!NUMBERED_ROLES.has(line.role) || (line.name === '' && pwRef === undefined)) continue;
    const states = kept.filter(state => STATES.has(state));
    const entry: Entry = { role: line.role, name: line.name, pwRef, href: undefined, states, line: lines.length - 1, derived: line.name === '' };
    entries.push(entry);
    link = line.role === 'link' ? { indent, entry } : undefined;
  }
  const end = endsOf(lines);
  for (let k = entries.length - 1; k >= 0; k--) {
    const entry = entries[k]!;
    if (!entry.derived) continue;
    // 作った名前は 900 字まで（名前・承認の bind・画面に使う）。切ったときは、全体のまとめを手がかりにだけ入れる
    const full = subtreeName(lines, end, entry.line);
    const chars = [...full];
    entry.name = chars.length > DERIVED_NAME_MAX ? chars.slice(0, DERIVED_NAME_MAX).join('') : full;
    const line = lines[entry.line]!;
    line.name = entry.name;
    if (entry.name !== full) line.attrs += ` [name#${sha(full)}]`;
  }
  return { lines, entries: entries.filter(e => e.name !== ''), end };
}

// 各行の下の、最後の行
function endsOf(lines: readonly Line[]): number[] {
  const end = lines.map((_, i) => i);
  for (let i = lines.length - 1; i >= 0; i--) { const up = lines[i]!.parent; if (up >= 0 && end[i]! > end[up]!) end[up] = end[i]!; }
  return end;
}

// 名前の無い要素の名前を、下の行（子の名前と文）から作る。名前のある子はその名前だけ使い、その下は見ない。入力欄の値は入れない
function subtreeName(lines: readonly Line[], end: readonly number[], at: number): string {
  const own = lines[at]!;
  const parts: string[] = VALUE_ROLES.has(own.role) || own.inline === '' ? [] : [scalar(own.inline)];
  for (let i = at + 1; i <= end[at]!;) {
    const line = lines[i]!;
    if (line.inFrame || line.raw !== undefined || VALUE_ROLES.has(line.role)) { i = end[i]! + 1; continue; }
    if (line.name !== '') { parts.push(line.name); i = end[i]! + 1; continue; }
    if (line.inline !== '') parts.push(scalar(line.inline));
    i += 1;
  }
  return flatText(parts.join(' '));
}

// 行の「: 値」の YAML の引用（"…" と '…'）を外す（名前と同じ読み方）
function scalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return unquote(raw.slice(1, -1));
  if (raw.length >= 2 && raw.startsWith('\'') && raw.endsWith('\'')) return raw.slice(1, -1).replaceAll('\'\'', '\'');
  return raw;
}

// 番号の振り方。show: 見せる表を作る（先頭から limit 件〔既定 300〕まで、fits が false を返したところで止める。新しい番号は見せる要素にだけ振る）。
// check: 押す前の取り直し。新しい番号は振らず、前の番号のうち、同じ要素・同じ中身のものだけを表に残す。
// diff: 押したあとの差分（P3b）。新しい番号は増えた要素（見せた番号の印でも、前に見せる形で読んだ要素でもないもの）にだけ振る。
//   見せた番号の要素で中身が変わったものは使えなくして dead で返す（新しい番号は、次に見せる形で読んだときに振る）。
//   URL か文書が変わった・差分の行が maxLines を超えるときは、show（tableLimit 件まで）と同じ表の形に落とす。
// fits には番号を振る前の要素を渡す（行の形は呼ぶ側が作って測る）
export type Numbering =
  | { kind: 'show'; fits?: ((item: ListedElement) => boolean) | undefined; limit?: number | undefined }
  | { kind: 'check' }
  | { kind: 'diff'; fits?: ((item: ListedElement) => boolean) | undefined; maxLines: number; tableLimit: number };

// 差分の行（増えた要素だけ）
export function diffLine(item: ListedElement, secrets: readonly string[] = []): string {
  return `+ ${elementLine(item, secrets)}`;
}

// 表を読み、book の番号の対応を更新する。document は文書の代（主フレームが移動するたびに進む。PageHandle.documentId）。book を省くと、新しい対応（e1 から）
export function readElements(snapshot: string, url: string, book: RefBook = newRefBook(), document = 0, numbering: Numbering = { kind: 'show' }): ElementTable {
  const { lines, entries, end } = parseLines(snapshot, url);
  const navigated = book.url !== url || book.document !== document;
  // URL か文書が変わったら、前の番号は全部使えない
  if (navigated) {
    retireAll(book);
    book.url = url;
    book.document = document;
  }
  const outside = [0];
  for (const line of lines) outside.push(outside[outside.length - 1]! + (line.inFrame ? 0 : 1));
  const page: Page = { lines, end, outside, power: [1n], digests: [undefined, undefined] };
  // 同じ印が 2 回出る表（本来は無い）は、その印に番号を振らない
  const seenTwice = new Set<string>();
  const once = new Set<string>();
  for (const e of entries) if (e.pwRef !== undefined) { if (once.has(e.pwRef)) seenTwice.add(e.pwRef); else once.add(e.pwRef); }
  const usable = entries.filter(e => e.pwRef !== undefined && !seenTwice.has(e.pwRef));
  const keyOf = (e: Entry): string => `${e.role}\u0000${e.name}`;
  // diff: 差分で新しい番号を振ってよいのは、見せた番号の印でもなく、前に見せる形で読んだときにも無かった要素だけ
  const viewed = new Set(book.view.values());
  const wanted = numbering.kind === 'diff' && !navigated ? usable.filter(e => !viewed.has(e.pwRef!) && book.seen.get(e.pwRef!) !== keyOf(e)) : [];
  const tableLimit = numbering.kind === 'show' ? numbering.limit ?? MAX_ELEMENTS : numbering.kind === 'diff' ? numbering.tableLimit : 0;
  let form: 'show' | 'check' | 'diff' = numbering.kind === 'diff' ? (navigated ? 'show' : 'diff') : numbering.kind;
  let candidates = new Set(form === 'show' ? usable.slice(0, tableLimit) : wanted);
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = keyOf(e);
    const list = groups.get(key);
    if (list) list.push(e); else groups.set(key, [e]);
  }
  // 手がかりは、番号を振るかもしれない要素と、前の番号のある要素の組だけ作る
  const clue = new Map<Entry, string>();
  const addClues = (): void => {
    for (const list of groups.values()) {
      if (clue.has(list[0]!) || !list.some(e => candidates.has(e) || (e.pwRef !== undefined && book.records.has(e.pwRef)))) continue;
      cluesOf(list, page).forEach((c, k) => clue.set(list[k]!, c));
    }
  };
  addClues();
  const same = (e: Entry, record: RefRecord | undefined): boolean => record !== undefined && record.role === e.role && record.name === e.name && record.clue === clue.get(e);
  // 差分の行の数（使えなくなった見せた番号 + 増えた要素）が多すぎれば、表の形に落とす（番号を振る前に決める）
  let tableReason: 'navigated' | 'too_big' = 'navigated';
  if (form === 'diff' && numbering.kind === 'diff') {
    const keptNow = new Set(usable.filter(e => same(e, book.records.get(e.pwRef!))).map(e => e.pwRef!));
    const dead = [...book.view].filter(([ref, pwRef]) => !(keptNow.has(pwRef) && book.records.get(pwRef)?.ref === ref));
    const added = wanted.filter(e => !keptNow.has(e.pwRef!)).length;
    if (dead.length + added > numbering.maxLines) {
      form = 'show';
      tableReason = 'too_big';
      candidates = new Set(usable.slice(0, tableLimit));
      addClues();
    }
  }
  const alive = new Set<string>();
  const items: ListedElement[] = [];
  const fits = numbering.kind === 'check' ? () => false : numbering.fits ?? (() => true);
  let open = form !== 'check';
  let skipped = 0;
  for (const e of usable) {
    const pwRef = e.pwRef!;
    const record = book.records.get(pwRef);
    const kept = same(e, record);
    // 差分では、変わらない要素は行にしない
    if (form === 'diff' && kept) { alive.add(pwRef); continue; }
    if (open && candidates.has(e)) {
      const ref = kept ? record!.ref : `e${book.counter.next}`;
      const item: ListedElement = { ref, role: e.role, name: e.name, pwRef, frameUrl: undefined, href: e.href, states: e.states };
      if (fits(item)) {
        if (!kept) {
          if (record !== undefined) retire(book, record.ref);
          if (book.counter.next > REF_MAX) throw new BrowserFailure('ref_limit', 'browser.refs_exhausted', { max: REF_MAX });
          book.counter.next += 1;
          book.records.set(pwRef, { ref, role: e.role, name: e.name, clue: clue.get(e)! });
        }
        alive.add(pwRef);
        items.push(item);
        continue;
      }
      open = false;
    }
    if (candidates.has(e)) skipped += 1;
    // 見せない要素: 前の番号が同じ要素・同じ中身なら残す（check では表にも入れる）。違えば使えなくする
    if (kept) {
      alive.add(pwRef);
      if (numbering.kind === 'check') items.push({ ref: record!.ref, role: e.role, name: e.name, pwRef, frameUrl: undefined, href: e.href, states: e.states });
    }
  }
  for (const [pwRef, record] of [...book.records]) {
    if (!alive.has(pwRef)) { retire(book, record.ref); book.records.delete(pwRef); }
  }
  if (form === 'check') return { url, items, omitted: Math.max(0, usable.length - items.length) };
  // 見せる形で読んだ要素を、次の差分の元として覚える
  book.seen.clear();
  for (const e of usable) book.seen.set(e.pwRef!, keyOf(e));
  // 使えなくなった見せた番号は元から外す。差分の形では、使えなくなったもの（dead）として知らせる（表の形では、表そのものが新しい元になる）
  const dead: Array<{ ref: string; present: boolean }> = [];
  for (const [ref, pwRef] of [...book.view]) {
    const record = book.records.get(pwRef);
    if (record?.ref === ref) continue;
    book.view.delete(ref);
    if (form !== 'diff') continue;
    dead.push({ ref, present: book.seen.has(pwRef) });
  }
  if (form === 'diff') return { url, items, omitted: skipped, diff: { form: 'diff', dead } };
  return { url, items, omitted: Math.max(0, usable.length - items.length), ...(numbering.kind === 'diff' ? { diff: { form: 'table', reason: tableReason } } : {}) };
}

// 使えなくなった番号か
export function retiredRef(book: RefBook, ref: string): boolean {
  return book.retired.has(ref);
}

// モデルに見せた番号として覚える（見せていない番号は押せない）
export function markShown(book: RefBook, items: readonly ElementRef[]): void {
  for (const item of items) {
    book.shown.add(item.ref);
    book.view.set(item.ref, item.pwRef);
  }
  while (book.view.size > RETIRED_KEPT) book.view.delete(book.view.keys().next().value!);
}

export function shownRef(book: RefBook, ref: string): boolean {
  return book.shown.has(ref);
}

// 名前は伏せてから 100 字で切る（切ってから伏せると、切り目にまたがる秘密の頭が残る）
function shown(name: string, secrets: readonly string[]): string {
  const sent = sentText(flatText(name), secrets, NAME_SHOWN);
  return JSON.stringify(sent.cut ? `${sent.text}…` : sent.text);
}

// 表の 1 行（見せる形）。secrets: 伏せる決まった秘密の一覧（鍵の形はいつも伏せる）
export function elementLine(e: ListedElement, secrets: readonly string[] = []): string {
  return [e.ref, e.role, shown(e.name, secrets), ...e.states.map(s => `[${s}]`), ...(e.href ? [`→ ${e.href}`] : [])].join(' ');
}

export function formatElements(table: ElementTable, language: Language, limit = MAX_ELEMENTS, secrets: readonly string[] = []): string {
  if (table.items.length === 0) return toolText(language, 'browser.no_elements');
  const lines = table.items.slice(0, limit).map(item => elementLine(item, secrets));
  const more = Math.max(0, table.items.length - limit) + table.omitted;
  if (more > 0) lines.push(toolText(language, 'browser.more_elements', { count: more }));
  return lines.join('\n');
}
