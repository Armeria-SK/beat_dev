import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderConfig } from '../src/config/schema.ts';
import { listProviderModels, MODEL_LIST_MAX } from '../src/providers/model-list.ts';
import { ProviderError } from '../src/providers/types.ts';
import { setupModelConfig, setupProviderConfig, type ModelForm } from '../web/src/onboarding.ts';
import { listPlan } from '../web/src/ui/onboarding-steps.ts';
import { startApp } from './app-setup.ts';

const KEY = 'Zk3qP9xW7mB2vN8cLd5Tq1';
const FAKE: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 };

interface Seen { url: string; headers: Record<string, string>; redirect: unknown }

function recorder(answer: (url: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    seen.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, redirect: init.redirect });
    return answer(String(input));
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const list = (ids: unknown[], extra: Record<string, unknown> = {}) => Response.json({ data: ids.map(id => ({ id })), ...extra });

test('モデルの一覧: 設定にあるプロバイダの送り先だけに、そのプロバイダの鍵で尋ねる。要求が持ち込んだ URL は使わない', async t => {
  const net = recorder(() => list(['qwen3', 'qwen3', 'gemma', 7, '', null, 'x'.repeat(201)]));
  const s = await startApp(t, { env: { FAKE_KEY: KEY }, fetch: net.fetchImpl });
  const got = await s.json('/api/providers/fake/models?baseUrl=https://evil.example/v1&url=https://evil.example', 'GET');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { models: ['qwen3', 'gemma'], truncated: false });
  assert.deepEqual(net.seen, [{ url: 'http://127.0.0.1:1/v1/models', headers: { Accept: 'application/json', Authorization: `Bearer ${KEY}` }, redirect: 'error' }]);

  assert.equal((await s.json('/api/providers/nobody/models', 'GET')).status, 404);
  assert.equal(net.seen.length, 1, '設定に無いプロバイダには何も送らない');
});

test('モデルの一覧（Anthropic）: 既定の宛先か、設定の baseUrl の /v1/models に x-api-key で尋ねる。続きがあれば truncated', async () => {
  const net = recorder(() => list(['claude-a', 'claude-b'], { has_more: true }));
  const anthropic: ProviderConfig = { id: 'anthropic', kind: 'anthropic', maxParallel: 2, timeoutMs: 10_000 };
  assert.deepEqual(await listProviderModels(anthropic, { ANTHROPIC_API_KEY: KEY }, net.fetchImpl), { models: ['claude-a', 'claude-b'], truncated: true });
  await listProviderModels({ ...anthropic, baseUrl: 'https://proxy.example/anthropic/' }, { ANTHROPIC_API_KEY: KEY }, net.fetchImpl);
  assert.deepEqual(net.seen.map(x => x.url), ['https://api.anthropic.com/v1/models?limit=1000', 'https://proxy.example/anthropic/v1/models?limit=1000']);
  assert.deepEqual(net.seen[0]!.headers, { Accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': KEY });
});

test('モデルの一覧: 鍵が無い・送り先が使えない形なら、何も送らずに断る（鍵を外への http に載せない）', async () => {
  const net = recorder(() => list(['a']));
  await assert.rejects(listProviderModels(FAKE, {}, net.fetchImpl), (e: ProviderError) => e.kind === 'auth' && /FAKE_KEY/u.test(e.message));
  await assert.rejects(listProviderModels({ ...FAKE, baseUrl: 'http://far.example/v1' }, { FAKE_KEY: KEY }, net.fetchImpl), /Use https/u);
  await assert.rejects(listProviderModels({ ...FAKE, baseUrl: 'https://user:pw@far.example/v1' }, { FAKE_KEY: KEY }, net.fetchImpl), /credentials/u);
  assert.deepEqual(net.seen, []);
});

test('モデルの一覧: 失敗は読める 1 行で返し、相手が鍵をそのまま返しても・例外に鍵が入っていても、応答とログに鍵を出さない', async t => {
  let mode: 'http' | 'throw' | 'junk' = 'http';
  const net = recorder(() => {
    if (mode === 'throw') throw new Error(`connect failed with Bearer ${KEY}`);
    if (mode === 'junk') return new Response(`<html>${KEY}</html>`, { status: 200 });
    return Response.json({ error: { message: `Incorrect API key provided: ${KEY}` } }, { status: 401 });
  });
  const s = await startApp(t, { env: { FAKE_KEY: KEY }, fetch: net.fetchImpl });
  for (const [next, pattern] of [['http', /Authentication failed \(HTTP 401\)/u], ['throw', /Cannot connect to the provider/u], ['junk', /did not answer with a model list/u]] as const) {
    mode = next;
    const failed = await s.api('/api/providers/fake/models');
    const text = await failed.text();
    assert.equal(failed.status, 502, next);
    assert.equal(text.includes(KEY), false, `${next}: 応答に鍵が無い`);
    const body = JSON.parse(text) as { error: string; message: string };
    assert.equal(body.error, 'models_unavailable');
    assert.match(body.message, /^Could not get the model list from "fake": /u);
    assert.match(body.message, pattern);
    assert.equal(body.message.includes('\n'), false);
  }
  assert.equal(s.logs.join('\n').includes(KEY), false);
});

test('モデルの一覧: 時間切れで止める。一覧は上限で切り、大きすぎる応答は読まない', async () => {
  const hung = ((_input: unknown, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  })) as typeof fetch;
  const started = Date.now();
  await assert.rejects(listProviderModels(FAKE, { FAKE_KEY: KEY }, hung, 60), (e: ProviderError) => e instanceof ProviderError && e.kind === 'timeout');
  assert.ok(Date.now() - started < 5000);

  const many = recorder(() => list(Array.from({ length: MODEL_LIST_MAX + 100 }, (_, i) => `m-${i}`)));
  const capped = await listProviderModels(FAKE, { FAKE_KEY: KEY }, many.fetchImpl);
  assert.equal(capped.models.length, MODEL_LIST_MAX);
  assert.equal(capped.truncated, true);
  assert.equal(capped.models.at(-1), `m-${MODEL_LIST_MAX - 1}`);

  const huge = recorder(() => new Response(`{"data":[{"id":"${'x'.repeat(5 * 1024 * 1024)}"}]}`));
  await assert.rejects(listProviderModels(FAKE, { FAKE_KEY: KEY }, huge.fetchImpl), /too large/u);
});

test('はじめの設定: 一覧のためにプロバイダだけを足し、同じ送り先があれば足さない。あとの「確かめる」は、その使われていないプロバイダを（鍵の名前ごと）使う', () => {
  const form: ModelForm = { source: 'openai', model: 'qwen3', baseUrl: 'http://127.0.0.1:8000/v1', server: 'generic', contextLength: '32768', apiKeyEnv: '' };
  const empty = { providers: [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600000 }], models: [], routing: { chat: [], background: [], retriesPerModel: 2 } };
  const first = setupProviderConfig(empty, form);
  assert.equal(first.providerId, 'local');
  assert.deepEqual(first.config.providers.at(-1), { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8000/v1', server: 'generic', maxParallel: 1, timeoutMs: 600000 });
  assert.deepEqual(first.config.models, []);
  const again = setupProviderConfig(first.config, form);
  assert.equal(again.providerId, 'local');
  assert.equal(again.config, first.config, '同じ送り先がすでにあれば何も変えない');
  assert.equal(setupProviderConfig(empty, { ...form, source: 'anthropic' }).providerId, 'anthropic');

  const keyed = { ...first.config, providers: first.config.providers.map((p: Record<string, unknown>) => (p.id === 'local' ? { ...p, apiKeyEnv: 'LOCAL_API_KEY' } : p)) };
  const tested = setupModelConfig(keyed, form, null);
  assert.equal(tested.config.providers.length, 2, 'プロバイダを二重に足さない');
  assert.equal(tested.config.providers.at(-1).apiKeyEnv, 'LOCAL_API_KEY');
  assert.equal(tested.config.models[0].provider, 'local');
  const second = setupModelConfig(tested.config, { ...form, model: 'gemma' }, null);
  assert.equal(second.config.providers.length, 3, '使われているプロバイダは、今までどおり別に足す');

  const retested = setupModelConfig(tested.config, form, tested.modelId);
  assert.equal(retested.config.providers.at(-1).apiKeyEnv, 'LOCAL_API_KEY', '同じ送り先をもう一度確かめても、鍵の名前は残る');
  const moved = setupModelConfig(tested.config, { ...form, baseUrl: 'https://far.example/v1' }, tested.modelId);
  assert.equal('apiKeyEnv' in moved.config.providers.at(-1), false, '送り先を変えたら、前の鍵は新しい送り先へ持っていかない');
});

test('はじめの設定の一覧: 鍵を入れて外の送り先の一覧を取るときは、鍵がそこへ送られることを確かめに並べる。この PC の中・鍵なしなら並べない', () => {
  const latest = { providers: [{ id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600000 }], models: [], routing: { chat: [], background: [], retriesPerModel: 2 } };
  const form = { provider: 'custom' as const, model: '', baseUrl: 'https://far.example/v1', context: '32768', key: 'secret-value' };
  const outside = listPlan(latest, form);
  assert.equal(outside.providerId, 'local');
  assert.deepEqual(outside.items, [{ kind: 'provider-url', id: 'local', url: 'https://far.example/v1' }, { kind: 'provider-key-send', id: 'local', url: 'https://far.example/v1' }]);
  assert.deepEqual(listPlan(latest, { ...form, key: '' }).items.map(i => i.kind), ['provider-url']);
  assert.deepEqual(listPlan(latest, { ...form, baseUrl: 'http://127.0.0.1:8000/v1' }).items, []);
  assert.deepEqual(listPlan(outside.config, form).items, [{ kind: 'provider-key-send', id: 'local', url: 'https://far.example/v1' }], '保存済みの外のプロバイダに鍵を入れるときも並べる');
});
