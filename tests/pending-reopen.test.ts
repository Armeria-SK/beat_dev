import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { languageOf } from '../src/shared/language.ts';
import { pendingDecided } from '../src/tasks/pending-wake.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, startApp, waitFor } from './app-setup.ts';
import { reply, type Script, withLoad } from './helpers.ts';

const START = Date.parse('2026-11-14T03:00:00Z');

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const complete = () => call('task_complete', { summary: 'done', notify: false });

function parkTool(): ToolDef {
  const park: ToolDef<{ text: string }> = {
    name: 'fake_park', description: 'Test tool: needs approval.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['task', 'agent'],
    summarize: input => ({ title: 'Park', body: input.text }),
    async execute(input) {
      if (input.text === 'fail') return { content: 'boom', isError: true };
      if (input.text === 'exit1') return { content: 'exit 1', exitCode: 1, isError: true };
      if (input.text === 'no-code') return { content: 'ok' };
      return { content: 'ok', exitCode: 0 };
    },
  };
  return park as unknown as ToolDef;
}

async function setup(t: Parameters<typeof startApp>[0], agents = false) {
  const clock = { now: START };
  const s = await startApp(t, {
    models: [fakeModel('m1')], tools: [...builtinTools(), parkTool()], now: () => clock.now,
    configure: c => {
      c.tools.policies = { fake_park: 'ask', ...(agents ? { agent_run: 'allow' as const } : {}) };
      c.memory.review = false;
      if (agents) { c.tools.agent.enabled = true; c.tools.agent.inTasks = true; }
    },
  });
  // P4 のあと done に残る待ちは、完了の門が積んだ項目のコマンド（keepPending）だけ。その形を作る
  const keepDone = (id: string) => { s.app.tasks.finish(id, 'done', 'done', 'beat', undefined, undefined, { keepPending: true }); };
  const rows = (taskId: string) => s.app.db.prepare('SELECT id, status FROM pending_actions WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; status: string }>;
  const finished = (id: number) => waitFor(() => !['waiting', 'running'].includes(s.app.pending.view(id)!.status), `pending #${id} finished`);
  const doneWithRow = async (text: string, title = 'Commit and finish') => {
    const id = s.app.tasks.create({ title, origin: 'user', actor: 'user', ownerRequest: true }).id;
    s.adapter().scripts = [call('fake_park', { text }), complete()];
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.app.tasks.get(id)!.waiting_kind, 'approval', 'P4: 待ちのある task_complete は承認待ち');
    keepDone(id);
    const [row] = rows(id);
    assert.equal(row!.status, 'waiting');
    return { id, row: row!.id };
  };
  const approve = async (row: number) => {
    const res = await s.json(`/api/pending/${row}/approve`, 'POST');
    assert.equal(res.status, 202);
    await finished(row);
  };
  const reopened = (id: string) => s.app.tasks.events(id).filter(e => e.kind === 'reopened');
  const deps = () => ({ db: s.app.db, tasks: s.app.tasks, pending: s.app.pending, now: () => clock.now, language: () => languageOf(s.app.config()), log: () => undefined });
  return { ...s, clock, rows, keepDone, doneWithRow, approve, reopened, deps };
}

test('5-P2 承認した行が failed で終わると、done のタスクが実行待ちに戻り、経過に理由が残る。判定役の頼みは変わらず、知らせは増えない', async t => {
  const s = await setup(t);
  const { id, row } = await s.doneWithRow('fail');
  const before = s.app.tasks.get(id)!;
  const judged = s.app.tasks.judgeRequest(id);
  const notices = s.app.notifications.list(100).length;
  await s.approve(row);
  assert.equal(s.app.pending.view(row)!.status, 'failed');
  const task = s.app.tasks.get(id)!;
  assert.equal(task.status, 'ready');
  assert.equal(task.run_at, null);
  assert.equal(task.completed_at, null);
  assert.equal(task.owner_request, before.owner_request);
  assert.equal(s.app.tasks.judgeRequest(id), judged);
  const events = s.reopened(id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor, 'beat');
  assert.match(events[0]!.content!, new RegExp(`#${row}\\b`, 'u'));
  assert.match(events[0]!.content!, /ended as failed/u);
  assert.match(events[0]!.content!, /Check what relied on its result/u);
  assert.match(events[0]!.content!, /If a check refused it, do not try the same thing another way/u);
  assert.doesNotMatch(events[0]!.content!, /boom/u);
  assert.equal(s.app.notifications.list(100).length, notices);
  s.adapter().scripts = [complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(id)!.status, 'done');
});

test('5-P2 承認したあと stale で終わっても開き直す', async t => {
  const s = await setup(t);
  const { id, row } = await s.doneWithRow('x');
  s.app.pending.claim(row);
  s.app.pending.finish(row, { status: 'stale' });
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
  assert.match(s.reopened(id)[0]!.content!, /ended as stale/u);
});

test('5-P2 ran で終わりの番号が 1 なら開き直し、0 と番号なし（NULL）なら done のまま', async t => {
  const s = await setup(t);
  const one = await s.doneWithRow('exit1', 'One');
  const zero = await s.doneWithRow('zero', 'Zero');
  const none = await s.doneWithRow('no-code', 'None');
  for (const row of [one.row, zero.row, none.row]) await s.approve(row);
  assert.deepEqual([one.row, zero.row, none.row].map(r => [s.app.pending.view(r)!.status, s.app.pending.view(r)!.exit_code]), [['ran', 1], ['ran', 0], ['ran', null]]);
  assert.equal(s.app.tasks.get(one.id)!.status, 'ready');
  assert.match(s.reopened(one.id)[0]!.content!, /exit code 1/u);
  assert.equal(s.app.tasks.get(zero.id)!.status, 'done');
  assert.equal(s.app.tasks.get(none.id)!.status, 'done');
  assert.equal(s.reopened(zero.id).length + s.reopened(none.id).length, 0);
});

test('5-P2 Reject と取り消し（cancelled）では開き直さない', async t => {
  const s = await setup(t);
  const rejected = await s.doneWithRow('fail', 'Rejected');
  const cancelled = await s.doneWithRow('fail', 'Cancelled');
  s.app.pending.reject(rejected.row, 'no');
  s.app.pending.cancelConversations([s.app.tasks.get(cancelled.id)!.conversation_id!]);
  assert.equal(s.app.pending.view(cancelled.row)!.status, 'cancelled');
  for (const id of [rejected.id, cancelled.id]) {
    assert.equal(s.app.tasks.get(id)!.status, 'done');
    assert.equal(s.reopened(id).length, 0);
  }
});

test('5-P2 承認したあとに再実行が cancelled で終わっても（会話を消した）開き直さない', async t => {
  const s = await setup(t);
  const { id, row } = await s.doneWithRow('fail');
  s.app.pending.claim(row);
  s.app.pending.finish(row, { status: 'cancelled' });
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.equal(s.reopened(id).length, 0);
});

test('5-P2 done でないタスク（failed・cancelled・時刻つきの実行待ち）は 5-P のまま', async t => {
  const s = await setup(t);
  const failed = await s.doneWithRow('fail', 'Failed');
  s.app.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(failed.id);
  const cancelled = await s.doneWithRow('fail', 'Cancelled');
  s.app.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(cancelled.id);
  const later = await s.doneWithRow('fail', 'Later');
  s.app.db.prepare("UPDATE tasks SET status = 'ready', completed_at = NULL, run_at = ? WHERE id = ?").run(START + 3_600_000, later.id);
  for (const row of [failed.row, cancelled.row, later.row]) { s.app.pending.claim(row); s.app.pending.finish(row, { status: 'failed' }); }
  assert.equal(s.app.tasks.get(failed.id)!.status, 'failed');
  assert.equal(s.app.tasks.get(cancelled.id)!.status, 'cancelled');
  assert.equal(s.app.tasks.get(later.id)!.run_at, s.clock.now);
  for (const id of [failed.id, cancelled.id, later.id]) assert.equal(s.reopened(id).length, 0);
});

test('5-P2 開き直したあと（ready）に同じ行の出来事がもう一度来ても、同じタスクの別の行が失敗しても、何もしない（開き直しは 1 回）', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Two', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('fake_park', { text: 'fail' }), call('fake_park', { text: 'exit1' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  s.keepDone(id);
  const [a, b] = s.rows(id);
  await s.approve(a!.id);
  const change = { id: a!.id, status: 'failed' as const, projectId: null, conversationId: s.app.tasks.get(id)!.conversation_id!, taskId: id };
  pendingDecided(s.deps(), change);
  await s.approve(b!.id);
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
  assert.equal(s.reopened(id).length, 1);
});

test('5-P2 見回り（sweepPendingWaits）は開き直さない: 出来事なしに failed で閉じた行の done のタスクは done のまま', async t => {
  const s = await setup(t);
  const { id, row } = await s.doneWithRow('fail');
  s.app.pending.claim(row);
  assert.equal(s.app.pending.closeInterrupted(), 1);
  s.adapter().scripts = [reply('unused')];
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.equal(s.reopened(id).length, 0);
});

test('5-P2 繰り返しのひな形には触らない', async t => {
  const s = await setup(t);
  const { id, row } = await s.doneWithRow('fail');
  s.app.db.prepare("UPDATE tasks SET cron = '0 9 * * *', parent_id = NULL WHERE id = ?").run(id);
  s.app.pending.claim(row);
  s.app.pending.finish(row, { status: 'failed' });
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.equal(s.reopened(id).length, 0);
});

test('5-P2 予定の実行（parent_id あり）は、同じ予定の別の実行がまだ開いていれば開き直さない。開いていなければ開き直す', async t => {
  const s = await setup(t);
  const template = s.app.tasks.create({ title: 'Daily', origin: 'user', actor: 'user', cron: '0 9 * * *' }).id;
  const first = s.app.tasks.spawnNow(template)!.id;
  s.adapter().scripts = [call('fake_park', { text: 'fail' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  s.keepDone(first);
  assert.equal(s.app.tasks.get(first)!.status, 'done');
  const [row] = s.rows(first);
  const second = s.app.tasks.spawnNow(template)!.id;
  assert.equal(s.app.tasks.get(second)!.status, 'ready');
  await s.approve(row!.id);
  assert.equal(s.app.pending.view(row!.id)!.status, 'failed');
  assert.equal(s.app.tasks.get(first)!.status, 'done');
  assert.equal(s.reopened(first).length, 0);
  const open = s.app.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status IN ('ready', 'running', 'waiting')").get(template) as { n: number };
  assert.equal(Number(open.n), 1);
  s.adapter().scripts = [call('fake_park', { text: 'fail' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  s.keepDone(second);
  assert.equal(s.app.tasks.get(second)!.status, 'done');
  const [later] = s.rows(second);
  await s.approve(later!.id);
  assert.equal(s.app.tasks.get(second)!.status, 'ready');
  assert.equal(s.reopened(second).length, 1);
});

test('5-P2 子の担当（agent_run）が積んだ行が失敗すると、親のタスクを開き直す', async t => {
  const s = await setup(t, true);
  const id = s.app.tasks.create({ title: 'Parent', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('agent_run', { task: 'commit it' }), call('fake_park', { text: 'fail' }), reply('child done'), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const parked = s.app.db.prepare('SELECT id, run_kind, task_id FROM pending_actions').all() as Array<{ id: number; run_kind: string; task_id: string }>;
  assert.deepEqual(parked.map(r => [r.run_kind, r.task_id]), [['agent', id]]);
  s.keepDone(id);
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  await s.approve(parked[0]!.id);
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
  assert.equal(s.reopened(id).length, 1);
});

test('5-P2 子のタスク（spawned_by）を開き直しても、もう終わった親は開き直さない', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'Parent', origin: 'user', actor: 'user' }).id;
  s.app.tasks.finish(parent, 'done', 'all done', 'beat');
  const child = await s.doneWithRow('fail', 'Child');
  s.app.db.prepare('UPDATE tasks SET spawned_by = ? WHERE id = ?').run(parent, child.id);
  await s.approve(child.row);
  assert.equal(s.app.tasks.get(child.id)!.status, 'ready');
  assert.equal(s.app.tasks.get(parent)!.status, 'done');
  assert.equal(s.reopened(parent).length, 0);
});

// ── 別の Build が動いている製品で、済んだ Build の承認した行が失敗したとき（開き直しは断られる） ──

async function buildWithRow(s: Awaited<ReturnType<typeof setup>>, title: string) {
  const made = await s.doneWithRow('fail', title);
  // 済んだ Build の形（製品と受け入れの項目を持つ）にする。Build の完了の門は、この試験の対象ではない
  s.app.db.prepare("UPDATE tasks SET project_id = 'shop', acceptance_items = '[\"A-1\"]' WHERE id = ?").run(made.id);
  return made;
}
const failedChange = (s: Awaited<ReturnType<typeof setup>>, made: { id: string; row: number }) => ({ id: made.row, status: 'failed' as const, projectId: null, conversationId: s.app.tasks.get(made.id)!.conversation_id!, taskId: made.id });

test('5-P2 同じ製品で別の Build が動いていると、済んだ Build は開き直さず、経過に理由を残す（呼んだ側には投げない）。別の Build が片づいたあとの再実行は持ち主に任せる', async t => {
  const s = await setup(t);
  const old = await buildWithRow(s, 'Build: 済んだ');
  const other = s.app.tasks.create({ title: 'Build: 動いている', origin: 'user', actor: 'user', projectId: 'shop', acceptanceItems: ['A-1'] });
  const notices = s.app.notifications.list(100).length;
  assert.doesNotThrow(() => pendingDecided(s.deps(), failedChange(s, old)));
  const after = s.app.tasks.get(old.id)!;
  assert.deepEqual([after.status, after.completed_at !== null], ['done', true], '済んだままにする');
  assert.equal(s.reopened(old.id).length, 0);
  const notes = s.app.tasks.events(old.id).filter(event => event.kind === 'skipped');
  assert.equal(notes.length, 1, '開き直さなかった理由が、そのタスクの経過に 1 つ残る');
  assert.equal(notes[0]!.actor, 'beat');
  assert.match(notes[0]!.content!, new RegExp(`#${old.row}\\b`, 'u'));
  assert.match(notes[0]!.content!, /another Build of this product is open/u);
  assert.equal(s.app.notifications.list(100).length, notices, '知らせは増やさない');
  assert.equal(s.app.tasks.get(other.id)!.status, 'ready', '動いている Build には触らない');
});

test('5-P2 同じ製品の別の Build が動いていても、実際の流れ（行が failed で終わる）で済んだ Build の経過に理由が残る。別の製品の Build なら、いつもどおり開き直す', async t => {
  const s = await setup(t);
  const old = await buildWithRow(s, 'Build: 済んだ');
  const elsewhere = await buildWithRow(s, 'Build: 別の製品');
  s.app.db.prepare("UPDATE tasks SET project_id = 'cafe' WHERE id = ?").run(elsewhere.id);
  s.app.tasks.create({ title: 'Build: 動いている', origin: 'user', actor: 'user', projectId: 'shop', acceptanceItems: ['A-1'] });
  s.app.pending.claim(old.row);
  s.app.pending.finish(old.row, { status: 'failed' });
  assert.equal(s.app.tasks.get(old.id)!.status, 'done');
  assert.equal(s.app.tasks.events(old.id).filter(event => event.kind === 'skipped').length, 1);

  s.app.pending.claim(elsewhere.row);
  s.app.pending.finish(elsewhere.row, { status: 'failed' });
  assert.equal(s.app.tasks.get(elsewhere.id)!.status, 'ready', '別の製品の Build は動いていないので、開き直す');
  assert.equal(s.reopened(elsewhere.id).length, 1);
});

test('5-P2 開き直しが Build の断り以外の理由で失敗したときは、今までどおり投げる（経過に断りの理由を書かない）', async t => {
  const s = await setup(t);
  const old = await buildWithRow(s, 'Build: 済んだ');
  const task = s.app.tasks.get(old.id)!;
  const events: string[] = [];
  const tasks = { get: () => task, hasOpenRun: () => false, reopen: () => { throw new Error('disk gone'); }, event: (_id: string, kind: string) => { events.push(kind); } };
  assert.throws(() => pendingDecided({ ...s.deps(), tasks: tasks as never }, failedChange(s, old)), /disk gone/u);
  assert.deepEqual(events, []);
});
