// 書き換えの前後の行の足し引き（画面の ToolRow の `+n −n`）。行は中身で突き合わせ、並びは見ない
// （動かしただけの行は数えない。差分の道具の数とは、行を入れ替えたときだけずれる）。末尾の改行は行を作らない。
export interface LineDelta { added: number; removed: number }

function lines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export function appendDelta(before: string, appended: string): LineDelta {
  if (before === '' || before.endsWith('\n')) return { added: lines(appended).length, removed: 0 };
  const cut = appended.indexOf('\n');
  const head = (cut < 0 ? appended : appended.slice(0, cut)).replace(/\r$/u, '');
  const rest = cut < 0 ? 0 : lines(appended.slice(cut + 1)).length;
  return head === '' ? { added: rest, removed: 0 } : { added: 1 + rest, removed: 1 };
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

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
const DIFF_CELLS = 4_000_000;

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > DIFF_CELLS) return [...a.map((text): DiffLine => ({ kind: 'del', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))];
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (common[(i + 1) * width + j]! >= common[i * width + j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}
