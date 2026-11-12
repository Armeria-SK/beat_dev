import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickFocus, underHead } from '../web/src/ui/focus.ts';

// Settings を閉じたあとの焦点の戻し先（1-1 のレビューの残り）。開いた元 → Settings のボタン → メニューのボタンの順で、
// 見えていて文書の中にあるものへ。body は戻し先にしない（何にも焦点が無いまま開いたとき、開いた元が body になる）。

const el = (name: string, shown = true, connected = true) => ({ name, isConnected: connected, getClientRects: () => ({ length: shown ? 1 : 0 }), hiddenStyle: false });

test('ui/focus: 開いた元が body なら飛ばして、次の Settings のボタンへ', () => {
  const body = el('body');
  const settings = el('settings');
  assert.equal(pickFocus([body, settings], body, () => false), settings);
});

test('ui/focus: 開いた元が無い（#/settings を直接開いた）ときも Settings のボタンへ。狭い幅で隠れていればメニューのボタンへ', () => {
  const body = el('body');
  const settings = el('settings', false);
  const menu = el('menu');
  assert.equal(pickFocus([null, settings, menu], body, () => false), menu);
  const hiddenStyle = el('settings');
  assert.equal(pickFocus([null, hiddenStyle, menu], body, x => x === hiddenStyle), menu);
});

test('ui/focus: 止まった頭の下に入った焦点は、頭の下に少し空けて見える所までだけ戻す。隠れていなければ動かさない', () => {
  assert.equal(underHead(92, 40, 8, true), 60);
  assert.equal(underHead(92, 100, 8, true), 0);
  assert.equal(underHead(92, 84, 8, true), 16);
  assert.equal(underHead(173, -20, 8, true), 201);
});

test('ui/focus: マウスで押した焦点（focus-visible でない）は戻さない。押している間に行が動いて別の所を押すことになるため', () => {
  assert.equal(underHead(92, 87, 8, false), 0);
});

test('ui/focus: 文書から外れた元は使わない。どれも使えなければ null', () => {
  const body = el('body');
  assert.equal(pickFocus([el('gone', true, false), undefined], body, () => false), null);
});
