import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardText } from '../src/shared/messages/guard.ts';
import { en } from '../web/src/i18n/en.ts';

const STALE = /Ask for approval|No approval|Ask in Pending|mode is Auto/u;

test('en の辞書のどの値にも、古い方針・モードの名前（Ask for approval / No approval / Ask in Pending / mode is Auto）が残っていない', () => {
  const stale = Object.entries(en).flatMap(([key, value]) => (STALE.test(String(value)) ? [`${key}: ${String(value)}`] : []));
  assert.deepEqual(stale, []);
  assert.ok(en['ui.set.shell.askDesc'].includes(en['ui.composer.modeNormal']), 'Always ask の説明は、いまのモードの名前（Normal）で言う');
});

test('方針 Ask の道具の理由の文は、画面の方針の名前（Ask）で言う', () => {
  for (const key of ['pipeline.policy_ask', 'pipeline.policy_review'] as const) {
    const text = guardText('en', key, { name: 'shell_run' });
    assert.ok(text.includes(`"${en['ui.tools.ask']}"`), text);
    assert.doesNotMatch(text, /ask for approval/iu, text);
  }
});
