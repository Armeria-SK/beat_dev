import { randomUUID } from 'node:crypto';
import { isSensitiveName } from '../shared/redaction.ts';
import type { ToolCall } from './types.ts';

export function extractToolCalls(text: string, toolNames: ReadonlySet<string>): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = [];
  let rest = text;

  const take = (raw: string): boolean => {
    let value: unknown;
    try { value = JSON.parse(raw.trim()); } catch { return false; }
    const items = Array.isArray(value) ? value : [value];
    let found = false;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const fn = (obj.function && typeof obj.function === 'object' ? obj.function : obj) as Record<string, unknown>;
      const name = fn.name;
      if (typeof name !== 'string' || !toolNames.has(name)) continue;
      let args: unknown = fn.arguments ?? fn.parameters ?? fn.args ?? {};
      let rawArgs: string | undefined;
      if (typeof args === 'string') { rawArgs = args; try { args = JSON.parse(args); } catch { args = undefined; } }
      calls.push({ id: `call_${randomUUID()}`, name, arguments: args, raw: rawArgs ?? JSON.stringify(args) });
      found = true;
    }
    return found;
  };

  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gu, (whole, body: string) => (take(body) ? '' : whole));
  rest = rest.replace(/\[TOOL_CALLS\]\s*(\[[\s\S]*\])/u, (whole, body: string) => (take(body) ? '' : whole));
  if (!calls.length) {
    rest = rest.replace(/```(?:json|tool_call)?\s*\n([\s\S]*?)\n```/gu, (whole, body: string) => (/"name"\s*:/u.test(body) && take(body) ? '' : whole));
  }
  if (!calls.length) {
    const trimmed = rest.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}') && take(trimmed)) rest = '';
  }
  return { calls, text: rest.replace(/\n{3,}/gu, '\n\n').trim() };
}

const TEXT_TOOL_CALL = /<tool_call>|\[TOOL_CALLS\]|"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"/u;

export function looksLikeTextToolCall(text: string): boolean {
  return TEXT_TOOL_CALL.test(text);
}

// 画面へ流すのをやめる印は、拾う印（TEXT_TOOL_CALL）に、引数の欄の名前とコロン（arguments・parameters・args、\u で書いた欄の名前も）を足したもの。
// 拾う側は、欄の順・名前の位置を問わず、この 3 つの欄のどれかの値を引数にする。だから引数の値は必ずこの印より後ろにあり、引数が先・間に別の欄・args の形でも、値を流す前に止まる。
// 流した文字は取り消せないので、引数を流した呼び出しを実行することは無い。エスケープで書いた欄の名前は、小文字の英字とエスケープだけでできていて、全部の字を書いても 60 字（10 字 × 6）を超えないので、その形だけ見る（長い本文を毎回なめ直さない）
const ARGUMENT_KEY = /"(?:arguments|parameters|args)"\s*:|"[a-z]{0,59}\\u[0-9a-fA-F]{4}(?:[a-z]|\\u[0-9a-fA-F]{4}){0,59}"\s*:/u;
const STREAM_HOLD = new RegExp(`${TEXT_TOOL_CALL.source}|${ARGUMENT_KEY.source}`, 'u');

// 本文に書かれたツール呼び出しの始まりの位置（無ければ -1）。引数（試しの暗証番号など）は、必ず始まりの印より後ろに来る。ここより後ろは、画面への知らせにも書きかけの履歴にも流さない
export function textToolCallStart(text: string): number {
  const found = STREAM_HOLD.exec(text);
  if (found === null) return -1;
  if (!found[0].startsWith('"name"')) return found.index;
  const brace = text.lastIndexOf('{', found.index);
  return brace === -1 ? found.index : brace;
}

// 画面へ流してよい長さ（text は返事のここまで、streamed はいままで流した長さ）。印が見えたら、そこから先は流さない（流した分は戻らない）
export function streamEnd(text: string, streamed: number): number {
  const start = textToolCallStart(text);
  return start === -1 ? text.length : Math.max(start, streamed);
}

const SENSITIVE_VALUE_MIN = 4;
const SENSITIVE_VALUE_DEPTH = 20;

// 拾った呼び出しの引数のうち、秘密の名前の欄（password など。その下の入れ子・配列も）の文字列。呼び出しとして取り除かれなかった本文（繰り返した呼び出し・壊れた呼び出し・説明）に同じ値が残るので、保存の前に伏せるのに使う。
// 4 文字より短い値は集めない（本文の 1 文字まで壊れる）
export function sensitiveArgValues(calls: readonly ToolCall[]): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number, inherited: boolean): void => {
    if (depth > SENSITIVE_VALUE_DEPTH || value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const sensitive = inherited || isSensitiveName(key);
      if (typeof item === 'string') { if (sensitive && item.trim().length >= SENSITIVE_VALUE_MIN) found.add(item); }
      else walk(item, depth + 1, sensitive);
    }
  };
  for (const call of calls) walk(call.arguments, 0, false);
  return [...found];
}
