import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { buildDynamic } from '../src/engine/workspace.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, reply, tempDir, testConfig } from './helpers.ts';

const LATER = /cannot save to it in plan mode[\s\S]*memory review that runs after this conversation/u;
const OFF = /cannot save to it in plan mode, and memory review is turned off/u;

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const dir = tempDir(t);
  const paths = resolvePaths(join(dir, 'data'));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'm', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const root = join(dir, 'product');
  mkdirSync(root);
  const real = realpathSync.native(root);
  const project = app.projects.create({ name: 'Demo', root: real, rootKey: rootKeyOf(real), checkCommand: null });
  // 1 回送って、モデルに渡った毎回の system を返す
  const dynamicOf = async (id: string, mode: 'auto' | 'plan', projectId?: string) => {
    adapter.scripts.push(reply('ok'));
    const outcome = app.engine.send(id, 'please remember that we deploy on Fridays', [], [], { permissionMode: mode }, projectId ? { projectId } : {});
    assert.ok(outcome.ok, JSON.stringify(outcome));
    await app.engine.wait(outcome.runId);
    return adapter.calls.at(-1)!.system.dynamic;
  };
  return { app, project, dynamicOf };
}

test('plan-mode memory line: a product chat in plan mode is told it cannot save now and that the review after the conversation picks the request up', async t => {
  const s = await setup(t);
  const dynamic = await s.dynamicOf('p1', 'plan', s.project.id);
  assert.match(dynamic, LATER, dynamic);
  assert.match(dynamic, /Do not say it is saved already/u);
  assert.match(dynamic, /AGENTS\.md or CLAUDE\.md/u, 'it is told not to push AGENTS.md / CLAUDE.md for this');
});

test('plan-mode memory line: not in auto mode, not outside a product, not in a non-product plan-mode chat', async t => {
  const s = await setup(t);
  assert.doesNotMatch(await s.dynamicOf('p2', 'auto', s.project.id), /memory review|cannot save to it/u);
  const outside = await s.dynamicOf('n1', 'plan');
  assert.doesNotMatch(outside, /memory review|cannot save to it|product/iu, outside);
});

test('plan-mode memory line: with memory review off, the model does not promise a later save', async t => {
  const s = await setup(t, c => { c.memory.review = false; });
  const dynamic = await s.dynamicOf('p3', 'plan', s.project.id);
  assert.match(dynamic, OFF, dynamic);
  assert.doesNotMatch(dynamic, LATER);
});

test('plan-mode memory line: buildDynamic adds it only with a product in plan mode, before the plan instruction, and leaves other output unchanged', () => {
  const at = new Date('2026-11-12T00:00:00Z');
  const product = { name: 'Shop', root: 'C:/shop' };
  const plan = buildDynamic('UTC', 'en', at, 'plan', { ...product, memory: 'review' }, 'Write the plan with plan_write.');
  assert.match(plan, LATER);
  assert.ok(plan.endsWith('\nWrite the plan with plan_write.'), plan);
  assert.match(buildDynamic('UTC', 'en', at, 'plan', { ...product, memory: 'off' }), OFF);
  assert.equal(buildDynamic('UTC', 'en', at, 'auto', { ...product, memory: 'review' }), buildDynamic('UTC', 'en', at, 'auto', product));
  assert.equal(buildDynamic('UTC', 'en', at, 'plan', product), buildDynamic('UTC', 'en', at, 'plan', { ...product, memory: undefined }));
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'plan', product), /cannot save to it/u, 'without the memory flag (e.g. a child run) nothing is added');
});
