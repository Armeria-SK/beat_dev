import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { engineText } from '../src/shared/messages/engine.ts';
import { taskText } from '../src/shared/messages/tasks.ts';
import { warningText } from '../web/src/server-text.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script } from './helpers.ts';

// S1（beat self-fix）: 会話が裏の実行を止めるのは、会話が最初に使う提供元に空きが無いときだけ

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// 壊れたときに、終わらない待ちでテスト全体が止まらないよう、待ちに上限を付ける
function within<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`待ちきれませんでした: ${label}`)), ms).unref(); })]);
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

// 止められるまで返事を始めない台本（abort されたら止まる）
function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '考えています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

// 何も書かずに止められるまで待つ台本（止めても、書きかけの返事が残らない）
function silent(): Script {
  return async function* (req) {
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
    yield { type: 'done', stop: 'end_turn' as StopReason };
  };
}

const reviewOn = (c: AppConfig): void => { c.memory.review = true; c.memory.reviewIdleMinutes = 1440; };

// split: 会話の鎖は cloud（先頭）→ local、裏の鎖は local だけ（会話の鎖の後ろに、裏の実行と同じ提供元がある形）
async function setup(t: { after: (fn: () => void) => void }, options: { providerMax: number; workerMax?: number; split?: boolean; edit?: (c: AppConfig) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  if (options.split) {
    config.providers = [
      { id: 'cloud', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: options.providerMax, timeoutMs: 10_000 },
      { id: 'local', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 },
    ];
    config.models = [
      { id: 'cm', provider: 'cloud', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false },
      { id: 'lm', provider: 'local', model: 'y', contextLength: 65536, maxOutputTokens: 1024, vision: false },
    ];
    config.routing = { chat: ['cm', 'lm'], background: ['lm'], retriesPerModel: 0 };
  } else {
    config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: options.providerMax, timeoutMs: 10_000 }];
    config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
    config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  }
  config.memory.review = false;
  config.worker.maxParallel = options.workerMax ?? 2;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-25T20:00:00Z') };
  const adapters = new Map<string, FakeAdapter>();
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => { const made = new FakeAdapter(p); adapters.set(p.id, made); return made; },
  });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => { app.worker.stop(); app.engine.stopAll(); });
  t.after(() => app.close());
  const userTask = (title: string) => app.tasks.create({ title, origin: 'user', actor: 'user' });
  const adapter = (id = options.split ? 'cloud' : 'fake') => adapters.get(id)!;
  const pausedWarnings = (runId: string) => events.flatMap(e => (e.type === 'warning' && e.runId === runId && e.code === 'task_paused' ? [e] : []));
  return { app, adapter, adapters, clock, events, userTask, pausedWarnings };
}

type Setup = Awaited<ReturnType<typeof setup>>;

// 台本を積んで、タスクを 1 本始める（始まって、モデルを呼ぶところまで待つ）
async function startTask(s: Setup, script: Script, adapterId?: string) {
  const adapter = s.adapter(adapterId);
  const before = adapter.calls.length;
  adapter.scripts.push(script);
  const ticking = s.app.worker.tick();
  await waitFor(() => adapter.calls.length === before + 1, 'タスクの実行がモデルを呼ぶ');
  const run = s.app.worker.status().runningAll.at(-1)!;
  return { ticking, run };
}

test('空きがある（maxParallel 2・裏 1 本）なら、会話に送っても裏の実行を止めない。task_paused も出さない', async t => {
  const s = await setup(t, { providerMax: 2 });
  const task = s.userTask('A');
  const g = gated();
  const { ticking, run } = await startTask(s, g.script);
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  await s.app.engine.wait(sent.runId);
  assert.equal(s.app.engine.wasPreempted(run.runId), false, '空きがあるので止めない');
  assert.equal(s.app.tasks.get(task.id)!.status, 'running');
  assert.deepEqual(s.pausedWarnings(sent.runId), [], '止めていないので知らせない');
  g.release();
  assert.equal(await within(ticking, 'タスクが終わる'), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('空きが無い（maxParallel 1・裏 1 本）なら、止めて実行待ちに戻し、会話の実行が task_paused を 1 回出す（count 1）', async t => {
  const s = await setup(t, { providerMax: 1 });
  const task = s.userTask('A');
  const { ticking, run } = await startTask(s, hang());
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.equal(await within(ticking, '止められて戻る'), 'ran');
  assert.equal(s.app.engine.wasPreempted(run.runId), true);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  const requeued = s.app.tasks.events(task.id).find(e => e.kind === 'requeued');
  assert.equal(requeued?.content, taskText('en', 'reason.preempted'), 'task_events に requeued（preempted）');
  await s.app.engine.wait(sent.runId);
  const warnings = s.pausedWarnings(sent.runId);
  assert.equal(warnings.length, 1, 'task_paused は 1 回だけ');
  assert.deepEqual(warnings[0]!.params, { count: 1 });
  assert.equal(warnings[0]!.message, engineText('en', 'warn.task_paused', { count: 1 }));
  const startIndex = s.events.findIndex(e => e.type === 'run.start' && e.runId === sent.runId);
  assert.ok(startIndex >= 0 && s.events.indexOf(warnings[0]!) > startIndex, '始まりの知らせ（最初の往復の前）');
});

test('maxParallel 2・裏 2 本のときに会話へ送ると、あとから始まった 1 本だけ止まる', async t => {
  const s = await setup(t, { providerMax: 2 });
  const a = s.userTask('A');
  const b = s.userTask('B');
  const ga = gated();
  const first = await startTask(s, ga.script);
  const second = await startTask(s, hang());
  assert.equal(first.run.taskId, a.id, '前提: A が先に始まった');
  assert.equal(second.run.taskId, b.id, '前提: B があとから始まった');
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.equal(await within(second.ticking, 'あとから始まった B が止められて戻る'), 'ran');
  assert.equal(s.app.engine.wasPreempted(second.run.runId), true);
  assert.equal(s.app.engine.wasPreempted(first.run.runId), false, '先に始まった A は止めない');
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  await s.app.engine.wait(sent.runId);
  assert.deepEqual(s.pausedWarnings(sent.runId).map(e => e.params), [{ count: 1 }]);
  ga.release();
  assert.equal(await within(first.ticking, 'A が終わる'), 'ran');
});

test('止めた実行の数には、タスクの無い実行（振り返り）も入る', async t => {
  const s = await setup(t, { providerMax: 1, edit: reviewOn });
  s.adapter().scripts.push(reply('来週は大阪ですね'));
  const first = s.app.engine.send('c1', '来週から大阪に出張です');
  assert.ok(first.ok);
  await s.app.engine.wait(first.runId);
  s.app.engine.lastUserActivity = 0;
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' });
  const { ticking, run } = await startTask(s, hang());
  assert.equal(run.taskId ?? null, null, '前提: タスクではなく振り返りが動いている');
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c2', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.equal(await within(ticking, '振り返りが止められて戻る'), 'ran');
  assert.equal(s.app.engine.wasPreempted(run.runId), true);
  await s.app.engine.wait(sent.runId);
  assert.deepEqual(s.pausedWarnings(sent.runId).map(e => e.params), [{ count: 1 }]);
});

test('やり直し（retry）でも同じ決まり: 空きが無ければ止めて知らせ、空きがあれば止めない', async t => {
  for (const providerMax of [1, 2]) {
    const s = await setup(t, { providerMax });
    s.userTask('A');
    s.adapter().scripts.push(silent());
    const stopped = s.app.engine.send('c1', 'こんにちは');
    assert.ok(stopped.ok);
    await waitFor(() => s.adapter().calls.length === 1, '会話の 1 回目が始まる');
    s.app.engine.stop(stopped.runId);
    await s.app.engine.wait(stopped.runId);
    const { ticking, run } = await startTask(s, gated().script);
    s.adapter().scripts.push(reply('はい'));
    const retried = s.app.engine.retry('c1');
    assert.ok(retried.ok, JSON.stringify(retried));
    await s.app.engine.wait(retried.runId);
    assert.equal(s.app.engine.wasPreempted(run.runId), providerMax === 1, `maxParallel ${providerMax}`);
    assert.equal(s.pausedWarnings(retried.runId).length, providerMax === 1 ? 1 : 0, `maxParallel ${providerMax}`);
    s.app.engine.stopAll();
    await within(ticking, '片付く');
  }
});

test('会話の実行が動いている間のワーカー: 空きがあればタスクを始める。空きが無ければ待ち（busy・理由は chat）', async t => {
  const room = await setup(t, { providerMax: 2 });
  const a = room.userTask('A');
  room.adapter().scripts.push(hang());
  const chat = room.app.engine.send('c1', 'こんにちは');
  assert.ok(chat.ok);
  await waitFor(() => room.adapter().calls.length === 1, '会話が始まる');
  assert.equal(room.app.worker.waitReason(room.app.tasks.get(a.id)!), null, '空きがあるので待たない');
  const g = gated();
  room.adapter().scripts.push(g.script);
  const ticking = room.app.worker.tick();
  await waitFor(() => room.adapter().calls.length === 2, '会話の実行と並んでタスクが始まる');
  assert.equal(room.app.tasks.get(a.id)!.status, 'running');
  g.release();
  assert.equal(await within(ticking, 'タスクが終わる'), 'ran');
  room.app.engine.stopAll();
  await room.app.engine.wait(chat.runId);

  const full = await setup(t, { providerMax: 1 });
  const b = full.userTask('B');
  full.adapter().scripts.push(hang());
  const busy = full.app.engine.send('c1', 'こんにちは');
  assert.ok(busy.ok);
  await waitFor(() => full.adapter().calls.length === 1, '会話が始まる');
  assert.deepEqual(full.app.worker.waitReason(full.app.tasks.get(b.id)!), { kind: 'chat' });
  assert.equal(await within(full.app.worker.tick(), '始めずに返る'), 'busy');
  assert.equal(full.adapter().calls.length, 1, 'タスクは始めない');
  assert.equal(full.app.tasks.get(b.id)!.status, 'ready');
  full.app.engine.stopAll();
  await full.app.engine.wait(busy.runId);
});

test('maxParallel 2・会話の実行 2 本・タスク 0 本なら、ワーカーは始めない（会話だけで埋まっている）', async t => {
  const s = await setup(t, { providerMax: 2 });
  const a = s.userTask('A');
  s.adapter().scripts.push(hang(), hang());
  const one = s.app.engine.send('c1', 'ひとつめ');
  const two = s.app.engine.send('c2', 'ふたつめ');
  assert.ok(one.ok && two.ok);
  await waitFor(() => s.adapter().calls.length === 2, '会話 2 本が動く');
  assert.equal(s.app.engine.activeRuns().filter(r => r.kind === 'chat').length, 2);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(a.id)!), { kind: 'chat' });
  assert.equal(await within(s.app.worker.tick(), '始めずに返る'), 'busy');
  assert.equal(s.adapter().calls.length, 2, 'タスクは始めない');
  assert.equal(s.app.tasks.get(a.id)!.status, 'ready');
  s.app.engine.stopAll();
  await Promise.all([s.app.engine.wait(one.runId), s.app.engine.wait(two.runId)]);
});

test('空きの数には会話の実行も入る（maxParallel 2・会話 1 本・裏 1 本のとき、別の会話を送ると裏の実行を止める）', async t => {
  const s = await setup(t, { providerMax: 2 });
  s.adapter().scripts.push(hang());
  const one = s.app.engine.send('c1', 'ひとつめ');
  assert.ok(one.ok);
  await waitFor(() => s.adapter().calls.length === 1, '会話が始まる');
  const task = s.userTask('A');
  const { ticking, run } = await startTask(s, hang());
  s.adapter().scripts.push(reply('はい'));
  const two = s.app.engine.send('c2', 'ふたつめ');
  assert.ok(two.ok, JSON.stringify(two));
  assert.equal(await within(ticking, '止められて戻る'), 'ran');
  assert.equal(s.app.engine.wasPreempted(run.runId), true, '会話 1 本 + 裏 1 本で maxParallel 2 は満杯');
  assert.equal(s.app.engine.wasPreempted(one.runId), false, '会話の実行は止めない');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  await s.app.engine.wait(two.runId);
  assert.deepEqual(s.pausedWarnings(two.runId).map(e => e.params), [{ count: 1 }]);
  s.app.engine.stopAll();
  await s.app.engine.wait(one.runId);
});

test('止める候補が無ければ、何も止めない（会話の実行は止めない。枠の待ち行列に任せる）', async t => {
  const s = await setup(t, { providerMax: 1 });
  s.adapter().scripts.push(hang(), reply('はい'));
  const one = s.app.engine.send('c1', 'ひとつめ');
  assert.ok(one.ok);
  await waitFor(() => s.adapter().calls.length === 1, '会話が始まる');
  const two = s.app.engine.send('c2', 'ふたつめ');
  assert.ok(two.ok);
  assert.equal(s.app.engine.wasPreempted(one.runId), false, '会話の実行は止めない');
  assert.equal(s.app.engine.activeRuns().filter(r => r.kind === 'chat').length, 2);
  assert.deepEqual(s.pausedWarnings(two.runId), [], '止めたものが無いので知らせない');
  s.app.engine.stop(one.runId);
  await Promise.all([s.app.engine.wait(one.runId), s.app.engine.wait(two.runId)]);
});

test('会話の鎖の先頭の提供元が、裏の実行の先頭と違うなら止めない（後ろに同じ提供元があるだけでは止めない）', async t => {
  const s = await setup(t, { providerMax: 1, split: true });
  const task = s.userTask('A');
  const { ticking, run } = await startTask(s, hang(), 'local');
  s.adapter('cloud').scripts.push(reply('はい'));
  const sent = s.app.engine.send('c1', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  await s.app.engine.wait(sent.runId);
  assert.equal(s.app.engine.wasPreempted(run.runId), false, '会話は cloud が先頭。local の裏の実行は止めない');
  assert.equal(s.app.tasks.get(task.id)!.status, 'running');
  assert.deepEqual(s.pausedWarnings(sent.runId), []);
  s.app.engine.stopAll();
  await within(ticking, '片付く');
});

test('画面の文: task_paused の知らせは、画面の言語（en・ja）で件数が入った文になる', () => {
  const en = warningText({ code: 'task_paused', message: 'サーバーの文', params: { count: 2 } }, 'en');
  assert.equal(en, engineText('en', 'warn.task_paused', { count: 2 }));
  assert.match(en, /Paused 2 background run\(s\)/u);
  assert.match(en, /2 minutes after the pause/u);
  const ja = warningText({ code: 'task_paused', message: 'サーバーの文', params: { count: 2 } }, 'ja');
  assert.match(ja, /裏の作業 2 件を一時止めました/u);
  assert.match(ja, /2 分後に実行待ちへ戻り/u);
  assert.equal(warningText({ code: 'task_paused', message: 'サーバーの文' }, 'ja'), 'サーバーの文', '件数が無ければサーバーの文');
});
