import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App, builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, startApp, waitFor } from './app-setup.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script } from './helpers.ts';

const MIN = 60_000;
const START = Date.parse('2026-11-14T03:00:00Z');

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const checkpoint = (minutes = 30) => call('task_checkpoint', { tried: 'tried', result: 'result', next_action: 'next', resume_after_minutes: minutes });

function fakeTools(runs: string[]): ToolDef[] {
  const park: ToolDef<{ text: string }> = {
    name: 'fake_park', description: 'Test tool: needs approval.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['task', 'agent'],
    summarize: input => ({ title: 'Park', body: input.text }),
    async execute(input) { runs.push(input.text); return { content: `ran ${input.text}`, exitCode: 0 }; },
  };
  const work: ToolDef<{ text: string }> = {
    name: 'fake_work', description: 'Test tool: plain work.', input: Type.Object({ text: Type.String() }), effect: 'read', allowedIn: ['task'],
    async execute(input) { return { content: `worked ${input.text}` }; },
  };
  return [park as unknown as ToolDef, work as unknown as ToolDef];
}

async function setup(t: Parameters<typeof startApp>[0], agents = false) {
  const clock = { now: START };
  const runs: string[] = [];
  const s = await startApp(t, {
    models: [fakeModel('m1')], tools: [...builtinTools(), ...fakeTools(runs)], now: () => clock.now,
    configure: c => {
      c.tools.policies = { fake_park: 'ask', fake_work: 'allow', ...(agents ? { agent_run: 'allow' as const } : {}) };
      c.memory.review = false;
      if (agents) { c.tools.agent.enabled = true; c.tools.agent.inTasks = true; }
    },
  });
  const task = (title = 'Build') => s.app.tasks.create({ title, origin: 'user', actor: 'user' }).id;
  const rows = (taskId: string) => s.app.db.prepare('SELECT id, status FROM pending_actions WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; status: string }>;
  const decided = async (id: number) => waitFor(() => !['waiting', 'running'].includes(s.app.pending.view(id)!.status), `pending #${id} decided`);
  const parkAndWork = () => [call('fake_park', { text: 'commit' }), call('fake_work', { text: 'more' }), checkpoint(30)];
  const parkedRun = async (id: string) => {
    s.adapter().scripts = parkAndWork();
    assert.equal(await s.app.worker.tick(), 'ran');
    return rows(id);
  };
  const idleRun = async () => {
    s.adapter().scripts = [checkpoint(30)];
    assert.equal(await s.app.worker.tick(), 'ran');
  };
  return { ...s, clock, runs, task, rows, decided, parkedRun, idleRun };
}

test('5-P 仕事をした回の checkpoint は、待ちの行があっても時間つきの実行待ちのまま（止まらない）', async t => {
  const s = await setup(t);
  const id = s.task();
  const parked = await s.parkedRun(id);
  assert.deepEqual(parked.map(r => r.status), ['waiting']);
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.waiting_kind, null);
  assert.equal(task.run_at, START + 30 * MIN);
});

test('5-P 何もしなかった回の checkpoint で待ちの行がある → waiting / approval（行の番号、時刻なし）。そのあとモデルは呼ばれない', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'waiting');
  assert.equal(task.waiting_kind, 'approval');
  assert.equal(task.waiting_text, `#${row!.id}`);
  assert.equal(task.run_at, null);
  assert.match(task.body, /tried/u);
  assert.equal(task.next_action, 'next');
  const asks = s.task('Asks');
  s.app.tasks.setWaiting(asks, 'question', 'Which?');
  const calls = s.adapter().calls.length;
  for (let i = 0; i < 14; i++) { s.clock.now += 60 * MIN; await s.app.worker.tick(); }
  assert.equal(s.adapter().calls.length, calls);
  const reminders = s.app.notifications.list(50).filter(n => n.kind === 'task_waiting').map(n => n.link);
  assert.ok(reminders.includes(`#/tasks/${asks}`), '同じ時間で、質問の返事待ちは知らせ直される');
  assert.ok(!reminders.includes(`#/tasks/${id}`), '承認待ちは知らせ直さない');
});

test('5-P 待ちの行が無いときの何もしない checkpoint は、前と同じに時間で起きる', async t => {
  const s = await setup(t);
  const id = s.task();
  await s.idleRun();
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.run_at, START + 30 * MIN);
});

test('5-P 承認待ちのタスクは、Approve で実行待ちに戻り、1 回だけ選ばれる', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  assert.equal(s.app.tasks.get(id)!.waiting_kind, 'approval');
  const approved = await s.json(`/api/pending/${row!.id}/approve`, 'POST');
  assert.equal(approved.status, 202);
  await s.decided(row!.id);
  assert.deepEqual(s.runs, ['commit']);
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.waiting_kind, null);
  assert.ok(task.run_at !== null && task.run_at <= s.clock.now);
  s.adapter().scripts = [call('task_complete', { summary: 'done', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.equal(await s.app.worker.tick(), 'idle');
});

test('5-P 仕事をした回のあとで休んでいるタスクは、行が決まると run_at が今になる', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 5 * MIN;
  assert.equal(await s.app.worker.tick(), 'idle');
  const rejected = await s.json(`/api/pending/${row!.id}/reject`, 'POST', {});
  assert.equal(rejected.status, 200);
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.run_at, s.clock.now);
  s.adapter().scripts = [call('task_complete', { summary: 'done', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
});

test('5-P Reject・取り消し・古くなった（stale）のどれでも、承認待ちから実行待ちに戻る', async t => {
  for (const how of ['reject', 'cancel', 'stale'] as const) {
    await t.test(how, async t2 => {
      const s = await setup(t2);
      const id = s.task();
      const [row] = await s.parkedRun(id);
      s.clock.now += 31 * MIN;
      await s.idleRun();
      assert.equal(s.app.tasks.get(id)!.waiting_kind, 'approval');
      if (how === 'reject') s.app.pending.reject(row!.id);
      else if (how === 'cancel') s.app.pending.cancelConversations([s.app.tasks.get(id)!.conversation_id!]);
      else { s.app.pending.claim(row!.id); s.app.pending.finish(row!.id, { status: 'stale' }); }
      const task = s.app.tasks.get(id)!;
      assert.equal(task.status, 'ready', how);
      assert.equal(task.waiting_kind, null);
    });
  }
});

test('5-P 行が 2 つあれば、最初の決めで起きる', async t => {
  const s = await setup(t);
  const id = s.task();
  s.adapter().scripts = [call('fake_park', { text: 'a' }), call('fake_park', { text: 'b' }), checkpoint(30)];
  assert.equal(await s.app.worker.tick(), 'ran');
  const parked = s.rows(id);
  assert.equal(parked.length, 2);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  assert.equal(s.app.tasks.get(id)!.waiting_text, `#${parked[0]!.id}, #${parked[1]!.id}`);
  s.app.pending.reject(parked[1]!.id);
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
});

test('5-P 承認待ちのタスクへの /answer は 409 で、タスクは変わらない。今すぐ実行は断り、取り消し・取り消しを戻すは前と同じに動く', async t => {
  const s = await setup(t);
  const id = s.task();
  await s.parkedRun(id);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  const before = s.app.tasks.get(id)!;
  const answered = await s.json(`/api/tasks/${id}/answer`, 'POST', { text: 'go' });
  assert.equal(answered.status, 409);
  assert.match(JSON.stringify(answered.body), /Pending/u);
  assert.deepEqual(s.app.tasks.get(id), before);
  const runNow = await s.json(`/api/tasks/${id}/run-now`, 'POST', {});
  assert.equal(runNow.status, 409);
  assert.match(JSON.stringify(runNow.body), /Pending/u);
  assert.deepEqual(s.app.tasks.get(id), before);
  const cancelled = await s.json(`/api/tasks/${id}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  assert.equal(s.app.tasks.get(id)!.status, 'cancelled');
  const restored = await s.json(`/api/tasks/${id}/uncancel`, 'POST', {});
  assert.equal(restored.status, 200);
  const back = s.app.tasks.get(id)!;
  assert.equal(back.status, 'waiting');
  assert.equal(back.waiting_kind, 'approval');
});

test('5-P 質問の返事待ちへの /answer は前と同じに通る', async t => {
  const s = await setup(t);
  const id = s.task();
  s.app.tasks.setWaiting(id, 'question', 'Which one?');
  const answered = await s.json(`/api/tasks/${id}/answer`, 'POST', { text: 'the first' });
  assert.equal(answered.status, 200);
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
});

test('5-P 子の担当（agent_run）が積んだ行は親のタスクの番号を持ち、その決めで親のタスクが起きる', async t => {
  const s = await setup(t, true);
  const id = s.task();
  s.adapter().scripts = [call('agent_run', { task: 'commit it' }), call('fake_park', { text: 'child' }), reply('child done'), checkpoint(30)];
  assert.equal(await s.app.worker.tick(), 'ran');
  const parked = s.app.db.prepare('SELECT id, run_kind, task_id FROM pending_actions').all() as Array<{ id: number; run_kind: string; task_id: string }>;
  assert.deepEqual(parked.map(r => [r.run_kind, r.task_id]), [['agent', id]]);
  assert.equal(s.app.tasks.get(id)!.run_at, START + 30 * MIN);
  s.app.pending.reject(parked[0]!.id);
  assert.equal(s.app.tasks.get(id)!.run_at, s.clock.now);
});

test('5-P 決めは、質問の返事待ちのタスクには触らない', async t => {
  const s = await setup(t);
  const id = s.task();
  const conversation = s.app.conversations.create({ kind: 'task', title: 'x' });
  const row = await s.app.pending.park({ tool: 'fake_park', input: { text: 'x' }, cwd: s.paths.workspace, kind: 'policy', reason: 'r', runId: 'r1', runKind: 'task', conversationId: conversation.id, taskId: id });
  s.app.tasks.setWaiting(id, 'question', 'Which one?');
  s.app.pending.reject(row.id);
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'waiting');
  assert.equal(task.waiting_kind, 'question');
  assert.equal(task.waiting_text, 'Which one?');
});

test('5-P 実行の途中で行が決まったら、その回の checkpoint は時間を待たずに今すぐ続く', async t => {
  const s = await setup(t);
  const id = s.task();
  const rejectThenCheckpoint: Script = async function* (req) {
    s.app.pending.reject(s.rows(id)[0]!.id);
    yield* checkpoint(45)(req);
  };
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), call('fake_work', { text: 'more' }), rejectThenCheckpoint];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.rows(id).map(r => r.status), ['rejected']);
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.run_at, s.clock.now);
});

test('5-P 実行の前に決まった行は、次の回の checkpoint を今すぐにしない（時間で起きる。回りっぱなしにならない）', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 5 * MIN;
  s.app.pending.reject(row!.id);
  assert.equal(s.app.tasks.get(id)!.run_at, s.clock.now);
  s.clock.now += 1 * MIN;
  s.adapter().scripts = [call('fake_work', { text: 'more' }), checkpoint(30)];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(id)!.run_at, s.clock.now + 30 * MIN);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.run_at, s.clock.now + 30 * MIN);
});

test('5-P 起きたときの経過の文に、決めの結果が入る。見回りの文は、結果が残っていないことと確かめることを言う', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  s.app.pending.cancelConversations([s.app.tasks.get(id)!.conversation_id!]);
  const woke = s.app.tasks.events(id).find(e => e.kind === 'requeued')!;
  assert.match(woke.content!, new RegExp(`#${row!.id}`, 'u'));
  assert.match(woke.content!, /cancelled/u);
  s.app.tasks.finish(id, 'done', 'x', 'user');
  const other = s.task('Other');
  s.adapter().scripts = parkAndWorkScripts();
  assert.equal(await s.app.worker.tick(), 'ran');
  s.clock.now += 31 * MIN;
  await s.idleRun();
  assert.equal(s.app.tasks.get(other)!.waiting_kind, 'approval');
  const [late] = s.rows(other);
  s.app.pending.claim(late!.id);
  s.app.pending.closeInterrupted();
  s.adapter().scripts = [call('task_complete', { summary: 'done', notify: false })];
  await s.app.worker.tick();
  const swept = s.app.tasks.events(other).find(e => e.kind === 'requeued' && /result/u.test(e.content ?? ''));
  assert.ok(swept, JSON.stringify(s.app.tasks.events(other).map(e => e.content)));
  assert.match(swept!.content!, /check/u);
});

test('5-P 見回り: 再実行の途中で落ちた行だけが残った承認待ちのタスクは、見回りで起きる', async t => {
  const s = await setup(t);
  const id = s.task();
  const [row] = await s.parkedRun(id);
  s.clock.now += 31 * MIN;
  await s.idleRun();
  s.app.pending.claim(row!.id);
  assert.equal(s.app.tasks.get(id)!.waiting_kind, 'approval', '再実行中は待ちのまま');
  assert.equal(s.app.pending.closeInterrupted(), 1);
  assert.equal(s.app.tasks.get(id)!.status, 'waiting', '出来事なしで閉じられるので、まだ起きない');
  s.adapter().scripts = [call('task_complete', { summary: 'done', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(id)!.status, 'done');
});

test('5-P 見回り（起動時）: 再起動で再実行の途中の行が閉じられると、ワーカーの start で承認待ちのタスクが起きる（ワーカーが無効でも）', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [fakeModel('m1')];
  config.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const databasePath = join(paths.data, 'beat.db');
  const open = () => new App({ paths, databasePath, log: () => undefined, now: () => START, workerTimers: false, tools: [...builtinTools(), ...fakeTools([])], adapterOverride: p => new FakeAdapter(p) });
  const first = open();
  const id = first.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  const conversation = first.conversations.create({ kind: 'task', title: 'Task: Build' });
  const row = await first.pending.park({ tool: 'fake_park', input: { text: 'x' }, cwd: paths.workspace, kind: 'policy', reason: 'r', runId: 'r1', runKind: 'task', conversationId: conversation.id, taskId: id });
  first.tasks.setWaiting(id, 'approval', `#${row.id}`);
  first.pending.claim(row.id);
  first.close();
  config.worker.enabled = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const second = open();
  try {
    assert.equal(second.pending.view(row.id)!.status, 'failed');
    assert.equal(second.tasks.get(id)!.status, 'waiting');
    second.worker.start();
    second.worker.stop();
    assert.equal(second.tasks.get(id)!.status, 'ready');
  } finally { second.close(); }
});

test('5-P 見回りは、待ちの行が残っている承認待ちと、質問の返事待ちには触らない', async t => {
  const s = await setup(t);
  const waits = s.task('Waits');
  const asks = s.task('Asks');
  const conversation = s.app.conversations.create({ kind: 'task', title: 'x' });
  const row = await s.app.pending.park({ tool: 'fake_park', input: { text: 'x' }, cwd: s.paths.workspace, kind: 'policy', reason: 'r', runId: 'r1', runKind: 'task', conversationId: conversation.id, taskId: waits });
  s.app.tasks.setWaiting(waits, 'approval', `#${row.id}`);
  s.app.tasks.setWaiting(asks, 'question', 'Which?');
  s.adapter().scripts = [reply('unused')];
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.tasks.get(waits)!.waiting_kind, 'approval');
  assert.equal(s.app.tasks.get(asks)!.waiting_kind, 'question');
});

const parkAndWorkScripts = () => [call('fake_park', { text: 'commit' }), call('fake_work', { text: 'more' }), checkpoint(30)];

test('5-P 作業の決まりの文に、積まれても待たなくてよいことが 1 文ある（task_complete は、その結果に頼る作業が残っていないときだけ）', async () => {
  const { taskPrompt } = await import('../src/tasks/worker.ts');
  const prompt = taskPrompt({ id: 'aaaaaaaa-0000', title: 'T', origin: 'user', body: '', next_action: null, done_criteria: null } as never, [], 'UTC');
  const line = prompt.split('\n').find(l => l.includes('Pending'))!;
  assert.match(line, /^- You do not need to wait for a call held in Pending/u);
  assert.match(line, /resumes the task as soon as the user decides/u);
  assert.match(line, /task_complete only when nothing left in the task depends on/u);
  assert.match(line, /task_checkpoint/u);
});
