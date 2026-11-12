import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { markSetupShown, setupModelConfig, wasSetupShown } from '../web/src/onboarding.ts';
import {
  agentInput, canContinue, connectProblem, emptyConnect, modelFormOf, nameInput, ONBOARD_DONE_HASH, ONBOARD_STEPS, opensOnLoad, OPENAI_URL, resumeIndex, setupPending, styleInput,
} from '../web/src/ui/onboarding-steps.ts';
import { defaultConfig } from '../src/config/store.ts';

// 新しい画面のはじめの設定（steps/p1-ui.md「はじめの設定」、持ち主の答え 8）。名前は 1 欄で、サーバーへは userName と callMe に同じ値を送る。

test('ui/onboarding: 5 段で、名前は 1 欄の値を userName と callMe の両方に入れる（空は送らない）', () => {
  assert.deepEqual([...ONBOARD_STEPS], ['name', 'agent', 'style', 'model', 'hello']);
  assert.deepEqual(nameInput('  Sam '), { userName: 'Sam', callMe: 'Sam' });
  assert.deepEqual(nameInput('   '), {});
});

test('ui/onboarding: 段 5 のボタンは "New product" で、終わると製品を作る画面を開く（2-2c）', () => {
  assert.equal(ONBOARD_DONE_HASH, '#/products/new');
  const screen = readFileSync(new URL('../web/src/ui/Onboarding.tsx', import.meta.url), 'utf8');
  assert.match(screen, /step === 'hello' \? t\('ui\.product\.new'\)/u);
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /location\.hash = ONBOARD_DONE_HASH;/u);
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

// T4（持ち主の決定 2026-11-12）: 初めてのはじめの設定も Esc と "Skip for now" で閉じられる。閉じても「済み」にはしない。
test('ui/onboarding: Skip と Esc は「済み」にしない。閉じたあとは勝手に開かず、サイドバーの Continue setup から続きの段で開く', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(opensOnLoad(false, wasSetupShown(storage)), true, '初めては自動で開く');
  markSetupShown(storage);
  assert.equal(opensOnLoad(false, wasSetupShown(storage)), false, '閉じたあとの読み込みでは開かない');
  assert.equal(opensOnLoad(true, false), false);
  assert.equal(setupPending(false, false), true, '済んでいないあいだは続きの入口が出る');
  assert.equal(setupPending(false, true), false);
  assert.equal(setupPending(true, false), false);
  assert.equal(setupPending(null, false), false, 'サーバーの答えが来るまでは出さない');
  assert.equal(resumeIndex({ user: false, identity: false, persona: false, model: false }), 0);
  assert.equal(ONBOARD_STEPS[resumeIndex({ user: true, identity: true, persona: false, model: false })], 'style');
  assert.equal(ONBOARD_STEPS[resumeIndex({ user: true, identity: true, persona: true, model: true })], 'hello');

  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../web/src/ui/Onboarding.tsx', import.meta.url), 'utf8');
  assert.equal(app.includes('onboardingDone'), false, '閉じる側（App）は「済み」の口を呼ばない');
  assert.deepEqual(screen.match(/.*onboardingDone.*/gu)?.map(line => line.trim().startsWith("if (step === 'hello')")), [true], '「済み」にするのは最後の段の Start だけ');
  assert.match(screen, /onClick=\{onSkip\}/u);
  assert.match(app, /if \(onboard\) \{ e\.preventDefault\(\); closeOnboard\(\); return; \}/u);
});
