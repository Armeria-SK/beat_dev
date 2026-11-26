import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { RunBus } from '../src/engine/bus.ts';
import { ChatEngine } from '../src/engine/chat.ts';
import { ModelStatus } from '../src/engine/status.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { listProviderModels } from '../src/providers/model-list.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { ProviderError, type ModelRequest, type StreamEvent } from '../src/providers/types.ts';
import { GEMINI_URL } from '../web/src/settings/model.ts';
import { startApp } from './app-setup.ts';
import { fakeServer, sse, tempDir, testConfig } from './helpers.ts';

// AR-1: Gemini API を提供元に足す。Google の OpenAI 互換の入口（base_url は …/v1beta/openai/、鍵は Authorization: Bearer、
// 公式の文書 https://ai.google.dev/gemini-api/docs/openai → https://aistudio.google.com/docs/openai を 2026-11-26 に読んだ）。
// どの試験も偽のサーバーだけに繋ぐ（本物の Google には繋がない）。鍵は偽の値

const KEY = 'gem-Zk3qP9xW7mB2vN8cLd5Tq1xY';
const ENV = 'BEAT_GEMINI_API_KEY';
const PATH = '/v1beta/openai';

const gemini = (baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: 'gemini', kind: 'openai_compatible', baseUrl, apiKeyEnv: ENV, server: 'gemini', maxParallel: 2, timeoutMs: 10_000, ...over });
const model = (over: Partial<ModelConfig> = {}): ModelConfig => ({ id: 'g', provider: 'gemini', model: 'gemini-test', contextLength: 65536, maxOutputTokens: 1024, vision: false, ...over });
const request = (m: ModelConfig, over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: m, system: { frozen: 'you are beat', dynamic: 'now', tail: '' }, messages: [{ role: 'user', content: 'hello' }],
  tools: [], maxOutputTokens: 1024, signal: new AbortController().signal, ...over,
});
async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try { await promise; } catch (error) { assert.ok(error instanceof ProviderError, String(error)); return error; }
  assert.fail('should fail');
}
const noKey = (what: unknown, label: string): void => assert.equal(JSON.stringify(what).includes(KEY), false, `${label} must not contain the key`);
const errorShape = (e: ProviderError) => ({ message: e.message, text: e.text('en'), params: e.params, upstream: e.upstream, code: e.code });

test('Gemini: 公式の入口の chat/completions に、Authorization: Bearer だけで鍵を送る。URL・問い合わせ・本文・ほかの見出しに鍵は無い。返事・使用量・終わりを読む', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [
    { choices: [{ delta: { role: 'assistant', content: 'こん' } }] },
    { choices: [{ delta: { content: 'にちは' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
  ]));
  t.after(() => server.close());
  const events = await collect(new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}/`), { [ENV]: KEY }).stream(request(model())));
  assert.equal(events.filter(e => e.type === 'text').map(e => (e as { delta: string }).delta).join(''), 'こんにちは');
  assert.deepEqual(events.find(e => e.type === 'usage'), { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } });
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'end_turn' });
  assert.equal(server.requests.length, 1);
  const sent = server.requests[0]!;
  assert.equal(sent.method, 'POST');
  assert.equal(sent.path, `${PATH}/chat/completions`, '問い合わせ（?key=…）を付けない');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent.headers['x-goog-api-key'], undefined);
  assert.equal(sent.headers['x-api-key'], undefined);
  assert.equal(JSON.stringify(sent.headers).split(KEY).length - 1, 1, 'key appears in the Authorization header only');
  noKey(sent.body, 'request body');
  assert.equal(sent.body.model, 'gemini-test');
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
});

test('Gemini: 道具の呼び出し（1 つの断片に全部入った形・index と id が無い形）を組み立て、finish_reason が stop でも tool_use で終える。道具の定義を送る', async t => {
  const args = '{"location":"Tokyo","unit":"celsius"}';
  let n = 0;
  const server = await fakeServer((_req, _body, res) => {
    n += 1;
    if (n === 1) return sse(res, [{ choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: args } }] }, finish_reason: 'stop' }] }]);
    return sse(res, [{ choices: [{ delta: { tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: args } }] }, finish_reason: 'stop' }] }]);
  });
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), { [ENV]: KEY });
  const tools = [{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }];
  const first = await collect(adapter.stream(request(model(), { tools })));
  assert.deepEqual(first.find(e => e.type === 'tool_call'), { type: 'tool_call', call: { id: 'call_a', name: 'get_weather', arguments: { location: 'Tokyo', unit: 'celsius' }, raw: args } });
  assert.deepEqual(first.at(-1), { type: 'done', stop: 'tool_use' });
  const second = await collect(adapter.stream(request(model(), { tools })));
  const call = second.find(e => e.type === 'tool_call') as { call: { id: string; name: string; arguments: unknown } };
  assert.match(call.call.id, /^call_[0-9a-f-]{36}$/u, 'id が無ければ作る');
  assert.deepEqual(call.call.arguments, { location: 'Tokyo', unit: 'celsius' });
  assert.deepEqual(second.at(-1), { type: 'done', stop: 'tool_use' });
  assert.deepEqual(server.requests[0]!.body.tools, [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: tools[0]!.inputSchema } }]);
});

test('Gemini: 鍵が環境に無い（空・空白だけも）なら、何も送らずに auth で止める。文に鍵の環境変数の名前だけを出す', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }]));
  t.after(() => server.close());
  for (const env of [{}, { [ENV]: '' }, { [ENV]: '   ' }]) {
    const adapter = new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), env);
    const error = await rejection(collect(adapter.stream(request(model()))));
    assert.equal(error.kind, 'auth');
    assert.equal(error.retryable, false);
    assert.equal(error.code, 'key.missing');
    assert.match(error.text('en'), new RegExp(`environment variable ${ENV}`, 'u'));
    const probe = await adapter.probe(model(), 4096, 'en');
    assert.equal(probe.status, 'no_api_key');
    await assert.rejects(listProviderModels(gemini(`${server.url}${PATH}`), env, fetch), (e: ProviderError) => e.kind === 'auth');
  }
  assert.equal(server.requests.length, 0, 'nothing is sent without a key');
});

test('Gemini: 鍵まちがい（401 でも、公式の文書にある 400 でも）は鍵を含まない 1 行で返し、相手が鍵をそのまま返しても文・値・実行ログ用の本文に鍵が出ない。試し直さない', async t => {
  const echo = `API key not valid: ${KEY}. Please pass a valid API key.`;
  let status = 401;
  const server = await fakeServer((_req, _body, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: status, message: echo, status: 'INVALID_ARGUMENT' } }));
  });
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), { [ENV]: KEY });
  for (const [code, kind, message] of [[401, 'auth', 'Authentication failed (HTTP 401)'], [403, 'auth', 'Authentication failed (HTTP 403)'], [400, 'provider_error', 'The request was rejected (HTTP 400)']] as const) {
    status = code;
    const error = await rejection(collect(adapter.stream(request(model()))));
    assert.equal(error.kind, kind, String(code));
    assert.equal(error.retryable, false, String(code));
    assert.equal(error.status, code);
    assert.equal(error.text('en'), message);
    assert.match(error.upstream ?? '', /API key not valid: \[REDACTED\]/u, 'the body for the run log has the key masked');
    noKey(errorShape(error), `error ${code}`);
    const probe = await adapter.probe(model(), 4096, 'en');
    assert.equal(probe.status, code === 400 ? 'error' : 'no_api_key');
    noKey(probe, `probe ${code}`);
    await assert.rejects(listProviderModels(gemini(`${server.url}${PATH}`), { [ENV]: KEY }, fetch), (e: ProviderError) => { noKey(errorShape(e), `list ${code}`); return e.kind === kind; });
  }
});

test('Gemini: 混みすぎ（429）は Retry-After を読んで試し直せる失敗にし、文に鍵を出さない', async t => {
  const server = await fakeServer((_req, _body, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '7' });
    res.end(JSON.stringify({ error: { code: 429, message: `Quota exceeded for key ${KEY}`, status: 'RESOURCE_EXHAUSTED' } }));
  });
  t.after(() => server.close());
  const error = await rejection(collect(new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), { [ENV]: KEY }).stream(request(model()))));
  assert.equal(error.kind, 'rate_limit');
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 7000);
  assert.equal(error.text('en'), 'The usage limit was reached (HTTP 429)');
  assert.match(error.upstream ?? '', /Quota exceeded for key \[REDACTED\]/u);
  noKey(errorShape(error), 'rate limit');
});

test('Gemini: 転送（リダイレクト）は追わない。別の送り先へ鍵を持っていかない', async t => {
  const other = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end('{}'); });
  const server = await fakeServer((_req, _body, res) => { res.writeHead(307, { Location: `${other.url}/stolen` }); res.end(); });
  t.after(() => Promise.all([server.close(), other.close()]));
  const adapter = new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), { [ENV]: KEY });
  const error = await rejection(collect(adapter.stream(request(model()))));
  noKey(errorShape(error), 'redirect error');
  await assert.rejects(listProviderModels(gemini(`${server.url}${PATH}`), { [ENV]: KEY }, fetch));
  assert.equal(server.requests.length, 2);
  assert.equal(other.requests.length, 0, 'the other server received nothing');
});

test('Gemini: 確かめ（probe）は /models に Bearer で尋ね、サーバーの種類を gemini として、生のモデルの長さは測れないので設定の長さを使う（generic の案内にしない）', async t => {
  const server = await fakeServer((_req, _body, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'models/gemini-test' }] })); });
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter(gemini(`${server.url}${PATH}`), { [ENV]: KEY });
  const declared = await adapter.probe(model(), 4096, 'en');
  assert.equal(declared.status, 'ok');
  assert.equal(declared.server, 'gemini');
  assert.equal(declared.effective, 65536);
  const { contextLength: _declared, ...undeclared } = model();
  const unknown = await adapter.probe(undeclared, 4096, 'en');
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.hint, 'Enter the length you set on the server in Settings › Models › Advanced › Context length');
  const small = await adapter.probe(model({ contextLength: 2048 }), 4096, 'en');
  assert.equal(small.status, 'too_small');
  assert.equal(small.hint, 'Choose a model whose context length is 4,096 or more', 'a hosted provider: choose another model, not "set it on the server"');
  assert.ok(server.requests.length >= 3 && server.requests.every(r => r.method === 'GET' && r.path === `${PATH}/models` && r.headers.authorization === `Bearer ${KEY}`));
  noKey([declared, unknown, small], 'probe results');
});

test('Gemini: モデルの一覧は …/models に Bearer で尋ね、models/ の頭が付いて返っても付かなくても、チャットに使う名前（頭なし）で出す。ほかの提供元の名前は変えない', async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; redirect: unknown }> = [];
  const answer = (ids: string[]) => (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    seen.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, redirect: init.redirect });
    return Response.json({ data: ids.map(id => ({ id })) });
  }) as typeof fetch;
  const official = gemini(GEMINI_URL);
  assert.deepEqual(await listProviderModels(official, { [ENV]: KEY }, answer(['models/gemini-a', 'gemini-b', 'models/gemini-b'])), { models: ['gemini-a', 'gemini-b'], truncated: false });
  assert.deepEqual(seen, [{ url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', headers: { Accept: 'application/json', Authorization: `Bearer ${KEY}` }, redirect: 'error' }]);
  assert.deepEqual(await listProviderModels(gemini(GEMINI_URL, { server: 'generic' }), { [ENV]: KEY }, answer(['models/x'])), { models: ['models/x'], truncated: false });
});

test('Gemini: 設定は server: gemini を受け、鍵を使う送り先は https だけ。送り先に鍵の問い合わせ（?key=）・認証情報は書けない', () => {
  const base = testConfig();
  const config = (provider: Record<string, unknown>) => ({ ...base, providers: [...base.providers, provider] });
  const official = { id: 'gemini', kind: 'openai_compatible', baseUrl: GEMINI_URL, apiKeyEnv: ENV, server: 'gemini', maxParallel: 2, timeoutMs: 600_000 };
  const parsed = parseConfig(config(official));
  assert.equal(parsed.providers.find(p => p.id === 'gemini')?.server, 'gemini');
  assert.throws(() => parseConfig(config({ ...official, baseUrl: 'http://generativelanguage.googleapis.com/v1beta/openai' })), /Use https/u);
  assert.throws(() => parseConfig(config({ ...official, baseUrl: `${GEMINI_URL}?key=${KEY}` })), /query/u);
  assert.throws(() => parseConfig(config({ ...official, baseUrl: `https://user:${KEY}@generativelanguage.googleapis.com/v1beta/openai` })), /credentials/u);
});

test('Gemini: 画面から入れた鍵は .env にだけ書かれ、一覧・失敗の応答・ログのどこにも全体が出ない。鍵の名前は BEAT_GEMINI_API_KEY', async t => {
  let fail = false;
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    seen.push({ url: String(input), auth: (init.headers as Record<string, string>).Authorization });
    return fail ? Response.json({ error: { message: `API key not valid: ${KEY}` } }, { status: 400 }) : Response.json({ data: [{ id: 'models/gemini-a' }] });
  }) as typeof fetch;
  const s = await startApp(t, {
    env: {}, fetch: fetchImpl, models: [model()],
    configure: c => { c.providers = [{ id: 'gemini', kind: 'openai_compatible', baseUrl: GEMINI_URL, server: 'gemini', maxParallel: 2, timeoutMs: 10_000 }]; },
  });
  const put = await s.api('/api/providers/gemini/key', { method: 'PUT', body: JSON.stringify({ key: KEY }) });
  const putText = await put.text();
  assert.equal(put.status, 200, putText);
  noKey(putText, 'PUT response');
  assert.equal(s.app.config().providers[0]!.apiKeyEnv, ENV);
  assert.match(readFileSync(s.paths.env, 'utf8'), new RegExp(`^${ENV}=`, 'mu'));
  assert.equal(readFileSync(s.paths.config, 'utf8').includes(KEY), false, 'the settings file has the variable name only');

  const listed = await s.api('/api/providers/gemini/models');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { models: ['gemini-a'], truncated: false });
  assert.deepEqual(seen.at(-1), { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', auth: `Bearer ${KEY}` });

  fail = true;
  const failed = await s.api('/api/providers/gemini/models');
  const failedText = await failed.text();
  assert.equal(failed.status, 502);
  noKey(failedText, 'failure response');
  assert.match(failedText, /The request was rejected \(HTTP 400\)/u);
  const state = await (await s.api('/api/providers/gemini/key')).text();
  noKey(state, 'GET key state');
  assert.equal(s.logs.join('\n').includes(KEY), false);
  assert.ok(s.app.registry.secrets().includes(KEY), 'the registry knows the key for masking');
});

test('Gemini: 提供元の一覧に入ると、鍵は伏せる対象（secrets）と承認の札で印に替える対象（held）に入る', () => {
  const registry = new ProviderRegistry({ env: { [ENV]: KEY } });
  registry.reload({ ...testConfig(), providers: [gemini(GEMINI_URL)] });
  assert.deepEqual(registry.secrets(), [KEY]);
  assert.deepEqual(registry.held(), [{ source: `env ${ENV}`, value: KEY }]);
  assert.ok(registry.get('gemini') instanceof OpenAiCompatibleAdapter);
});

test('Gemini: 会話の実行が鍵まちがいで失敗しても、実行の記録・出来事・ログ・DB のどの行にも鍵が残らない', async t => {
  const echo = `API key not valid: ${KEY}. Please pass a valid API key.`;
  const server = await fakeServer((req, _body, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'gemini-test' }] })); return; }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 401, message: echo } }));
  });
  t.after(() => server.close());
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'SOUL.md'), 'soul');
  const config: AppConfig = parseConfig({
    ...testConfig(), providers: [gemini(`${server.url}${PATH}`)], models: [model()], routing: { chat: ['g'], background: [], retriesPerModel: 0 },
  });
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const runs = new Runs(db);
  const kv = new KV(db);
  const registry = new ProviderRegistry({ env: { [ENV]: KEY } });
  registry.reload(config);
  const status = new ModelStatus({ registry, kv, baseTokens: () => 500 });
  await status.probeAll(config);
  const bus = new RunBus();
  const events: RunEvent[] = [];
  bus.subscribe(e => events.push(e.event));
  const logs: string[] = [];
  const engine = new ChatEngine({ config: () => config, conversations: new Conversations(db), runs, kv, registry, status, bus, limiter: new EndpointLimiter(), paths, log: line => { logs.push(line); }, sleep: async () => undefined });
  t.after(() => engine.stopAll());
  const sent = engine.send('c1', 'hello');
  assert.ok(sent.ok, JSON.stringify(sent));
  const result = await engine.wait(sent.runId)!;
  assert.equal(result.ok, false);
  const row = runs.get(sent.runId)!;
  assert.equal(row.error_kind, 'auth');
  assert.match(row.error_message ?? '', /Authentication failed \(HTTP 401\): API key not valid: \[REDACTED\]/u, 'the log keeps what the provider said, with the key masked');
  noKey(result, 'result');
  noKey(events, 'events');
  noKey(logs, 'logs');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name);
  assert.ok(tables.length > 5);
  for (const name of tables) noKey(db.prepare(`SELECT * FROM "${name}"`).all(), `table ${name}`);
  const request = server.requests.find(r => r.method === 'POST')!;
  assert.equal(request.headers.authorization, `Bearer ${KEY}`, 'the real adapter did send the key, in the header');
});
