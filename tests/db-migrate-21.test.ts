import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';
import { assertMidwayKeepsShape } from './helpers/migrate-midway.ts';

const TABLES = ['conversations', 'messages', 'tasks', 'projects', 'engine_runs', 'kv'] as const;

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(TABLES.map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

function seedV20(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 20));
  try {
    assert.equal(version(db), 20);
    db.prepare("INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES ('p1', 'Shop', 'C:\\Work\\Shop', 'c:\\work\\shop', 1, 1)").run();
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, project_id) VALUES ('chat-1', 'chat', 'Plan', 1, 2, 'p1')").run();
    db.prepare("INSERT INTO messages (conversation_id, role, text, parts, created_at) VALUES ('chat-1', 'user', 'hello', '{\"role\":\"user\",\"content\":\"hello\"}', 3)").run();
    db.prepare("INSERT INTO tasks (id, title, status, origin, project_id, created_at, updated_at) VALUES ('t1', 'Build', 'ready', 'user', 'p1', 1, 1)").run();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('plan:p1', '{}', 5)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 21: 形 20 の DB を今のコードで開いても行は減らず、製品の文書の言語は「まだ決まっていない」。控えができ、もう一度開いても変わらない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV20(path);
  assert.ok(MIGRATIONS.length >= 21);

  const db = openDatabase(path, MIGRATIONS.slice(0, 21), { backupDir: backups });
  try {
    assert.equal(version(db), 21);
    assert.deepEqual(counts(db), before, '行数が前後で同じ');
    const row = db.prepare("SELECT name, doc_language, doc_language_pinned FROM projects WHERE id = 'p1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { name: 'Shop', doc_language: null, doc_language_pinned: 0 });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM acceptance_versions').get() as { n: number }).n, 0);
  } finally { db.close(); }

  const files = readdirSync(backups);
  assert.equal(files.length, 1, '控えは 1 つ');
  assert.match(files[0]!, /-v20-.+\.db$/u);
  const backup = openDatabase(join(backups, files[0]!), MIGRATIONS.slice(0, 20));
  try {
    assert.equal(version(backup), 20);
    assert.deepEqual(counts(backup), before);
    assert.ok(!columns(backup, 'projects').includes('doc_language'));
  } finally { backup.close(); }

  const again = openDatabase(path, MIGRATIONS.slice(0, 21), { backupDir: backups });
  try {
    assert.equal(version(again), 21);
    assert.deepEqual(counts(again), before);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
  assert.throws(() => openDatabase(path, MIGRATIONS.slice(0, 20)), /newer than this app/u, '前の版のコードは形 21 の DB を開かない');
});

test('移し替え 21: 途中で落ちると DB は形 20 のまま（表も列も足されない）', t => assertMidwayKeepsShape(t, 20, seedV20, counts, db => {
  assert.ok(!columns(db, 'projects').includes('doc_language'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'acceptance_versions'").get(), undefined);
}));

test('移し替え 21: acceptance_versions は製品と版の組で 1 行、source は決まった 4 つだけ', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    const add = (version: number, source: string) => db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, source, created_at) VALUES ('p1', ?, 'h', '{}', ?, 1)").run(version, source);
    for (const [v, source] of [[1, 'build'], [2, 'change'], [3, 'question'], [4, 'proposal']] as const) add(v, source);
    assert.throws(() => add(1, 'build'), /UNIQUE constraint failed/u);
    assert.throws(() => add(5, 'owner'), /CHECK constraint failed/u);
    const row = db.prepare("SELECT plan_hash, build_task_id FROM acceptance_versions WHERE version = 1").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { plan_hash: null, build_task_id: null });
  } finally { db.close(); }
});
