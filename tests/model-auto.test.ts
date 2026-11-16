import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { AUTO_MAX_OUTPUT, CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, maxOutputFor } from '../src/engine/context-budget.ts';
import { HISTORY_RESERVE, requiredContext } from '../src/engine/status.ts';
import { resolvePaths } from '../src/paths.ts';
import { AnthropicAdapter } from '../src/providers/anthropic.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { providerText } from '../src/shared/messages/providers.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, fakeServer, isJudgeRequest, reply, tempDir, testConfig } from './helpers.ts';

const auto = (over: Partial<ModelConfig> = {}): ModelConfig => ({ id: 'm', provider: 'p', model: 'test-model', vision: false, ...over });
const compat = (baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl, maxParallel: 1, timeoutMs: 10_000, ...over });
const anthropicProvider: ProviderConfig = { id: 'p', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 1, timeoutMs: 10_000 };

test('model-auto: 返事の上限は、書いてあればその値（提供元の上限で抑える）、無ければ 32,000・長さの 1/4・下限 1,024 で決まり、提供元の上限が下限に勝つ', () => {
  assert.equal(maxOutputFor(auto({ maxOutputTokens: 3000 }), 500_000), 3000, '書いた値');
  assert.equal(maxOutputFor(auto({ maxOutputTokens: 200_000 }), 500_000, 128_000), 128_000, '書いた値も提供元の上限で抑える');
  assert.equal(maxOutputFor(auto(), 500_000, 128_000), 32_000, '自動は 32,000 まで');
  assert.equal(maxOutputFor(auto(), 500_000), AUTO_MAX_OUTPUT);
  assert.equal(maxOutputFor(auto(), 32_768), 8192, '長さの 1/4');
  assert.equal(maxOutputFor(auto(), 500_000, 8192), 8192, '提供元の上限');
  assert.equal(maxOutputFor(auto(), 2048), 1024, '下限 1,024');
  assert.equal(maxOutputFor(auto(), 2048, 512), 512, '提供元の上限が下限に勝つ');
});

// テストの中で、実装を使わずに「長さ c で足りる」を数え直す
function needAt(model: ModelConfig, base: number, memory: number, c: number): number {
  const out = model.maxOutputTokens ?? Math.min(32_000, Math.max(1024, Math.floor(c / 4)));
  const available = Math.floor(c * CONTEXT_FILL_RATIO) - out;
  return base + HISTORY_RESERVE + out + Math.min(memory, Math.floor(MEMORY_BUDGET_RATIO * Math.max(0, available)));
}

test('model-auto: 必要な長さは minContext を使わず、前後 ±2,000 のどの長さでも「足りる」と「required 以上」が一致する（総当たり）', () => {
  for (const model of [auto(), auto({ maxOutputTokens: 1024 }), auto({ maxOutputTokens: 60_000 })]) {
    for (const base of [0, 500, 3500, 20_000]) {
      for (const memory of [0, 300, 5000, 100_000]) {
        const required = requiredContext(model, base, memory);
        for (let c = Math.max(0, required - 2000); c <= required + 2000; c++) {
          const enough = c >= needAt(model, base, memory, c);
          if (enough !== c >= required) assert.fail(`out=${model.maxOutputTokens ?? 'auto'} base=${base} memory=${memory} c=${c} required=${required}: enough=${enough}`);
        }
      }
    }
  }
  assert.equal(requiredContext(auto({ maxOutputTokens: 1024 }), 3500), 3500 + HISTORY_RESERVE + 1024, '記憶が無ければ system と履歴と返事の上限の和（65,536 の床は無い）');
});

const anthropicProbe = async (body: Record<string, unknown>) => {
  const fetchImpl = (async () => new Response(JSON.stringify({ id: 'claude-x', type: 'model', display_name: 'x', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 200000, ...body }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  return new AnthropicAdapter(anthropicProvider, { ANTHROPIC_API_KEY: 'k' }, fetchImpl).probe(auto(), 65536);
};

test('model-auto: Anthropic の確認は max_tokens を返事の上限（maxOutput）として読み、null・負の数・小数・数でない値は無視する', async () => {
  const ok = await anthropicProbe({ max_tokens: 64000 });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.maxOutput, 64000);
  assert.equal(maxOutputFor(auto(), ok.effective!, ok.maxOutput), 32_000);
  assert.equal(maxOutputFor(auto(), ok.effective!, (await anthropicProbe({ max_tokens: 8192 })).maxOutput), 8192);
  for (const bad of [null, -1, 0.5, '64000', 1e999]) {
    const result = await anthropicProbe({ max_tokens: bad });
    assert.equal(result.maxOutput, undefined, JSON.stringify(bad));
    assert.equal(result.status, 'ok');
  }
});

async function jsonServer(t: { after: (fn: () => Promise<unknown>) => void }, routes: Record<string, string>) {
  const server = await fakeServer((req, _body, res) => {
    const body = routes[req.url ?? ''];
    res.writeHead(body === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(body ?? '{}');
  });
  t.after(() => server.close());
  return server;
}

test('model-auto: OpenRouter の top_provider.max_completion_tokens を読む。10^9 は捨てられ、送る値は 32,000 を超えない', async t => {
  const read = await jsonServer(t, { '/v1/models': JSON.stringify({ data: [{ id: 'test-model', context_length: 1_000_000, top_provider: { context_length: 200_000, max_completion_tokens: 16_000 } }] }) });
  const result = await new OpenAiCompatibleAdapter(compat(`${read.url}/v1`, { server: 'openrouter' }), {}).probe(auto(), 65536);
  assert.equal(result.status, 'ok');
  assert.equal(result.effective, 200_000);
  assert.equal(result.maxOutput, 16_000);
  assert.equal(maxOutputFor(auto(), result.effective!, result.maxOutput), 16_000);
  const huge = await jsonServer(t, { '/v1/models': JSON.stringify({ data: [{ id: 'test-model', top_provider: { context_length: 200_000, max_completion_tokens: 1_000_000_000 } }] }) });
  const big = await new OpenAiCompatibleAdapter(compat(`${huge.url}/v1`, { server: 'openrouter' }), {}).probe(auto(), 65536);
  assert.equal(big.maxOutput, undefined, '10,000,000 を超える数は知らせなかったとみなす');
  assert.equal(maxOutputFor(auto(), big.effective!, big.maxOutput), 32_000);
});

test('model-auto: サーバーが知らせた長さは 1〜10,000,000 の整数だけ使う（1e999・0.5・-1・2e7 はどれも使わず unknown）', async t => {
  for (const raw of ['1e999', '0.5', '-1', '2e7']) {
    const server = await jsonServer(t, { '/v1/models': `{"data":[{"id":"test-model","max_model_len":${raw}}]}` });
    const result = await new OpenAiCompatibleAdapter(compat(`${server.url}/v1`, { server: 'generic' }), {}).probe(auto(), 4096);
    assert.equal(result.status, 'unknown', raw);
    assert.equal(result.effective, undefined, raw);
    assert.equal(result.measured, undefined, raw);
  }
  const fine = await jsonServer(t, { '/v1/models': '{"data":[{"id":"test-model","max_model_len":1e999,"context_length":32768}]}' });
  const result = await new OpenAiCompatibleAdapter(compat(`${fine.url}/v1`, { server: 'generic' }), {}).probe(auto(), 4096);
  assert.equal(result.measured, 32768, '捨てた欄の次の正しい欄を使う');
});

test('model-auto: LM Studio の読み込み前と generic の n_ctx_train だけのとき、長さを書いていなければ上限を信じず unknown（読み込んでから Check now の案内）。書いてあれば今どおり', async t => {
  const lm = await jsonServer(t, { '/api/v0/models/test-model': JSON.stringify({ id: 'test-model', state: 'not-loaded', max_context_length: 131072 }), '/v1/models': '{"data":[]}' });
  const lmAdapter = new OpenAiCompatibleAdapter(compat(`${lm.url}/v1`, { server: 'lmstudio' }), {});
  const unknown = await lmAdapter.probe(auto(), 4096);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.hint, providerText('en', 'hint.unknown_not_loaded'));
  assert.match(unknown.hint ?? '', /Check now/);
  const declared = await lmAdapter.probe(auto({ contextLength: 32768 }), 4096);
  assert.equal(declared.status, 'ok');
  assert.equal(declared.effective, 32768);
  const over = await lmAdapter.probe(auto({ contextLength: 200_000 }), 4096);
  assert.equal(over.status, 'exceeds_model', '書いた値が上限を超える判定は今どおり');
  const generic = await jsonServer(t, { '/v1/models': JSON.stringify({ data: [{ id: 'test-model', meta: { n_ctx_train: 131072 } }] }) });
  const gAdapter = new OpenAiCompatibleAdapter(compat(`${generic.url}/v1`, { server: 'generic' }), {});
  assert.equal((await gAdapter.probe(auto(), 4096)).status, 'unknown');
  const gDeclared = await gAdapter.probe(auto({ contextLength: 65536 }), 4096);
  assert.equal(gDeclared.status, 'ok');
  assert.equal(gDeclared.effective, 65536);
  const vllm = await jsonServer(t, { '/v1/models': JSON.stringify({ data: [{ id: 'test-model', max_model_len: 65536 }] }) });
  assert.equal((await new OpenAiCompatibleAdapter(compat(`${vllm.url}/v1`, { server: 'vllm' }), {}).probe(auto(), 4096)).effective, 65536, '測った値のサーバーは今どおり');
});

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, models: ModelConfig[], probes: Record<string, Record<string, unknown>> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [
    { id: 'claude', kind: 'anthropic', apiKeyEnv: 'FAKE_ANTHROPIC_KEY', maxParallel: 1, timeoutMs: 10_000 },
    { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 },
    { id: 'unk', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 },
  ];
  config.models = models;
  config.routing = { chat: models.map(m => m.id), background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(config));
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined,
    adapterOverride: provider => { const a = new FakeAdapter(provider); a.probeResult = probes[provider.id] ?? {}; adapters.set(provider.id, a); return a; },
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  return { app, api, adapter: (id: string) => adapters.get(id)! };
}

test('model-auto: /api/models は minContext を出さず、limits（いま使っている長さ・返事の上限・必要な長さ）を出す（Anthropic・ローカル・unknown の 3 通り）', async t => {
  const s = await startApp(t, [
    { id: 'sonnet', provider: 'claude', model: 'claude-x', vision: true },
    { id: 'local', provider: 'fake', model: 'qwen', contextLength: 32768, vision: false },
    { id: 'set', provider: 'fake', model: 'qwen', contextLength: 32768, maxOutputTokens: 2048, vision: false },
    { id: 'blind', provider: 'unk', model: 'x', vision: false },
  ], { claude: { maxOutput: 8192 }, unk: { status: 'unknown', effective: undefined } });
  const { models } = await (await s.api('/api/models')).json() as { models: Array<Record<string, any>> };
  const by = (id: string) => models.find(m => m.id === id)!;
  for (const m of models) assert.equal('minContext' in m, false, m.id);
  assert.deepEqual(by('sonnet').limits, { context: 200_000, maxOutput: 8192, required: s.app.status.get('sonnet')!.required });
  assert.deepEqual(by('local').limits, { context: 32768, maxOutput: 8192, required: s.app.status.get('local')!.required });
  assert.equal(by('local').maxOutputTokens, undefined, '書いていない値は出さない（画面が Auto と Set by you を分ける）');
  assert.equal(by('set').limits.maxOutput, 2048);
  assert.equal(by('set').maxOutputTokens, 2048);
  assert.deepEqual(by('blind').limits, { context: null, maxOutput: null, required: s.app.status.get('blind')!.required });
});

test('model-auto: 本番の呼び出しに渡る返事の上限は自動の値で、/api/models の limits.maxOutput と同じ', async t => {
  const s = await startApp(t, [{ id: 'local', provider: 'fake', model: 'qwen', contextLength: 131072, vision: false }]);
  const { models } = await (await s.api('/api/models')).json() as { models: Array<Record<string, any>> };
  assert.equal(models[0]!.limits.maxOutput, 32_000);
  s.app.conversations.create({ id: 'c1' });
  s.adapter('fake').scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'こんにちは');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  const real = s.adapter('fake').calls.filter(call => !isJudgeRequest(call));
  assert.ok(real.length >= 1);
  assert.equal(real.at(-1)!.maxOutputTokens, 32_000);
  assert.equal(real.at(-1)!.maxOutputTokens, models[0]!.limits.maxOutput);
});

test('model-auto: PUT /api/settings に新しい形（minContext なし・maxOutputTokens: 512）を送ると 512 が残り、/api/models にも出る', async t => {
  const s = await startApp(t, [{ id: 'local', provider: 'fake', model: 'qwen', contextLength: 32768, vision: false }]);
  const view = await (await s.api('/api/settings')).json() as any;
  assert.equal('minContext' in view.config.models[0], false);
  const next = structuredClone(view.config);
  next.models[0].maxOutputTokens = 512;
  const saved = await s.api('/api/settings', { method: 'PUT', body: JSON.stringify({ config: next }) });
  assert.equal(saved.status, 200);
  assert.equal(((await saved.json()) as any).config.models[0].maxOutputTokens, 512);
  assert.equal(s.app.config().models[0]!.maxOutputTokens, 512);
  const { models } = await (await s.api('/api/models')).json() as { models: Array<Record<string, any>> };
  assert.equal(models[0]!.limits.maxOutput, 512);
});
