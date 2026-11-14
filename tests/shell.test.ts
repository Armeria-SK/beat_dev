import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed, formatRelativeCompact, setTimezone } from '../web/src/i18n/index.ts';
import { isComposing } from '../web/src/keys.ts';

// 画面を持たない小さな決まり（相対時刻・変換中のキー）。
// 前の画面の枠（タブ・パレット・右のパネル・Esc の順・ステータスバー・幅の CSS）の項は、前の画面と一緒に消した（beat 1-6）。

const reset = () => { setTimezone('Asia/Tokyo'); };

test('isComposing: 日本語の変換中のキーは何にも使わない', () => {
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ keyCode: 13 }), false);
});

test('formatRelativeCompact: サイドバー用の短い相対時刻', () => {
  reset();
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const ago = (ms: number) => formatRelativeCompact(now - ms, now);
  assert.equal(ago(10_000), 'now');
  assert.equal(ago(5 * 60_000), '5m');
  assert.equal(ago(2 * 3_600_000), '2h');
  assert.equal(ago(3 * 86_400_000), '3d');
  assert.equal(ago(45 * 86_400_000), '1mo');
  assert.equal(ago(400 * 86_400_000), '1y');
  assert.equal(ago(-5000), 'now', '未来の時刻は今として扱う');
  reset();
});

test('formatElapsed: 実行中の経過時間', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000 + 4 * 60_000 + 7_000), '1:04:07');
  assert.equal(formatElapsed(-5000), '00:00');
});
