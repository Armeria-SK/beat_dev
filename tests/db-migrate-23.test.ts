import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type Migration } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const TABLES = ['conversations', 'messages', 'tasks', 'projects', 'acceptance_versions', 'kv'] as const;

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(TABLES.map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as Array<{ name: string }>).map(r => r.name);

function seedV22(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 22));
  try {
    assert.equal(version(db), 22);
    db.prepare("INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES ('p1', 'Shop', 'C:\\Work\\Shop', 'c:\\work\\shop', 1, 1)").run();
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, project_id) VALUES ('chat-1', 'chat', 'Plan', 1, 2, 'p1')").run();
    db.prepare("INSERT INTO messages (conversation_id, role, text, parts, created_at) VALUES ('chat-1', 'user', 'hello', '{\"role\":\"user\",\"content\":\"hello\"}', 3)").run();
    db.prepare("INSERT INTO tasks (id, title, status, origin, project_id, acceptance_items, created_at, updated_at) VALUES ('t1', 'Build', 'ready', 'user', 'p1', '[\"A-1\"]', 1, 1)").run();
    db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, build_task_id, created_at) VALUES ('p1', 1, 'h', '{}', 'build', 't1', 4)").run();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('plan:p1', '{}', 5)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 23: 形 22 の DB を今のコードで開いても行は減らず、空の acceptance_changes と索引ができる。控えができ、もう一度開いても変わらない。前の版のコードは開かない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV22(path);
  assert.equal(MIGRATIONS.length, 23);
  assert.match(String(MIGRATIONS[22]), /CREATE TABLE acceptance_changes/u);

  const db = openDatabase(path, MIGRATIONS, { backupDir: backups });
  try {
    assert.equal(version(db), 23);
    assert.deepEqual(counts(db), before, '行数が前後で同じ');
    assert.ok(tables(db).includes('acceptance_changes'));
    assert.ok(tables(db).includes('ix_acceptance_changes_project'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM acceptance_changes').get() as { n: number }).n, 0);
    const insert = db.prepare('INSERT INTO acceptance_changes (id, project_id, base_version, ops, language, conversation_id, tainted, status, created_at) VALUES (?, ?, 1, ?, NULL, NULL, 0, ?, 1)');
    insert.run('c1', 'p1', '[]', 'pending');
    for (const status of ['approved', 'rejected', 'superseded']) insert.run(`c-${status}`, 'p1', '[]', status);
    assert.throws(() => insert.run('c-bad', 'p1', '[]', 'done'), /CHECK constraint/u, '状態は 4 つだけ');
    assert.throws(() => db.prepare("INSERT INTO acceptance_changes (id, project_id, base_version, ops, status, created_at) VALUES ('c-text', 'p1', 'one', '[]', 'pending', 1)").run(), /cannot store TEXT value in INTEGER column/u, 'STRICT');
    const row = db.prepare("SELECT tainted, decided_at FROM acceptance_changes WHERE id = 'c1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { tainted: 0, decided_at: null });
  } finally { db.close(); }

  const files = readdirSync(backups);
  assert.equal(files.length, 1, '控えは 1 つ');
  assert.match(files[0]!, /-v22-.+\.db$/u);
  const backup = openDatabase(join(backups, files[0]!), MIGRATIONS.slice(0, 22));
  try {
    assert.equal(version(backup), 22);
    assert.deepEqual(counts(backup), before);
    assert.ok(!tables(backup).includes('acceptance_changes'));
  } finally { backup.close(); }

  const again = openDatabase(path, MIGRATIONS, { backupDir: backups });
  try {
    assert.equal(version(again), 23);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
  assert.throws(() => openDatabase(path, MIGRATIONS.slice(0, 22)), /newer than this app/u, '前の版のコードは形 23 の DB を開かない');
});

test('移し替え 23: 途中で落ちると DB は形 22 のまま（表ができない）', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const before = seedV22(path);
  const failing: Migration[] = [...MIGRATIONS.slice(0, 22), db => { db.exec(String(MIGRATIONS[22])); throw new Error('stopped midway'); }];
  assert.throws(() => openDatabase(path, failing, { backupDir: join(dir, 'backups') }), /stopped midway/u);
  assert.ok(existsSync(join(dir, 'backups')));
  const db = openDatabase(path, MIGRATIONS.slice(0, 22));
  try {
    assert.equal(version(db), 22);
    assert.deepEqual(counts(db), before);
    assert.ok(!tables(db).includes('acceptance_changes'));
  } finally { db.close(); }
});
