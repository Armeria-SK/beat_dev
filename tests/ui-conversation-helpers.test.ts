import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestOnly } from '../web/src/ui/latest.ts';
import { menuStep } from '../web/src/ui/menu.ts';
import { staggerOf } from '../web/src/ui/tool-row.ts';

// 会話の画面の小さな決まり（1-2 のコードレビューから）。

test('ui/latest: 会話を読み直す要求が重なったとき、最後に出した要求の答えだけを使う（先に出した要求の答えが後に届いても古い一覧に戻さない）', () => {
  const loads = latestOnly();
  const first = loads.begin();
  const second = loads.begin();
  assert.equal(loads.isCurrent(first), false);
  assert.equal(loads.isCurrent(second), true);
});

test('ui/menu: 会話のメニューは ↓ ↑ で項目を回り、Home / End で端へ。ほかのキーは動かさない', () => {
  assert.equal(menuStep(-1, 3, 'ArrowDown'), 0);
  assert.equal(menuStep(0, 3, 'ArrowDown'), 1);
  assert.equal(menuStep(2, 3, 'ArrowDown'), 0);
  assert.equal(menuStep(0, 3, 'ArrowUp'), 2);
  assert.equal(menuStep(-1, 3, 'ArrowUp'), 2);
  assert.equal(menuStep(1, 3, 'Home'), 0);
  assert.equal(menuStep(1, 3, 'End'), 2);
  assert.equal(menuStep(1, 3, 'a'), null);
  assert.equal(menuStep(0, 0, 'ArrowDown'), null);
});

test('ui/tool-row: 一緒に届いた道具の行は、新しいものだけ 0, 1, 2… の順で浮かせる（デザインの --bt-i）', () => {
  assert.deepEqual(staggerOf([false, true, true, false, true]), [null, 0, 1, null, 2]);
  assert.deepEqual(staggerOf([]), []);
});
