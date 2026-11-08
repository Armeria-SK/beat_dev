// ページの「触れるもの」の一覧。元は Playwright の公開の API（locator('body').ariaSnapshot()）の文。
// 番号を振り、番号から要素を探し直す（ページに印は付けない）
import type { Language } from '../../config/schema.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { pageUrl as publicPageUrl } from '../web/public-page.ts';
import type { ElementState, PageHandle } from './driver.ts';

export const NUMBERED_ROLES: ReadonlySet<string> = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
]);
export const MAX_ELEMENTS = 300;
const NAME_SHOWN = 100;

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
  items: ListedElement[];
  // 上限（300）で省いた数
  omitted: number;
}

const LINE = /^( *)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(?::.*)?$/u;
const URL_LINE = /^( *)- \/url: (.*)$/u;
const STATES = new Set(['disabled', 'checked', 'selected', 'expanded', 'pressed']);

function unquote(raw: string): string {
  try { return JSON.parse(`"${raw}"`) as string; } catch { return raw; }
}

function resolveHref(raw: string, base: string): string | undefined {
  try { return publicPageUrl(new URL(raw.trim(), base).href).href; } catch { return undefined; }
}

interface Entry { role: string; name: string; href: string | undefined; states: string[] }

export function readElements(snapshot: string, url: string, limit = MAX_ELEMENTS): ElementTable {
  const entries: Entry[] = [];
  let skipBelow: number | undefined;
  let link: { indent: number; entry: Entry } | undefined;
  for (const line of snapshot.split(/\r?\n/u)) {
    const hrefLine = URL_LINE.exec(line);
    if (hrefLine) {
      const indent = hrefLine[1]!.length;
      if (link && indent > link.indent && skipBelow === undefined && link.entry.href === undefined) link.entry.href = resolveHref(hrefLine[2]!, url);
      continue;
    }
    const match = LINE.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    if (skipBelow !== undefined) {
      if (indent > skipBelow) continue;
      skipBelow = undefined;
    }
    const role = match[2]!;
    // iframe の中は、どのホストの枠か分からないので、番号を振らない
    if (role === 'iframe' || role === 'frame') { skipBelow = indent; link = undefined; continue; }
    if (!NUMBERED_ROLES.has(role)) continue;
    const name = unquote(match[3] ?? '');
    if (name === '') continue;
    const states = [...(match[4] ?? '').matchAll(/\[([a-z]+)\]/gu)].map(m => m[1]!).filter(state => STATES.has(state));
    const entry: Entry = { role, name, href: undefined, states };
    entries.push(entry);
    link = role === 'link' ? { indent, entry } : undefined;
  }
  const totals = new Map<string, number>();
  const key = (e: Entry) => `${e.role}\u0000${e.name}`;
  for (const e of entries) totals.set(key(e), (totals.get(key(e)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const items: ListedElement[] = [];
  entries.forEach((e, index) => {
    const nth = seen.get(key(e)) ?? 0;
    seen.set(key(e), nth + 1);
    if (index >= limit) return;
    items.push({ ref: `e${index + 1}`, role: e.role, name: e.name, nth, count: totals.get(key(e))!, frameUrl: undefined, href: e.href, states: e.states });
  });
  return { url, items, omitted: Math.max(0, entries.length - limit) };
}

function shown(name: string): string {
  const flat = name.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return JSON.stringify(flat.length > NAME_SHOWN ? `${flat.slice(0, NAME_SHOWN)}…` : flat);
}

export function formatElements(table: ElementTable, language: Language): string {
  if (table.items.length === 0) return toolText(language, 'browser.no_elements');
  const lines = table.items.map(e => [e.ref, e.role, shown(e.name), ...e.states.map(s => `[${s}]`), ...(e.href ? [`→ ${e.href}`] : [])].join(' '));
  if (table.omitted > 0) lines.push(toolText(language, 'browser.more_elements', { count: table.omitted }));
  return lines.join('\n');
}

export type Relocated = { ok: true; state: ElementState } | { ok: false; reason: 'changed' };

// 役割・名前（完全一致）・nth で探し直す。読んだときと数が違う・無い → 実行しない（ページが変わった）
export async function relocate(page: PageHandle, element: ElementRef): Promise<Relocated> {
  if (await page.countRole(element.role, element.name) !== element.count) return { ok: false, reason: 'changed' };
  const state = await page.stateOf(element.role, element.name, element.nth);
  return state ? { ok: true, state } : { ok: false, reason: 'changed' };
}
