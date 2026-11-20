import { MIN_QUOTE_WEIGHT, normalizeQuote, quoteWeight } from '../projects/acceptance.ts';
import type { ResearchLimits } from '../shared/research-languages.ts';

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

const REPO_HOSTS: ReadonlySet<string> = new Set(['github.com', 'gitlab.com', 'codeberg.org']);

// P-R3-6: 置き場のページ（github.com・gitlab.com・codeberg.org）は owner/repo で同じものとみなす。似ているものの重複と「定番」の数え方だけに使う（開ける URL の確かめには使わない）
export function sourceKey(raw: string): string | null {
  const key = pageKey(raw);
  if (key === null) return null;
  const [host, ...path] = key.split('/');
  const bare = host!.replace(/^www\./u, '');
  if (!REPO_HOSTS.has(bare) || path.length < 2 || !path[0] || !path[1]) return key;
  return `${bare}/${path[0]}/${path[1].replace(/\.git$/u, '')}`;
}

export class OpenedPages {
  readonly #pages = new Map<string, string>();
  readonly #words = new Map<string, string>();

  add(url: string, text: string): void {
    const key = normalizeUrl(url);
    if (key === null) return;
    const before = this.#pages.get(key);
    const folded = normalizeQuote(text);
    this.#pages.set(key, (before === undefined ? folded : `${before}\u0000${folded}`).slice(0, PAGE_CHARS));
    const words = this.#words.get(key);
    this.#words.set(key, (words === undefined ? spaced(text) : `${words}\u0000${spaced(text)}`).slice(0, PAGE_CHARS * 2));
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

  // R-1a の申し送り (1): 両端がページの上で語の切れ目になっている抜き書きだけ（「is written in Go」は「Google Apps Script」のページで当たらない）
  wholeQuoted(url: string, excerpt: string | undefined): boolean {
    if (!this.quoted(url, excerpt)) return false;
    const page = this.#words.get(normalizeUrl(url)!) ?? '';
    const quote = spaced(excerpt!);
    const first = [...quote][0];
    const last = [...quote].at(-1);
    for (let at = page.indexOf(quote); at >= 0; at = page.indexOf(quote, at + 1)) {
      const before = [...page.slice(Math.max(0, at - 2), at)].at(-1);
      const after = [...page.slice(at + quote.length, at + quote.length + 2)][0];
      if (!joins(before, first) && !joins(last, after)) return true;
    }
    return false;
  }
}

export type PartKind = 'first' | 'candidate' | 'continue' | 'libraries';

// answered: 返事が来た検索（結果 0 件も数える）・failed: 断られた・失敗した検索（全部が failed なら「検索ができなかった」）
export interface ResearchBudget { fetches: number; searches: number; started: number; answered?: number; failed?: number }

export interface Candidate { name: string; url: string }

export class ResearchSession {
  readonly researchId: string;
  readonly part: PartKind;
  readonly oneByOne: boolean;
  readonly budget: ResearchBudget;
  readonly limits: ResearchLimits;
  readonly pages: OpenedPages;
  readonly #seen: Map<string, string>;
  readonly candidates: Candidate[];
  readonly #now: () => number;

  constructor(input: { researchId: string; part: PartKind; oneByOne?: boolean; budget: ResearchBudget; limits: ResearchLimits; pages?: OpenedPages; seen?: Map<string, string>; candidates?: Candidate[]; now?: () => number }) {
    this.researchId = input.researchId;
    this.part = input.part;
    this.oneByOne = input.oneByOne ?? false;
    this.budget = input.budget;
    this.limits = input.limits;
    this.pages = input.pages ?? new OpenedPages();
    this.#seen = input.seen ?? new Map();
    this.candidates = input.candidates ?? [];
    this.#now = input.now ?? Date.now;
  }

  continued(): ResearchSession {
    return new ResearchSession({ researchId: this.researchId, part: this.part, oneByOne: this.oneByOne, budget: this.budget, limits: this.limits, pages: this.pages, seen: this.#seen, candidates: this.candidates, now: this.#now });
  }

  see(url: string): void {
    const key = normalizeUrl(url);
    if (key !== null && !this.#seen.has(key)) this.#seen.set(key, url);
  }

  saw(url: string): boolean {
    const key = normalizeUrl(url);
    return key !== null && this.#seen.has(key);
  }

  // 守り 7: 開けるのは beat が見た URL の書き方だけ（モデルが足した空白や / を外へ送らない）
  seenUrl(url: string): string | undefined {
    const key = normalizeUrl(url);
    return key === null ? undefined : this.#seen.get(key);
  }

  get takesCandidates(): boolean { return this.oneByOne && this.part === 'first'; }

  overTime(): boolean { return this.#now() - this.budget.started >= this.limits.minutes * 60_000; }
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
