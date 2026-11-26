// 計画の道具を MCP で渡せない実行役（Codex。AR-9b）の、返事の文の中の決まった塊を取り出す。
// 塊: <beat-plan language="ja">…</beat-plan>（計画の全文）、<beat-acceptance>{…}</beat-acceptance>（受け入れの一覧。固定の前）、<beat-acceptance-change>{…}</beat-acceptance-change>（変更の案。固定のあと）。
// 取り出すだけで、何も書かない・信用しない: 書くのは beat の道具（plan_write など）で、入力はそこで型・長さ・秘密を確かめる。同じ塊が複数あれば、いちばん後ろのものを使う（言い直したもの）
export type PlanBlockTool = 'plan_write' | 'acceptance_write' | 'acceptance_change';

export type PlanBlock = { tool: PlanBlockTool; input: unknown } | { tool: PlanBlockTool; error: string };

const PLAN = /<beat-plan(?:[ \t]+language="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})")?[ \t]*>\n?([\s\S]*?)\n?<\/beat-plan>/gu;
const ACCEPTANCE = /<beat-acceptance>([\s\S]*?)<\/beat-acceptance>/gu;
const CHANGE = /<beat-acceptance-change>([\s\S]*?)<\/beat-acceptance-change>/gu;

function last(pattern: RegExp, text: string): RegExpExecArray | undefined {
  let found: RegExpExecArray | undefined;
  for (const match of text.matchAll(pattern)) found = match;
  return found;
}

// JSON を ``` で囲んで書く実行役もいる。囲いだけ外して読む
function jsonOf(body: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const unfenced = body.trim().replace(/^```[A-Za-z]*\s*\n/u, '').replace(/\n?```$/u, '').trim();
  try {
    const value: unknown = JSON.parse(unfenced);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: 'it is not a JSON object' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}

export function planBlocksOf(text: string): PlanBlock[] {
  const blocks: PlanBlock[] = [];
  const plan = last(PLAN, text);
  if (plan) {
    const content = plan[2] ?? '';
    blocks.push(content.trim() === '' ? { tool: 'plan_write', error: 'the plan is empty' } : { tool: 'plan_write', input: { content, ...(plan[1] ? { language: plan[1] } : {}) } });
  }
  for (const [pattern, tool] of [[ACCEPTANCE, 'acceptance_write'], [CHANGE, 'acceptance_change']] as const) {
    const found = last(pattern, text);
    if (!found) continue;
    const parsed = jsonOf(found[1] ?? '');
    blocks.push(parsed.ok ? { tool, input: parsed.value } : { tool, error: parsed.error });
  }
  return blocks;
}
