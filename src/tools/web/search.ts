import type { Language } from '../../config/schema.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';
import { decodeText, fetchPublic, RetrievalFailure, searchNetwork, type PageNetwork } from './public-page.ts';
import { readSafely, type SearchHit } from './search/engine.ts';
import { duckduckgoHtml } from './search/engines/duckduckgo-html.ts';

export type { SearchHit } from './search/engine.ts';

export class SearchFailure extends Error {
  readonly key: ToolMessageKey | undefined;
  readonly params: MessageParams;
  constructor(message: string, key?: ToolMessageKey, params: MessageParams = {}) { super(message); this.key = key; this.params = params; }

  text(language: Language): string { return this.key ? toolText(language, this.key, this.params) : this.message; }
}

export function searchFailure(key: ToolMessageKey, params: MessageParams = {}): SearchFailure {
  return new SearchFailure(toolText('en', key, params), key, params);
}

export type SearchProvider = 'duckduckgo' | 'off';

export function parseDuckDuckGo(html: string, limit: number): SearchHit[] {
  const result = readSafely(duckduckgoHtml, html, 'text/html', limit);
  if (result.state === 'blocked') throw searchFailure('search.blocked');
  return result.hits;
}

export const SEARCH_HOSTS: ReadonlySet<string> = new Set(duckduckgoHtml.hosts(''));

export async function searchDuckDuckGo(query: string, options: { limit: number; region: string; signal?: AbortSignal | undefined; network?: PageNetwork | undefined; onlySearchHosts?: boolean | undefined }): Promise<SearchHit[]> {
  const url = duckduckgoHtml.request(query, options.region);
  try {
    const page = await fetchPublic(url.href, options.signal, options.network ?? searchNetwork, 15_000, undefined, options.onlySearchHosts ? SEARCH_HOSTS : undefined);
    return parseDuckDuckGo(decodeText(page.body, page.contentType), options.limit);
  } catch (error) {
    // 202 は DuckDuckGo の「自動アクセスの確認」。回避はせずに知らせる
    if (error instanceof RetrievalFailure && (error.code === 'refused' || error.status === 202)) {
      throw searchFailure('search.blocked');
    }
    throw error;
  }
}

export class SearchThrottle {
  #times: number[] = [];
  readonly #now: () => number;
  constructor(now: () => number = Date.now) { this.#now = now; }
  take(maxPerHour: number, minIntervalMs = 1500): number {
    const now = this.#now();
    this.#times = this.#times.filter(t => now - t < 3_600_000);
    if (this.#times.length >= maxPerHour) throw searchFailure('search.limit', { max: maxPerHour });
    const last = this.#times.at(-1);
    const wait = last === undefined ? 0 : Math.max(0, minIntervalMs - (now - last));
    this.#times.push(now + wait);
    return wait;
  }
}
