import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { FakeAdapter, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

const complete: Script = async function* (req) {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name: 'task_complete', arguments: { summary: 'done', notify: false } };
  for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const checkpoint: Script = async function* (req) {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name: 'task_checkpoint', arguments: { tried: 'read the notes', result: 'half done', next_action: 'finish the rest' } };
  for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function gated(): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const script: Script = async function* (req) {
    yield { type: 'text', delta: '…' };
    await new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      void gate.then(resolve);
    });
    yield* complete(req);
  };
  return { script, release };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function setup(t: { after: (fn: () => void) => void }, edit?: (c: AppConfig) => void, timers = false) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = true;
  config.memory.reviewIdleMinutes = 1440;
  config.worker.enabled = false;
  edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-15T03:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: timers, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => { app.worker.stop(); app.engine.stopAll(); });
  t.after(() => app.close());
  const template = (origin: 'user' | 'self') => {
    const made = app.tasks.create({ title: `every minute (${origin})`, origin, actor: origin === 'user' ? 'user' : 'worker', cron: '* * * * *', timezone: 'UTC' });
    app.db.prepare("UPDATE tasks SET status = 'scheduled', run_at = ? WHERE id = ?").run(clock.now - 1000, made.id);
    return made.id;
  };
  const project = () => {
    const root = join(dir, 'shop');
    mkdirSync(root, { recursive: true });
    return app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null }).id;
  };
  return { app, adapter: () => adapter, clock, template, project };
}

test('worker Off: a task the owner made (Build or New task) runs to done', async t => {
  const s = await setup(t);
  const build = s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(build.id)!.status, 'done');
});

test('worker Off: a run of the owner\'s repeating task is made and runs; a run of a repeating task beat made does not', async t => {
  const s = await setup(t);
  const mine = s.template('user');
  const beats = s.template('self');
  s.adapter().scripts.push(complete, complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  const runOf = (id: string) => (s.app.db.prepare('SELECT status FROM tasks WHERE parent_id = ?').get(id) as { status: string } | undefined)?.status;
  assert.equal(runOf(mine), 'done');
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(runOf(beats), 'ready');
  assert.equal(s.adapter().calls.length, 1);
});

test('worker Off: tasks beat started on its own, curiosity and memory reviews do not run', async t => {
  const s = await setup(t);
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  const curious = s.app.tasks.create({ title: 'look into X', origin: 'curiosity', actor: 'worker' });
  const job = s.app.reviews.enqueue('manual', 'manual:1')!;
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.tasks.get(self.id)!.status, 'ready');
  assert.equal(s.app.tasks.get(curious.id)!.status, 'ready');
  assert.equal(s.app.reviews.get(job.id)!.status, 'pending');
  assert.equal(s.adapter().calls.length, 0);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(self.id)!), { kind: 'owner' }, 'beat\'s own task waits for the owner (7-4), not for the switch');
  assert.deepEqual(s.app.worker.status().waiting[curious.id], { kind: 'owner' });
});

test('worker Off: the owner pressing Run now on a task beat started runs it', async t => {
  const s = await setup(t);
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  s.app.worker.requestRun(self.id);
  s.app.worker.setPaused(true);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(self.id)!), { kind: 'paused' }, 'a pressed task counts as the owner work, so its wait is shown');
  s.app.worker.setPaused(false);
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(self.id)!.status, 'done');
});

test('worker On: reviews run as before; beat\'s own task no longer runs on its own (7-4)', async t => {
  const s = await setup(t, c => { c.worker.enabled = true; });
  const job = s.app.reviews.enqueue('manual', 'manual:2')!;
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  s.adapter().scripts.push(complete);
  await s.app.worker.tick();
  assert.equal(s.app.reviews.get(job.id)!.status, 'done');
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.tasks.get(self.id)!.status, 'ready');
  assert.equal(s.adapter().calls.length, 0);
});

test('worker Off: the worker wakes at once for a task the owner adds, not on the next poll', async t => {
  const s = await setup(t, undefined, true);
  s.app.worker.start();
  await new Promise(r => setTimeout(r, 30));
  s.adapter().scripts.push(complete);
  const task = s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user' });
  await waitFor(() => s.app.tasks.get(task.id)!.status === 'done', 'the owner task runs without a manual tick', 3000);
});

test('7-4: a self / curiosity task waiting in ready says it waits for the owner (Run now), with the worker On or Off; once pressed it no longer does', async t => {
  for (const enabled of [true, false]) {
    const s = await setup(t, c => { c.worker.enabled = enabled; });
    const mine = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'beat' });
    const curious = s.app.tasks.create({ title: 'look into it', origin: 'curiosity', actor: 'beat' });
    const waits = () => s.app.worker.status().waiting;
    assert.deepEqual([waits()[mine.id], waits()[curious.id]], [{ kind: 'owner' }, { kind: 'owner' }], String(enabled));
    s.app.worker.requestRun(mine.id);
    assert.notDeepEqual(waits()[mine.id], { kind: 'owner' }, String(enabled));
  }
});

test('waiting reasons match what the worker does: paused, chat reply, hourly limit, product busy, no free slot', async t => {
  const s = await setup(t, c => { c.worker.maxRunsPerHour = 2; c.providers[0]!.maxParallel = 1; });
  const { app } = s;
  const task = app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user' });
  const reason = () => app.worker.status().waiting[task.id] ?? null;

  app.worker.setPaused(true);
  assert.deepEqual(reason(), { kind: 'paused' });
  assert.equal(await app.worker.tick(), 'paused');
  app.worker.setPaused(false);

  // 会話の返事を書いている最中（本物の会話の実行。提供元は maxParallel 1 なので、会話だけで埋まる。会話の実行がいるだけでは待たない。beat self-fix S1）
  s.adapter().scripts.push(async function* (req) {
    yield { type: 'text', delta: '…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  });
  const chatting = app.engine.send('c1', 'hello');
  assert.ok(chatting.ok, JSON.stringify(chatting));
  await waitFor(() => s.adapter().calls.length === 1, 'a chat reply is being written');
  assert.deepEqual(reason(), { kind: 'chat' });
  assert.equal(await app.worker.tick(), 'busy');
  app.engine.stop(chatting.runId);
  await app.engine.wait(chatting.runId);

  const insert = app.db.prepare("INSERT INTO engine_runs (id, kind, started_at) VALUES (?, 'task', ?)");
  insert.run('r1', s.clock.now - 45 * 60_000);
  insert.run('r2', s.clock.now - 20 * 60_000);
  assert.deepEqual(reason(), { kind: 'budget', at: s.clock.now + 15 * 60_000 });
  assert.equal(await app.worker.tick(), 'budget');
  const pressed = app.tasks.create({ title: 'pressed', origin: 'user', actor: 'user' });
  app.worker.requestRun(pressed.id);
  assert.equal(app.worker.status().waiting[pressed.id], undefined, 'Run now goes ahead of the hourly limit, so no limit reason');
  app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(pressed.id);
  app.db.prepare('DELETE FROM engine_runs').run();

  const projectId = s.project();
  const other = app.tasks.create({ title: 'other', origin: 'user', actor: 'user', projectId });
  app.db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(projectId, task.id);
  app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(other.id);
  assert.deepEqual(reason(), { kind: 'product' });
  app.db.prepare("UPDATE tasks SET project_id = NULL WHERE id = ?").run(task.id);
  app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(other.id);

  const busy = app.tasks.create({ title: 'first', origin: 'user', actor: 'user', priority: 1 });
  const g = gated();
  s.adapter().scripts.push(g.script);
  const first = app.worker.tick();
  await waitFor(() => app.tasks.get(busy.id)!.status === 'running', 'the first task starts');
  assert.deepEqual(reason(), { kind: 'slots' });
  assert.equal(await app.worker.tick(), 'busy');
  g.release();
  assert.equal(await first, 'ran');
  assert.equal(reason(), null);
});

test('worker Off: a task beat started that the owner pressed keeps going after it pauses midway, and the mark goes when it finishes', async t => {
  const s = await setup(t);
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  s.app.worker.requestRun(self.id);
  s.adapter().scripts.push(checkpoint);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(self.id)!.status, 'ready', 'the first run paused midway');
  s.clock.now += 2 * 60_000;
  s.app.worker.setPaused(true);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(self.id)!), { kind: 'paused' }, 'it still counts as the owner work');
  s.app.worker.setPaused(false);
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(self.id)!.status, 'done');
  assert.equal(s.app.kv.get(`task-owner-run:${self.id}`), undefined);
});

test('worker Off: runs of a repeating task beat set up (inside a Build, or in chat for the owner) do not run; the owner pressing Run now on one does', async t => {
  const s = await setup(t);
  const build = s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user' });
  s.app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(build.id);
  const inBuild = s.app.tasks.create({ title: 'check the shop daily', origin: 'user', actor: 'beat', cron: '* * * * *', timezone: 'UTC', spawnedBy: build.id });
  const inChat = s.app.tasks.create({ title: 'post a summary', origin: 'user', actor: 'beat', cron: '* * * * *', timezone: 'UTC' });
  for (const id of [inBuild.id, inChat.id]) s.app.db.prepare("UPDATE tasks SET status = 'scheduled', run_at = ? WHERE id = ?").run(s.clock.now - 1000, id);
  assert.equal(await s.app.worker.tick(), 'idle');
  const runOf = (id: string) => s.app.db.prepare('SELECT id, status FROM tasks WHERE parent_id = ?').get(id) as { id: string; status: string };
  assert.equal(runOf(inBuild.id).status, 'ready');
  assert.equal(runOf(inChat.id).status, 'ready');
  assert.equal(s.adapter().calls.length, 0);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(runOf(inBuild.id).id)!), { kind: 'off' });
  s.app.worker.requestRun(runOf(inChat.id).id);
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(runOf(inChat.id).status, 'done');
  assert.equal(runOf(inBuild.id).status, 'ready');
});

test('hourly limit: the worker wakes again when the limit frees up, not on the fixed poll', async t => {
  const s = await setup(t, c => { c.worker.maxRunsPerHour = 2; }, true);
  s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user' });
  const insert = s.app.db.prepare("INSERT INTO engine_runs (id, kind, started_at) VALUES (?, 'task', ?)");
  insert.run('r1', s.clock.now - 58 * 60_000);
  insert.run('r2', s.clock.now - 20 * 60_000);
  s.app.worker.start();
  await waitFor(() => s.app.worker.status().nextWakeAt === s.clock.now + 2 * 60_000, 'the next wake is when the older run leaves the hour', 2000);
});

test('a Build whose own sub-task is running shows no waiting reason (it is working through its parts)', async t => {
  const s = await setup(t);
  const projectId = s.project();
  const parent = s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user', projectId });
  const child = s.app.tasks.create({ title: 'part 1', origin: 'user', actor: 'beat', projectId, spawnedBy: parent.id });
  s.app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(child.id);
  assert.equal(s.app.worker.waitReason(s.app.tasks.get(parent.id)!), null);
  assert.equal(s.app.worker.status().waiting[parent.id], undefined);
});

test('worker Off: a repeating task beat proposed and the owner approved runs', async t => {
  const s = await setup(t);
  const proposal = s.app.tasks.create({ title: 'weekly tidy', origin: 'self', actor: 'beat', cron: '* * * * *', timezone: 'UTC', propose: true });
  s.app.tasks.approve(proposal.id);
  s.app.db.prepare("UPDATE tasks SET run_at = ? WHERE id = ?").run(s.clock.now - 1000, proposal.id);
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal((s.app.db.prepare('SELECT status FROM tasks WHERE parent_id = ?').get(proposal.id) as { status: string }).status, 'done');
});

test('worker Off: the child and grandchild of a run of a repeating task beat set up stay held; a press on the run lets its chain through', async t => {
  const s = await setup(t);
  const template = s.app.tasks.create({ title: 'post a summary', origin: 'user', actor: 'beat', cron: '* * * * *', timezone: 'UTC' });
  s.app.db.prepare("UPDATE tasks SET status = 'scheduled', run_at = ? WHERE id = ?").run(s.clock.now - 1000, template.id);
  assert.equal(await s.app.worker.tick(), 'idle');
  const run = s.app.db.prepare('SELECT id FROM tasks WHERE parent_id = ?').get(template.id) as { id: string };
  s.app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(run.id);
  const child = s.app.tasks.create({ title: 'part 1', origin: 'user', actor: 'beat', spawnedBy: run.id });
  const grandchild = s.app.tasks.create({ title: 'part 1a', origin: 'user', actor: 'beat', spawnedBy: child.id });
  s.app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(child.id);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(grandchild.id)!), { kind: 'off' });
  s.app.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(child.id);
  s.app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(grandchild.id);
  assert.deepEqual(s.app.worker.waitReason(s.app.tasks.get(child.id)!), { kind: 'off' });
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.adapter().calls.length, 0);
  s.app.kv.set(`task-owner-run:${run.id}`, '1');
  assert.equal(s.app.worker.waitReason(s.app.tasks.get(child.id)!), null, 'the owner pressed the run, so its parts are the owner work');
});

test('worker Off: a pressed task that is cancelled and then restored still runs', async t => {
  const s = await setup(t);
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  s.app.worker.requestRun(self.id);
  s.app.tasks.finish(self.id, 'cancelled', null, 'user');
  assert.equal(await s.app.worker.tick(), 'idle', 'the one-shot press is dropped while cancelled');
  s.app.tasks.uncancel(self.id, 'user');
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(self.id)!.status, 'done');
});

test('worker On: a task beat started that the owner pressed keeps going (the press is the owner asking)', async t => {
  const s = await setup(t, c => { c.worker.enabled = true; });
  const self = s.app.tasks.create({ title: 'tidy the notes', origin: 'self', actor: 'worker' });
  s.app.worker.requestRun(self.id);
  s.adapter().scripts.push(checkpoint);
  assert.equal(await s.app.worker.tick(), 'ran');
  s.clock.now += 2 * 60_000;
  s.adapter().scripts.push(complete);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(self.id)!.status, 'done');
  const other = s.app.tasks.create({ title: 'not pressed', origin: 'self', actor: 'worker' });
  s.adapter().scripts.push(complete, complete);
  await s.app.worker.tick();
  await s.app.worker.tick();
  assert.equal(s.app.tasks.get(other.id)!.status, 'ready', 'an unpressed one never runs on its own (7-4)');
});
