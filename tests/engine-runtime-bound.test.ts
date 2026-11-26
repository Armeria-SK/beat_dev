import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { RunBus } from '../src/engine/bus.ts';
import { ChatEngine } from '../src/engine/chat.ts';
import { ModelStatus } from '../src/engine/status.ts';
import { resolvePaths } from '../src/paths.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { FakeAdapter, reply, tempDir, testConfig } from './helpers.ts';

// 実行役の窓口（runtimes）を持たない形でエンジンを組んでも、実行役に結ばれた会話は提供元のモデルへ移らない

async function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config: AppConfig = parseConfig({
    ...testConfig(),
    providers: [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }],
    models: [{ id: 'a', provider: 'fake', model: 'a', contextLength: 65536, maxOutputTokens: 1024, vision: false }],
    routing: { chat: ['a'], background: [] },
  });
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const kv = new KV(db);
  const adapter = new FakeAdapter(config.providers[0]!, [reply('provider answer')]);
  const registry = new ProviderRegistry({ override: () => adapter });
  registry.reload(config);
  const status = new ModelStatus({ registry, kv, baseTokens: () => 500 });
  await status.probeAll(config);
  const engine = new ChatEngine({ config: () => config, conversations, runs: new Runs(db), kv, registry, status, bus: new RunBus(), limiter: new EndpointLimiter(), paths, sleep: async () => undefined });
  return { engine, conversations, adapter };
}

test('実行役に結ばれた会話は、実行役の窓口が無いエンジンでも、提供元のモデルで返事をされない（断って、何も保存しない）', async t => {
  const s = await setup(t);
  s.conversations.ensure('bound', {});
  assert.equal(s.conversations.bindRuntime('bound', 'claude-code'), true);
  const outcome = s.engine.send('bound', 'hello');
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.deepEqual({ status: outcome.httpStatus, code: outcome.errorCode }, { status: 409, code: 'engine.runtime.unavailable' });
  assert.equal(s.adapter.calls.length, 0, 'no provider model was called');
  assert.equal(s.conversations.messages('bound', 5).length, 0, 'nothing was saved');

  // 結ばれていない会話は、これまでどおり提供元のモデルで返事をされる
  const plain = s.engine.send('plain', 'hello');
  assert.ok(plain.ok, JSON.stringify(plain));
  await s.engine.wait(plain.runId);
  assert.equal(s.adapter.calls.length, 1);
});
