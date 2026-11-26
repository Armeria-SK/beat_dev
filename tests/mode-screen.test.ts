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
  assert.ok(composer.includes('className="bt-seg__opt" title={t(modeHint(value, byRuntime))}'), '説明は、入力欄のモードのボタンの title に出す');
  assert.ok(!composer.includes('{!byRuntime && <span className="bt-seg"'), '外の実行役の会話でも、モードの切り替えを出す（計画モードは実行役を起こす許可に効く）');
  assert.ok(composer.includes('composerView({ hasConversation, running, mode, '), '入力欄は、実行役の会話でも本当のモードで描く');
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

test('実行役の会話の説明: 計画は「一番慎重な許可で始める・承認が要る操作は返事が止まる」、通常は beat が操作を判定しないことを書く', () => {
  assert.match(en['mode.runtimePlanDesc'], /most careful permission/u);
  assert.match(en['mode.runtimePlanDesc'], /approval/u);
  assert.match(en['mode.runtimeAutoDesc'], /does not judge/u);
  for (const key of ['mode.runtimeAutoDesc', 'mode.runtimePlanDesc'] as const) assert.doesNotMatch(en[key], /\n/u);
});
