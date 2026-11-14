import { normalizeQuote } from '../projects/acceptance.ts';

export const PAGE_CHARS = 20_000;

export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  return url.href.replace(/\/+$/u, '');
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
    if (page === undefined || excerpt === undefined) return false;
    const folded = normalizeQuote(excerpt);
    return folded.length > 0 && page.includes(folded);
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

export function quoteHasName(quote: string, name: string): boolean {
  const folded = normalizeQuote(name);
  return folded.length > 0 && normalizeQuote(quote).includes(folded);
}
