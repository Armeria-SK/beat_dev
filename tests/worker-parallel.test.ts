import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { FakeAdapter, tempDir, type Script, testConfig } from './helpers.ts';

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// 返事を止めておき、release() で task_complete を返して終わらせる偽の提供元の台本
function gated(): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const script: Script = async function* (req) {
    yield { type: 'text', delta: '調べています…' };
    await new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      void gate.then(resolve);
    });
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name: 'task_complete', arguments: { summary: '終わりました', notify: false } };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  return { script, release };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '調べています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

async function setup(t: { after: (fn: () => void) => void }, options: { workerMax: number; providerMax: number; timers?: boolean; edit?: (c: AppConfig) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: options.providerMax, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, toolMode: 'native', vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.worker.maxParallel = options.workerMax;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: options.timers ?? false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => { app.worker.stop(); app.engine.stopAll(); });
  t.after(() => app.close());
  const userTask = (title: string) => app.tasks.create({ title, origin: 'user', actor: 'user' });
  return { app, adapter: () => adapter, clock, userTask };
}

test('worker.maxParallel が 2 なら、2 件のタスクが同時に動く', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2 });
  const a = s.userTask('A');
  const b = s.userTask('B');
  const g1 = gated();
  const g2 = gated();
  s.adapter().scripts.push(g1.script, g2.script);
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が同時に始まる');
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  assert.equal(s.app.tasks.get(b.id)!.status, 'running');
  const status = s.app.worker.status();
  assert.equal(status.runningAll.length, 2);
  assert.equal(status.running?.runId, status.runningAll[0]!.runId, '先頭は今までの running と同じ');
  g1.release(); g2.release();
  assert.deepEqual(await Promise.all([t1, t2]), ['ran', 'ran']);
  assert.equal(s.app.tasks.get(a.id)!.status, 'done');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
  assert.equal(s.app.worker.status().runningAll.length, 0);
});

test('提供元の maxParallel が 1 なら、ワーカーの枠が空いていても 2 件目を始めない', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1 });
  s.userTask('A');
  const b = s.userTask('B');
  const g1 = gated();
  s.adapter().scripts.push(g1.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  assert.equal(await s.app.worker.tick(), 'busy', '提供元が満杯なので 2 件目は選ばない');
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready', '選ばれなかったタスクは実行待ちのまま（claim しない）');
  g1.release();
  assert.equal(await t1, 'ran');
  assert.equal(await s.app.worker.tick(), 'ran', '空けば 2 件目が動く');
});

test('既定の 1 では、動いている最中の 2 回目の tick は busy（今までと同じ）', async t => {
  const s = await setup(t, { workerMax: 1, providerMax: 2 });
  s.userTask('A');
  s.userTask('B');
  const g1 = gated();
  s.adapter().scripts.push(g1.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  assert.equal(await s.app.worker.tick(), 'busy');
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.app.worker.status().runningAll.length, 1);
  g1.release();
  assert.equal(await t1, 'ran');
});

test('自動で動くとき、枠が残っていれば続けて始め、1 件終わると空いた枠で次が始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2, timers: true });
  s.userTask('A'); s.userTask('B'); s.userTask('C');
  const g = [gated(), gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  s.app.worker.start();
  await waitFor(() => s.adapter().calls.length === 2, '手で tick しなくても 2 件が始まる');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.adapter().calls.length, 2, '枠は 2 つまで');
  g[0]!.release();
  await waitFor(() => s.adapter().calls.length === 3, '終わった枠に 3 件目が入る');
  g[1]!.release(); g[2]!.release();
  await waitFor(() => s.app.tasks.list().every(x => x.status === 'done'), '全部終わる');
});

test('提供元が満杯でも、自動で動くなら、1 件終わった合図で待っていた 2 件目が始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1, timers: true });
  s.userTask('A');
  const b = s.userTask('B');
  const g = [gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  s.app.worker.start();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.adapter().calls.length, 1, '提供元が満杯なので 2 件目は待つ');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  g[0]!.release();
  await waitFor(() => s.adapter().calls.length === 2, '終わった合図で 2 件目が始まる', 6000);
  g[1]!.release();
  await waitFor(() => s.app.tasks.list().every(x => x.status === 'done'), '全部終わる');
});

test('「今すぐ実行」は、提供元が満杯のあいだ待ち、空いたら始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1 });
  s.userTask('A');
  const b = s.userTask('B');
  const g = [gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  s.app.worker.requestRun(b.id);
  assert.equal(await s.app.worker.tick(), 'busy', '満杯のあいだは始めない');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  g[0]!.release();
  assert.equal(await t1, 'ran');
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '空いたら始まる');
  g[1]!.release();
  assert.equal(await t2, 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
});

test('stopTask は、止めると言われたタスクの実行だけを止める', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2 });
  const a = s.userTask('A');
  const b = s.userTask('B');
  s.adapter().scripts.push(hang(), hang());
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が動く');
  assert.equal(s.app.worker.stopTask(b.id), true);
  await waitFor(() => s.app.worker.status().runningAll.length === 1, '止めた方だけ抜ける');
  assert.equal(s.app.worker.status().runningAll[0]!.taskId, a.id);
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  assert.equal(s.app.worker.stopTask(b.id), false, '止め終えたものは、もう動いていない');
  assert.equal(s.app.worker.stopTask(a.id), true);
  await Promise.all([t1, t2]);
});

test('1 時間の上限は、並列で動いている分も合計で数える', async t => {
  const s = await setup(t, { workerMax: 3, providerMax: 3, edit: c => { c.worker.maxRunsPerHour = 2; } });
  s.userTask('A'); s.userTask('B'); const c = s.userTask('C');
  const g1 = gated(); const g2 = gated();
  s.adapter().scripts.push(g1.script, g2.script);
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が動く');
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.equal(s.app.tasks.get(c.id)!.status, 'ready');
  g1.release(); g2.release();
  await Promise.all([t1, t2]);
});

test('worker.maxParallel は 1〜4 だけ受け付ける', async t => {
  for (const bad of [0, 5]) {
    await assert.rejects(() => setup(t, { workerMax: bad, providerMax: 1 }));
  }
});
