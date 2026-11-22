// ページの「触れるもの」の一覧。元は Playwright の公開の API（locator('body').ariaSnapshot()）の文。
// 番号を振り、番号から要素を探し直す（ページに印は付けない）
// 番号（P3a）: 同じ役割・名前の組ごとに持つ。同じ URL で読み直して組のしるし（数と、各要素の周りの行の手がかり）が同じなら同じ番号、
//   少しでも違えば組ごと使えなくして新しい番号を振る（要素ごとの突き合わせはしない）。番号は会話のタブで共通の続きの数で、振り直さない
import { createHash, randomInt } from 'node:crypto';
import type { Language } from '../../config/schema.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { pageUrl as publicPageUrl } from '../web/public-page.ts';
import { BrowserFailure } from './driver.ts';

export const NUMBERED_ROLES: ReadonlySet<string> = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
]);
// 見せるのは 300 件まで。表として持つ（番号で押せる）のは 2,000 件まで
export const MAX_ELEMENTS = 300;
export const MAX_TABLE = 2000;
// 番号は e1〜e999999。使い切ったら断る
export const REF_MAX = 999_999;
// beat の起動ごとの番号の始まり（1〜9,000 のどこか）。起動し直したあとに、前の起動の番号が同じ番号の別の要素に当たりにくくする。
// 始まりが最大でも、使い切るまで 990,000 個以上ある
const REF_START_SPAN = 9_000;
export const randomRefStart = (): number => 1 + randomInt(REF_START_SPAN);
const NAME_SHOWN = 100;
// 各要素の手がかり: 前後 8 行ずつと、親の行（16 段まで）と、その要素の入れ物（下を参照）の行すべて。
// 1 行は 120 字で切る（長い 1 行で近くの行が押し出されない）。行の手がかりの形は 1 行につき 1 回だけ作る（量はページの行の数に比例）
const NEAR_LINES = 8;
const PARENT_LINES = 16;
const LINE_CHARS = 120;
// 使えなくなった番号を覚えておく数（断る文を「使えなくなりました」にするため）
const RETIRED_KEPT = 20_000;
// 値（ariaSnapshot の「: 値」）を持つ入力欄。ふだんは値を手がかりに入れず、この欄を中に持つ行の名前（値を含む）も入れない
const VALUE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

export interface ElementRef {
  ref: string;
  role: string;
  name: string;
  // 同じ役割・同じ名前の何番目か（0 から）と、読んだときの全部の数
  nth: number;
  count: number;
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
  // 表として持つ要素（2,000 件まで）。見せるのは先頭の 300 件
  items: ListedElement[];
  // 上限（2,000）で省いた数
  omitted: number;
}

// 会話のブラウザに 1 つの続きの数（タブで共通）
export interface RefCounter { next: number }

interface RefGroup { signature: string; refs: Array<string | undefined> }

// タブごとの番号の対応。url が変わったら組を全部使えなくする（数は続きから）
export interface RefBook {
  readonly counter: RefCounter;
  url: string | undefined;
  readonly groups: Map<string, RefGroup>;
  // 使えなくなった番号
  readonly retired: Set<string>;
}

export function newRefBook(counter: RefCounter = { next: 1 }): RefBook {
  return { counter, url: undefined, groups: new Map(), retired: new Set() };
}

const LINE = /^( *)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::(.*))?$/u;
const URL_LINE = /^( *)- \/url: (.*)$/u;
const STATES = new Set(['disabled', 'checked', 'selected', 'expanded', 'pressed']);

function unquote(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

function resolveHref(raw: string, base: string): string | undefined {
  try { return publicPageUrl(new URL(raw.trim(), base).href).href; } catch { return undefined; }
}

const flatText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

// ariaSnapshot の 1 行。attrs は [checked] などの並び、url はその行の下の /url:（リンク先）、parent は親の行
interface Line { indent: number; role: string; name: string; attrs: string; inline: string; url: string; hasInput: boolean; inFrame: boolean; parent: number }
interface Entry { role: string; name: string; href: string | undefined; states: string[]; line: number }

// 行の手がかりの形。withValues: 入力欄の値と、値を含む行の名前も入れる（値を除くと見分けられない組だけ）
function token(line: Line, withValues: boolean): string {
  const text = VALUE_ROLES.has(line.role) ? `${line.role} ${line.name}${line.attrs} ${withValues ? line.inline : ''}`
    : line.hasInput && !withValues ? `${line.role}${line.attrs}`
      : `${line.role} ${line.name}${line.attrs} ${line.inline} ${line.url}`;
  return flatText(text).slice(0, LINE_CHARS);
}

// 1 回の読みの行と、行ごとの手がかりの形（値なし・値ありを 1 行につき 1 回だけ作って使い回す）。end[i] は行 i の下の最後の行
interface Page { lines: readonly Line[]; end: readonly number[]; tokens: [Array<string | undefined>, Array<string | undefined>] }

function tokenAt(page: Page, i: number, withValues: boolean): string {
  const cache = page.tokens[withValues ? 1 : 0];
  return cache[i] ??= token(page.lines[i]!, withValues);
}

const groupKey = (role: string, name: string): string => `${role}\u0000${name}`;

// 1 つの要素の手がかりにする行: 自分の行（状態・リンク先）、親の行（16 段まで）、前後 8 行（iframe の中の行は入れない）。-1 は区切り
function nearLines(lines: readonly Line[], at: number): number[] {
  const picked = [at];
  let up = lines[at]!.parent;
  for (let depth = 0; up >= 0 && depth < PARENT_LINES; depth++) { picked.push(up); up = lines[up]!.parent; }
  picked.push(-1);
  for (let i = Math.max(0, at - NEAR_LINES); i < Math.min(lines.length, at + NEAR_LINES + 1); i++) {
    if (i !== at && !lines[i]!.inFrame) picked.push(i);
  }
  return picked;
}

// 要素の入れ物: 組のほかの要素を中に持たない、いちばん上の親（無ければ要素の行そのもの）。prev / next は組の前後の要素の行。
// 組の要素どうしの入れ物は重ならないので、全部の入れ物の行を足してもページの行の数を超えない
function itemOf(page: Page, at: number, prev: number, next: number): [number, number] {
  let top = at;
  for (let up = page.lines[at]!.parent; up >= 0 && up > prev && page.end[up]! < next; up = page.lines[up]!.parent) top = up;
  return [top, page.end[top]!];
}

function hashItem(hash: ReturnType<typeof createHash>, page: Page, item: readonly [number, number], withValues: boolean): void {
  for (let i = item[0]; i <= item[1]; i++) if (!page.lines[i]!.inFrame) hash.update(tokenAt(page, i, withValues)).update('\n');
}

// 組のしるし: 数が 1 なら「1」だけ。2 以上なら数と、各要素の手がかり（周りの行と入れ物の行すべて）。
// 入れ物の中身（値を除く）が同じ要素があれば（入力欄の値だけが違う一覧など）、その組だけ入力欄の値も入れる
function signatureOf(members: readonly Entry[], page: Page): string {
  if (members.length === 1) return '1';
  const items = members.map((member, k) => itemOf(page, member.line, members[k - 1]?.line ?? -1, members[k + 1]?.line ?? Infinity));
  const contents = items.map(item => { const hash = createHash('sha256'); hashItem(hash, page, item, false); return hash.digest('hex'); });
  const withValues = new Set(contents).size < members.length;
  const hash = createHash('sha256').update(`${members.length}${withValues ? 'v' : ''}`);
  members.forEach((member, k) => {
    hash.update('\u0000');
    for (const i of nearLines(page.lines, member.line)) hash.update(i < 0 ? '\u0001' : tokenAt(page, i, withValues)).update('\n');
    hash.update('\u0002');
    if (withValues) hashItem(hash, page, items[k]!, true); else hash.update(contents[k]!);
  });
  return hash.digest('hex');
}

function retire(book: RefBook, group: RefGroup): void {
  for (const ref of group.refs) {
    if (ref === undefined) continue;
    book.retired.add(ref);
    if (book.retired.size > RETIRED_KEPT) book.retired.delete(book.retired.values().next().value!);
  }
}

// 表を読み、book の番号の対応を更新する。book を省くと、新しい対応（e1 から）
export function readElements(snapshot: string, url: string, book: RefBook = newRefBook(), limit = MAX_TABLE): ElementTable {
  const lines: Line[] = [];
  const entries: Entry[] = [];
  let skipBelow: number | undefined;
  let link: { indent: number; entry: Entry } | undefined;
  const open: number[] = [];
  for (const raw of snapshot.split(/\r?\n/u)) {
    const hrefLine = URL_LINE.exec(raw);
    if (hrefLine) {
      const indent = hrefLine[1]!.length;
      const owner = open.length > 0 ? lines[open[open.length - 1]!] : undefined;
      if (owner && indent > owner.indent && owner.url === '') owner.url = hrefLine[2]!.trim();
      if (link && indent > link.indent && skipBelow === undefined && link.entry.href === undefined) link.entry.href = resolveHref(hrefLine[2]!, url);
      continue;
    }
    const match = LINE.exec(raw);
    if (!match) continue;
    const indent = match[1]!.length;
    const role = match[2]!;
    const name = unquote(match[3] ?? '');
    let inFrame = false;
    if (skipBelow !== undefined) {
      if (indent > skipBelow) inFrame = true;
      else skipBelow = undefined;
    }
    while (open.length > 0 && lines[open[open.length - 1]!]!.indent >= indent) open.pop();
    if (VALUE_ROLES.has(role)) for (const parent of open) lines[parent]!.hasInput = true;
    const line: Line = { indent, role, name, attrs: match[4] ?? '', inline: match[5] ?? '', url: '', hasInput: false, inFrame, parent: open.length > 0 ? open[open.length - 1]! : -1 };
    open.push(lines.length);
    lines.push(line);
    if (inFrame) continue;
    // iframe の中は、どのホストの枠か分からないので、番号を振らない
    if (role === 'iframe' || role === 'frame') { skipBelow = indent; link = undefined; continue; }
    if (!NUMBERED_ROLES.has(role)) continue;
    if (name === '') continue;
    const states = [...(match[4] ?? '').matchAll(/\[([a-z]+)\]/gu)].map(m => m[1]!).filter(state => STATES.has(state));
    const entry: Entry = { role, name, href: undefined, states, line: lines.length - 1 };
    entries.push(entry);
    link = role === 'link' ? { indent, entry } : undefined;
  }
  const members = new Map<string, Entry[]>();
  for (const e of entries) {
    const key = groupKey(e.role, e.name);
    const list = members.get(key);
    if (list) list.push(e); else members.set(key, [e]);
  }
  // URL が変わったら、前のページの番号は全部使えない
  if (book.url !== url) {
    for (const group of book.groups.values()) retire(book, group);
    book.groups.clear();
    book.url = url;
  }
  for (const [key, group] of [...book.groups]) {
    if (!members.has(key)) { retire(book, group); book.groups.delete(key); }
  }
  const end = lines.map((_, i) => i);
  for (let i = lines.length - 1; i >= 0; i--) { const up = lines[i]!.parent; if (up >= 0 && end[i]! > end[up]!) end[up] = end[i]!; }
  const page: Page = { lines, end, tokens: [[], []] };
  for (const [key, list] of members) {
    const signature = signatureOf(list, page);
    const before = book.groups.get(key);
    if (before?.signature === signature) continue;
    if (before) retire(book, before);
    book.groups.set(key, { signature, refs: new Array<string | undefined>(list.length).fill(undefined) });
  }
  const seen = new Map<string, number>();
  const items: ListedElement[] = [];
  entries.forEach((e, index) => {
    const key = groupKey(e.role, e.name);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    if (index >= limit) return;
    const group = book.groups.get(key)!;
    let ref = group.refs[nth];
    if (ref === undefined) {
      if (book.counter.next > REF_MAX) throw new BrowserFailure('ref_limit', 'browser.refs_exhausted', { max: REF_MAX });
      ref = `e${book.counter.next++}`;
      group.refs[nth] = ref;
    }
    items.push({ ref, role: e.role, name: e.name, nth, count: group.refs.length, frameUrl: undefined, href: e.href, states: e.states });
  });
  return { url, items, omitted: Math.max(0, entries.length - limit) };
}

// 使えなくなった番号か
export function retiredRef(book: RefBook, ref: string): boolean {
  return book.retired.has(ref);
}

function shown(name: string): string {
  const flat = flatText(name);
  return JSON.stringify(flat.length > NAME_SHOWN ? `${flat.slice(0, NAME_SHOWN)}…` : flat);
}

export function formatElements(table: ElementTable, language: Language, limit = MAX_ELEMENTS): string {
  if (table.items.length === 0) return toolText(language, 'browser.no_elements');
  const lines = table.items.slice(0, limit).map(e => [e.ref, e.role, shown(e.name), ...e.states.map(s => `[${s}]`), ...(e.href ? [`→ ${e.href}`] : [])].join(' '));
  const more = Math.max(0, table.items.length - limit) + table.omitted;
  if (more > 0) lines.push(toolText(language, 'browser.more_elements', { count: more }));
  return lines.join('\n');
}
