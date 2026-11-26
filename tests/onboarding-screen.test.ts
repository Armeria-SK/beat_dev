import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import {
  markSetupShown, resumeStep, setupModelConfig, STEPS, wasSetupShown,
  type ModelForm, type OnboardingSteps,
} from '../web/src/onboarding.ts';
import { estimateTokens, overPersonaBudget } from '../web/src/tokens.ts';
import { testConfig } from './helpers.ts';

const steps = (patch: Partial<Record<'user' | 'identity' | 'persona' | 'model', boolean>> = {}) => ({ user: false, identity: false, persona: false, model: false, ...patch });

test('resumeStep: 左の一覧の「続ける」は、済んでいない最初の手順から始める。全部済んでいればあいさつ。言語の段は無い', () => {
  assert.deepEqual(STEPS, ['you', 'identity', 'style', 'model', 'greeting']);
  assert.equal(resumeStep(steps()), 'you');
  assert.equal(resumeStep({ ...steps(), language: false } as OnboardingSteps), 'you', 'サーバーがまだ返す steps.language は読まない');
  assert.equal(resumeStep(steps({ user: true })), 'identity');
  assert.equal(resumeStep(steps({ user: true, identity: true })), 'style');
  assert.equal(resumeStep(steps({ user: true, identity: true, persona: true })), 'model');
  assert.equal(resumeStep(steps({ user: true, identity: true, persona: true, model: true })), 'greeting');
  assert.equal(resumeStep(steps({ model: true })), 'you', '飛ばした手順があれば、そこへ戻る');
});

const form = (patch: Partial<ModelForm> = {}): ModelForm => ({ source: 'openai', model: 'qwen3-27b', baseUrl: 'http://127.0.0.1:1234/v1', server: 'generic', contextLength: '32768', apiKeyEnv: '', ...patch });

const base = () => ({
  providers: [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600000 }, { id: 'ollama', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434', maxParallel: 1, timeoutMs: 600000 }],
  models: [] as Array<Record<string, unknown>>,
  routing: { chat: [] as string[], background: [] as string[], retriesPerModel: 2 },
});

test('setupModelConfig（OpenAI 互換）: 送り先・サーバーの種類・鍵の環境変数名・コンテキスト長で、プロバイダとモデルを足し、順番が空ならチャットにも裏方にも入れる', () => {
  const { config, modelId } = setupModelConfig(base(), form({ server: 'tabbyapi', apiKeyEnv: 'LOCAL_KEY', contextLength: '65536' }), null);
  assert.equal(modelId, 'qwen3-27b');
  assert.deepEqual(config.providers.at(-1), { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1234/v1', server: 'tabbyapi', maxParallel: 1, timeoutMs: 600000, apiKeyEnv: 'LOCAL_KEY' });
  assert.deepEqual(config.models, [{ id: 'qwen3-27b', label: '', provider: 'local', model: 'qwen3-27b', contextLength: 65536, vision: false }], 'model-auto: 返事の上限と minContext は書かない（自動）');
  assert.deepEqual(config.routing, { chat: ['qwen3-27b'], background: ['qwen3-27b'], retriesPerModel: 2 });
  assert.equal(config.providers.length, 3, '最初から入っているプロバイダは残す');
  const noKey = setupModelConfig(base(), form(), null).config;
  assert.equal('apiKeyEnv' in noKey.providers.at(-1), false, '鍵を使わないときは apiKeyEnv を書かない');
});

test('setupModelConfig: Anthropic は、すでにあるプロバイダを使い、同じモデルをもう一度確かめるときは項目を直す', () => {
  const anthropic = setupModelConfig(base(), { source: 'anthropic', model: 'claude-sonnet-x', baseUrl: '', server: 'generic', contextLength: '', apiKeyEnv: '' }, null);
  assert.equal(anthropic.config.models[0].provider, 'anthropic');
  assert.equal('contextLength' in anthropic.config.models[0], false, 'Anthropic は長さを書かない');
  assert.equal(anthropic.config.providers.length, 2, '足さずに、あるものを使う');

  const first = setupModelConfig(base(), form({ contextLength: '32768' }), null);
  const again = setupModelConfig(first.config, form({ baseUrl: 'http://127.0.0.1:5000/v1', model: 'qwen3-27b', contextLength: '16384' }), first.modelId);
  assert.equal(again.config.models.length, 1, '同じモデルは重ねない');
  assert.equal(again.config.providers.filter((p: { id: string }) => p.id === 'local').length, 1, '自分の足したプロバイダも重ねない');
  assert.equal(again.config.providers.find((p: { id: string }) => p.id === 'local').baseUrl, 'http://127.0.0.1:5000/v1');
  assert.equal(again.config.models[0].contextLength, 16384);
  assert.deepEqual(again.config.routing.chat, ['qwen3-27b'], '順番にも重ねない');

  const second = setupModelConfig(first.config, form({ model: 'Another Model!' }), null);
  assert.equal(second.modelId, 'another-model', 'モデル名から、使える文字の id を作る');
  assert.deepEqual(second.config.routing, { chat: ['qwen3-27b', 'another-model'], background: ['qwen3-27b', 'another-model'], retriesPerModel: 2 }, '順番がすでにあるときは、足したモデルを最後に足す');
  assert.equal(setupModelConfig(first.config, form(), null).modelId, 'qwen3-27b-2', '同じ id があれば番号を付ける');
  assert.equal(base().models.length, 0, '元の設定は書き換えない');
});

test('setupModelConfig: runtime models are left out of the lists it fills (a runtime model may only be first in chat), so the saved settings are accepted', () => {
  const runtimes = { ...testConfig(), runtimes: [{ id: 'cc', kind: 'claude-code', enabled: true }], providers: [], models: ['rt1', 'rt2'].map(id => ({ id, runtime: 'cc', model: id, vision: false })), routing: { chat: [], background: [], retriesPerModel: 0 } };
  assert.doesNotThrow(() => parseConfig(runtimes), 'the starting settings are valid');
  const { config } = setupModelConfig(runtimes as never, form(), null);
  assert.deepEqual(config.routing, { chat: ['qwen3-27b'], background: ['qwen3-27b'], retriesPerModel: 0 });
  assert.doesNotThrow(() => parseConfig(config));
});

test('estimateTokens: 画面の見積もりは、サーバーの estimateTextTokens と同じ式。予算を超えたときだけ注意する（予算なしなら出さない）', () => {
  for (const text of ['', 'hello world', '落ち着いて簡潔に話す。', 'Mixed 日本語 and English, 한국어 too, ＡＢＣ', 'x'.repeat(1000), '名'.repeat(500)]) {
    assert.equal(estimateTokens(text), estimateTextTokens(text), JSON.stringify(text.slice(0, 20)));
  }
  assert.equal(overPersonaBudget(1000, 500), true);
  assert.equal(overPersonaBudget(500, 500), false, '予算ちょうどは超えていない');
  assert.equal(overPersonaBudget(100000, null), false, 'モデルが無い（予算なし）なら注意しない');
});

test('はじめの設定の記録: 自動で開くのは 1 回だけ。保存できない環境でも落ちない', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(wasSetupShown(storage), false);
  markSetupShown(storage);
  assert.equal(wasSetupShown(storage), true);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(wasSetupShown(blocked), false);
  markSetupShown(blocked);
});
