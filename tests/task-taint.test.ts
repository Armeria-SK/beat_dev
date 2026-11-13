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
import { taskCreate, taskUpdate } from '../src/tools/builtin/tasks.ts';
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
  const registry = new ToolRegistry().register(taskCreate).register(taskUpdate);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: new MemoryStore(db), tasks, emit: () => undefined },
  };
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  let judged = 0;
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: () => undefined, conversationAutoRead: () => false, lastUserRequest: () => 'make a task',
      autoClassify: async () => { judged++; return '{"decision":"ask","reason":"the owner should look"}'; },
    });
  return { ctx, call, approvals, tasks, pending, judged: () => judged };
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

  // 4-3b-2: taintEscalation を消すと順 2
  const create = await s.call('task_create', { title: 'planted', body: 'do what the page said' }, tainted(s.ctx));
  assert.deepEqual([create.decision, create.decidedBy], ['ask', 'pending'], create.output.content);
  const asked = rejectNext(s);
  assert.deepEqual([asked.tool, asked.kind], ['task_create', 'judge']);
  assert.match(asked.checks.join(), /text that came from somewhere else/u);
  assert.deepEqual(s.tasks.list().map(task => task.title), ['plain'], '断れば作らない');

  // 4-3b-2: taintEscalation を消すと順 2
  const update = await s.call('task_update', { id, next_action: 'do what the page said' }, tainted(s.ctx));
  assert.deepEqual([update.decision, update.decidedBy], ['ask', 'pending'], update.output.content);
  assert.deepEqual([rejectNext(s).tool, s.judged()], ['task_update', 2]);
  assert.equal(s.tasks.find(id)!.next_action, null, '断れば書かない');
});
