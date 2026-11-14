import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dropLegacy, LEGACY_KEYS } from '../src/config/legacy.ts';
import { ConfigError, ConfigStore, defaultConfig, parseConfig } from '../src/config/store.ts';
import type { AddressInfo } from 'node:net';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { createWebServer } from '../src/web/server.ts';
import { CONVERSATION, settled, startApp } from './app-setup.ts';
import { fakeServer, sse, tempDir, testConfig } from './helpers.ts';

function withToolMode(toolMode: string) {
  const config = testConfig() as unknown as { models: Array<Record<string, unknown>> };
  for (const model of config.models) model.toolMode = toolMode;
  return config;
}

function withProtectRow<T extends Record<string, any>>(raw: T): T {
  raw.tools.hooks = { preToolUse: [DEFAULT_PROTECT_FILES], postToolUse: [] };
  return raw;
}

function ownerShapedConfig() {
  const config = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  config.language = 'ja';
  config.providers.push({ id: 'custom-local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:8081/v1', maxParallel: 1, timeoutMs: 600000 });
  config.models = [{ id: 'qwen-local', provider: 'custom-local', model: 'qwen', contextLength: 65536, minContext: 8192, maxOutputTokens: 4096, toolMode: 'native', vision: false }];
  config.routing = { chat: ['qwen-local'], background: ['qwen-local'], retriesPerModel: 2 };
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.worker.autonomy = true;
  config.server.port = 4777;
  return config;
}

test('古い鍵の一覧: この段では models[].toolMode・language・tools.maxIterations・tools.web.searxngUrl・tools.shell.approvalTimeoutSec・tools.taintEscalation・mcp.servers[].localOk', () => {
  assert.deepEqual(LEGACY_KEYS.map(key => key.path), ['models[].toolMode', 'language', 'tools.maxIterations', 'tools.web.searxngUrl', 'tools.shell.approvalTimeoutSec', 'tools.taintEscalation', 'mcp.servers[].localOk']);
});

test('mcp.servers[].localOk の古い設定が読め、読んだ設定に残らず、入力は書き換えない', () => {
  const raw = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  raw.mcp = { servers: [{ id: 'a', transport: 'stdio', command: ['node', 'a.mjs'], localOk: true }, { id: 'b', transport: 'stdio', command: ['node', 'b.mjs'] }] };
  const config = parseConfig(raw);
  assert.deepEqual(config.mcp.servers.map(server => [server.id, 'localOk' in server]), [['a', false], ['b', false]]);
  assert.deepEqual(dropLegacy(raw).dropped, ['mcp.servers[].localOk']);
  assert.equal(raw.mcp.servers[0].localOk, true);
});

test('tools.taintEscalation: false の古い設定が読め、読んだ設定に残らず、起動のログの Ignored の 1 行に入る', t => {
  const raw = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  raw.tools.taintEscalation = false;
  const config = parseConfig(raw);
  assert.equal('taintEscalation' in config.tools, false);
  assert.deepEqual(dropLegacy(raw).dropped, ['tools.taintEscalation']);

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(raw), null, 2)}
`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), ['[INFO] Ignored settings that are no longer used: tools.taintEscalation']);
  assert.deepEqual(readFileSync(paths.config), before);
});

test('tools.shell.approvalTimeoutSec: 30 の古い設定が読め、読んだ設定に残らず、起動のログの Ignored の 1 行に入る', t => {
  const raw = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  raw.tools.shell = { ...(raw.tools.shell ?? {}), approvalTimeoutSec: 30 };
  const config = parseConfig(raw);
  assert.equal('approvalTimeoutSec' in config.tools.shell, false);
  assert.deepEqual(dropLegacy(raw).dropped, ['tools.shell.approvalTimeoutSec']);

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(raw), null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), ['[INFO] Ignored settings that are no longer used: tools.shell.approvalTimeoutSec']);
  assert.deepEqual(readFileSync(paths.config), before);
});

test('tools.maxIterations（16 でも 0 でも）の設定が parseConfig で読め、dropped に入り、読んだ設定に残らない', () => {
  for (const value of [16, 0]) {
    const raw = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
    raw.tools.maxIterations = value;
    const config = parseConfig(raw);
    assert.equal('maxIterations' in config.tools, false, String(value));
    assert.deepEqual(dropLegacy(raw).dropped, ['tools.maxIterations'], String(value));
  }
});

test('ConfigStore: tools.maxIterations 入りのファイルを読むと dropped に入り、ファイルのバイトは変わらない', t => {
  const path = join(tempDir(t), 'config.json');
  const raw = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  raw.tools.maxIterations = 0;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
  const before = readFileSync(path);
  const store = new ConfigStore(path);
  const config = store.load();
  assert.equal('maxIterations' in config.tools, false);
  assert.deepEqual(store.dropped, ['tools.maxIterations']);
  assert.deepEqual(readFileSync(path), before);
});

test('持ち主の形に tools.maxIterations: 0 を足した設定が読め、起動のログの Ignored の 1 行に tools.maxIterations が入り、ファイルは書き換えない', t => {
  const raw = ownerShapedConfig();
  raw.tools.maxIterations = 0;
  assert.equal(parseConfig(raw).models[0]!.id, 'qwen-local');
  assert.deepEqual(dropLegacy(raw).dropped, ['models[].toolMode', 'language', 'tools.maxIterations']);

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(raw), null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), ['[INFO] Ignored settings that are no longer used: models[].toolMode, language, tools.maxIterations']);
  assert.deepEqual(readFileSync(paths.config), before);
});

test('toolMode: "json_fallback" の設定も parseConfig で読め、モデルに toolMode が残らない。dropped は 1 回だけ', () => {
  const raw = withToolMode('json_fallback');
  assert.equal(raw.models.length > 1, true, 'モデルが 2 つ以上でも dropped は 1 回');
  const config = parseConfig(raw);
  for (const model of config.models) assert.equal('toolMode' in model, false);
  assert.deepEqual(dropLegacy(raw).dropped, ['models[].toolMode']);
});

test('dropLegacy は入力を書き換えない。古い鍵の無いもの・オブジェクトでないものはそのまま返す', () => {
  const raw = withToolMode('native');
  const before = JSON.stringify(raw);
  const result = dropLegacy(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.notEqual(result.config, raw);
  assert.equal((result.config as { models: Array<Record<string, unknown>> }).models.some(m => 'toolMode' in m), false);

  const clean = testConfig();
  assert.deepEqual(dropLegacy(clean), { config: clean, dropped: [], rewritten: [] });
  for (const value of [null, 1, 'x', [{ models: [{ toolMode: 'native' }] }]]) assert.deepEqual(dropLegacy(value), { config: value, dropped: [], rewritten: [] });
  assert.deepEqual(dropLegacy({ models: 'not a list' }).dropped, []);
});

test('知らない鍵は今までどおり ConfigError', () => {
  const raw = withToolMode('native');
  raw.models[0]!.foo = 1;
  assert.throws(() => parseConfig(raw), (e: unknown) => e instanceof ConfigError && e.problems.some(p => p.includes('/models/0')));
});

test('ConfigStore: toolMode 入りのファイルを読むと dropped に入り、ファイルのバイトは変わらない', t => {
  const path = join(tempDir(t), 'config.json');
  writeFileSync(path, `${JSON.stringify(withToolMode('json_fallback'), null, 2)}\n`);
  const before = readFileSync(path);
  const store = new ConfigStore(path);
  const config = store.load();
  assert.equal(config.models.some(m => 'toolMode' in m), false);
  assert.deepEqual(store.dropped, ['models[].toolMode']);
  assert.deepEqual(readFileSync(path), before);
  store.current();
  assert.deepEqual(readFileSync(path), before, 'もう一度読んでも書かない');
});

test('ConfigStore: 保存すると toolMode の無い形で書き、dropped は空になる', t => {
  const path = join(tempDir(t), 'config.json');
  writeFileSync(path, JSON.stringify(withToolMode('native')));
  const store = new ConfigStore(path);
  const config = store.load();
  assert.deepEqual(store.dropped, ['models[].toolMode']);
  store.save(config);
  assert.deepEqual(store.dropped, []);
  assert.equal(readFileSync(path, 'utf8').includes('toolMode'), false);
});

test('画面からの保存: PUT /api/settings に toolMode 入りの設定 → 200 で、保存したファイルに toolMode が無い', async t => {
  const s = await startApp(t);
  const current = await s.json('/api/settings', 'GET');
  assert.equal(current.status, 200);
  const config = structuredClone(current.body.config) as { models: Array<Record<string, unknown>> };
  for (const model of config.models) model.toolMode = 'native';
  const res = await s.json('/api/settings', 'PUT', { config });
  assert.equal(res.status, 200);
  const saved = JSON.parse(readFileSync(s.paths.config, 'utf8')) as { models: Array<Record<string, unknown>> };
  assert.equal(saved.models.length, config.models.length);
  assert.equal(saved.models.some(m => 'toolMode' in m), false);
});

test('持ち主の設定と同じ形（language: "ja"、toolMode: "native"、秘密の欄は空）が読め、起動のログに 1 行出し、ファイルは書き換えない', t => {
  const raw = ownerShapedConfig();
  const config = parseConfig(raw);
  assert.equal(config.models[0]!.id, 'qwen-local');
  assert.equal('toolMode' in config.models[0]!, false);
  assert.equal('language' in config, false);

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(raw), null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), ['[INFO] Ignored settings that are no longer used: models[].toolMode, language']);
  assert.deepEqual(readFileSync(paths.config), before);
});

test('起動のログ: 保存で古い鍵が消えたあと、手で toolMode を書き戻すと、再読み込みでもう一度 1 行出す', async t => {
  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(withToolMode('native')));
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  const ignored = () => logs.filter(line => line.includes('no longer used'));
  assert.equal(ignored().length, 1, '起動で 1 行');

  await app.applyConfig(app.config(), { probe: false });
  app.config();
  assert.equal(readFileSync(paths.config, 'utf8').includes('toolMode'), false);
  assert.equal(ignored().length, 1, '保存しただけでは出さない');

  writeFileSync(paths.config, `${JSON.stringify(withToolMode('json_fallback'), null, 2)}\n`);
  app.config();
  app.config();
  assert.deepEqual(ignored(), ['[INFO] Ignored settings that are no longer used: models[].toolMode', '[INFO] Ignored settings that are no longer used: models[].toolMode']);
});

function withOldOllama(baseUrl?: string, id = 'ollama') {
  const config = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  config.providers.push({ id, kind: 'ollama', ...(baseUrl === undefined ? {} : { baseUrl }), maxParallel: 3, timeoutMs: 120_000 });
  config.models.push({ id: 'old-local', provider: id, model: 'qwen3:8b', contextLength: 32768, minContext: 4096, maxOutputTokens: 2048, vision: false });
  return config;
}

test('古い kind: "ollama" は openai_compatible に読み替え、baseUrl に /v1 を足し、server は generic。ほかの項目は変わらない', () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, 'http://127.0.0.1:11434/v1'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434/v1'],
    ['http://192.168.1.20:11434', 'http://192.168.1.20:11434/v1'],
    ['http://x:11434/v1', 'http://x:11434/v1'],
    ['  http://127.0.0.1:11434//  ', 'http://127.0.0.1:11434/v1'],
  ];
  for (const [baseUrl, expected] of cases) {
    const raw = withOldOllama(baseUrl);
    const result = dropLegacy(raw);
    const provider = (result.config as { providers: Array<Record<string, unknown>> }).providers.find(p => p.id === 'ollama');
    assert.deepEqual(provider, { id: 'ollama', kind: 'openai_compatible', baseUrl: expected, maxParallel: 3, timeoutMs: 120_000, server: 'generic' }, String(baseUrl));
    assert.deepEqual(result.rewritten, [`providers.ollama.kind "ollama" → "openai_compatible" (${expected})`], String(baseUrl));
    assert.deepEqual(result.dropped, [], String(baseUrl));
    const config = parseConfig(raw);
    assert.equal(config.providers.find(p => p.id === 'ollama')!.kind, 'openai_compatible', String(baseUrl));
    assert.equal(config.models.find(m => m.id === 'old-local')!.provider, 'ollama', String(baseUrl));
  }
});

test('古い kind: "ollama" に server・apiKeyEnv が書いてあれば、そのまま残す', () => {
  const raw = withOldOllama('http://127.0.0.1:11434');
  raw.providers.at(-1).server = 'lmstudio';
  raw.providers.at(-1).apiKeyEnv = 'OLLAMA_KEY';
  const provider = (dropLegacy(raw).config as { providers: Array<Record<string, unknown>> }).providers.find(p => p.id === 'ollama');
  assert.deepEqual(provider, { id: 'ollama', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', server: 'lmstudio', apiKeyEnv: 'OLLAMA_KEY', maxParallel: 3, timeoutMs: 120_000 });
  assert.equal(parseConfig(raw).providers.find(p => p.id === 'ollama')!.apiKeyEnv, 'OLLAMA_KEY');
});

test('Ollama の読み替え: 入力を変えない。同じ入力を 2 回通しても同じ。読み替えたあとの形をもう一度通すと何も変わらない', () => {
  const raw = withOldOllama();
  const before = JSON.stringify(raw);
  const first = dropLegacy(raw);
  const second = dropLegacy(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(first, second);
  const again = dropLegacy(first.config);
  assert.deepEqual(again.rewritten, []);
  assert.equal(again.config, first.config);
});

test('ConfigStore: 古い Ollama の設定のファイルを読むと rewritten に入り、ファイルのバイトは変わらない。保存すると新しい形で書き、rewritten は空', t => {
  const path = join(tempDir(t), 'config.json');
  writeFileSync(path, `${JSON.stringify(withOldOllama(), null, 2)}\n`);
  const before = readFileSync(path);
  const store = new ConfigStore(path);
  const config = store.load();
  assert.equal(config.providers.find(p => p.id === 'ollama')!.kind, 'openai_compatible');
  assert.deepEqual(store.rewritten, ['providers.ollama.kind "ollama" → "openai_compatible" (http://127.0.0.1:11434/v1)']);
  assert.deepEqual(store.dropped, []);
  store.current();
  assert.deepEqual(readFileSync(path), before);
  store.save(config);
  assert.deepEqual(store.rewritten, []);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { providers: Array<Record<string, unknown>> };
  assert.deepEqual(saved.providers.find(p => p.id === 'ollama'), { id: 'ollama', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', maxParallel: 3, timeoutMs: 120_000, server: 'generic' });
});

test('起動のログ: 古い Ollama の設定は「Read old settings in their new form」を 1 行だけ出し、2 回目の config() では出さない', t => {
  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(withOldOllama('http://127.0.0.1:11434/')), null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('new form')), ['[INFO] Read old settings in their new form: providers.ollama.kind "ollama" → "openai_compatible" (http://127.0.0.1:11434/v1)']);
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), []);
  assert.deepEqual(readFileSync(paths.config), before);
});

test('読み替えたあとの接続先: baseUrl の無い古い Ollama はこの PC、LAN の古い Ollama は書いてあった宛先', () => {
  const local = parseConfig(withOldOllama()).providers.find(p => p.id === 'ollama')!;
  const lan = parseConfig(withOldOllama('http://192.168.1.20:11434')).providers.find(p => p.id === 'ollama')!;
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(lan.baseUrl, 'http://192.168.1.20:11434/v1');
});

test('古い Ollama の提供元のモデルで会話を送ると、OpenAI 互換の POST /v1/chat/completions が届き、返事が保存される', async t => {
  const server = await fakeServer((req, _body, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') return sse(res, [{ choices: [{ delta: { content: 'こんにちは' }, finish_reason: 'stop' }] }]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));
  });
  t.after(() => server.close());
  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  const raw = withOldOllama(server.url);
  raw.providers = raw.providers.filter((p: { id: string }) => p.id === 'ollama');
  raw.models = raw.models.filter((m: { id: string }) => m.id === 'old-local');
  raw.routing = { chat: ['old-local'], background: [], retriesPerModel: 0 };
  writeFileSync(paths.config, JSON.stringify(raw));
  const app = new App({ paths, databasePath: ':memory:', log: () => {}, workerTimers: false, env: {} });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  const res = await fetch(`${origin}/api/conversations/${CONVERSATION}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ text: 'やあ' }) });
  assert.equal(res.status, 202);
  await settled(app, ((await res.json()) as { runId: string }).runId);
  const posts = server.requests.filter(r => r.method === 'POST');
  assert.deepEqual(posts.map(r => r.path), ['/v1/chat/completions']);
  assert.equal(posts[0]!.body.model, 'qwen3:8b');
  const last = app.conversations.messages(CONVERSATION).at(-1)!.message;
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, 'こんにちは');
});

test('画面からの保存: PUT /api/settings に kind: "ollama" の設定 → 200 で、保存したファイルの種類は openai_compatible', async t => {
  const s = await startApp(t);
  const current = await s.json('/api/settings', 'GET');
  const config = structuredClone(current.body.config) as Record<string, any>;
  config.providers.push({ id: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', maxParallel: 1, timeoutMs: 600000 });
  const res = await s.json('/api/settings', 'PUT', { config });
  assert.equal(res.status, 200);
  const saved = JSON.parse(readFileSync(s.paths.config, 'utf8')) as { providers: Array<Record<string, unknown>> };
  assert.deepEqual(saved.providers.find(p => p.id === 'ollama'), { id: 'ollama', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:11434/v1', maxParallel: 1, timeoutMs: 600000, server: 'generic' });
});

const OWNER_WEB = { fetch: true, search: 'searxng', searxngUrl: 'http://127.0.0.1:8888', region: 'jp-jp', maxSearchesPerHour: 30 };

function withSearxng(web: Record<string, unknown> = { search: 'searxng', searxngUrl: 'http://127.0.0.1:8888' }) {
  const config = JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;
  Object.assign(config.tools.web, web);
  return config;
}

test('古い tools.web.search: "searxng" は duckduckgo に読み替え、searxngUrl は落とす。dropped と rewritten にそれぞれ 1 つ', () => {
  const raw = withSearxng();
  const result = dropLegacy(raw);
  const web = (result.config as { tools: { web: Record<string, unknown> } }).tools.web;
  assert.equal(web.search, 'duckduckgo');
  assert.equal('searxngUrl' in web, false);
  assert.deepEqual(result.dropped, ['tools.web.searxngUrl']);
  assert.deepEqual(result.rewritten, ['tools.web.search "searxng" → "duckduckgo"']);
  const config = parseConfig(raw);
  assert.equal(config.tools.web.search, 'duckduckgo');
  assert.equal('searxngUrl' in config.tools.web, false);
});

test('searxngUrl だけ（search は duckduckgo / off）は落とすだけで、search は読み替えない', () => {
  for (const search of ['duckduckgo', 'off']) {
    const raw = withSearxng({ search, searxngUrl: 'http://127.0.0.1:8888' });
    const result = dropLegacy(raw);
    assert.deepEqual(result.dropped, ['tools.web.searxngUrl'], search);
    assert.deepEqual(result.rewritten, [], search);
    assert.equal(parseConfig(raw).tools.web.search, search, search);
  }
  const off = withSearxng({ search: 'off' });
  assert.deepEqual(dropLegacy(off), { config: off, dropped: [], rewritten: [] });
  assert.equal(parseConfig(off).tools.web.search, 'off');
});

test('SearXNG の読み替え: 入力を変えない。同じ入力を 2 回通しても同じ。読み替えたあとの形をもう一度通すと何も変わらない', () => {
  const raw = withSearxng();
  const before = JSON.stringify(raw);
  const first = dropLegacy(raw);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(first, dropLegacy(raw));
  const again = dropLegacy(first.config);
  assert.deepEqual([again.dropped, again.rewritten], [[], []]);
  assert.equal(again.config, first.config);
});

test('ConfigStore: SearXNG の設定のファイルを読むとファイルのバイトは変わらない。保存すると新しい形で書き、dropped と rewritten は空', t => {
  const path = join(tempDir(t), 'config.json');
  writeFileSync(path, `${JSON.stringify(withSearxng(), null, 2)}\n`);
  const before = readFileSync(path);
  const store = new ConfigStore(path);
  const config = store.load();
  assert.equal(config.tools.web.search, 'duckduckgo');
  assert.deepEqual(store.dropped, ['tools.web.searxngUrl']);
  assert.deepEqual(store.rewritten, ['tools.web.search "searxng" → "duckduckgo"']);
  store.current();
  assert.deepEqual(readFileSync(path), before);
  store.save(config);
  assert.deepEqual([store.dropped, store.rewritten], [[], []]);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as { tools: { web: Record<string, unknown> } };
  assert.equal(saved.tools.web.search, 'duckduckgo');
  assert.equal('searxngUrl' in saved.tools.web, false);
});

test('持ち主の形（tools.maxIterations: 0 と SearXNG の tools.web）が読め、region は jp-jp のまま。起動のログは決まった 2 行で、ファイルは書き換えない', t => {
  const raw = ownerShapedConfig();
  raw.tools.maxIterations = 0;
  raw.tools.web = { ...OWNER_WEB };
  const config = parseConfig(raw);
  assert.deepEqual(config.tools.web, { fetch: true, search: 'duckduckgo', region: 'jp-jp', maxSearchesPerHour: 30 });

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(withProtectRow(raw), null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  app.config();
  assert.deepEqual(logs.filter(line => /no longer used|new form/u.test(line)), [
    '[INFO] Ignored settings that are no longer used: models[].toolMode, language, tools.maxIterations, tools.web.searxngUrl',
    '[INFO] Read old settings in their new form: tools.web.search "searxng" → "duckduckgo"',
  ]);
  assert.deepEqual(readFileSync(paths.config), before);
});
