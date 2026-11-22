// ページの「触れるもの」の一覧。元は Playwright の公開の API（locator('body').ariaSnapshot()）の文。
// 番号を振り、番号から要素を探し直す（ページに印は付けない）
// 番号（P3a）: 同じ役割・名前の組ごとに持つ。同じ URL で読み直して組のしるし（数と、各要素の前の行の手がかり）が同じなら同じ番号、
//   少しでも違えば組ごと使えなくして新しい番号を振る（要素ごとの突き合わせはしない）。番号は会話のタブで共通の続きの数で、振り直さない
import { createHash } from 'node:crypto';
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
const NAME_SHOWN = 100;
// 行の手がかり: 組の最初の要素は前の 8 行、各要素の手がかりは 200 字まで
const FIRST_ANCHOR_LINES = 8;
const ANCHOR_CHARS = 200;
// 使えなくなった番号を覚えておく数（断る文を「使えなくなりました」にするため）
const RETIRED_KEPT = 20_000;
// 値（ariaSnapshot の「: 値」）を持つ入力欄。値は手がかりに入れず、この欄を中に持つ行の名前（値を含む）も入れない
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
  // 使えなくなった番号 → その組（役割と名前）
  readonly retired: Map<string, { role: string; name: string }>;
}

export function newRefBook(counter: RefCounter = { next: 1 }): RefBook {
  return { counter, url: undefined, groups: new Map(), retired: new Map() };
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

// ariaSnapshot の 1 行。token は行の手がかりに使う形（役割と名前と、入力欄でない行の「: 文」）
interface Line { indent: number; role: string; name: string; inline: string; hasInput: boolean; inFrame: boolean }
interface Entry { role: string; name: string; href: string | undefined; states: string[]; line: number }

function token(line: Line): string {
  if (VALUE_ROLES.has(line.role)) return flatText(`${line.role} ${line.name}`);
  if (line.hasInput) return line.role;
  return flatText(`${line.role} ${line.name} ${line.inline}`);
}

const groupKey = (role: string, name: string): string => `${role}\u0000${name}`;

// 組のしるし: 数が 1 なら「1」だけ。2 以上なら数と、各要素の前の行の手がかり（前の同じ組の要素のあとから、最初の要素は前の 8 行）
function signatureOf(members: readonly Entry[], lines: readonly Line[]): string {
  if (members.length === 1) return '1';
  const hash = createHash('sha256').update(String(members.length));
  let from = Math.max(0, members[0]!.line - FIRST_ANCHOR_LINES);
  for (const member of members) {
    const anchor = lines.slice(from, member.line).filter(line => !line.inFrame).map(token).join('\n').slice(0, ANCHOR_CHARS);
    hash.update('\u0000').update(anchor);
    from = member.line + 1;
  }
  return hash.digest('hex');
}

function retire(book: RefBook, key: string, group: RefGroup): void {
  const [role, name] = key.split('\u0000') as [string, string];
  for (const ref of group.refs) {
    if (ref === undefined) continue;
    book.retired.set(ref, { role, name });
    if (book.retired.size > RETIRED_KEPT) book.retired.delete(book.retired.keys().next().value!);
  }
}

// 表を読み、book の番号の対応を更新する。book を省くと、新しい対応（e1 から）
export function readElements(snapshot: string, url: string, book: RefBook = newRefBook(), limit = MAX_TABLE): ElementTable {
  const lines: Line[] = [];
  const entries: Entry[] = [];
  let skipBelow: number | undefined;
  let link: { indent: number; entry: Entry } | undefined;
  const open: Line[] = [];
  for (const raw of snapshot.split(/\r?\n/u)) {
    const hrefLine = URL_LINE.exec(raw);
    if (hrefLine) {
      const indent = hrefLine[1]!.length;
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
    const line: Line = { indent, role, name, inline: match[5] ?? '', hasInput: false, inFrame };
    while (open.length > 0 && open[open.length - 1]!.indent >= indent) open.pop();
    if (VALUE_ROLES.has(role)) for (const parent of open) parent.hasInput = true;
    open.push(line);
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
    for (const [key, group] of book.groups) retire(book, key, group);
    book.groups.clear();
    book.url = url;
  }
  for (const [key, group] of [...book.groups]) {
    if (!members.has(key)) { retire(book, key, group); book.groups.delete(key); }
  }
  for (const [key, list] of members) {
    const signature = signatureOf(list, lines);
    const before = book.groups.get(key);
    if (before?.signature === signature) continue;
    if (before) retire(book, key, before);
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

// 使えなくなった番号なら、その組（役割と名前）
export function retiredRef(book: RefBook, ref: string): { role: string; name: string } | undefined {
  return book.retired.get(ref);
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
