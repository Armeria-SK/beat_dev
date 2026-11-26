import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRuntimeModel, providerModels, providerOf, type AppConfig, type ModelConfig } from '../src/config/schema.ts';
import { ConfigError, findModel, parseConfig } from '../src/config/store.ts';
import { candidateModelIds } from '../src/engine/chat.ts';
import { judgeIdentity } from '../src/tools/judge-cache.ts';
import { CONVERSATION, fakeModel, settled, startApp } from './app-setup.ts';
import { testConfig } from './helpers.ts';

const runtimeModel = (id: string, runtime: string): ModelConfig => ({ id, runtime, model: 'fake-large', maxOutputTokens: 4096, vision: false });
const withRuntime = (config: AppConfig, runtimeId = 'cc'): AppConfig => {
  config.runtimes = [{ id: runtimeId, kind: 'claude-code', enabled: true }];
  config.models.push(runtimeModel('rt', runtimeId));
  return config;
};
const problemsOf = (raw: unknown): string[] => {
  try { parseConfig(raw); } catch (error) { assert.ok(error instanceof ConfigError); return [...error.problems]; }
  return [];
};
const plain = (config: AppConfig): any => JSON.parse(JSON.stringify(config));

test('a settings file without runtimes reads and writes back exactly as before: no runtimes key appears', () => {
  const raw = plain(testConfig());
  assert.equal('runtimes' in raw, false);
  const config = parseConfig(raw);
  assert.equal('runtimes' in config, false);
  assert.deepEqual(plain(config), raw);
  assert.deepEqual(providerModels(config), config.models, 'every model is a provider model');
  assert.equal(config.models.some(isRuntimeModel), false);
});

test('a runtime is off unless it says enabled; a runtime model points to a runtime and is not a provider model', () => {
  const raw = plain(withRuntime(testConfig()));
  delete raw.runtimes[0].enabled;
  const config = parseConfig(raw);
  assert.equal(config.runtimes![0]!.enabled, false);
  const model = config.models.find(m => m.id === 'rt')!;
  assert.equal(isRuntimeModel(model), true);
  assert.equal(providerOf(config, model), undefined);
  assert.equal(providerModels(config).some(m => m.id === 'rt'), false);
  assert.equal(findModel(config, 'rt'), undefined);
  assert.ok(findModel(config, 'local'), 'a provider model is found as before');
  assert.equal(providerOf(config, config.models.find(m => m.id === 'local')!)?.id, 'local');
});

test('settings mistakes about runtimes are named by where they are', () => {
  const base = (): any => plain(withRuntime(testConfig()));

  const both = base();
  both.models.find((m: any) => m.id === 'rt').provider = 'local';
  assert.ok(problemsOf(both).includes('models.rt: A model points to a provider or to a runtime, not both'));

  const neither = base();
  delete neither.models.find((m: any) => m.id === 'rt').runtime;
  assert.ok(problemsOf(neither).includes('models.rt: A model needs a provider (or a runtime)'));

  const missing = base();
  missing.models.find((m: any) => m.id === 'rt').runtime = 'ghost';
  assert.ok(problemsOf(missing).includes('models.rt: Runtime "ghost" does not exist'));

  const duplicate = base();
  duplicate.runtimes.push({ ...duplicate.runtimes[0] });
  assert.ok(problemsOf(duplicate).some(text => text.includes('ID "cc" is duplicated')));

  const relative = base();
  relative.runtimes[0].executablePath = 'tools/claude.exe';
  assert.ok(problemsOf(relative).some(text => text.startsWith('runtimes.cc.executablePath: ')));

  const kind = base();
  kind.runtimes[0].kind = 'gemini-cli';
  assert.ok(problemsOf(kind).length > 0);

  const extra = base();
  extra.runtimes[0].apiKey = 'x';
  assert.ok(problemsOf(extra).length > 0, 'a runtime holds no key');

  const second = base();
  second.routing.chat = ['claude-sonnet', 'rt'];
  assert.ok(problemsOf(second).some(text => text.startsWith('routing.chat: Model "rt" runs through a runtime')), 'a runtime model cannot be a fallback of the conversation');

  for (const route of ['background', 'judge', 'scout', 'research']) {
    const other = base();
    other.routing[route] = ['rt'];
    assert.ok(problemsOf(other).some(text => text.startsWith(`routing.${route}: Model "rt" runs through a runtime`)), route);
  }

  const first = base();
  first.routing.chat = ['rt', 'claude-sonnet'];
  assert.deepEqual(problemsOf(first), [], 'a runtime model may be the first model of the conversation');
});

test('a mistake about a provider model reads the same as before', () => {
  const raw = plain(testConfig());
  raw.models.push({ id: 'orphan', provider: 'nope', model: 'x', maxOutputTokens: 1024, vision: false });
  raw.routing.chat = ['missing'];
  const problems = problemsOf(raw);
  assert.ok(problems.includes('models.orphan: Provider "nope" does not exist'));
  assert.ok(problems.includes('routing.chat: Model "missing" does not exist'));
});

test('candidate models: without a runtime the list is what it was; a runtime model never counts as a fallback when nothing is written', () => {
  const plainConfig = testConfig();
  plainConfig.routing.chat = [];
  assert.deepEqual(candidateModelIds(plainConfig, 'chat'), plainConfig.models.map(m => m.id));
  const config = withRuntime(testConfig());
  config.routing.chat = [];
  assert.deepEqual(candidateModelIds(config, 'chat'), plainConfig.models.map(m => m.id), 'the runtime model is not a candidate');
  config.routing.chat = ['rt', 'claude-sonnet'];
  assert.deepEqual(candidateModelIds(config, 'chat'), ['rt', 'claude-sonnet'], 'what is written is kept as written');
});

test('the judge cache identity: a provider model is identified as before; a runtime model has no provider', () => {
  const config = withRuntime(testConfig());
  assert.deepEqual(judgeIdentity(config, 'local'), [['local', 'local', 'qwen3:32b']]);
  assert.deepEqual(judgeIdentity(config, 'rt'), [['rt', null, 'fake-large']]);
  assert.deepEqual(judgeIdentity(config, 'ghost'), [['ghost', null, null]]);
});

test('the model list shows a runtime model without a provider and leaves provider models as they were', async t => {
  const s = await startApp(t, { configure: config => { withRuntime(config); config.routing.chat = ['m1', 'm2']; } });
  const body = (await s.json('/api/models', 'GET')).body;
  const rows = Object.fromEntries(body.models.map((row: any) => [row.id, row]));
  assert.equal(rows.m1.provider, 'fake');
  assert.equal(rows.m1.providerKind, 'openai_compatible');
  assert.equal(rows.rt.provider, '');
  assert.equal(rows.rt.providerKind, undefined);
  assert.equal(rows.rt.model, 'fake-large');
});

test('a runtime model is not checked against any provider (its state is the runtime check); the provider models are checked as before', async t => {
  const s = await startApp(t, { configure: config => { withRuntime(config); config.routing.chat = ['m1', 'm2']; } });
  assert.deepEqual(s.app.status.all().map(r => r.modelId).sort(), ['m1', 'm2', 'rt']);
  assert.equal(s.app.status.get('rt')?.messageCode, 'provider.probe.runtime_unchecked', 'its state comes from the runtime check, which has not been run');
  assert.equal(s.adapter().probeLanguages.length, 2, 'two provider models were probed, the runtime model was not');
});

test('a runtime model that nothing else can stand in for is "not usable" with its own reason, and no provider is called', async t => {
  const s = await startApp(t, { models: [], configure: config => { withRuntime(config); config.routing.chat = ['rt']; } });
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'hello' });
  assert.equal(sent.status, 409);
  assert.equal(sent.body.errorCode, 'engine.runtime.no_project', 'a runtime conversation needs a product; with no provider model to fall back on, that is the reason given');
  assert.equal(s.adapters.size === 0 || s.adapter().calls.length === 0, true, 'no provider was called');
  const usage = await s.json(`/api/conversations/${CONVERSATION}/context`, 'GET');
  assert.equal(usage.status, 409, 'the context estimate also says it cannot be counted instead of failing');
  assert.equal(usage.body.problems[0].messageCode, 'engine.problem.runtime_unavailable');
  const pinned = await s.json(`/api/conversations/${CONVERSATION}/context?modelId=rt`, 'GET');
  assert.equal(pinned.status, 409);
  assert.equal(pinned.body.errorCode, 'engine.usage.runtime', 'a conversation that runs through a runtime has no length gauge');
});

test('with a provider model after it, the conversation goes on as before and the runtime model is skipped', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], configure: config => { withRuntime(config); config.routing.chat = ['rt', 'm1']; } });
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'hello' });
  assert.equal(sent.status, 202);
  await settled(s.app, sent.body.runId);
  assert.equal(s.adapter().calls.at(-1)!.model.id, 'm1');
});

test('onboarding: a runtime model that was never checked does not complete the model step (a usable one does: tests/ar10-no-provider.test.ts)', async t => {
  const only = await startApp(t, { models: [], configure: config => { withRuntime(config); config.routing.chat = ['rt']; } });
  assert.equal((await only.json('/api/onboarding', 'GET')).body.steps.model, false);
  const both = await startApp(t, { models: [fakeModel('m1')], configure: config => { withRuntime(config); config.routing.chat = ['m1']; } });
  assert.equal((await both.json('/api/onboarding', 'GET')).body.steps.model, true);
  const none = await startApp(t, { models: [] });
  assert.equal((await none.json('/api/onboarding', 'GET')).body.steps.model, false, 'no models at all: as before');
});

test('the worker rests with "no_model" when only runtime models exist, and runs as before when a provider model exists', async t => {
  const only = await startApp(t, { models: [], configure: config => { withRuntime(config); config.routing.chat = ['rt']; } });
  assert.equal(await only.app.worker.tick(), 'no_model');
  const none = await startApp(t, { models: [] });
  assert.equal(await none.app.worker.tick(), 'no_model');
  const both = await startApp(t, { models: [fakeModel('m1')], configure: config => { withRuntime(config); config.routing.chat = ['m1']; } });
  assert.notEqual(await both.app.worker.tick(), 'no_model');
});

test('the settings API keeps the runtimes section through a save and a read', async t => {
  const s = await startApp(t, { configure: config => { withRuntime(config); config.routing.chat = ['m1', 'm2']; } });
  const read = (await s.json('/api/settings', 'GET')).body;
  assert.deepEqual(read.config.runtimes, [{ id: 'cc', kind: 'claude-code', enabled: true }]);
  const edited = structuredClone(read.config);
  edited.runtimes[0].permission = 'acceptEdits';
  const saved = await s.json('/api/settings', 'PUT', { config: edited });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config.runtimes[0].permission, 'acceptEdits');
  assert.equal(s.app.config().runtimes![0]!.permission, 'acceptEdits');
  const rejected = await s.json('/api/settings', 'PUT', { config: { ...edited, routing: { ...edited.routing, background: ['rt'] } } });
  assert.equal(rejected.status, 400);
});

test('the smallest usable window and the effort choices are what they were: a runtime model is never counted as usable and declares no efforts of its own', async t => {
  const plainApp = await startApp(t, { models: [fakeModel('m1', { contextLength: 65536 })] });
  const mixed = await startApp(t, { models: [fakeModel('m1', { contextLength: 65536 })], configure: config => { withRuntime(config); config.routing.chat = ['rt', 'm1']; } });
  assert.equal(mixed.app.engine.backgroundAvailable(), plainApp.app.engine.backgroundAvailable());
  assert.notEqual(mixed.app.engine.backgroundAvailable(), undefined);
  assert.deepEqual(mixed.app.engine.effortChoices('rt'), { modelId: 'rt', efforts: [] });
  assert.deepEqual(mixed.app.engine.effortChoices('m1'), plainApp.app.engine.effortChoices('m1'));
});
