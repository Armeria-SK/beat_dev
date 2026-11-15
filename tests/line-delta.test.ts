import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDelta, lineDelta, lineDiff } from '../src/shared/line-delta.ts';

// 書き換えの前後の行の足し引き（file_write の結果と、画面の ToolRow の +n −n）。行は中身で突き合わせ、並びは見ない。

const DELTA_ROWS: Array<{ name: string; cases: Array<[string, string, number, number]> }> = [
  { name: 'lineDelta: 作る・消す・変えない', cases: [['', 'a\nb\nc', 3, 0], ['a\nb\nc\n', '', 0, 3], ['a\nb\n', 'a\nb\n', 0, 0], ['', '', 0, 0]] },
  { name: 'lineDelta: 1 行を変えると +1 −1、末尾の改行と CRLF は行を作らない', cases: [['a\nb\nc\n', 'a\nB\nc\n', 1, 1], ['a\r\nb\r\n', 'a\nb', 0, 0], ['a\nb', 'a\nb\n', 0, 0]] },
  { name: 'lineDelta: 同じ中身の行は数で突き合わせる（重なった行を 1 つ消すと −1）。動かしただけの行は数えない',
    cases: [['x\nx\nx\n', 'x\nx\n', 0, 1], ['a\nb\n', 'b\na\n', 0, 0], ['one\ntwo\n3', 'one\ntwo\n3new', 1, 1]] },
];

for (const row of DELTA_ROWS) {
  test(row.name, () => {
    for (const [before, after, added, removed] of row.cases) assert.deepEqual(lineDelta(before, after), { added, removed }, JSON.stringify([before, after]));
  });
}

test('appendDelta: 足す書き込みは前の中身と突き合わせず数える（前の終わりに改行が無ければ、最後の行が 1 つ変わる）。中身の違う行どうしでは lineDelta と同じ数', () => {
  const cases: Array<[string, string]> = [['', 'a\nb'], ['a\n', 'b\nc\n'], ['a', 'b\nc'], ['a', '\nb'], ['a', 'b'], ['a\r\n', 'b'], ['a', ''], ['a', '\n'], ['x\ny', 'z\n']];
  for (const [before, appended] of cases) assert.deepEqual(appendDelta(before, appended), lineDelta(before, before + appended), JSON.stringify([before, appended]));
});

test('lineDiff: 前と後の行を、順を保って同じ・足した・消したで並べる（この例では印の数が lineDelta と同じ）', () => {
  const before = '1. Fetch wttr.in\n2. Read the days\n3. Answer\n';
  const after = '1. Fetch wttr.in\n2. For next week, open the 10-day page\n2. Read the days\n3. Answer with the source\n';
  const diff = lineDiff(before, after);
  assert.deepEqual(diff, [
    { kind: 'same', text: '1. Fetch wttr.in' },
    { kind: 'add', text: '2. For next week, open the 10-day page' },
    { kind: 'same', text: '2. Read the days' },
    { kind: 'del', text: '3. Answer' },
    { kind: 'add', text: '3. Answer with the source' },
  ]);
  const count = (kind: string) => diff.filter(line => line.kind === kind).length;
  assert.deepEqual({ added: count('add'), removed: count('del') }, lineDelta(before, after));
  assert.deepEqual(lineDiff('', 'a\r\nb'), [{ kind: 'add', text: 'a' }, { kind: 'add', text: 'b' }]);
  assert.deepEqual(lineDiff('a\nb', ''), [{ kind: 'del', text: 'a' }, { kind: 'del', text: 'b' }]);
  assert.deepEqual(lineDiff('a\nb', 'a\nb\n'), [{ kind: 'same', text: 'a' }, { kind: 'same', text: 'b' }]);
});

test('lineDiff: とても長い前後は突き合わせを省き、前を全部消した・後を全部足した形で返す（固まらない）', () => {
  const before = [...Array.from({ length: 2100 }, (_, i) => `old ${i}`), 'shared'].join('\n');
  const after = ['shared', ...Array.from({ length: 2100 }, (_, i) => `new ${i}`)].join('\n');
  const diff = lineDiff(before, after);
  assert.equal(diff.length, 4202);
  assert.equal(diff.some(line => line.kind === 'same'), false, '同じ行があっても突き合わせない');
  assert.deepEqual([diff[0], diff[2100], diff[2101]], [{ kind: 'del', text: 'old 0' }, { kind: 'del', text: 'shared' }, { kind: 'add', text: 'shared' }]);
});

test('lineDiff: 前後で同じ頭と尻の行は先に除くので、上限を超える長さでも同じ・ほぼ同じ本文は全部変わった扱いにならない', () => {
  const body = Array.from({ length: 2100 }, (_, i) => `step ${i}`);
  const same = lineDiff(body.join('\n'), body.join('\n'));
  assert.equal(same.length, 2100);
  assert.equal(same.every(line => line.kind === 'same'), true);
  const changed = [...body];
  changed[1000] = 'step 1000, then check the result';
  const near = lineDiff(body.join('\n'), changed.join('\n'));
  assert.deepEqual(near.filter(line => line.kind !== 'same'), [{ kind: 'del', text: 'step 1000' }, { kind: 'add', text: 'step 1000, then check the result' }]);
  assert.equal(near.length, 2101);
});

test('lineDiff と lineDelta: 行を入れ替えただけのとき、差分には印が付くが、行の足し引きは 0（画面の数は lineDelta で出す）', () => {
  assert.deepEqual(lineDiff('A\nB', 'B\nA'), [{ kind: 'del', text: 'A' }, { kind: 'same', text: 'B' }, { kind: 'add', text: 'A' }]);
  assert.deepEqual(lineDelta('A\nB', 'B\nA'), { added: 0, removed: 0 });
});
