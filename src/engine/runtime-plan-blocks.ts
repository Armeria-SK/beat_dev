// 計画の道具を MCP で渡せない実行役（Codex。AR-9b）の、返事の文の中の決まった塊を取り出す。
// 塊: <beat-plan language="ja">…</beat-plan>（計画の全文）、<beat-acceptance>{…}</beat-acceptance>（受け入れの一覧。固定の前）、<beat-acceptance-change>{…}</beat-acceptance-change>（変更の案。固定のあと）。
// 取り出すだけで、何も書かない・信用しない: 書くのは beat の道具（plan_write など）で、入力はそこで型・長さ・秘密を確かめる。
// 読み方: 開きの印は行の頭、閉じの印は行の頭か行の終わりにあるものだけ。文の途中の言及（`<beat-plan>` の塊を下に書きました、など）は印として読まない。
// 閉じの印は同じ種類のいちばん後ろのものを取り、その直前でいちばん近い開きの印から読む（言い直したものを使い、前置きの言及に引きずられない）。コードの囲い（``` ・ ~~~）の中の印は読まない（テンプレートの引用など）
export type PlanBlockTool = 'plan_write' | 'acceptance_write' | 'acceptance_change';

export type PlanBlock = { tool: PlanBlockTool; input: unknown } | { tool: PlanBlockTool; error: string };

const PLAN_OPEN = /^[ \t]*<beat-plan(?:[ \t]+language="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})")?[ \t]*>/u;

const SPECS: ReadonlyArray<{ tool: PlanBlockTool; open: RegExp; close: string }> = [
  { tool: 'plan_write', open: PLAN_OPEN, close: '</beat-plan>' },
  { tool: 'acceptance_write', open: /^[ \t]*<beat-acceptance>/u, close: '</beat-acceptance>' },
  { tool: 'acceptance_change', open: /^[ \t]*<beat-acceptance-change>/u, close: '</beat-acceptance-change>' },
];

// コードの囲いの中（囲いの行も含む）の行
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let fence: { char: string; size: number } | undefined;
  for (const line of lines) {
    if (!fence) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      const mark = opening?.[1];
      if (opening && mark && !(mark.startsWith('`') && (opening[2] ?? '').includes('`'))) { fence = { char: mark[0]!, size: mark.length }; fenced.push(true); continue; }
      fenced.push(false);
      continue;
    }
    fenced.push(true);
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u.exec(line)?.[1];
    if (closing && closing.startsWith(fence.char) && closing.length >= fence.size) fence = undefined;
  }
  return fenced;
}

// 閉じの印が、行の終わり、または行の頭にあるときの位置（無ければ -1）
function closerAt(line: string, tag: string): number {
  const end = line.lastIndexOf(tag);
  if (end >= 0 && line.slice(end + tag.length).trim() === '') return end;
  const start = line.indexOf(tag);
  return start >= 0 && line.slice(0, start).trim() === '' ? start : -1;
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
  const lines = text.split('\r\n').join('\n').split('\n');
  const fenced = fencedLines(lines);
  const blocks: PlanBlock[] = [];
  for (const spec of SPECS) {
    let closeLine = -1;
    let closeCol = -1;
    for (let i = lines.length - 1; i >= 0 && closeLine < 0; i -= 1) {
      if (fenced[i]) continue;
      const col = closerAt(lines[i]!, spec.close);
      if (col >= 0) { closeLine = i; closeCol = col; }
    }
    if (closeLine < 0) continue;
    for (let j = closeLine; j >= 0; j -= 1) {
      if (fenced[j]) continue;
      const open = spec.open.exec(lines[j]!);
      if (!open || (j === closeLine && open[0].length > closeCol)) continue;
      const first = lines[j]!.slice(open[0].length, j === closeLine ? closeCol : undefined);
      const rest = j === closeLine ? [] : [...lines.slice(j + 1, closeLine), lines[closeLine]!.slice(0, closeCol)];
      const body = [first, ...rest].join('\n').replace(/^\n/u, '').replace(/\n$/u, '');
      if (spec.tool === 'plan_write') {
        blocks.push(body.trim() === '' ? { tool: spec.tool, error: 'the plan is empty' } : { tool: spec.tool, input: { content: body, ...(open[1] ? { language: open[1] } : {}) } });
      } else {
        const parsed = jsonOf(body);
        blocks.push(parsed.ok ? { tool: spec.tool, input: parsed.value } : { tool: spec.tool, error: parsed.error });
      }
      break;
    }
  }
  return blocks;
}
