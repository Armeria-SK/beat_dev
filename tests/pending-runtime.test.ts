import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { pendingNote, closedEvent } from '../src/pending/notes.ts';
import { replayAction, type ReplayDeps } from '../src/pending/replay.ts';
import { sweepStale } from '../src/pending/sweep.ts';
import { closedByBeat, PendingStore, type ParkRuntimeInput, type PendingChange, type PendingRow } from '../src/pending/store.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { startApp } from './app-setup.ts';
import { tempDir, testConfig } from './helpers.ts';

// AR-8a: a request an outside runtime waits on is a Pending row of its own kind ("runtime"). beat never runs it: the owner's answer is only passed back (status "answered")

const VALUE = 'zq81-held-value-4f2a9c';
const MARK = '[BEAT-SECRET: env SEARCH_API_KEY]';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const held: Array<{ source: string; value: string }> = [];
  const changes: PendingChange[] = [];
  const store = new PendingStore(db, { tools: new ToolRegistry().register(shellRun), dataDir: dir, now: () => 1_000_000, held: () => held, onChange: change => { changes.push(change); } });
  let seq = 0;
  const park = (over: Partial<ParkRuntimeInput> = {}) => store.parkRuntime({
    runtimeId: 'claude-code', tool: 'claude-code:Write', requestId: `req-${++seq}`, title: 'Write a.txt', body: 'hello', cwd: null, extra: null, reason: 'Claude Code is waiting for your answer: Write',
    checks: ['a check'], reply: false, root: dir, runId: `run-${seq}`, conversationId: 'conv-1', projectId: null, ...over,
  });
  return { dir, db, store, park, held, changes };
}

test('行を作る: runtime の種類で積まれ、動かせる入力は持たず、札は預かった値を印にして出し、決めたあとは印の付かない形で残る', t => {
  const s = setup(t);
  s.held.push({ source: 'env SEARCH_API_KEY', value: VALUE });
  const view = s.park({ title: `Write ${VALUE}.txt`, body: `token=${VALUE}`, cwd: `C:/work/${VALUE}`, extra: JSON.stringify({ key: VALUE }), reason: `waits ${VALUE}`, checks: [`check ${VALUE}`], reply: true });
  const row = s.store.row(view.id)!;
  assert.deepEqual([row.kind, row.status, row.tool, row.run_kind, row.tainted, row.bind, row.files, row.task_id], ['runtime', 'waiting', 'claude-code:Write', 'chat', 1, null, null, null]);
  assert.deepEqual(JSON.parse(row.input), { request: 'req-1' }, 'only the id of the request is kept: nothing beat could run');
  assert.ok(!JSON.stringify(row).includes(VALUE), 'the stored row never holds a held value');
  assert.deepEqual([view.title, view.parts.body, view.parts.cwd, view.masked > 0, view.held, view.runtime, view.rule], [`Write ${MARK}.txt`, `token=${MARK}`, `C:/work/${MARK}`, true, ['env SEARCH_API_KEY'], { id: 'claude-code', reply: true }, null]);
  assert.equal(view.reason, 'waits [REDACTED]');
  assert.deepEqual(view.checks, ['check [REDACTED]']);
  assert.equal(s.store.rememberableNow(row), false, 'a runtime row can never become a rule');
  assert.deepEqual(s.changes.map(c => [c.id, c.status, c.conversationId, c.taskId]), [[view.id, 'waiting', 'conv-1', null]]);
  assert.equal(s.store.counts(0).waiting, 1);

  s.store.claim(view.id);
  const done = s.store.finish(view.id, { status: 'answered', reason: 'Allowed' })!;
  assert.deepEqual([done.status, done.reject_reason, done.ran_at, done.exit_code, done.output_preview], ['answered', 'Allowed', null, null, null]);
  const settled = s.store.row(view.id)!;
  assert.deepEqual([settled.input, settled.status], ['', 'answered']);
  assert.ok(!JSON.stringify(settled).includes(VALUE));
  assert.deepEqual(s.changes.map(c => c.status), ['waiting', 'running', 'answered']);
  assert.equal(s.store.finish(view.id, { status: 'ran' })!.status, 'answered', 'a second finish changes nothing');
  assert.deepEqual(s.store.list({ status: 'decided' }).map(i => i.id), [view.id], 'an answered row is in the decided list');
  assert.equal(s.store.counts(0).waiting, 0);
});

test('行を作る: 札のパターン（鍵に見える文）は待っているあいだは見え、決めたあとは伏せられる', t => {
  const s = setup(t);
  const view = s.park({ body: 'curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://example.com' });
  assert.match(view.parts.body ?? '', /Bearer abcdefghijklmnop1234567890/u, 'the owner decides on what the runtime really asked');
  s.store.reject(view.id, 'no');
  const after = s.store.view(view.id)!;
  assert.ok(!(after.parts.body ?? '').includes('abcdefghijklmnop1234567890'), after.parts.body ?? '');
  assert.ok(!after.shown.includes('abcdefghijklmnop1234567890'));
});

test('決まり方: 却下・取り下げ・古くなった・会話ごとの取り消しは、どれも waiting の行だけを、その行の ID で閉じる', t => {
  const s = setup(t);
  const [a, b, c, d] = [s.park(), s.park(), s.park(), s.park({ conversationId: 'conv-x' })];
  assert.equal(s.store.reject(a.id, 'no').status, 'rejected');
  assert.equal(s.store.withdraw(b.id, 'gone'), true);
  assert.equal(s.store.closeStale(c.id, 'late'), true);
  assert.equal(s.store.cancelConversations(['conv-x']), 1);
  assert.deepEqual([a, b, c, d].map(v => s.store.row(v.id)!.status), ['rejected', 'cancelled', 'stale', 'cancelled']);
  for (const id of [a.id, b.id, c.id, d.id]) {
    assert.equal(s.store.withdraw(id, 'again'), false);
    assert.equal(s.store.closeStale(id, 'again'), false);
    assert.throws(() => s.store.reject(id), /not waiting|waiting/iu);
  }
  assert.equal(closedByBeat(s.store.row(c.id)!), true, 'a stale row with a reason is one beat closed');
});

test('beat の起動: 答えを待っていた求めと動かし中の求めは、実行役がもういないので古くして閉じる。答えた行と別の種類の行は変えない', t => {
  const s = setup(t);
  const waiting = s.park();
  const running = s.park();
  s.store.claim(running.id);
  const answered = s.park();
  s.store.claim(answered.id);
  s.store.finish(answered.id, { status: 'answered' });
  const rejected = s.park();
  s.store.reject(rejected.id);
  s.db.prepare("INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, status, created_at) VALUES ('shell_run', '{}', 'x', 'judge', 'r', 'r9', 'chat', 'c9', 'waiting', 1)").run();
  s.db.prepare("INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, status, created_at) VALUES ('shell_run', '{}', 'x', 'judge', 'r', 'r9', 'chat', 'c9', 'running', 1)").run();
  const seen = s.changes.length;

  assert.equal(s.store.closeRuntimeWaiting('beat was restarted, so the runtime that asked for this is gone'), 1);
  assert.equal(s.store.closeInterrupted(), 2);
  const status = (id: number) => s.store.row(id)!.status;
  assert.deepEqual([waiting, running, answered, rejected].map(v => status(v.id)), ['stale', 'stale', 'answered', 'rejected']);
  const restarted = 'beat was restarted, so the runtime that asked for this is gone';
  assert.deepEqual([waiting, running].map(v => s.store.row(v.id)!.reject_reason), [restarted, restarted]);
  assert.equal(s.store.row(running.id)!.ran_at, null);
  const others = s.db.prepare("SELECT status FROM pending_actions WHERE kind = 'judge' ORDER BY id").all() as Array<{ status: string }>;
  assert.deepEqual(others.map(r => r.status), ['waiting', 'failed'], 'a waiting row of another kind is left alone; a running one is failed, as before');
  assert.equal(s.changes.length - seen, 1, 'closing the waiting one told the screen once (the interrupted ones are closed quietly, as before)');
});

test('モデルへの知らせ（note）と出来事の行は、実行役の求めには付かない。ほかの種類の閉じた行には付く', t => {
  const s = setup(t);
  const states: Array<(id: number) => void> = [
    id => { s.store.reject(id, 'no'); }, id => { s.store.withdraw(id, 'gone'); }, id => { s.store.closeStale(id, 'late'); },
    id => { s.store.claim(id); s.store.finish(id, { status: 'answered' }); }, id => { s.store.claim(id); s.store.finish(id, { status: 'failed', output: 'x' }); },
  ];
  for (const settle of states) {
    const view = s.park();
    settle(view.id);
    const row = s.store.row(view.id)!;
    assert.equal(pendingNote(row, s.store.view(view.id)!), undefined, row.status);
    assert.equal(closedEvent(row), undefined, row.status);
  }
  const other = { ...s.store.row(s.park().id)!, kind: 'judge' as const, status: 'rejected' as const, reject_reason: 'no' };
  assert.ok(pendingNote(other, s.store.view(other.id)!), 'premise: the same row of another kind does get a note');
});

test('runtime の行は動かし直されない: replayAction は何も動かさず「実行役の求めなので beat は動かさない」で閉じ、古さの掃き出しも触らない', async t => {
  const s = await startApp(t, {});
  const store = s.app.pending;
  const park = (over: Partial<ParkRuntimeInput> = {}) => store.parkRuntime({
    runtimeId: 'claude-code', tool: 'claude-code:Write', requestId: 'r1', title: 'Write a.txt', body: 'x', cwd: null, extra: null, reason: 'waits', reply: false, root: tempDir(t), runId: 'run-1', conversationId: 'conv-1', projectId: null, ...over,
  });
  const deps: ReplayDeps = {
    db: s.app.db, store, registry: s.app.tools, config: () => s.app.config(), paths: s.app.paths, projects: s.app.projects,
    conversationExists: () => true, log: () => undefined,
  };
  const view = park();
  const claimed = store.claim(view.id);
  const outcome = await replayAction(claimed, deps);
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.output ?? '', /request from an outside runtime.*never runs the request itself/u);
  assert.equal(store.row(view.id)!.status, 'failed');

  const tasked = park({ requestId: 'r2' });
  const state = JSON.parse(store.row(tasked.id)!.state!) as Record<string, unknown>;
  s.app.db.prepare('UPDATE pending_actions SET task_id = ?, state = ? WHERE id = ?').run('task-1', JSON.stringify({ ...state, cwdReal: 'C:/a-folder-that-is-not-here' }), tasked.id);
  assert.deepEqual(await sweepStale('task-1', deps), [], 'a row that would look stale to the generic check is still not touched');
  assert.equal(store.row(tasked.id)!.status, 'waiting', 'the sweep leaves a runtime row alone');
});

test('beat を立て直すと（同じ DB を新しい App が開くと）、前に待っていた実行役の求めは古くして閉じ、ログに 1 行残る。答えた行は変わらない', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const databasePath = join(dir, 'beat.db');
  const open = () => {
    const logs: string[] = [];
    return { app: new App({ paths, databasePath, log: line => { logs.push(line); }, workerTimers: false, env: {} }), logs };
  };
  const first = open();
  const input = (requestId: string): ParkRuntimeInput => ({
    runtimeId: 'codex', tool: 'codex:commandExecution', requestId, title: 'Run a command (Codex)', body: 'ls', cwd: dir, extra: null, reason: 'waits', reply: false, root: dir, runId: 'run-1', conversationId: 'conv-1', projectId: null,
  });
  const waiting = first.app.pending.parkRuntime(input('w'));
  const answered = first.app.pending.parkRuntime(input('a'));
  first.app.pending.claim(answered.id);
  first.app.pending.finish(answered.id, { status: 'answered' });
  const running = first.app.pending.parkRuntime(input('r'));
  first.app.pending.claim(running.id);
  first.app.close();

  const second = open();
  try {
    const rows = second.app.db.prepare('SELECT id, status, reject_reason FROM pending_actions ORDER BY id').all() as unknown as PendingRow[];
    assert.deepEqual(rows.map(r => [r.id, r.status]), [[waiting.id, 'stale'], [answered.id, 'answered'], [running.id, 'stale']]);
    assert.ok(rows.filter(r => r.status === 'stale').every(r => r.reject_reason === 'beat was restarted, so the runtime that asked for this is gone'));
    assert.ok(second.logs.some(line => /Closed 1 request\(s\) of outside runtimes that were waiting/u.test(line)), second.logs.join('\n'));
    assert.equal(second.app.runtimeApprovals.size, 0);
  } finally { second.app.close(); }
});
