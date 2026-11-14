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
const modes = (db: DatabaseSync): Array<{ id: string; permission_mode: string }> =>
  db.prepare('SELECT id, permission_mode FROM conversations ORDER BY id').all().map(r => ({ ...r })) as Array<{ id: string; permission_mode: string }>;

test('会話を作るとき、モードを渡さない行（タスク・子・振り返り）も列に auto を書く', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    const conversations = new Conversations(db);
    conversations.create({ id: 'task', kind: 'task', title: 'Task' });
    conversations.create({ id: 'chat', title: 'Chat' });
    conversations.create({ id: 'child', parentRunId: 'r1' });
    assert.deepEqual(modes(db), [{ id: 'chat', permission_mode: 'auto' }, { id: 'child', permission_mode: 'auto' }, { id: 'task', permission_mode: 'auto' }]);
  } finally { db.close(); }
});

test('移し替え 28: 形 27 のあとに列の既定値で書かれた normal の行を auto にし、plan と行の数は変わらず、控えができる', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, 27));
  try {
    assert.equal(version(seed), 27);
    seed.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('c-default', 'task', 'Default', 1, 1)").run();
    seed.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, permission_mode) VALUES ('c-plan', 'chat', 'Plan', 1, 1, 'plan')").run();
    assert.deepEqual(modes(seed), [{ id: 'c-default', permission_mode: 'normal' }, { id: 'c-plan', permission_mode: 'plan' }]);
  } finally { seed.close(); }
  assert.ok(MIGRATIONS.length >= 28);

  const db = openDatabase(path, MIGRATIONS.slice(0, 28), { backupDir: backups });
  try {
    assert.equal(version(db), 28);
    assert.deepEqual(modes(db), [{ id: 'c-default', permission_mode: 'auto' }, { id: 'c-plan', permission_mode: 'plan' }]);
  } finally { db.close(); }
  assert.match(readdirSync(backups).join(','), /-v27-.+\.db/u);
});
