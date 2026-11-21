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

test('task_create・task_update（P3 で反転）: 外から読んだあとも、ふつうと同じく確かめなし（R18）', async t => {
  const s = setup(t);
  const made = await s.call('task_create', { title: 'plain', body: 'mine' });
  assert.equal(made.decision, 'allow');
  const id = s.tasks.list()[0]!.id;
  assert.equal((await s.call('task_update', { id, note: 'mine too' })).decision, 'allow');

  const create = await s.call('task_create', { title: 'after reading', body: 'from the page' }, tainted(s.ctx));
  assert.deepEqual([create.decision, create.decidedBy], [made.decision, made.decidedBy], create.output.content);
  const update = await s.call('task_update', { id, next_action: 'from the page' }, tainted(s.ctx));
  assert.equal(update.decision, 'allow', update.output.content);
  assert.equal(s.judged(), 0);
  assert.equal(s.pending.list({ status: 'waiting' }).length, 0);
  assert.equal(s.tasks.find(id)!.next_action, 'from the page');
});

// P3: 人の見ていない実行（タスク）でも、外を読んだあとの記憶・タスクの道具は、外を読んでいない実行と同じ（判定役も持ち主も通らない）。振り返りは今までどおり断る（G9）
test('AP-1c N4（P3 で反転）: 外を読んだタスクの実行の memory_save・task_update は、外を読んでいない実行と同じく確かめなしに動く。振り返りは断る', async t => {
  const s = setup(t);
  const task = (c: ToolContext, dirty: boolean): ToolContext => ({ ...(dirty ? tainted(c) : c), kind: 'task', task: { id: 'task-1', control: { outcome: 'none' } } });
  s.judge.answer = '{"decision":"ask","reason":"the owner should look"}';
  const clean = await s.call('memory_save', { book: 'notes', content: 'build with npm run build' }, task(s.ctx, false));
  const saved = await s.call('memory_save', { book: 'notes', content: 'from the page' }, task(s.ctx, true));
  assert.deepEqual([saved.decision, saved.decidedBy], [clean.decision, clean.decidedBy], saved.output.content);
  assert.equal(saved.decision, 'allow');
  assert.equal(Number((s.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n), 2);
  const columns = (s.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(c => c.name);
  assert.ok(!columns.some(name => /taint/u.test(name)), 'no taint mark on the memory row (Q7, accepted)');

  await s.call('task_create', { title: 'plain' });
  const id = s.tasks.list()[0]!.id;
  const update = await s.call('task_update', { id, next_action: 'from the page' }, task(s.ctx, true));
  assert.equal(update.decision, 'allow', update.output.content);
  assert.equal(s.judged(), 0);
  assert.equal(s.pending.list({ status: 'waiting' }).length, 0);

  const review = await s.call('memory_save', { book: 'notes', content: 'x' }, { ...tainted(s.ctx), kind: 'review' });
  assert.equal(review.decision, 'deny', review.output.content);
  assert.match(review.output.content, /a review \(background work\) has nobody to approve it/u, 'refused for the taint itself (G9)');
  assert.equal(s.judged(), 0, 'a review run is refused before the judge');
});
