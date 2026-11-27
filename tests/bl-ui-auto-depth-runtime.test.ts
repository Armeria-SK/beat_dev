import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import type { ModelView } from '../web/src/api.ts';
import { depthOptions, modelInEffect, runtimeShown, type RuntimeUse } from '../web/src/ui/composer-state.ts';
import { fakeModel, startApp } from './app-setup.ts';

const withRuntimeFirst = (config: AppConfig): void => {
  config.runtimes = [{ id: 'cc', kind: 'claude-code', enabled: true }];
  config.models.push({ id: 'rt', runtime: 'cc', model: 'sonnet', maxOutputTokens: 4096, vision: false, efforts: ['low', 'high'] });
  config.routing.chat = ['rt', 'm1'];
};

test('画面の「自動」の深さは、起こし直したあと（実行役が未確認）でも、サーバーが最初の送信で確かめる深さと同じ（#266）', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts: ['medium'] })], configure: withRuntimeFirst });
  const view = (await s.json('/api/models', 'GET')).body as { chatOrder: string[]; models: ModelView[] };
  const rt = view.models.find(m => m.id === 'rt')!;
  assert.notEqual(rt.probe?.status, 'ok', 'the check of a runtime is only in memory: after a restart it is not ok');
  assert.equal(view.models.find(m => m.id === 'm1')!.probe?.status, 'ok');

  const use: RuntimeUse = { bound: null, allowed: true };
  const screen = modelInEffect(runtimeShown(view.models, use), view.chatOrder, null, use);
  const server = s.app.engine.effortChoices(null, null, true);
  assert.equal(server.modelId, 'rt', 'the server sends the first message of a fresh product conversation to the first candidate');
  assert.equal(screen?.id, server.modelId);
  assert.deepEqual(depthOptions(screen), server.efforts);
  assert.deepEqual(server.efforts, ['low', 'high']);
});
