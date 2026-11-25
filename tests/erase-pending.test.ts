import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { openDatabase } from '../src/db/database.ts';
import { eraseConversation } from '../src/db/erase.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { closedByBeat, PendingStore } from '../src/pending/store.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const echo: ToolDef<{ text: string }> = {
  name: 'fake_echo', description: 'echo', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task'],
  summarize: input => ({ title: 'Echo', body: input.text }),
  execute: async input => ({ content: input.text }),
};

const CHANGED = 'File src/secret-plan.ts changed after it was parked';
const NO = 'Owner said no because of private-reason-text';

test('V2: 会話を消しても、beat が閉じた承認待ちの行は「古くなった（承認できる）」行に見え戻らない。理由の中身は消える', async t => {
  const dir = tempDir(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const store = new PendingStore(db, { tools: new ToolRegistry().register(echo), dataDir: dir, now: () => 1_000_000 });
  const park = () => store.park({
    tool: 'fake_echo', input: { text: 'x' }, cwd: dir, kind: 'send', reason: 'Runs code', runId: 'run-1', runKind: 'chat', conversationId: 'conv-1', check: { decision: 'ask', reasons: ['Runs code'] },
  });

  const closed = await park();
  assert.equal(store.closeStale(closed.id, CHANGED), true);
  const replayed = await park();
  db.prepare("UPDATE pending_actions SET status = 'stale', reject_reason = NULL WHERE id = ?").run(replayed.id);
  const rejected = await park();
  store.reject(rejected.id, NO);

  const row = (id: number) => store.row(id)!;
  assert.equal(closedByBeat(row(closed.id)), true, '前提: beat が閉じた行');
  assert.equal(closedByBeat(row(replayed.id)), false, '前提: 理由の無い stale の行');

  eraseConversation({ db, uploadsDir: dir, toolOutputsDir: dir }, 'conv-1');

  assert.equal(row(closed.id).reject_reason, 'stale', 'beat が閉じた行は、閉じた印のまま');
  assert.equal(closedByBeat(row(closed.id)), true);
  assert.equal(row(replayed.id).reject_reason, null, '理由の無い stale の行は、理由が無いまま');
  assert.equal(closedByBeat(row(replayed.id)), false);
  assert.equal(row(rejected.id).reject_reason, null, 'rejected の行の理由は消える');
  const all = JSON.stringify(db.prepare('SELECT * FROM pending_actions').all());
  assert.equal(all.includes('secret-plan') || all.includes('private-reason-text'), false, '元の理由の文はどの欄にも残らない');
});
