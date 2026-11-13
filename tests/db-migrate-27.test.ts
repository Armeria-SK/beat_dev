import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const counts = (db: DatabaseSync): Record<string, number> => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
  return Object.fromEntries(tables.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
};

function seedV26(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 26));
  try {
    assert.equal(version(db), 26);
    const conversation = db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, permission_mode) VALUES (?, 'chat', ?, 1, 1, ?)");
    conversation.run('c-normal', 'Normal', 'normal');
    conversation.run('c-auto', 'Auto', 'auto');
    conversation.run('c-plan', 'Plan', 'plan');
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('c-default', 'task', 'Default', 1, 1)").run();
    const approval = db.prepare("INSERT INTO approvals (id, run_id, conversation_id, tool, input, input_hash, reasons, status, scope, created_at, expires_at, decided_at) VALUES (?, 'r', 'c-auto', 'shell_run', '{}', 'h', '[]', ?, ?, 1, 2, ?)");
    approval.run('a-pending', 'pending', null, null);
    approval.run('a-approved', 'approved', 'auto', 5);
    approval.run('a-denied', 'denied', 'once', 6);
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 27: 形 26 の DB を開くと normal の会話が auto に、pending の札の行が cancelled になり、ほかの行と行の数は変わらず、控えができる', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV26(path);
  assert.ok(MIGRATIONS.length >= 27);
  const started = Date.now();

  const db = openDatabase(path, MIGRATIONS.slice(0, 27), { backupDir: backups });
  try {
    assert.equal(version(db), 27);
    assert.deepEqual(counts(db), before);
    assert.deepEqual(db.prepare('SELECT id, permission_mode FROM conversations ORDER BY id').all().map(r => ({ ...r })), [
      { id: 'c-auto', permission_mode: 'auto' }, { id: 'c-default', permission_mode: 'auto' }, { id: 'c-normal', permission_mode: 'auto' }, { id: 'c-plan', permission_mode: 'plan' },
    ]);
    const approvals = db.prepare('SELECT id, status, scope, decided_at FROM approvals ORDER BY id').all().map(r => ({ ...r })) as Array<{ id: string; status: string; scope: string | null; decided_at: number | null }>;
    assert.deepEqual(approvals.map(a => [a.id, a.status, a.scope]), [['a-approved', 'approved', 'auto'], ['a-denied', 'denied', 'once'], ['a-pending', 'cancelled', null]]);
    assert.deepEqual(approvals.filter(a => a.id !== 'a-pending').map(a => a.decided_at), [5, 6]);
    const closed = approvals.find(a => a.id === 'a-pending')!.decided_at!;
    assert.ok(closed >= Math.floor(started / 1000) * 1000 && closed <= Date.now(), `片づけた時刻は今（ミリ秒）: ${closed}`);
  } finally { db.close(); }

  assert.match(readdirSync(backups).join(','), /-v26-.+\.db/u);
  const again = openDatabase(path, MIGRATIONS.slice(0, 27), { backupDir: backups });
  try {
    assert.equal(version(again), 27);
    assert.deepEqual(counts(again), before);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('移し替え 27 のあと: 古い控えから戻した normal の行も、読むときは auto', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, permission_mode) VALUES ('old', 'chat', 'Old', 1, 1, 'normal')").run();
    const conversations = new Conversations(db);
    assert.equal(conversations.get('old')!.permission_mode, 'auto');
    assert.equal(conversations.modeOf('old'), 'auto');
    assert.equal(conversations.list().find(c => c.id === 'old')!.permission_mode, 'auto');
    assert.equal(conversations.listByProject().conversations.find(c => c.id === 'old')!.permission_mode, 'auto');
  } finally { db.close(); }
});
