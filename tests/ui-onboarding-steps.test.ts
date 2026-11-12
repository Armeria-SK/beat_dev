import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupModelConfig } from '../web/src/onboarding.ts';
import {
  agentInput, canContinue, canEscape, connectProblem, emptyConnect, modelFormOf, nameInput, ONBOARD_ESC_A, ONBOARD_ESC_B, ONBOARD_STEPS, OPENAI_URL, styleInput,
} from '../web/src/ui/onboarding-steps.ts';
import { defaultConfig } from '../src/config/store.ts';

// 新しい画面のはじめの設定（steps/p1-ui.md「はじめの設定」、持ち主の答え 8）。名前は 1 欄で、サーバーへは userName と callMe に同じ値を送る。

test('ui/onboarding: 5 段で、名前は 1 欄の値を userName と callMe の両方に入れる（空は送らない）', () => {
  assert.deepEqual([...ONBOARD_STEPS], ['name', 'agent', 'style', 'model', 'hello']);
  assert.deepEqual(nameInput('  Sam '), { userName: 'Sam', callMe: 'Sam' });
  assert.deepEqual(nameInput('   '), {});
});

test('ui/onboarding: AI の名前は変わったときだけ、話し方は「なし」なら送らない', () => {
  assert.deepEqual(agentInput('beat', 'beat'), {});
  assert.deepEqual(agentInput(' Juno ', 'beat'), { botName: 'Juno' });
  assert.deepEqual(agentInput('  ', 'beat'), {});
  assert.deepEqual(styleInput('friendly'), { style: 'friendly' });
  assert.deepEqual(styleInput('none'), {});
  assert.deepEqual(styleInput(null), {});
});

test('ui/onboarding: 段は飛ばせない（名前・AI の名前・話し方を選ぶ・接続が通る）', () => {
  const base = { name: '', agent: 'beat', style: null, passed: false } as const;
  assert.equal(canContinue('name', base), false);
  assert.equal(canContinue('name', { ...base, name: 'Sam' }), true);
  assert.equal(canContinue('agent', { ...base, agent: ' ' }), false);
  assert.equal(canContinue('style', base), false);
  assert.equal(canContinue('style', { ...base, style: 'none' }), true);
  assert.equal(canContinue('model', base), false);
  assert.equal(canContinue('model', { ...base, passed: true }), true);
  assert.equal(canContinue('hello', base), true);
});

test('ui/onboarding: 鍵を省けるのは Custom だけ（鍵が既にあるときも省ける）', () => {
  assert.equal(connectProblem({ ...emptyConnect('anthropic'), model: 'm' }, false), 'key');
  assert.equal(connectProblem({ ...emptyConnect('anthropic'), model: 'm' }, true), null);
  assert.equal(connectProblem({ ...emptyConnect('openai'), model: 'm', key: 'k' }, false), null);
  assert.equal(connectProblem({ ...emptyConnect('custom'), model: 'm' }, false), null);
  assert.equal(connectProblem({ ...emptyConnect('custom'), model: 'm', baseUrl: 'ftp://x' }, false), 'baseUrl');
  assert.equal(connectProblem(emptyConnect('custom'), false), 'model');
  assert.equal(connectProblem({ ...emptyConnect('custom'), model: 'm', context: '100' }, false), 'context', 'OpenAI 互換はコンテキスト長が要る（サーバーの決まり）');
  assert.equal(connectProblem({ ...emptyConnect('anthropic'), model: 'm', context: '' }, true), null);
});

test('ui/onboarding: 提供元の選び方から設定の形へ（OpenAI は api.openai.com の OpenAI 互換）', () => {
  const openai = setupModelConfig(defaultConfig() as Record<string, any>, modelFormOf({ ...emptyConnect('openai'), model: 'gpt-x' }), null);
  const provider = (openai.config.providers as Array<Record<string, any>>).find(p => p.kind === 'openai_compatible');
  assert.equal(provider?.baseUrl, OPENAI_URL);
  assert.equal(provider?.server, 'openai');
  assert.equal((openai.config.models as Array<Record<string, any>>).at(-1)?.contextLength, 32768);
  const anthropic = setupModelConfig(defaultConfig() as Record<string, any>, modelFormOf({ ...emptyConnect('anthropic'), model: 'claude-x' }), null);
  assert.equal((anthropic.config.models as Array<Record<string, any>>).at(-1)?.provider, 'anthropic');
  assert.deepEqual(anthropic.config.routing.chat, [anthropic.modelId]);
});

test('ui/onboarding: T4 の a は、やり直しのときだけ Esc で閉じる。b はいつでも閉じる（試しのときだけ）', () => {
  assert.equal(canEscape(ONBOARD_ESC_A, false), false);
  assert.equal(canEscape(ONBOARD_ESC_A, true), true);
  assert.equal(canEscape(ONBOARD_ESC_B, false), true);
  assert.equal(ONBOARD_ESC_B.tag, 'onboarding-b-esc-anytime');
});
