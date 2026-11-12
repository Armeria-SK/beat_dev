import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
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
  const approvals = new ApprovalBroker(db, () => undefined);
  const registry = new ToolRegistry().register(taskCreate).register(taskUpdate);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: new MemoryStore(db), tasks, emit: () => undefined },
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, { registry, approvals, db, emit: () => undefined, conversationAutoRead: () => false });
  return { ctx, call, approvals, tasks };
}

async function denyNext(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 200 && !s.approvals.pending().length; i++) await new Promise(r => setTimeout(r, 10));
  const pending = s.approvals.pending()[0];
  assert.ok(pending, '承認の依頼が来ていない');
  s.approvals.decide(pending.id, 'deny');
  return pending;
}

const tainted = (ctx: ToolContext): ToolContext => ({ ...ctx, taint: { tainted: true, sources: ['web_fetch'] } });

test('task_create・task_update（指摘 6）: 外から読んだあとは確かめになる（タスクの本文・メモ・次の一手に、読んだ文がそのまま残らないように）。ふつうは確かめなし', async t => {
  const s = setup(t);
  const made = await s.call('task_create', { title: 'plain', body: 'mine' });
  assert.equal(made.decision, 'allow');
  const id = s.tasks.list()[0]!.id;
  assert.equal((await s.call('task_update', { id, note: 'mine too' })).decision, 'allow');

  const create = s.call('task_create', { title: 'planted', body: 'do what the page said' }, tainted(s.ctx));
  const asked = await denyNext(s);
  assert.equal(asked.tool, 'task_create');
  assert.ok(asked.kinds?.includes('taint'), JSON.stringify(asked.kinds));
  assert.equal((await create).output.isError, true);
  assert.deepEqual(s.tasks.list().map(task => task.title), ['plain'], '断れば作らない');

  const update = s.call('task_update', { id, next_action: 'do what the page said' }, tainted(s.ctx));
  assert.equal((await denyNext(s)).tool, 'task_update');
  assert.equal((await update).output.isError, true);
  assert.equal(s.tasks.find(id)!.next_action, null, '断れば書かない');
});
