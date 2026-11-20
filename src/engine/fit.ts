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
// 組になる呼び出しの無い結果の行は外す（前の不具合で残った行・道具の途中で閉じたアプリ。提供元は組でない履歴を断る）。何も変えなければ同じ配列を返す
export function closeToolCalls(messages: readonly ChatMessage[], notRun: string): readonly ChatMessage[] {
  const out: ChatMessage[] = [];
  let changed = false;
  for (let i = 0; i < messages.length;) {
    const m = messages[i]!;
    i++;
    if (m.role === 'tool') { changed = true; continue; }
    out.push(m);
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const open = new Map(m.toolCalls.map(call => [call.id, call.name]));
    for (; i < messages.length && messages[i]!.role === 'tool'; i++) {
      const row = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
      if (open.delete(row.toolCallId)) out.push(row); else changed = true;
    }
    for (const [toolCallId, name] of open) { out.push({ role: 'tool', toolCallId, name, content: notRun, isError: true }); changed = true; }
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
