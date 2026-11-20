import { DEFAULT_LANGUAGE } from '../config/schema.ts';
import { engineText } from '../shared/messages/engine.ts';
import type { ChatMessage, ToolSpec } from './types.ts';
import { estimateRequest, type Estimate } from './tokens.ts';

export class ContextOverflow extends Error {
  readonly required: number;
  readonly available: number;
  constructor(required: number, available: number) {
    super(engineText(DEFAULT_LANGUAGE, 'fit.overflow', { required: required.toLocaleString('en-US'), available: available.toLocaleString('en-US') }));
    this.required = required;
    this.available = available;
  }
}

export function groupExchanges(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.note !== 'continue' && current.length) { groups.push(current); current = []; }
    current.push(m);
  }
  if (current.length) groups.push(current);
  return groups;
}

export interface Fitted {
  messages: ChatMessage[];
  removed: number;
  estimate: Estimate;
}

// fitMessages がどれだけ古い発言を外しても残る、いちばん小さい送信量（system・道具の仕様・最後のやり取り 1 つ）。
// これが available を超えると fitMessages は ContextOverflow を投げる。逆に、available との差が、いま道具の結果などを足せる余裕
// tail: まだ発言に付けていない、次に送る tail（estimateRequest と同じ）
export function irreducibleEstimate(input: { system: string; messages: readonly ChatMessage[]; tools: readonly ToolSpec[]; factor?: number; tail?: string }): Estimate {
  return estimateRequest(input.system, groupExchanges(input.messages).at(-1) ?? [], input.tools, input.factor ?? 1, input.tail);
}

// 送る履歴の道具の呼び出しを結果と組にする: 結果の行が無い呼び出しには、その回の結果の行のあとに「動かしていない」行を足し、
// 組になる呼び出しの無い結果の行は外す（前の不具合で残った行・道具の途中で閉じたアプリ。提供元は組でない履歴を断る）。何も変えなければ同じ配列を返す。
// 直した回の tail（外した行の分も）は、その回の最後の結果の行にまとめる（adapter は tail を結果の行のすぐ後ろに置くので、途中にあると結果の並びが切れる）
export function closeToolCalls(messages: readonly ChatMessage[], notRun: string, added?: Set<string>): readonly ChatMessage[] {
  type ToolRow = Extract<ChatMessage, { role: 'tool' }>;
  const join = (a: string | undefined, b: string | undefined): string | undefined => (a === undefined ? b : b === undefined ? a : `${a}\n${b}`);
  const bare = (row: ToolRow): ToolRow => { const { tail: _tail, ...rest } = row; return rest; };
  const out: ChatMessage[] = [];
  let changed = false;
  let carry: string | undefined;
  for (let i = 0; i < messages.length;) {
    const m = messages[i]!;
    i++;
    if (m.role === 'tool') {
      changed = true;
      const last = out.at(-1);
      if (m.tail !== undefined && last && last.role !== 'assistant') out[out.length - 1] = { ...last, tail: join(last.tail, m.tail)! };
      else carry = join(carry, m.tail);
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push(m);
      const open = new Map(m.toolCalls.map(call => [call.id, call.name]));
      const rows: ToolRow[] = [];
      let tail = carry;
      let fixed = carry !== undefined;
      carry = undefined;
      for (; i < messages.length && messages[i]!.role === 'tool'; i++) {
        const row = messages[i] as ToolRow;
        tail = join(tail, row.tail);
        if (open.delete(row.toolCallId)) rows.push(bare(row)); else fixed = true;
      }
      for (const [toolCallId, name] of open) { rows.push({ role: 'tool', toolCallId, name, content: notRun, isError: true }); added?.add(toolCallId); fixed = true; }
      if (!fixed) { out.push(...messages.slice(i - rows.length, i)); continue; }
      changed = true;
      if (tail !== undefined) rows[rows.length - 1] = { ...rows.at(-1)!, tail };
      out.push(...rows);
      continue;
    }
    out.push(m.role !== 'assistant' && carry !== undefined ? { ...m, tail: join(carry, m.tail)! } : m);
    if (m.role !== 'assistant') carry = undefined;
  }
  if (carry !== undefined) {
    const at = out.findLastIndex(m => m.role !== 'assistant');
    const target = out[at];
    if (target && target.role !== 'assistant') out[at] = { ...target, tail: join(target.tail, carry)! };
  }
  return changed ? out : messages;
}

export function fitMessages(input: {
  system: string; messages: readonly ChatMessage[]; tools: readonly ToolSpec[]; available: number; factor?: number; tail?: string;
}): Fitted {
  const factor = input.factor ?? 1;
  let groups = groupExchanges(input.messages);
  const total = input.messages.length;
  for (;;) {
    const messages = groups.flat();
    const estimate = estimateRequest(input.system, messages, input.tools, factor, input.tail);
    if (estimate.tokens <= input.available) return { messages, removed: total - messages.length, estimate };
    if (groups.length <= 1) throw new ContextOverflow(estimate.tokens, input.available);
    groups = groups.slice(1);
  }
}
