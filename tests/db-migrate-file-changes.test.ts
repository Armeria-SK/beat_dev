import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE file_changes'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const insert = (db: DatabaseSync, action: string, kept: number, place: string | null = null) => db.prepare(
  "INSERT INTO file_changes (project_id, place, run_id, conversation_id, task_id, batch, path, action, before_hash, after_hash, size, kept, created_at) VALUES ('p', ?, 'r', 'c', NULL, NULL, 'a.txt', ?, NULL, NULL, 0, ?, 1)").run(place, action, kept);

test('書き換えの記録の移し替え: 前の版の DB に当てると空の file_changes ができ、ほかの表の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'file_changes migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES ('c1', 'chat', 1, 1)").run();
    before = counts(old);
    assert.ok(!tables(old).includes('file_changes'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), { ...before, file_changes: 0 });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_changes' AND name LIKE 'ix_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    assert.deepEqual(indexes, ['ix_file_changes_project', 'ix_file_changes_run']);
    insert(db, 'create', 1);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(counts(again).file_changes, 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('書き換えの記録の移し替え: action と kept は決まった値だけ、place は NULL か worktree の id', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    assert.throws(() => insert(db, 'delete', 1), /CHECK/u);
    assert.throws(() => insert(db, 'create', 2), /CHECK/u);
    for (const action of ['create', 'modify', 'undo', 'redo']) insert(db, action, 0);
    insert(db, 'modify', 1, 'abcd1234');
    assert.equal(counts(db).file_changes, 5);
  } finally { db.close(); }
});
