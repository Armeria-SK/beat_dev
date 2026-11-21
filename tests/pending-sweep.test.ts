import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { tempDir, type Script, withLoad } from './helpers.ts';

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const checkpoint = () => call('task_checkpoint', { tried: 'tried', result: 'result', next_action: 'next' });

// 動かす中身（target.txt）の指紋を bind にする道具。方針 ask で必ず Pending に積まれる
function boundTool(runs: string[]): ToolDef {
  const bound: ToolDef<{ text: string }> = {
    name: 'fake_bound', description: 'Test tool: runs target.txt.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['task'],
    summarize: input => ({ title: 'Bound', body: input.text }),
    preCheck: (_input, ctx) => {
      const file = join(ctx.workspace, 'target.txt');
      const content = existsSync(file) ? readFileSync(file, 'utf8') : 'none';
      return { decision: 'allow', reasons: [], bind: createHash('sha256').update(content).digest('hex') };
    },
    async execute(input) { runs.push(input.text); return { content: 'ran', exitCode: 0 }; },
  };
  return bound as unknown as ToolDef;
}

async function setup(t: Parameters<typeof startApp>[0]) {
  const runs: string[] = [];
  const hookLog = join(tempDir(t), 'hook.log');
  const hook = join(tempDir(t), 'hook.mjs');
  writeFileSync(hook, `import { appendFileSync } from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{appendFileSync(${JSON.stringify(hookLog)}, 'x\\n');process.exit(0)});`);
  const s = await startApp(t, {
    models: [fakeModel('m1')], tools: [...builtinTools(), boundTool(runs)],
    configure: c => {
      c.tools.policies = { fake_bound: 'ask' };
      c.memory.review = false;
      c.tools.hooks.preToolUse = [...c.tools.hooks.preToolUse, { matcher: 'fake_bound', command: [process.execPath, hook], timeoutMs: 10_000, onError: 'deny' }];
    },
  });
  const rows = (taskId: string) => s.app.db.prepare('SELECT id, status, output_preview FROM pending_actions WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; status: string; output_preview: string | null }>;
  const hookCalls = () => (existsSync(hookLog) ? readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).length : 0);
  const toolTexts = (taskId: string) => s.app.conversations.messages(s.app.tasks.get(taskId)!.conversation_id!).filter(m => m.message.role === 'tool').map(m => m.text);
  return { ...s, runs, rows, hookCalls, toolTexts };
}

test('P5: bind のファイルを書くと待ちの行が stale で閉じ、担当は道具の結果の末尾で知る。sweep では持ち主のフックが呼ばれない', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  let hooksAtPark = -1;
  const write: Script = async function* (req) { hooksAtPark = s.hookCalls(); yield* call('file_write', { path: 'target.txt', content: 'v2' })(req); };
  s.adapter().scripts = [call('fake_bound', { text: 'run' }), write, checkpoint()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const [row] = s.rows(id);
  assert.equal(row!.status, 'stale');
  assert.match(row!.output_preview!, /what it would run changed after it was parked/u);
  const written = s.toolTexts(id).find(text => text.includes('target.txt') && text.includes('Closed Pending item'));
  assert.ok(written, JSON.stringify(s.toolTexts(id)));
  assert.match(written!, new RegExp(`Closed Pending item #${row!.id} without running it, because you changed what it would run`, 'u'));
  const pendingEvents = s.app.tasks.events(id).filter(e => e.kind === 'pending');
  assert.deepEqual(pendingEvents.map(e => e.actor), ['beat'], '持ち主の承認として記録しない');
  assert.match(pendingEvents[0]!.content!, new RegExp(`#${row!.id} closed by beat`, 'u'));
  assert.doesNotMatch(JSON.stringify(s.adapter().calls.map(c => c.messages)), /owner approved Pending/u, '承認の知らせをモデルに送らない');
  assert.ok(hooksAtPark >= 1, '積むときにはフックが走る（前提）');
  assert.equal(s.hookCalls(), hooksAtPark, 'sweep ではフックを走らせない');
  assert.deepEqual(s.runs, []);
});

test('P5: 関係ないファイルを書いても閉じない', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('fake_bound', { text: 'run' }), call('file_write', { path: 'other.txt', content: 'x' }), checkpoint()];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.rows(id).map(r => r.status), ['waiting']);
  assert.ok(!s.toolTexts(id).some(text => text.includes('Closed Pending item')));
});

test('P5: 同じ中身・同じ bind の park は同じ番号を返し、中身（bind）が変われば新しい番号', async t => {
  const s = await setup(t);
  const id = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user' }).id;
  s.adapter().scripts = [call('fake_bound', { text: 'run' }), call('fake_bound', { text: 'run' }), checkpoint()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const first = s.rows(id);
  assert.deepEqual(first.map(r => r.status), ['waiting'], '重ねない');
  appendFileSync(join(s.paths.workspace, 'target.txt'), 'changed by someone else');
  s.app.tasks.setReady(id, { runAt: Date.now() });
  s.adapter().scripts = [call('fake_bound', { text: 'run' }), checkpoint()];
  assert.equal(await s.app.worker.tick(), 'ran');
  const after = s.rows(id);
  assert.equal(after.length, 2, '中身が変われば新しい行');
  assert.notEqual(after[1]!.id, first[0]!.id);
  s.adapter().scripts = [call('fake_bound', { text: 'other input' }), checkpoint()];
  s.app.tasks.setReady(id, { runAt: Date.now() });
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.rows(id).length, 3, '引数が違えば新しい行');
});
