import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latestOnly } from '../web/src/ui/latest.ts';
import { menuFit, menuLeft, menuStep } from '../web/src/ui/menu.ts';
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

test('ui/menu: 選ぶ一覧は、下に入らず上のほうが広ければ上に開き、入る側の高さまでに縮めてスクロールさせる', () => {
  const bounds = { top: 0, bottom: 600, left: 0, right: 800 };
  const size = { width: 240, height: 300 };
  assert.deepEqual(menuFit({ top: 100, bottom: 128, left: 500, right: 600 }, bounds, size, 4), { up: false, left: false, maxHeight: 468, maxWidth: 600 });
  assert.deepEqual(menuFit({ top: 500, bottom: 528, left: 500, right: 600 }, bounds, size, 4), { up: true, left: false, maxHeight: 496, maxWidth: 600 });
  assert.equal(menuFit({ top: 280, bottom: 308, left: 500, right: 600 }, bounds, { width: 240, height: 900 }, 4).up, false);
  assert.equal(menuFit({ top: 300, bottom: 328, left: 500, right: 600 }, bounds, { width: 240, height: 900 }, 4).maxHeight, 296);
});

test('ui/menu: 選ぶ一覧は、ボタンの右端にそろえて左へ広がるが、左に入らず右のほうが広ければボタンの左端から右へ広がる', () => {
  const bounds = { top: 0, bottom: 600, left: 200, right: 800 };
  const size = { width: 240, height: 100 };
  assert.equal(menuFit({ top: 100, bottom: 128, left: 700, right: 780 }, bounds, size, 4).left, false);
  const fit = menuFit({ top: 100, bottom: 128, left: 220, right: 300 }, bounds, size, 4);
  assert.equal(fit.left, true);
  assert.equal(fit.maxWidth, 580);
  const wide = menuFit({ top: 100, bottom: 128, left: 600, right: 700 }, bounds, { width: 600, height: 100 }, 4);
  assert.equal(wide.left, false, '左にも入らないが右のほうが狭いなら、右端そろえのまま左へ広げる');
  assert.equal(wide.maxWidth, 500);
});

test('ui/menu: メニューからフォーカスが出たら閉じるが、開いたボタンへ出たときは閉じない（ボタンの押し直しで閉じられる）', () => {
  const opener = {};
  const other = {};
  assert.equal(menuLeft(other, false, opener), true);
  assert.equal(menuLeft(opener, false, opener), false);
  assert.equal(menuLeft(other, true, opener), false);
  assert.equal(menuLeft(null, false, opener), false);
});
