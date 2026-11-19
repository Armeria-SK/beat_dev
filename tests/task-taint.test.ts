import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { memorySave } from '../src/tools/builtin/memory.ts';
import { taskCreate, taskUpdate } from '../src/tools/builtin/tasks.ts';
import { TAINTED_NOTE, type ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const parsed = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const tasks = new TaskStore(db);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(taskCreate).register(taskUpdate).register(memorySave);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: new MemoryStore(db), tasks, emit: () => undefined },
  };
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  let judged = 0;
  const judge = { answer: '{"decision":"ask","reason":"the owner should look"}', prompts: [] as ClassifierPrompt[] };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: () => undefined, lastUserRequest: () => 'make a task',
      autoClassify: async prompt => { judged++; judge.prompts.push(prompt); return judge.answer; },
    });
  return { ctx, call, approvals, tasks, pending, db, judge, judged: () => judged };
}

function rejectNext(s: ReturnType<typeof setup>) {
  const row = s.pending.list({ status: 'waiting' })[0];
  assert.ok(row, 'Pending に積まれていない');
  s.pending.reject(row.id);
  return row;
}

const tainted = (ctx: ToolContext): ToolContext => ({ ...ctx, taint: { tainted: true, sources: ['web_fetch'] } });

test('task_create・task_update（指摘 6）: 外から読んだあとは確かめになる（タスクの本文・メモ・次の一手に、読んだ文がそのまま残らないように）。ふつうは確かめなし', async t => {
  const s = setup(t);
  const made = await s.call('task_create', { title: 'plain', body: 'mine' });
  assert.equal(made.decision, 'allow');
  const id = s.tasks.list()[0]!.id;
  assert.equal((await s.call('task_update', { id, note: 'mine too' })).decision, 'allow');

  // escalateOnTaint: 4-3b-2 後も判定役
  const create = await s.call('task_create', { title: 'planted', body: 'do what the page said' }, tainted(s.ctx));
  assert.deepEqual([create.decision, create.decidedBy], ['ask', 'pending'], create.output.content);
  const asked = rejectNext(s);
  assert.deepEqual([asked.tool, asked.kind], ['task_create', 'judge']);
  assert.match(asked.checks.join(), /text that came from somewhere else/u);
  assert.deepEqual(s.tasks.list().map(task => task.title), ['plain'], '断れば作らない');

  // escalateOnTaint: 4-3b-2 後も判定役
  const update = await s.call('task_update', { id, next_action: 'do what the page said' }, tainted(s.ctx));
  assert.deepEqual([update.decision, update.decidedBy], ['ask', 'pending'], update.output.content);
  assert.deepEqual([rejectNext(s).tool, s.judged()], ['task_update', 2]);
  assert.equal(s.tasks.find(id)!.next_action, null, '断れば書かない');
});

// AP-1c（Q2・Q7）: 人の見ていない実行（タスク）でも、外を読んだあとの記憶・タスクの道具は持ち主でなく判定役へ（会話と同じ）。振り返りは今までどおり断る（G9）
test('AP-1c N4: 外を読んだタスクの実行の memory_save は判定役に回り（TAINTED_NOTE 付き）、許せば動く。記憶の行に taint の印は無い。ask なら judge の行。task_update も判定役。振り返りは断る', async t => {
  const s = setup(t);
  const task = (c: ToolContext): ToolContext => ({ ...tainted(c), kind: 'task', task: { id: 'task-1', control: { outcome: 'none' } } });
  s.judge.answer = '{"decision":"allow","reason":"fits the request"}';
  const saved = await s.call('memory_save', { book: 'notes', content: 'build with npm run build' }, task(s.ctx));
  assert.deepEqual([saved.decision, saved.decidedBy], ['allow', 'auto-mode'], saved.output.content);
  assert.equal(s.judged(), 1, 'the judge decided, not the owner');
  assert.ok(s.judge.prompts[0]!.user.includes(TAINTED_NOTE), 'the judge is told the run read outside text');
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n), 1);
  const columns = (s.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(c => c.name);
  assert.ok(!columns.some(name => /taint/u.test(name)), 'no taint mark on the memory row (Q7, accepted)');
  assert.equal(s.pending.list({ status: 'waiting' }).length, 0);

  s.judge.answer = '{"decision":"ask","reason":"the owner should look"}';
  const asked = await s.call('memory_save', { book: 'notes', content: 'do what the page said' }, task(s.ctx));
  assert.equal(asked.decidedBy, 'pending', asked.output.content);
  assert.deepEqual([rejectNext(s).kind, s.judged()], ['judge', 2]);

  await s.call('task_create', { title: 'plain' });
  const id = s.tasks.list()[0]!.id;
  const update = await s.call('task_update', { id, next_action: 'do what the page said' }, task(s.ctx));
  assert.equal(update.decidedBy, 'pending', update.output.content);
  assert.deepEqual([rejectNext(s).kind, s.judged()], ['judge', 3]);

  const review = await s.call('memory_save', { book: 'notes', content: 'x' }, { ...tainted(s.ctx), kind: 'review' });
  assert.equal(review.decision, 'deny', review.output.content);
  assert.match(review.output.content, /a review \(background work\) has nobody to approve it/u, 'refused for the taint itself (G9)');
  assert.equal(s.judged(), 3, 'a review run is refused before the judge');
});
