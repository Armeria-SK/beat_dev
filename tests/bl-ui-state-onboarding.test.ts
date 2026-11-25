import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Profile } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { dropListed, plannedProviderId, setupModelConfig, setupProviderConfig, type ModelForm } from '../web/src/onboarding.ts';
import type { Config } from '../web/src/settings/model.ts';
import { listPlan } from '../web/src/ui/onboarding-steps.ts';

// backlog 343・344（はじめの設定の List models と Test connection）。

const OPENAI = 'https://api.openai.com/v1';
const routing = { chat: [], background: [], retriesPerModel: 2 };
const anthropic = { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600000 };
const compat = (id: string, extra: Record<string, unknown> = {}) => ({ id, kind: 'openai_compatible', baseUrl: OPENAI, server: 'openai', maxParallel: 1, timeoutMs: 600000, ...extra });
const modelOn = (id: string, provider: string) => ({ id, label: '', provider, model: id, vision: false });
const configOf = (providers: unknown[], models: unknown[] = []): Config => ({ providers, models, routing }) as unknown as Config;
const form: ModelForm = { source: 'openai', model: 'gpt-x', baseUrl: OPENAI, server: 'openai', contextLength: '32768', apiKeyEnv: '' };
const idsOf = (config: Config): string[] => (config.providers as Array<{ id: string }>).map(p => p.id);
const modelProvider = (built: { config: Config; modelId: string }): string => (built.config.models as Array<{ id: string; provider: string }>).find(m => m.id === built.modelId)!.provider;

test('344 List と Test は同じ提供元を選ぶ: 同じ送り先の提供元が使われているものだけなら、どちらも新しい提供元を足す（使われているものの鍵を、Test が新しい提供元に持っていかない）', () => {
  const config = configOf([anthropic, compat('local', { apiKeyEnv: 'LOCAL_API_KEY' })], [modelOn('old', 'local')]);
  const listed = setupProviderConfig(config, form);
  assert.equal(listed.providerId, 'local-2', 'List: 使われている local ではなく、新しく足す');
  assert.deepEqual(idsOf(listed.config), ['anthropic', 'local', 'local-2']);
  assert.equal(modelProvider(setupModelConfig(config, form, null)), listed.providerId, 'Test も同じ提供元');
  assert.equal(modelProvider(setupModelConfig(listed.config, form, null)), listed.providerId, 'List のあとの Test は、List が足した提供元を使う');
});

test('344 List と Test は同じ提供元を選ぶ: まだ使われていない同じ送り先の提供元が後ろにあれば、どちらもそれを選ぶ（先頭の使われているものではない）', () => {
  const config = configOf([anthropic, compat('local', { apiKeyEnv: 'LOCAL_API_KEY' }), compat('local-2')], [modelOn('old', 'local')]);
  const listed = setupProviderConfig(config, form);
  assert.equal(listed.providerId, 'local-2');
  assert.equal(listed.config, config, '足すものが無ければ設定は同じ物のまま');
  assert.equal(modelProvider(setupModelConfig(config, form, null)), 'local-2');
});

test('344 Test のあとの List: 確かめたモデルの提供元を使い、送り先を変えていれば Test と同じようにその提供元を書き換える', () => {
  const tested = setupModelConfig(configOf([anthropic]), form, null);
  const own = modelProvider(tested);
  assert.equal(setupProviderConfig(tested.config, form, tested.modelId).providerId, own);
  const moved = { ...form, baseUrl: 'https://far.example/v1', server: 'generic' as const };
  const listed = setupProviderConfig(tested.config, moved, tested.modelId);
  assert.equal(listed.providerId, own, '送り先を変えても、確かめたモデルの提供元のまま');
  assert.deepEqual(listed.config.providers, setupModelConfig(tested.config, moved, tested.modelId).config.providers, 'Test がこのあと書く提供元と同じ中身');
  assert.equal(listPlan(tested.config, { provider: 'custom', model: 'x', baseUrl: 'https://far.example/v1', context: '32768', key: '' }, tested.modelId).providerId, own, 'listPlan も同じ');
});

test('344 鍵が入っているかを見る提供元: List と Test が使う提供元（使われているものしか無ければ、まだ無い）と同じものを返す', () => {
  const used = configOf([anthropic, compat('local')], [modelOn('old', 'local')]);
  assert.equal(plannedProviderId(used, form, null), null, '新しく足すことになる提供元に、鍵はまだ無い');
  const spare = configOf([anthropic, compat('local'), compat('local-2')], [modelOn('old', 'local')]);
  assert.equal(plannedProviderId(spare, form, null), 'local-2');
  const tested = setupModelConfig(used, form, null);
  assert.equal(plannedProviderId(tested.config, form, tested.modelId), modelProvider(tested));
  assert.equal(plannedProviderId(used, { ...form, source: 'anthropic', baseUrl: '' }, null), 'anthropic');
  assert.equal(plannedProviderId(configOf([compat('local')]), { ...form, source: 'anthropic', baseUrl: '' }, null), null);
});

test('343 List が足した提供元の後片付け: 使われていない・今の行き先でもないものだけ消す。使われているもの・List が足していないものは残し、消すものが無ければ同じ設定を返す', () => {
  const config = configOf([anthropic, compat('local', { baseUrl: 'http://127.0.0.1:8001/v1' }), compat('local-2', { baseUrl: 'http://127.0.0.1:8002/v1' }), compat('mine', { baseUrl: 'http://127.0.0.1:8003/v1' }), compat('used', { baseUrl: 'http://127.0.0.1:8004/v1' })], [modelOn('m', 'used')]);
  const ids = new Set(['local', 'local-2', 'used']);
  assert.deepEqual(idsOf(dropListed(config, ids, 'local-2')), ['anthropic', 'local-2', 'mine', 'used'], '今の行き先（local-2）と使われている used は残る。mine は List が足したものではない');
  assert.deepEqual(idsOf(dropListed(config, ids, null)), ['anthropic', 'mine', 'used']);
  assert.equal(dropListed(config, new Set(['used']), null), config, '使われているものだけなら何も消さない（同じ物を返す）');
  const same = configOf([anthropic]);
  assert.equal(dropListed(same, new Set(['local']), null), same, '消すものが無ければ同じ物を返す');
  assert.equal(config.providers.length, 5, '渡した設定は書き換えない');
});

const { Onboarding } = await loadTsx<{ Onboarding: ComponentType<{ profile: Profile | null; replay: boolean; start: number; onProfile: () => void; onDone: () => void; onSkip: () => void }> }>('../web/src/ui/Onboarding.tsx', import.meta.url);

const g = globalThis as { matchMedia?: unknown };
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
const realFetch = globalThis.fetch;
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const later = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const settle = async () => { for (let i = 0; i < 4; i++) await later(0); };

interface Call { method: string; path: string; body: any }
function fakeServer(initial: Config, keyed: string[] = []) {
  const state = { config: structuredClone(initial) as Config, keys: new Set(keyed), calls: [] as Call[] };
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.calls.push({ method, path: url, body });
    if (url === '/api/settings') {
      if (method === 'PUT') state.config = structuredClone(body.config) as Config;
      return reply({ config: state.config, models: [] });
    }
    if (url === '/api/models') return reply({ models: [], routing: { chat: [], background: [] } });
    if (url === '/api/models/probe') return reply({ models: (state.config.models as Array<{ id: string }>).map(m => ({ id: m.id, probe: { modelId: m.id, status: 'ok', server: '', required: 0, message: '', checkedAt: 1 } })) });
    const key = /^\/api\/providers\/([^/]+)\/key$/u.exec(url);
    if (key) {
      const id = decodeURIComponent(key[1]!);
      if (method === 'PUT') state.keys.add(id);
      if (method === 'DELETE') state.keys.delete(id);
      return reply({ set: state.keys.has(id) });
    }
    if (/^\/api\/providers\/[^/]+\/models$/u.test(url)) return reply({ models: ['a', 'b'], truncated: false });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return state;
}

const urlsOf = (config: Config): string[] => (config.providers as Array<{ kind: string; baseUrl?: string }>).filter(p => p.kind === 'openai_compatible').map(p => p.baseUrl!);
const fieldOf = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLLabelElement>('label.bt-form-row')].find(l => l.querySelector('.bt-label')?.textContent === label)?.querySelector('input') ?? null;

async function openModelStep(): Promise<HTMLElement> {
  const { container } = await render(createElement(Onboarding, { profile: null, replay: false, start: 3, onProfile: () => undefined, onDone: () => undefined, onSkip: () => undefined }));
  await settle();
  return container;
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('343 はじめの設定（DOM）: List models のあと行き先を変えてもう一度押すと、前の List が足して使っていない提供元を消す。閉じたときも、使っていない分を消す', async () => {
  const server = fakeServer(configOf([anthropic]));
  const container = await openModelStep();
  await click(byText(container, 'button', en['ui.ob.model.custom']));
  await input(container.querySelector('input[list="ui-ob-model-names"]'), 'm1');
  await input(fieldOf(container, en['ui.ob.model.url']), 'http://127.0.0.1:8001/v1');
  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  assert.deepEqual(urlsOf(server.config), ['http://127.0.0.1:8001/v1'], '1 回目: 一覧のために足す');

  await input(fieldOf(container, en['ui.ob.model.url']), 'http://127.0.0.1:8002/v1');
  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  assert.deepEqual(urlsOf(server.config), ['http://127.0.0.1:8002/v1'], '2 回目: 使っていない 8001 の提供元は消え、今の行き先だけ残る');
  const saves = server.calls.filter(c => c.method === 'PUT' && c.path === '/api/settings').length;

  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  assert.equal(server.calls.filter(c => c.method === 'PUT' && c.path === '/api/settings').length, saves, '同じ行き先でもう一度押しても、設定は書かない');

  await cleanup();
  await settle();
  await later(30);
  assert.deepEqual(urlsOf(server.config), [], '使わないまま閉じたら、List が足した提供元は残らない');
  assert.deepEqual(idsOf(server.config), ['anthropic'], 'もとからあった提供元は残る');
});

test('343 はじめの設定（DOM）: List で入れた鍵は、その提供元を消すときに一緒に消す（鍵だけが残らない）。ほかの提供元の鍵には触らない', async () => {
  const server = fakeServer(configOf([anthropic]), ['anthropic']);
  const container = await openModelStep();
  await click(byText(container, 'button', en['ui.ob.model.custom']));
  await input(container.querySelector('input[list="ui-ob-model-names"]'), 'm1');
  await input(fieldOf(container, en['ui.ob.model.keyOptional']), 'k-secret-1');
  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  const made = idsOf(server.config).find(id => id !== 'anthropic')!;
  assert.ok(server.keys.has(made), 'List が鍵を入れた');

  await cleanup();
  await settle();
  await later(30);
  assert.deepEqual(idsOf(server.config), ['anthropic']);
  assert.equal(server.keys.has(made), false, '消した提供元の鍵も消えている');
  assert.equal(server.keys.has('anthropic'), true, '前からある鍵は残る');
  const del = server.calls.findIndex(c => c.method === 'DELETE' && c.path === `/api/providers/${made}/key`);
  const save = server.calls.findLastIndex(c => c.method === 'PUT' && c.path === '/api/settings');
  assert.ok(del >= 0 && del < save, '提供元が設定にあるうちに鍵を消し、そのあと設定から外す');
});

test('343 はじめの設定（DOM）: Test connection で使った提供元（モデルが付いたもの）は、閉じても消さない', async () => {
  const server = fakeServer(configOf([anthropic]));
  const container = await openModelStep();
  await click(byText(container, 'button', en['ui.ob.model.custom']));
  await input(container.querySelector('input[list="ui-ob-model-names"]'), 'm1');
  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  await click(byText(container, 'button', en['ui.ob.model.test']));
  await settle();
  assert.equal((server.config.models as unknown[]).length, 1, 'Test がモデルを足した');
  await cleanup();
  await settle();
  await later(30);
  assert.equal(urlsOf(server.config).length, 1, 'モデルが使う提供元は残る');
});

test('344 はじめの設定（DOM）: List に打った鍵は、Test が使う提供元に入る（同じ送り先の使われている提供元があっても、鍵を打ち直さない）', async () => {
  const server = fakeServer(configOf([anthropic, { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', server: 'generic', maxParallel: 1, timeoutMs: 600000, apiKeyEnv: 'LOCAL_API_KEY' }], [modelOn('old', 'local')]), ['local']);
  const container = await openModelStep();
  await click(byText(container, 'button', en['ui.ob.model.custom']));
  await input(container.querySelector('input[list="ui-ob-model-names"]'), 'm1');
  await input(fieldOf(container, en['ui.ob.model.keyOptional']), 'k-secret-2');
  await click(byText(container, 'button', en['ui.ob.model.list']));
  await settle();
  await click(byText(container, 'button', en['ui.ob.model.test']));
  await settle();
  const model = (server.config.models as Array<{ id: string; model: string; provider: string }>).find(m => m.model === 'm1')!;
  assert.ok(model, 'Test が m1 を足した');
  assert.equal(server.keys.has(model.provider), true, `m1 の提供元（${model.provider}）に、List で打った鍵が入っている`);
  assert.equal(server.keys.has('local'), true, '使われている local の鍵は触らない');
});

test('344 はじめの設定（DOM）: OpenAI を選んだとき、使われている提供元にしか鍵が無ければ「Key set」とは言わない（Test が使うのは新しい提供元で、鍵が無い）', async () => {
  fakeServer(configOf([anthropic, compat('local', { apiKeyEnv: 'LOCAL_API_KEY' })], [modelOn('old', 'local')]), ['local']);
  const container = await openModelStep();
  await click(byText(container, 'button', en['ui.ob.model.openai']));
  await settle();
  assert.equal(fieldOf(container, en['ui.ob.model.key'])?.placeholder, en['ui.set.key.paste']);

  fakeServer(configOf([anthropic, compat('local', { apiKeyEnv: 'LOCAL_API_KEY' }), compat('local-2', { apiKeyEnv: 'LOCAL_2_API_KEY' })], [modelOn('old', 'local')]), ['local-2']);
  await click(byText(container, 'button', en['ui.ob.model.custom']));
  await click(byText(container, 'button', en['ui.ob.model.openai']));
  await settle();
  assert.equal(fieldOf(container, en['ui.ob.model.key'])?.placeholder, en['ui.ob.model.keySet'], 'Test が使う提供元に鍵があるときは「Key set」');
});
