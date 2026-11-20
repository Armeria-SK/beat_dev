import type { SearchEngine } from './engine.ts';

export type EngineOutcome = 'ok' | 'empty' | 'blocked' | 'unknown' | 'error';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// 止められるたびに休みを延ばす（成功で元に戻す）
export const REST_STEPS_MS: readonly number[] = [5 * MINUTE, 15 * MINUTE, 60 * MINUTE];
export const MAX_REST_MS = 60 * MINUTE;
export const UNKNOWN_REST_MS = 5 * MINUTE;

interface EngineRecord { restUntil: number; strikes: number; last: EngineOutcome | undefined; sent: number[]; warned: boolean }

// 検索先ごとの調子（アプリに 1 つ。メモリだけ）: 休み・1 時間の数・同じ provider の間隔・検索ごとに始まりをずらす位置
export class EngineHealth {
  readonly #now: () => number;
  readonly #log: ((line: string) => void) | undefined;
  readonly #engines = new Map<string, EngineRecord>();
  readonly #providerNext = new Map<string, number>();
  #turn = 0;

  constructor(now: () => number = Date.now, log?: (line: string) => void) { this.#now = now; this.#log = log; }

  #record(id: string): EngineRecord {
    let record = this.#engines.get(id);
    if (!record) { record = { restUntil: 0, strikes: 0, last: undefined, sent: [], warned: false }; this.#engines.set(id, record); }
    return record;
  }

  now(): number { return this.#now(); }

  // 検索ごとに 1 つ進む位置（乱数は使わない）
  nextTurn(): number { return this.#turn++; }

  last(id: string): EngineOutcome | undefined { return this.#engines.get(id)?.last; }

  // 休みの残り（ミリ秒）。休み中でなければ 0
  restingFor(id: string): number { return Math.max(0, (this.#engines.get(id)?.restUntil ?? 0) - this.#now()); }

  overHourLimit(engine: SearchEngine): boolean {
    const record = this.#engines.get(engine.id);
    if (!record) return false;
    const now = this.#now();
    record.sent = record.sent.filter(t => now - t < HOUR);
    return record.sent.length >= engine.maxPerHour;
  }

  // 送る枠を取る。同じ provider の前の送信から minIntervalMs 空くまでの待ち（ミリ秒）を返す
  reserve(engine: SearchEngine): number {
    const now = this.#now();
    const at = Math.max(now, this.#providerNext.get(engine.provider) ?? 0);
    this.#providerNext.set(engine.provider, at + engine.minIntervalMs);
    this.#record(engine.id).sent.push(at);
    return at - now;
  }

  record(engine: SearchEngine, outcome: EngineOutcome, retryAfterMs?: number): void {
    const record = this.#record(engine.id);
    const now = this.#now();
    record.last = outcome;
    if (outcome === 'ok' || outcome === 'empty') { record.strikes = 0; record.restUntil = 0; return; }
    if (outcome === 'blocked') {
      record.strikes += 1;
      const rest = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.min(retryAfterMs, MAX_REST_MS) : REST_STEPS_MS[Math.min(record.strikes, REST_STEPS_MS.length) - 1]!;
      record.restUntil = now + rest;
      return;
    }
    if (outcome === 'unknown') {
      record.restUntil = now + UNKNOWN_REST_MS;
      if (!record.warned) { record.warned = true; this.#log?.(`[WARN] search: the result page of ${engine.id} could not be read (its layout may have changed)`); }
    }
  }
}
