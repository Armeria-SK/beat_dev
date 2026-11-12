import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDelta, lineDelta } from '../src/shared/line-delta.ts';

// 書き換えの前後の行の足し引き（file_write の結果と、画面の ToolRow の +n −n）。行は中身で突き合わせ、並びは見ない。

test('lineDelta: 作る・消す・変えない', () => {
  assert.deepEqual(lineDelta('', 'a\nb\nc'), { added: 3, removed: 0 });
  assert.deepEqual(lineDelta('a\nb\nc\n', ''), { added: 0, removed: 3 });
  assert.deepEqual(lineDelta('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
  assert.deepEqual(lineDelta('', ''), { added: 0, removed: 0 });
});

test('lineDelta: 1 行を変えると +1 −1、末尾の改行と CRLF は行を作らない', () => {
  assert.deepEqual(lineDelta('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta('a\r\nb\r\n', 'a\nb'), { added: 0, removed: 0 });
  assert.deepEqual(lineDelta('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
});

test('lineDelta: 同じ中身の行は数で突き合わせる（重なった行を 1 つ消すと −1）。動かしただけの行は数えない', () => {
  assert.deepEqual(lineDelta('x\nx\nx\n', 'x\nx\n'), { added: 0, removed: 1 });
  assert.deepEqual(lineDelta('a\nb\n', 'b\na\n'), { added: 0, removed: 0 });
  assert.deepEqual(lineDelta('one\ntwo\n3', 'one\ntwo\n3new'), { added: 1, removed: 1 });
});

test('appendDelta: 足す書き込みは前の中身と突き合わせず数える（前の終わりに改行が無ければ、最後の行が 1 つ変わる）。中身の違う行どうしでは lineDelta と同じ数', () => {
  const cases: Array<[string, string]> = [['', 'a\nb'], ['a\n', 'b\nc\n'], ['a', 'b\nc'], ['a', '\nb'], ['a', 'b'], ['a\r\n', 'b'], ['a', ''], ['a', '\n'], ['x\ny', 'z\n']];
  for (const [before, appended] of cases) assert.deepEqual(appendDelta(before, appended), lineDelta(before, before + appended), JSON.stringify([before, appended]));
});
