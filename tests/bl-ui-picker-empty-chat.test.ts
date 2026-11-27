import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import type { ModelView } from '../web/src/api.ts';
import { composerView, depthOptions, modelInEffect, modelOptions, runtimeShown, type RuntimeUse } from '../web/src/ui/composer-state.ts';
import { fakeModel, startApp } from './app-setup.ts';

// The conversation model is "auto" (routing.chat = []): the server then tries every provider model in config order (runtime models are never part of that),
// and the screen has to follow that same list. Before, it saw an empty list as "no model configured" and disabled the composer.

const withRuntimes = (config: AppConfig): void => {
  config.runtimes = [{ id: 'cc', kind: 'claude-code', enabled: true }];
  for (const [id, model] of [['rt1', 'opus'], ['rt2', 'sonnet'], ['rt3', 'haiku']] as const) {
    config.models.push({ id, runtime: 'cc', model, maxOutputTokens: 4096, vision: false, efforts: ['low', 'high'] });
  }
  config.routing.chat = [];
  config.routing.background = [];
};

const PRODUCT: RuntimeUse = { bound: null, allowed: true };
const PLAIN: RuntimeUse = { bound: null, allowed: false };

type Start = Awaited<ReturnType<typeof startApp>>;
const read = async (s: Start) => (await s.json('/api/models', 'GET')).body as { chatOrder: string[]; models: ModelView[] };

test('auto conversation model (routing.chat = []): the composer is not disabled, and the model it names is the one the engine would use', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts: ['medium'] })], configure: withRuntimes });
  assert.deepEqual(s.app.config().routing.chat, [], 'the stored list stays empty (auto)');
  const view = await read(s);

  assert.equal(composerView({ hasConversation: false, running: false, mode: 'auto', chatModels: view.models.filter(m => m.inChat).length, text: '', attachments: 0, uploading: false, sending: false, product: true, planless: false }).disabled, false);
  assert.deepEqual(view.models.filter(m => m.inChat).map(m => m.id), ['m1'], 'only provider models are in the auto list; the runtime models are not');
  assert.deepEqual(view.chatOrder, ['m1']);

  for (const [use, fresh] of [[PRODUCT, true], [PLAIN, false]] as const) {
    const screen = modelInEffect(runtimeShown(view.models, use), view.chatOrder, null, use);
    const server = s.app.engine.effortChoices(null, null, fresh);
    assert.equal(server.modelId, 'm1');
    assert.equal(screen?.id, server.modelId, `same model on screen and in the engine (product: ${use.allowed})`);
    assert.deepEqual(depthOptions(screen), server.efforts);
  }
});

test('auto conversation model with the only provider model offline: the composer still opens, the screen names that model, and the picker lists it as not available', async t => {
  const s = await startApp(t, { models: [fakeModel('m1', { efforts: ['medium'] })], configure: withRuntimes });
  s.adapter().probeResult = { status: 'unreachable', message: 'offline' };
  await s.app.status.probeAll(s.app.config());
  const view = await read(s);
  const m1 = view.models.find(m => m.id === 'm1')!;
  assert.notEqual(m1.probe?.status, 'ok');
  assert.equal(view.models.filter(m => m.inChat).length, 1, 'the offline model counts as a chat model');

  const screen = modelInEffect(runtimeShown(view.models, PRODUCT), view.chatOrder, null, PRODUCT);
  assert.equal(screen?.id, s.app.engine.effortChoices(null, null, true).modelId, 'with nothing usable the engine names the first candidate');
  assert.equal(screen?.id, 'm1');
  assert.equal(modelOptions(view.models, null, PRODUCT).find(o => o.id === 'm1')?.disabled, true);
});

test('an explicit conversation list is sent as it is, runtime model first included', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], configure: config => { withRuntimes(config); config.routing.chat = ['rt1', 'm1']; } });
  const view = await read(s);
  assert.deepEqual(view.chatOrder, ['rt1', 'm1']);
  assert.deepEqual(view.models.filter(m => m.inChat).map(m => m.id), ['m1', 'rt1'], 'the models come in config order; the order of the list is routing.chat');
});
