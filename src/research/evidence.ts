import { MIN_QUOTE_WEIGHT, normalizeQuote, quoteWeight } from '../projects/acceptance.ts';

export const PAGE_CHARS = 20_000;

export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href.replace(/\/+$/u, '');
}

export function pageKey(raw: string): string | null {
  const href = normalizeUrl(raw);
  if (href === null) return null;
  const url = new URL(href);
  return `${url.hostname.replace(/\.$/u, '')}${url.pathname.toLowerCase().replace(/\/+$/u, '')}`;
}

export class OpenedPages {
  readonly #pages = new Map<string, string>();

  add(url: string, text: string): void {
    const key = normalizeUrl(url);
    if (key === null) return;
    const before = this.#pages.get(key);
    const folded = normalizeQuote(text);
    this.#pages.set(key, (before === undefined ? folded : `${before}\u0000${folded}`).slice(0, PAGE_CHARS));
  }

  has(url: string): boolean {
    const key = normalizeUrl(url);
    return key !== null && this.#pages.has(key);
  }

  quoted(url: string, excerpt: string | undefined): boolean {
    const key = normalizeUrl(url);
    const page = key === null ? undefined : this.#pages.get(key);
    if (page === undefined || excerpt === undefined || quoteWeight(excerpt) < MIN_QUOTE_WEIGHT) return false;
    return page.includes(normalizeQuote(excerpt));
  }
}

const RUNS = new Map<string, OpenedPages>();

export function beginPages(runId: string): OpenedPages {
  const pages = new OpenedPages();
  RUNS.set(runId, pages);
  return pages;
}

export const pagesOf = (runId: string): OpenedPages | undefined => RUNS.get(runId);

export function endPages(runId: string): void {
  RUNS.delete(runId);
}

const WORD = /[\p{L}\p{N}_]/u;
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const spaced = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const joins = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && WORD.test(a) && WORD.test(b) && !WIDE.test(a) && !WIDE.test(b);

export function quoteHasName(quote: string, name: string): boolean {
  const label = spaced(name);
  if (!label) return false;
  const bare = [...label.replace(/\s/gu, '')];
  if (bare.length < 2 && bare.every(char => WIDE.test(char))) return false;
  const text = spaced(quote);
  const first = [...label][0];
  const last = [...label].at(-1);
  for (let at = text.indexOf(label); at >= 0; at = text.indexOf(label, at + 1)) {
    const before = [...text.slice(0, at)].at(-1);
    const after = [...text.slice(at + label.length)][0];
    if (!joins(before, first) && !joins(last, after)) return true;
  }
  return false;
}
