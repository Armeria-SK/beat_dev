import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from '../src/config/store.ts';
import { setupModelConfig, type ModelForm } from '../web/src/onboarding.ts';
import { setConversation } from '../web/src/ui/settings/view.ts';

// backlog（#270 の審査）: 会話の並びが空（自動 = 提供元のモデル全部）のとき、モデルを足したり会話のモデルを選んだりすると、
// それまで自動で使っていた提供元のモデルが黙って外れていた。今のエンジンの並びを写してから足す・先頭に置く。

const anthropicForm = (model: string): ModelForm => ({ source: 'anthropic', model, baseUrl: '', server: 'generic', contextLength: '', apiKeyEnv: '' });

function configWith(chat: string[], background: string[], withRuntime = false): Record<string, any> {
  const base = defaultConfig() as Record<string, any>;
  const models: Array<Record<string, unknown>> = [
    { id: 'a', label: '', provider: 'anthropic', model: 'model-a', vision: false },
    { id: 'b', label: '', provider: 'anthropic', model: 'model-b', vision: false },
  ];
  if (withRuntime) models.push({ id: 'cc', label: 'cc', runtime: 'claude-code', model: 'sonnet' });
  return {
    ...base,
    providers: [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY' }],
    models,
    ...(withRuntime ? { runtimes: [{ id: 'claude-code', kind: 'claude-code', enabled: true }] } : {}),
    routing: { ...base.routing, chat, background },
  };
}

test('bl-early routing: 自動の会話の並び＋裏の並びありでモデルを足すと、会話の並びに元の提供元のモデルが残る', () => {
  const { config, modelId } = setupModelConfig(configWith([], ['b']), anthropicForm('model-c'), null);
  assert.deepEqual(config.routing.chat, ['a', 'b', modelId]);
  assert.deepEqual(config.routing.background, ['b', modelId]);
});

test('bl-early routing: 固定の並びに足すときは今までどおり後ろに足す', () => {
  const { config, modelId } = setupModelConfig(configWith(['b'], ['a']), anthropicForm('model-c'), null);
  assert.deepEqual(config.routing.chat, ['b', modelId]);
  assert.deepEqual(config.routing.background, ['a', modelId]);
});

test('bl-early routing: 両方の並びが空なら、今までどおり提供元のモデル全部', () => {
  const { config, modelId } = setupModelConfig(configWith([], []), anthropicForm('model-c'), null);
  assert.deepEqual(config.routing.chat, ['a', 'b', modelId]);
  assert.deepEqual(config.routing.background, ['a', 'b', modelId]);
});

test('bl-early routing: 自動の並びで会話のモデルを選ぶと、ほかの提供元のモデルが予備に残る', () => {
  assert.deepEqual(setConversation(configWith([], ['a']), 'b').routing.chat, ['b', 'a']);
});

test('bl-early routing: 自動の並びで実行役のモデルを会話に選んでも、提供元のモデルが予備に残る（実行役は先頭だけ）', () => {
  assert.deepEqual(setConversation(configWith([], [], true), 'cc').routing.chat, ['cc', 'a', 'b']);
});

test('bl-early routing: 固定の並びでは今までどおり（選んだものを先頭、外れた実行役は残さない）', () => {
  assert.deepEqual(setConversation(configWith(['cc', 'a', 'b'], [], true), 'b').routing.chat, ['b', 'a']);
  assert.deepEqual(setConversation(configWith(['a', 'b'], [], true), 'cc').routing.chat, ['cc', 'a', 'b']);
});
