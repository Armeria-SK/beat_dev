import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Type } from '@sinclair/typebox';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { runToolCall, TOOL_OUTPUT_LIMIT } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

const echo: ToolDef<{ text: string; fail?: boolean }> = {
  name: 'echo_probe', description: 'echo', effect: 'read', allowedIn: ['chat', 'task', 'review', 'agent'],
  input: Type.Object({ text: Type.String(), fail: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  execute: async input => ({ content: input.text, ...(input.fail ? { isError: true } : {}) }),
};

const parkable: ToolDef<{ text: string }> = {
  name: 'park_probe', description: 'park', effect: 'exec', allowedIn: ['chat', 'task', 'agent'],
  input: Type.Object({ text: Type.String() }, { additionalProperties: false }),
  preCheck: () => ({ decision: 'ask', reasons: ['needs a look'] }),
  execute: async input => ({ content: input.text }),
};

function rig(t: { after: (fn: () => void) => void }, file = false) {
  let db: DatabaseSync | undefined;
  t.after(() => { try { db?.close(); } catch { } });
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  const config = parseConfig(raw);
  const policy = buildPolicy(config, paths);
  const registry = new ToolRegistry().register(echo).register(parkable);
  const events: RunEvent[] = [];
  const dbPath = file ? join(paths.data, 'beat.sqlite') : ':memory:';
  db = openDatabase(dbPath, MIGRATIONS);
  const open = (): DatabaseSync => db!;
  const base: ToolContext = {
    runId: 'r1', conversationId: 'task-conv', kind: 'task', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, over: Partial<ToolContext> = {}) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, { ...base, ...over }, {
      registry, approvals: new ApprovalBroker(open()), pending: new PendingStore(open(), { tools: registry, dataDir: paths.data }), db: open(),
      emit: e => events.push(e), lastUserRequest: () => 'do it', autoClassify: async () => '{"decision":"ask","reason":"not sure"}',
    });
  const numbers = (conversationId = 'task-conv') =>
    (open().prepare('SELECT evidence_no FROM tool_calls WHERE conversation_id = ? ORDER BY created_at, rowid').all(conversationId) as Array<{ evidence_no: number | null }>).map(r => r.evidence_no);
  const reopen = () => { open().close(); db = openDatabase(dbPath, MIGRATIONS); };
  return { call, numbers, reopen, events, db: open, paths };
}

test('5-3b-t: task tool results end with [E-n], numbered 1, 2, 3 within the task conversation', async t => {
  const r = rig(t);
  const outs = [await r.call('echo_probe', { text: 'a' }), await r.call('echo_probe', { text: 'b' }), await r.call('echo_probe', { text: 'c' })];
  assert.deepEqual(outs.map(o => o.output.content.match(/\[E-(\d+)\]$/u)?.[1]), ['1', '2', '3']);
  assert.ok(outs[0]!.output.content.startsWith('a'));
  assert.deepEqual(r.numbers(), [1, 2, 3]);
  const shown = r.events.filter(e => e.type === 'tool.result').map(e => (e as { preview: string }).preview);
  assert.match(shown[2]!, /\[E-3\]$/u);
});

test('5-3b-t: numbering continues across runs and across a restart, and each task conversation has its own sequence', async t => {
  const r = rig(t, true);
  await r.call('echo_probe', { text: 'a' });
  await r.call('echo_probe', { text: 'b' }, { runId: 'r2' });
  r.reopen();
  const after = await r.call('echo_probe', { text: 'c' }, { runId: 'r3' });
  assert.match(after.output.content, /\[E-3\]$/u);
  const other = await r.call('echo_probe', { text: 'x' }, { conversationId: 'other-task-conv' });
  assert.match(other.output.content, /\[E-1\]$/u);
  assert.deepEqual(r.numbers(), [1, 2, 3]);
  assert.deepEqual(r.numbers('other-task-conv'), [1]);
});

test('5-3b-t: chat, review and child agent tool calls carry no tag', async t => {
  const r = rig(t);
  const chat = await r.call('echo_probe', { text: 'a' }, { kind: 'chat', conversationId: 'chat-conv' });
  const review = await r.call('echo_probe', { text: 'b' }, { kind: 'review', conversationId: 'review-conv' });
  const agent = await r.call('echo_probe', { text: 'c' }, { kind: 'agent', conversationId: 'child-conv', parent: { runId: 'r1', conversationId: 'task-conv', kind: 'task', title: 'parent', taskId: 't1' } });
  assert.deepEqual([chat, review, agent].map(o => o.output.content), ['a', 'b', 'c']);
  assert.deepEqual([...r.numbers('chat-conv'), ...r.numbers('review-conv'), ...r.numbers('child-conv')], [null, null, null]);
  const next = await r.call('echo_probe', { text: 'd' });
  assert.match(next.output.content, /\[E-1\]$/u);
});

test('5-3b-t: a truncated long result still ends with its tag', async t => {
  const r = rig(t);
  const out = await r.call('echo_probe', { text: 'x'.repeat(TOOL_OUTPUT_LIMIT * 2) });
  assert.match(out.output.content, /only [0-9,]+ of [0-9,]+ characters were returned/u);
  assert.match(out.output.content, /\[E-1\]$/u);
});

test('5-3b-t: failed, refused and parked calls are tagged too, and a parked record is not decision allow', async t => {
  const r = rig(t);
  const failed = await r.call('echo_probe', { text: 'boom', fail: true });
  const refused = await r.call('no_such_tool', {});
  const parked = await r.call('park_probe', { text: 'p' });
  assert.equal(parked.decidedBy, 'pending', parked.output.content);
  assert.deepEqual([failed, refused, parked].map(o => o.output.content.match(/\[E-(\d+)\]$/u)?.[1]), ['1', '2', '3']);
  const rows = r.db().prepare('SELECT evidence_no, ok, decision FROM tool_calls WHERE conversation_id = ? ORDER BY evidence_no').all('task-conv') as Array<{ evidence_no: number; ok: number; decision: string }>;
  assert.deepEqual(rows.map(row => [row.evidence_no, row.ok, row.decision]), [[1, 0, 'allow'], [2, 0, 'deny'], [3, 1, 'ask']]);
});
