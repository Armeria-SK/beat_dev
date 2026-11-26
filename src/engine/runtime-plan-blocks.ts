// 計画の道具を MCP で渡せない実行役（Codex。AR-9b）の、返事の文の中の決まった塊を取り出す。
// 塊: <beat-plan language="ja">…</beat-plan>（計画の全文）、<beat-acceptance>{…}</beat-acceptance>（受け入れの一覧。固定の前）、<beat-acceptance-change>{…}</beat-acceptance-change>（変更の案。固定のあと）。
// 取り出すだけで、何も書かない・信用しない: 書くのは beat の道具（plan_write など）で、入力はそこで型・長さ・秘密を確かめる。
// 読み方: 開きの印は行の頭、閉じの印は行の頭か行の終わりにあるものだけ。文の途中の言及（`<beat-plan>` の塊を下に書きました、など）は印として読まない。
// 閉じの印は同じ種類のいちばん後ろのものを取り、その直前でいちばん近い開きの印から読む（言い直したものを使い、前置きの言及に引きずられない）。塊の終わりは、その開きの印のあとの最初の閉じの印（塊のあとの閉じの印の言及は、計画に入れない）。
// コードの囲い（``` ・ ~~~）の中の印は読まない（テンプレートの引用など）。読まなかった印は黙って捨てず、unreadPlanBlocks が「読めなかった」の結果にして、持ち主に見せる
export type PlanBlockTool = 'plan_write' | 'acceptance_write' | 'acceptance_change';

export type PlanBlock = { tool: PlanBlockTool; input: unknown } | { tool: PlanBlockTool; error: string };

const PLAN_OPEN = /^[ \t]*<beat-plan(?:[ \t]+language="([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3})")?[ \t]*>/u;

const SPECS: ReadonlyArray<{ tool: PlanBlockTool; open: RegExp; close: string; tag: RegExp }> = [
  { tool: 'plan_write', open: PLAN_OPEN, close: '</beat-plan>', tag: /^[ \t]*<\/?beat-plan(?:[ \t>]|$)/u },
  { tool: 'acceptance_write', open: /^[ \t]*<beat-acceptance>/u, close: '</beat-acceptance>', tag: /^[ \t]*<\/?beat-acceptance[ \t]*>/u },
  { tool: 'acceptance_change', open: /^[ \t]*<beat-acceptance-change>/u, close: '</beat-acceptance-change>', tag: /^[ \t]*<\/?beat-acceptance-change[ \t]*>/u },
];

const UNREAD = 'the block was inside a code fence, in an earlier message of the reply, or not closed; ask for it again as plain text in the last message, with each tag at the start of a line';

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

// 行の中の閉じの印のうち、行の頭（前に空白しかない）か行の終わり（後ろに空白しかない）にあるものの位置を、前から順に。from より前のものは数えない
function closersAt(line: string, tag: string, from: number): number[] {
  const found: number[] = [];
  const head = line.length - line.trimStart().length;
  if (line.startsWith(tag, head) && head >= from) found.push(head);
  const tail = line.trimEnd().length - tag.length;
  if (tail >= from && tail !== head && line.startsWith(tag, tail)) found.push(tail);
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

const linesOf = (text: string): string[] => text.split('\r\n').join('\n').split('\n');

export function planBlocksOf(text: string): PlanBlock[] {
  const lines = linesOf(text);
  const fenced = fencedLines(lines);
  const blocks: PlanBlock[] = [];
  for (const spec of SPECS) {
    let lastLine = -1;
    let lastCol = -1;
    for (let i = lines.length - 1; i >= 0 && lastLine < 0; i -= 1) {
      if (fenced[i]) continue;
      const last = closersAt(lines[i]!, spec.close, 0).at(-1);
      if (last !== undefined) { lastLine = i; lastCol = last; }
    }
    if (lastLine < 0) continue;
    for (let j = lastLine; j >= 0; j -= 1) {
      if (fenced[j]) continue;
      const open = spec.open.exec(lines[j]!);
      if (!open || (j === lastLine && open[0].length > lastCol)) continue;
      let endLine = -1;
      let endCol = -1;
      for (let k = j; k <= lastLine && endLine < 0; k += 1) {
        if (fenced[k]) continue;
        const first = closersAt(lines[k]!, spec.close, k === j ? open[0].length : 0)[0];
        if (first !== undefined) { endLine = k; endCol = first; }
      }
      const first = lines[j]!.slice(open[0].length, j === endLine ? endCol : undefined);
      const rest = j === endLine ? [] : [...lines.slice(j + 1, endLine), lines[endLine]!.slice(0, endCol)];
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

// 返事の全文に、行の頭の印（開きでも閉じでも。コードの囲いの中も数える）があるのに、最後の発言からは取れなかった種類を、「読めなかった」の結果にする。実行役が「保存した」と言うのに、何も残らないことを黙らせないため
export function unreadPlanBlocks(whole: string, taken: readonly PlanBlock[]): PlanBlock[] {
  const lines = linesOf(whole);
  return SPECS.filter(spec => !taken.some(block => block.tool === spec.tool) && lines.some(line => spec.tag.test(line))).map(spec => ({ tool: spec.tool, error: UNREAD }));
}
