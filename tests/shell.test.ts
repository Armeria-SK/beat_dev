import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed } from '../web/src/i18n/index.ts';
import { isComposing } from '../web/src/keys.ts';

// 画面を持たない小さな決まり（相対時刻・変換中のキー）。
// 前の画面の枠（タブ・パレット・右のパネル・Esc の順・ステータスバー・幅の CSS）の項は、前の画面と一緒に消した（beat 1-6）。

test('isComposing: 日本語の変換中のキーは何にも使わない', () => {
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ keyCode: 13 }), false);
});

test('formatElapsed: 実行中の経過時間', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000 + 4 * 60_000 + 7_000), '1:04:07');
  assert.equal(formatElapsed(-5000), '00:00');
});
