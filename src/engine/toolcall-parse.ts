import { randomUUID } from 'node:crypto';
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

export function looksLikeTextToolCall(text: string): boolean {
  return /<tool_call>|\[TOOL_CALLS\]|"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"/u.test(text);
}
