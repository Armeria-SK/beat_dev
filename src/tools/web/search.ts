import type { Language } from '../../config/schema.ts';
import type { MessageParams } from '../../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../../shared/messages/tools.ts';

// 検索の本体は search/metasearch.ts（複数の検索先を少しずつ同時に試し、止められた先は休ませて別の先へ移る。captcha は解かない）。
// 転送をたどってよいホストは、有効な先のホストの和（search/metasearch.ts の searchHosts）
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
