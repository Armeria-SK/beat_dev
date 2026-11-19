import { createHash } from 'node:crypto';
import { estimateTextTokens } from '../../src/engine/tokens.ts';

// プロンプトのキャッシュの真似（S1）。本物の数とは合わないが、前後の比べと「前半がそろうか」の判定に使う。
// Anthropic: 道具 → system → 発言のブロックを並びのまま正規化して累積の hash を取る。区切り（cache_control）の位置で書き、
// 前の呼び出しまでに書いた hash のうち、どれかの区切りから 20 ブロック以内で見つかる最長の一致を読む。最後の区切りより後ろは毎回の入力。
// OpenAI 互換: 前の本文と、道具と発言を頭から 1 つずつ比べて一致した分を読む（自動の前方一致・ローカルの KV の再利用の真似）。

export const LOOKBACK = 20;

export interface CallCost { read: number; write: number; input: number }
export interface SimTotals { calls: CallCost[]; read: number; write: number; input: number; readShare: number }

type Json = Record<string, unknown>;
const tokens = (value: unknown): number => estimateTextTokens(JSON.stringify(value));
const strip = (block: Json): Json => { const { cache_control: _cc, ...rest } = block; return rest; };

interface Unit { key: string; tokens: number; breakpoint: boolean }

// 本文を、キャッシュが数える順のブロックの並びにする（発言は役の印を前に付ける）
export function anthropicUnits(body: Json): Unit[] {
  const units: Unit[] = [];
  const push = (block: Json, prefix = '') => units.push({ key: prefix + JSON.stringify(strip(block)), tokens: tokens(strip(block)), breakpoint: block.cache_control !== undefined });
  for (const tool of (body.tools as Json[] | undefined) ?? []) push(tool, 'tool:');
  const system = body.system;
  if (typeof system === 'string') push({ type: 'text', text: system }, 'system:');
  else for (const block of (system as Json[] | undefined) ?? []) push(block, 'system:');
  for (const message of (body.messages as Array<{ role: string; content: string | Json[] }>) ?? []) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    blocks.forEach((block, i) => push(block, i === 0 ? `${message.role}:` : ''));
  }
  return units;
}

export class AnthropicCacheSim {
  readonly #written = new Set<string>();
  readonly calls: CallCost[] = [];

  call(body: Json): CallCost {
    const units = anthropicUnits(body);
    const hashes: string[] = [];
    const h = createHash('sha256');
    for (const unit of units) { h.update(unit.key); h.update('\u0000'); hashes.push(h.copy().digest('hex')); }
    const breakpoints = units.flatMap((u, i) => (u.breakpoint ? [i] : []));
    const last = breakpoints.at(-1) ?? -1;
    // 区切りごとに、その位置から LOOKBACK ブロック前までで、前に書いた hash を探す（API と同じく、それより前は探さない）。
    // API は続いた tool_use・tool_result をそれぞれ 1 つと数えるが、ここでは 1 ブロックずつ数える（厳しめ）
    let readEnd = -1;
    for (const b of breakpoints) {
      for (let i = b; i >= Math.max(0, b - LOOKBACK); i--) if (this.#written.has(hashes[i]!)) { readEnd = Math.max(readEnd, i); break; }
    }
    const sum = (from: number, to: number) => units.slice(from, to + 1).reduce((s, u) => s + u.tokens, 0);
    const cost = { read: sum(0, readEnd), write: sum(readEnd + 1, last), input: sum(last + 1, units.length - 1) };
    for (const i of breakpoints) this.#written.add(hashes[i]!);
    this.calls.push(cost);
    return cost;
  }
}

export class OpenAiCacheSim {
  #previous: string[] = [];
  readonly calls: CallCost[] = [];

  call(body: Json): CallCost {
    const items = [...((body.tools as unknown[] | undefined) ?? []), ...((body.messages as unknown[] | undefined) ?? [])].map(item => JSON.stringify(item));
    let same = 0;
    while (same < items.length && same < this.#previous.length && items[same] === this.#previous[same]) same++;
    const sum = (list: string[]) => list.reduce((s, item) => s + estimateTextTokens(item), 0);
    const cost = { read: sum(items.slice(0, same)), write: 0, input: sum(items.slice(same)) };
    this.#previous = items;
    this.calls.push(cost);
    return cost;
  }
}

// from 回目（0 から数える）以降の合計と、読みの割合（読み / (読み + 書き + 入力)）
export function totals(calls: readonly CallCost[], from = 0): SimTotals {
  const part = calls.slice(from);
  const read = part.reduce((s, c) => s + c.read, 0);
  const write = part.reduce((s, c) => s + c.write, 0);
  const input = part.reduce((s, c) => s + c.input, 0);
  return { calls: part, read, write, input, readShare: read / Math.max(1, read + write + input) };
}

export const blockTokens = tokens;
