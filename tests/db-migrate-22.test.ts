import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type Migration } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { tempDir } from './helpers.ts';

const TABLES = ['conversations', 'messages', 'tasks', 'projects', 'acceptance_versions', 'kv'] as const;

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(TABLES.map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

function seedV21(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 21));
  try {
    assert.equal(version(db), 21);
    db.prepare("INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES ('p1', 'Shop', 'C:\\Work\\Shop', 'c:\\work\\shop', 1, 1)").run();
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, project_id) VALUES ('chat-1', 'chat', 'Plan', 1, 2, 'p1')").run();
    db.prepare("INSERT INTO messages (conversation_id, role, text, parts, created_at) VALUES ('chat-1', 'user', 'hello', '{\"role\":\"user\",\"content\":\"hello\"}', 3)").run();
    db.prepare("INSERT INTO tasks (id, title, status, origin, project_id, created_at, updated_at) VALUES ('t1', 'Build', 'ready', 'user', 'p1', 1, 1)").run();
    db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, build_task_id, created_at) VALUES ('p1', 1, 'h', '{}', 'build', 't1', 4)").run();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('plan:p1', '{}', 5)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 22: 形 21 の DB を今のコードで開いても行は減らず、前からあるタスクの受け持ちの項目は NULL。控えができ、もう一度開いても変わらない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV21(path);
  assert.ok(MIGRATIONS.length >= 22);
  assert.match(String(MIGRATIONS[21]), /ALTER TABLE tasks ADD COLUMN acceptance_items TEXT/u);

  const db = openDatabase(path, MIGRATIONS.slice(0, 22), { backupDir: backups });
  try {
    assert.equal(version(db), 22);
    assert.deepEqual(counts(db), before, '行数が前後で同じ');
    const row = db.prepare("SELECT title, acceptance_items FROM tasks WHERE id = 't1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { title: 'Build', acceptance_items: null });
  } finally { db.close(); }

  const files = readdirSync(backups);
  assert.equal(files.length, 1, '控えは 1 つ');
  assert.match(files[0]!, /-v21-.+\.db$/u);
  const backup = openDatabase(join(backups, files[0]!), MIGRATIONS.slice(0, 21));
  try {
    assert.equal(version(backup), 21);
    assert.deepEqual(counts(backup), before);
    assert.ok(!columns(backup, 'tasks').includes('acceptance_items'));
  } finally { backup.close(); }

  const again = openDatabase(path, MIGRATIONS.slice(0, 22), { backupDir: backups });
  try {
    assert.equal(version(again), 22);
    assert.deepEqual(counts(again), before);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
  assert.throws(() => openDatabase(path, MIGRATIONS.slice(0, 21)), /newer than this app/u, '前の版のコードは形 22 の DB を開かない');
});

test('移し替え 22: 途中で落ちると DB は形 21 のまま（列が足されない）', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const before = seedV21(path);
  const failing: Migration[] = [...MIGRATIONS.slice(0, 21), db => { db.exec(String(MIGRATIONS[21])); throw new Error('stopped midway'); }];
  assert.throws(() => openDatabase(path, failing, { backupDir: join(dir, 'backups') }), /stopped midway/u);
  assert.ok(existsSync(join(dir, 'backups')));
  const db = openDatabase(path, MIGRATIONS.slice(0, 21));
  try {
    assert.equal(version(db), 21);
    assert.deepEqual(counts(db), before);
    assert.ok(!columns(db, 'tasks').includes('acceptance_items'));
  } finally { db.close(); }
});

test('移し替え 22: TaskStore.create は受け持ちの項目を JSON の配列で書き、渡さなければ NULL', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    const tasks = new TaskStore(db);
    const built = tasks.create({ title: 'Build: Shop', origin: 'user', actor: 'user', acceptanceItems: ['A-1', 'A-3'] });
    const empty = tasks.create({ title: 'Build: Cafe', origin: 'user', actor: 'user', acceptanceItems: [] });
    const plain = tasks.create({ title: 'Tidy', origin: 'user', actor: 'user' });
    assert.equal(built.acceptance_items, '["A-1","A-3"]');
    assert.equal(empty.acceptance_items, '[]');
    assert.equal(plain.acceptance_items, null);
  } finally { db.close(); }
});
