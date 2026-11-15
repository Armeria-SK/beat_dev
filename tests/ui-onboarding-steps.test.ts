import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { markSetupShown, setupModelConfig, wasSetupShown } from '../web/src/onboarding.ts';
import {
  agentInput, canContinue, connectProblem, escapeAction, emptyConnect, modelFormOf, nameInput, ONBOARD_STEPS, opensOnLoad, OPENAI_URL, resumeIndex, setupLoads, setupPending, styleInput,
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

test('ui/onboarding: 確かめの最中の Esc は全体を閉じない（動いている間は何もしない、広がる確かめが出ていればそれだけを閉じる）', () => {
  assert.equal(escapeAction({ busy: true, confirming: false }), 'ignore');
  assert.equal(escapeAction({ busy: true, confirming: true }), 'ignore');
  assert.equal(escapeAction({ busy: false, confirming: true }), 'cancelConfirm');
  assert.equal(escapeAction({ busy: false, confirming: false }), 'close');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  const screen = readFileSync(new URL('../web/src/ui/Onboarding.tsx', import.meta.url), 'utf8');
  assert.ok(screen.includes("addEventListener('keydown', onEscape, true)"), 'フォーカスが枠の外でも止められるよう、window の捕まえる段で見る');
  assert.ok(screen.includes("removeEventListener('keydown', onEscape, true)"));
  assert.ok(app.includes("if (e.key !== 'Escape' || e.defaultPrevented) return;"), 'App は止めた Esc では閉じない');
});

test('ui/onboarding: はじめの設定の読み取りに失敗したら 1 回だけ知らせ、間を空けて読み直す（届いたら当てる。止めたら読み直さない）', async () => {
  const answers: Array<() => Promise<{ done: boolean }>> = [
    async () => { throw new Error('500'); },
    async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ done: false }),
  ];
  let call = 0;
  let told = 0;
  const applied: boolean[] = [];
  const timers: Array<{ run: () => void; ms: number }> = [];
  const loads = setupLoads(() => answers[call++]!(), state => applied.push(state.done), () => { told += 1; }, (run, ms) => timers.push({ run, ms }), [10, 20]);
  await loads.load();
  assert.equal(told, 1, '失敗を黙って飲まない');
  assert.deepEqual(timers.map(x => x.ms), [10]);
  timers.shift()!.run();
  await new Promise(r => setImmediate(r));
  assert.equal(told, 1, '読み直しのたびには知らせない');
  assert.deepEqual(timers.map(x => x.ms), [20]);
  timers.shift()!.run();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(applied, [false], '届いたら当てる（済んでいなければ、はじめの設定が開く）');
  assert.equal(timers.length, 0);

  const stopped = setupLoads(async () => { throw new Error('500'); }, () => applied.push(true), () => undefined, (run, ms) => timers.push({ run, ms }), [10]);
  await stopped.load();
  stopped.stop();
  timers.shift()!.run();
  await new Promise(r => setImmediate(r));
  assert.equal(timers.length, 0, '画面を閉じたあとは読み直さない');
});
