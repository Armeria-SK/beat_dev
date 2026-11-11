import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { dropLegacy, LEGACY_KEYS } from '../src/config/legacy.ts';
import { ConfigError, ConfigStore, defaultConfig, parseConfig } from '../src/config/store.ts';
import { App } from '../src/app.ts';
import { resolvePaths } from '../src/paths.ts';
import { startApp } from './app-setup.ts';
import { tempDir, testConfig } from './helpers.ts';

function withToolMode(toolMode: string) {
  const config = testConfig() as unknown as { models: Array<Record<string, unknown>> };
  for (const model of config.models) model.toolMode = toolMode;
  return config;
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

test('古い鍵の一覧: この段では models[].toolMode だけ', () => {
  assert.deepEqual(LEGACY_KEYS.map(key => key.path), ['models[].toolMode']);
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
  assert.deepEqual(dropLegacy(clean), { config: clean, dropped: [] });
  for (const value of [null, 1, 'x', [{ models: [{ toolMode: 'native' }] }]]) assert.deepEqual(dropLegacy(value), { config: value, dropped: [] });
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
  assert.equal(config.language, 'ja');

  const dir = tempDir(t);
  const paths = { ...resolvePaths(dir), env: join(dir, '.env') };
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, `${JSON.stringify(raw, null, 2)}\n`);
  const before = readFileSync(paths.config);
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, env: {} });
  t.after(() => app.close());
  app.config();
  app.config();
  assert.deepEqual(logs.filter(line => line.includes('no longer used')), ['[INFO] Ignored settings that are no longer used: models[].toolMode']);
  assert.deepEqual(readFileSync(paths.config), before);
});
