// 書き換えの前後の行の足し引き（画面の ToolRow の `+n −n`）。行は中身で突き合わせ、並びは見ない
// （動かしただけの行は数えない。差分の道具の数とは、行を入れ替えたときだけずれる）。末尾の改行は行を作らない。
export interface LineDelta { added: number; removed: number }

function lines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export function lineDelta(before: string, after: string): LineDelta {
  const left = new Map<string, number>();
  for (const line of lines(before)) left.set(line, (left.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after)) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return { added, removed };
}
