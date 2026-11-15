import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { en } from '../web/src/i18n/en.ts';

// 入力欄の権限モード（Normal / Plan。値は auto / plan）の名前と、ボタンの title に出す説明の文

test('計画の説明は、Web の読み取りが外へ文字を出しうることを隠さない', () => {
  assert.match(en['mode.planDesc'], /reading the web/u);
  assert.match(en['mode.planDesc'], /text in a URL can leave this PC/u);
  assert.match(en['mode.planDesc'], /URL/u);
  const composer = readFileSync(new URL('../web/src/ui/Composer.tsx', import.meta.url), 'utf8');
  assert.ok(composer.includes('className="bt-seg__opt" title={t(MODE_HINT[value])}'), '説明は、入力欄のモードのボタンの title に出す');
});

test('Normal の説明は短い 1 行で、判定役が見ること・送る・消す・判定役が通せないものは Pending で聞くことを書き、前の承認の言い回しを残さない', () => {
  const desc = en['mode.autoDesc'];
  assert.doesNotMatch(desc, /\n/u);
  assert.ok(desc.length <= 140, `${desc.length} 文字`);
  assert.match(desc, /judge/u);
  assert.match(desc, /sending out/u);
  assert.match(desc, /deleting/u);
  assert.match(desc, /Pending/u);
  assert.doesNotMatch(desc, /Allow in this chat|approval|asked of you every time/u);
});
