import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE memory_file_events'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

test('移し替え 41（10-3）: memory_file_events を足すだけ。前からある表の行（DB の記憶と履歴を含む）は減らず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.equal(AT, 40, 'memory_file_events is migration 41');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    assert.equal(version(seed), AT);
    seed.prepare("INSERT INTO memories (book, content, origin, created_at, updated_at) VALUES ('user', 'likes tea', 'user', 1, 1)").run();
    seed.prepare("INSERT INTO memory_events (memory_id, action, before, after, actor, created_at) VALUES (1, 'create', NULL, 'likes tea', 'beat', 1)").run();
    before = counts(seed);
  } finally { seed.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    const after = counts(db);
    assert.deepEqual({ ...after, memory_file_events: undefined }, { ...before, memory_file_events: undefined });
    assert.equal(after.memory_file_events, 0);
    assert.equal(after.memories, 1);
    assert.equal(after.memory_events, 1);
    db.prepare("INSERT INTO memory_file_events (project_id, name, action, actor, tainted, created_at) VALUES ('p', 'n', 'reviewed', 'owner', 0, 1)").run();
    assert.throws(() => db.prepare("INSERT INTO memory_file_events (project_id, name, action, actor, tainted, created_at) VALUES ('p', 'n', 'create', 'agent', 0, 1)").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO memory_file_events (project_id, name, action, actor, tainted, created_at) VALUES ('p', 'n', 'create', 'beat', 2, 1)").run(), /CHECK/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
