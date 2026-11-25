import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { PendingStore } from '../src/pending/store.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { tempDir } from './helpers.ts';

// backlog 388: 積んだあとで beat が預かる値が増えたとき（積んだ時点では預かっていなかった鍵）、決めたあとの行に残る「聞いた理由（reason）」と「確かめの文（checks）」は、
// 預かった値を [BEAT-SECRET: …] の印にして残す。決め方は 6 つ（却下・動かした・会話ごと取り消し・取り下げ・古くなって閉じた・動かしている途中で止まった）あり、どれも同じ印の付け方を通る

const VALUE = 'zq81-held-value-4f2a9c';
const MARK = '[BEAT-SECRET: env SEARCH_API_KEY]';

function setup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const held: Array<{ source: string; value: string }> = [];
  const store = new PendingStore(db, { tools: new ToolRegistry().register(shellRun), dataDir: dir, now: () => 1_000_000, held: () => held });
  let seq = 0;
  const park = (over: { reason?: string; checks?: string[]; conversationId?: string } = {}) => store.park({
    tool: 'shell_run', input: { command: 'npm test' }, cwd: dir, kind: 'send', reason: over.reason ?? `Sends data with ${VALUE} attached`, checks: over.checks ?? [`outside the folder, key ${VALUE}`, 'Sends data out'],
    runId: `run-${++seq}`, runKind: 'chat', conversationId: over.conversationId ?? `conv-${seq}`, check: { decision: 'ask', reasons: ['r'] },
  });
  const hold = () => { held.push({ source: 'env SEARCH_API_KEY', value: VALUE }); };
  return { store, park, hold };
}

const expectMarked = (store: PendingStore, id: number, label: string): void => {
  const row = store.row(id)!;
  assert.equal(row.reason, `Sends data with ${MARK} attached`, `${label}: reason`);
  assert.deepEqual(JSON.parse(row.checks), [`outside the folder, key ${MARK}`, 'Sends data out'], `${label}: checks`);
  const view = store.view(id)!;
  assert.equal(view.reason, `Sends data with ${MARK} attached`, `${label}: 返す形の reason`);
  assert.deepEqual(view.checks, [`outside the folder, key ${MARK}`, 'Sends data out'], `${label}: 返す形の checks`);
  assert.ok(!JSON.stringify(row).includes(VALUE), `${label}: 行のどこにも値が残らない`);
};

test('前提: 積んだ時点で預かっていない値は、待っている行の reason・checks に生のまま残る（あとで預かる値を印にするのは、決めるときの仕事）', async t => {
  const s = setup(t);
  const row = await s.park();
  const saved = s.store.row(row.id)!;
  assert.ok(saved.reason.includes(VALUE));
  assert.ok(saved.checks.includes(VALUE));
});

test('却下（reject）: 積んだあとで預かった値は、決めたあとの reason・checks で印になる', async t => {
  const s = setup(t);
  const row = await s.park();
  s.hold();
  s.store.reject(row.id, 'no');
  expectMarked(s.store, row.id, 'reject');
});

test('動かした（claim → finish）: ran でも failed でも、決めたあとの reason・checks で印になる', async t => {
  const s = setup(t);
  for (const status of ['ran', 'failed'] as const) {
    const row = await s.park();
    s.hold();
    s.store.claim(row.id);
    s.store.finish(row.id, { status, exitCode: status === 'ran' ? 0 : 1, output: 'done' });
    expectMarked(s.store, row.id, `finish ${status}`);
  }
});

test('会話ごと取り消し（cancelConversations）・取り下げ（withdraw）・古くなって閉じた（closeStale）も、決めたあとの reason・checks で印になる', async t => {
  const s = setup(t);
  const cancelled = await s.park({ conversationId: 'conv-gone' });
  const withdrawn = await s.park();
  const stale = await s.park();
  s.hold();
  assert.equal(s.store.cancelConversations(['conv-gone']), 1);
  assert.equal(s.store.withdraw(withdrawn.id, 'task ended'), true);
  assert.equal(s.store.closeStale(stale.id, 'the folder moved'), true);
  expectMarked(s.store, cancelled.id, 'cancelConversations');
  expectMarked(s.store, withdrawn.id, 'withdraw');
  expectMarked(s.store, stale.id, 'closeStale');
});

test('動かしている途中で止まった行（closeInterrupted）も、決めたあとの reason・checks で印になる', async t => {
  const s = setup(t);
  const row = await s.park();
  s.hold();
  s.store.claim(row.id);
  assert.equal(s.store.closeInterrupted(), 1);
  assert.equal(s.store.row(row.id)!.status, 'failed');
  expectMarked(s.store, row.id, 'closeInterrupted');
});

test('預かった値が出てこない理由・確かめの文は、決めたあとも今のまま（印を付けすぎない）', async t => {
  const s = setup(t);
  const row = await s.park({ reason: 'Sends data out', checks: ['outside the folder'] });
  s.hold();
  s.store.reject(row.id);
  const saved = s.store.row(row.id)!;
  assert.equal(saved.reason, 'Sends data out');
  assert.deepEqual(JSON.parse(saved.checks), ['outside the folder']);
});
