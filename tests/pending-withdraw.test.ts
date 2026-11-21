import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { startApp, fakeModel } from './app-setup.ts';
import { type Script, withLoad } from './helpers.ts';

const START = Date.parse('2026-11-21T03:00:00Z');

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const complete = () => call('task_complete', { summary: 'done', notify: false });
const together = (...pairs: Array<[string, unknown]>): Script => async function* (req) {
  for (const [name, args] of pairs) {
    const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  }
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function fakeTools(runs: string[]): ToolDef[] {
  const park: ToolDef<{ text: string }> = {
    name: 'fake_park', description: 'Test tool: needs approval.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['task', 'chat'],
    summarize: input => ({ title: 'Park', body: input.text }),
    async execute(input) { runs.push(input.text); return { content: `ran ${input.text}`, exitCode: 0 }; },
  };
  const work: ToolDef<{ text: string }> = {
    name: 'fake_work', description: 'Test tool: plain work.', input: Type.Object({ text: Type.String() }), effect: 'read', allowedIn: ['task'],
    async execute(input) { return { content: `worked ${input.text}` }; },
  };
  return [park as unknown as ToolDef, work as unknown as ToolDef];
}

async function setup(t: Parameters<typeof startApp>[0]) {
  const clock = { now: START };
  const runs: string[] = [];
  const s = await startApp(t, {
    models: [fakeModel('m1')], tools: [...builtinTools(), ...fakeTools(runs)], now: () => clock.now,
    configure: c => { c.tools.policies = { fake_park: 'ask', fake_work: 'allow' }; c.memory.review = false; },
  });
  const rows = (taskId: string) => s.app.db.prepare('SELECT id, status, reject_reason FROM pending_actions WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; status: string; reject_reason: string | null }>;
  const product = () => {
    const root = join(s.paths.workspace, 'shop');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'check.js'), "require('node:fs').writeFileSync('checked.txt', 'x')\n");
    const project = s.app.projects.create({ name: 'Shop', root, rootKey: rootKeyOf(root), checkCommand: 'node check.js' });
    return { root, id: project.id };
  };
  const toolResults = (taskId: string) => s.app.conversations.messages(s.app.tasks.get(taskId)!.conversation_id!).filter(m => m.message.role === 'tool').map(m => m.text);
  return { ...s, clock, runs, rows, product, toolResults };
}

test('P4: 待ちのある task_complete は done にならず、確かめのコマンドも動かない。仕事をした実行でも承認待ちになり、すぐの新しい実行は起きない', async t => {
  const s = await setup(t);
  const shop = s.product();
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: shop.id }).id;
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), call('fake_work', { text: 'more' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.rows(id);
  assert.equal(row!.status, 'waiting');
  const task = s.app.tasks.get(id)!;
  assert.deepEqual([task.status, task.waiting_kind, task.waiting_text], ['waiting', 'approval', `#${row!.id}`]);
  assert.equal(existsSync(join(shop.root, 'checked.txt')), false, '確かめのコマンドは動いていない');
  assert.equal(s.app.tasks.events(id).some(e => e.kind === 'check_passed' || e.kind === 'check_failed'), false);
  const last = s.toolResults(id).at(-1)!;
  assert.match(last, new RegExp(`Pending #${row!.id} is still waiting`, 'u'));
  assert.match(last, /pending_withdraw/u);
  const calls = s.adapter().calls.length;
  s.adapter().scripts = [complete()];
  assert.equal(await s.app.worker.tick(), 'idle', '承認待ちのタスクは選ばれない');
  assert.equal(s.adapter().calls.length, calls);
  assert.deepEqual(s.runs, []);
});

test('P4: pending_withdraw で自分の待ちを取り下げると cancelled になり、次の task_complete で確かめが動いて done になる。取り下げた物の承認は not_waiting', async t => {
  const s = await setup(t);
  const shop = s.product();
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: shop.id }).id;
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.rows(id);
  s.adapter().scripts = [call('pending_withdraw', { id: row!.id }), complete()];
  s.app.tasks.setReady(id, { runAt: START });
  assert.equal(await s.app.worker.tick(), 'ran');
  const [after] = s.rows(id);
  assert.equal(after!.status, 'cancelled');
  assert.match(after!.reject_reason!, /Withdrawn by beat/u);
  assert.equal(s.app.tasks.get(id)!.status, 'done');
  assert.equal(existsSync(join(shop.root, 'checked.txt')), true, '待ちが無くなれば確かめが動く');
  const approved = await s.json(`/api/pending/${row!.id}/approve`, 'POST');
  assert.equal(approved.status, 409);
  assert.match(JSON.stringify(approved.body), /no longer waiting/u);
  assert.deepEqual(s.runs, [], '取り下げた呼び出しは動かない');
});

test('P4: pending_withdraw はほかのタスクの待ちを取り下げない', async t => {
  const s = await setup(t);
  const other = s.app.tasks.create({ title: 'Other', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('fake_park', { text: 'theirs' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const [theirs] = s.rows(other);
  const mine = s.app.tasks.create({ title: 'Mine', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('pending_withdraw', { id: theirs!.id }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.rows(other)[0]!.status, 'waiting');
  assert.match(s.toolResults(mine).find(text => text.includes(`#${theirs!.id}`))!, /cannot be withdrawn here/u);
  assert.equal(s.app.tasks.get(mine)!.status, 'done');
});

test('P4: 持ち主が承認待ちのタスクを取り消すと、待ちも cancelled（理由はタスクが終わった）。ほかの終わり方（failed・done）でも同じ', async t => {
  const s = await setup(t);
  const ids: string[] = [];
  for (const title of ['Cancel', 'Fail', 'Done']) {
    const id = s.app.tasks.create({ title, origin: 'user', actor: 'user' }).id;
    s.adapter().scripts = [call('fake_park', { text: title }), complete()];
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.app.tasks.get(id)!.waiting_kind, 'approval');
    ids.push(id);
  }
  const cancelled = await s.json(`/api/tasks/${ids[0]}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200);
  s.app.tasks.finish(ids[1]!, 'failed', 'x', 'beat');
  s.app.tasks.finish(ids[2]!, 'done', 'x', 'user');
  for (const id of ids) {
    const [row] = s.rows(id);
    assert.equal(row!.status, 'cancelled', id);
    assert.match(row!.reject_reason!, /the task it came from has finished/u);
  }
  assert.equal(s.app.tasks.get(ids[2]!)!.status, 'done', '取り下げはタスクを開き直さない');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
  assert.deepEqual(s.runs, []);
});

test('P4: 同じ回で task_complete のあとに積んだ待ちがあれば done にせず、持ち主の決めを待つ', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [together(['task_complete', { summary: 'done', notify: false }], ['fake_park', { text: 'late' }])];
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.rows(id);
  assert.equal(row!.status, 'waiting', '待ちは取り下げない');
  const task = s.app.tasks.get(id)!;
  assert.deepEqual([task.status, task.waiting_kind, task.waiting_text], ['waiting', 'approval', `#${row!.id}`]);
  assert.deepEqual(s.runs, []);
});

test('P4: 積んで自分で取り下げるだけの回は仕事にも決めにも数えず、進展なしで止まる', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Loop', origin: 'user', actor: 'user' }).id;
  const withdrawLatest: Script = async function* (req) {
    const latest = s.rows(id).filter(r => r.status === 'waiting').at(-1)!;
    yield* call('pending_withdraw', { id: latest.id })(req);
  };
  const checkpoint = () => call('task_checkpoint', { tried: 'tried', result: 'result', next_action: 'next' });
  for (let run = 0; run < 6 && s.app.tasks.get(id)!.status !== 'failed'; run++) {
    s.adapter().scripts = [call('fake_park', { text: `p${run}` }), withdrawLatest, checkpoint()];
    s.app.tasks.setReady(id, { runAt: START });
    assert.equal(await s.app.worker.tick(), 'ran');
  }
  assert.equal(s.app.tasks.get(id)!.status, 'failed');
  assert.equal(s.rows(id).length, 3, '3 回で止まる');
  assert.deepEqual(s.runs, []);
});
