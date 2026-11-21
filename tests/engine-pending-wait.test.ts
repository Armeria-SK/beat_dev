import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { reply, type Script, withLoad } from './helpers.ts';

const call = (name: string, args: unknown, before?: () => void): Script => async function* (req) {
  before?.();
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const complete = (before?: () => void) => call('task_complete', { summary: 'done', notify: false }, before);

function parkTool(runs: string[]): ToolDef {
  const park: ToolDef<{ text: string }> = {
    name: 'fake_park', description: 'Test tool: needs approval.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['task'],
    summarize: input => ({ title: 'Park', body: input.text }),
    async execute(input) { runs.push(input.text); return { content: `ran ${input.text}`, exitCode: 0 }; },
  };
  return park as unknown as ToolDef;
}

async function setup(t: Parameters<typeof startApp>[0], pendingWaitMs: number) {
  const runs: string[] = [];
  const s = await startApp(t, {
    models: [fakeModel('m1')], tools: [...builtinTools(), parkTool(runs)], pendingWaitMs,
    configure: c => { c.tools.policies = { fake_park: 'ask' }; c.memory.review = false; },
  });
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  const rows = () => s.app.db.prepare('SELECT id, status FROM pending_actions WHERE task_id = ? ORDER BY id').all(id) as Array<{ id: number; status: string }>;
  const runIds = () => (s.app.db.prepare('SELECT DISTINCT run_id FROM messages WHERE conversation_id = ? AND run_id IS NOT NULL').all(s.app.tasks.get(id)!.conversation_id!) as Array<{ run_id: string }>).map(r => r.run_id);
  const warnings: string[] = [];
  const unsubscribe = s.app.bus.subscribe(({ event }) => { if (event.type === 'warning' && event.code === 'pending_wait') warnings.push(event.message); });
  t.after(unsubscribe);
  const later = (fn: () => unknown, ms = 100) => { setTimeout(() => { void fn(); }, ms); };
  return { ...s, runs, id, rows, runIds, warnings, later };
}

test('P6: 待ちの間に承認されると、同じ実行のままもう 1 回モデルが呼ばれ、新しい実行は起きない', async t => {
  const s = await setup(t, 20_000);
  s.adapter().scripts = [
    call('fake_park', { text: 'commit' }),
    complete(() => s.later(() => s.json(`/api/pending/${s.rows()[0]!.id}/approve`, 'POST'))),
    complete(),
  ];
  const began = Date.now();
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(Date.now() - began < 15_000, '待ちは決めで終わる（上限まで待たない）');
  assert.deepEqual(s.runs, ['commit']);
  assert.equal(s.adapter().calls.length, 3, '承認のあと同じ実行でもう 1 回呼ばれる');
  assert.equal(s.runIds().length, 1, '新しい実行は無い');
  assert.equal(s.app.tasks.get(s.id)!.status, 'done');
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0]!, /Waiting for the owner to decide on Pending \(up to 1 more min\)/u);
  const notes = s.app.conversations.messages(s.app.tasks.get(s.id)!.conversation_id!).filter(m => m.message.role === 'user' && m.message.note === 'pending');
  assert.equal(notes.length, 1, '承認の結果は同じ実行の中で担当に届く');
});

test('P6: 返事だけで終わろうとしても、待ちがあれば待ち、決まれば続ける', async t => {
  const s = await setup(t, 20_000);
  s.adapter().scripts = [
    call('fake_park', { text: 'commit' }),
    async function* (req) { s.later(() => s.app.pending.reject(s.rows()[0]!.id, 'not now')); yield* reply('waiting for the owner')(req); },
    complete(),
  ];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 3);
  assert.equal(s.runIds().length, 1);
  assert.equal(s.app.tasks.get(s.id)!.status, 'done');
});

test('P6: 時間切れなら承認待ちで終わる（モデルは呼び直さない）', async t => {
  const s = await setup(t, 300);
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), complete()];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 2);
  const task = s.app.tasks.get(s.id)!;
  assert.deepEqual([task.status, task.waiting_kind], ['waiting', 'approval']);
  assert.deepEqual(s.rows().map(r => r.status), ['waiting']);
});

test('P6: 待っている間に持ち主がタスクを取り消すと、すぐ終わる', async t => {
  const s = await setup(t, 60_000);
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), complete(() => s.later(() => s.json(`/api/tasks/${s.id}/cancel`, 'POST', {})))];
  const began = Date.now();
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(Date.now() - began < 20_000, `取り消しで待ちが終わる（${Date.now() - began} ms）`);
  assert.equal(s.app.tasks.get(s.id)!.status, 'cancelled');
  assert.deepEqual(s.rows().map(r => r.status), ['cancelled']);
  assert.equal(s.adapter().calls.length, 2);
});

test('P6: 待ちが無ければ待たない', async t => {
  const s = await setup(t, 60_000);
  s.adapter().scripts = [reply('nothing to do')];
  const began = Date.now();
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(Date.now() - began < 20_000);
  assert.equal(s.warnings.length, 0);
  assert.equal(s.adapter().calls.length, 1);
});

test('P6: 返事だけで終わって時間切れになったら、承認待ちで終わる（すぐの新しい実行にしない）', async t => {
  const s = await setup(t, 300);
  s.adapter().scripts = [call('fake_park', { text: 'commit' }), reply('waiting for the owner')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 2);
  const task = s.app.tasks.get(s.id)!;
  assert.deepEqual([task.status, task.waiting_kind], ['waiting', 'approval']);
});
