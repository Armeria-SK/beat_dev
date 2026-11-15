import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';
import { assertMidwayKeepsShape } from './helpers/migrate-midway.ts';

const TABLES = ['conversations', 'messages', 'tasks', 'task_events', 'memories', 'skill_registry', 'notifications', 'engine_runs', 'kv'] as const;

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(TABLES.map(table => [table, (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n]));
}

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

function seedV19(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 19));
  try {
    assert.equal(version(db), 19);
    for (const [id, kind] of [['chat-1', 'chat'], ['chat-2', 'chat'], ['task-conv', 'task'], ['review-conv', 'task']] as const) {
      db.prepare('INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES (?, ?, ?, 1, 2)').run(id, kind, `title ${id}`);
    }
    db.prepare("UPDATE conversations SET source_conversation_id = 'chat-1' WHERE id = 'review-conv'").run();
    for (const id of ['chat-1', 'chat-1', 'chat-2', 'task-conv']) db.prepare("INSERT INTO messages (conversation_id, role, text, parts, created_at) VALUES (?, 'user', 'hello', '{\"role\":\"user\",\"content\":\"hello\"}', 3)").run(id);
    db.prepare("INSERT INTO tasks (id, title, status, origin, cron, timezone, run_at, created_at, updated_at) VALUES ('template', 'Every morning', 'scheduled', 'user', '0 9 * * *', 'UTC', 99, 1, 1)").run();
    db.prepare("INSERT INTO tasks (id, title, status, origin, parent_id, conversation_id, created_at, updated_at) VALUES ('child', 'Every morning', 'done', 'schedule', 'template', 'task-conv', 1, 1)").run();
    db.prepare("INSERT INTO tasks (id, title, status, origin, created_at, updated_at) VALUES ('proposal', 'An idea', 'inbox', 'self', 1, 1)").run();
    db.prepare("INSERT INTO task_events (task_id, kind, actor, created_at) VALUES ('child', 'created', 'system', 1)").run();
    db.prepare("INSERT INTO memories (book, content, origin, created_at, updated_at) VALUES ('user', 'Likes short answers', 'user', 1, 1)").run();
    db.prepare("INSERT INTO memories (book, content, origin, created_at, updated_at) VALUES ('notes', 'Notes live in docs', 'review', 1, 1)").run();
    db.prepare("INSERT INTO skill_registry (name, source, registered_at) VALUES ('weekly-report', 'owner', 1)").run();
    db.prepare("INSERT INTO notifications (kind, title, link, created_at) VALUES ('task_done', 'Done', '#/tasks/child', 1)").run();
    db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('run-1', 'chat', 'chat-1', 1)").run();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('archived-at:chat-2', '5', 5)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 20: 形 19 の DB を今のコードで開いても、行は 1 つも減らず、会話とタスクの project_id は全部 NULL。開く前の控えができ、もう一度開いても何も変わらない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV19(path);
  const db = openDatabase(path, MIGRATIONS.slice(0, 20), { backupDir: backups });
  try {
    assert.equal(version(db), 20);
    assert.deepEqual(counts(db), before, '行数が前後で同じ');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id IS NOT NULL').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id IS NOT NULL OR proposed_by IS NOT NULL').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 0);
    const kept = db.prepare("SELECT title, kind, source_conversation_id AS source FROM conversations WHERE id = 'review-conv'").get() as { title: string; kind: string; source: string };
    assert.deepEqual({ ...kept }, { title: 'title review-conv', kind: 'task', source: 'chat-1' }, '前からある列の値はそのまま');
    const child = db.prepare("SELECT parent_id, conversation_id, status FROM tasks WHERE id = 'child'").get() as Record<string, unknown>;
    assert.deepEqual({ ...child }, { parent_id: 'template', conversation_id: 'task-conv', status: 'done' });
    assert.equal((db.prepare("SELECT content FROM memories WHERE book = 'user'").get() as { content: string }).content, 'Likes short answers');
  } finally { db.close(); }

  const files = readdirSync(backups);
  assert.equal(files.length, 1, '控えは 1 つ');
  assert.match(files[0]!, /^beat-v19-.+\.db$/u);
  const backup = openDatabase(join(backups, files[0]!), MIGRATIONS.slice(0, 19));
  try {
    assert.equal(version(backup), 19, '控えは形 19 のまま');
    assert.deepEqual(counts(backup), before, '控えに全部の行がある');
    assert.ok(!columns(backup, 'conversations').includes('project_id'));
  } finally { backup.close(); }

  const again = openDatabase(path, MIGRATIONS.slice(0, 20), { backupDir: backups });
  try {
    assert.equal(version(again), 20);
    assert.deepEqual(counts(again), before);
    assert.equal(readdirSync(backups).length, 1, '形が同じなら控えを取り直さない');
  } finally { again.close(); }
});

test('移し替え 20: 途中で落ちると、DB は形 19 のまま（表も列も足されない）で、行も残る', t => assertMidwayKeepsShape(t, 19, seedV19, counts, db => {
  assert.ok(!columns(db, 'conversations').includes('project_id'));
  assert.ok(!columns(db, 'tasks').includes('project_id'));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get(), undefined);
}));

test('移し替え 20: 同じフォルダ（root_key）の使っている製品は 1 つだけ。しまった製品とは重なってよい。前の版のコードは形 20 の DB を開かない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const db = openDatabase(path, MIGRATIONS);
  try {
    const add = (id: string, archivedAt: number | null) => db.prepare('INSERT INTO projects (id, name, root, root_key, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)').run(id, id, 'C:\\Work\\Shop', 'c:\\work\\shop', archivedAt);
    add('first', null);
    assert.throws(() => add('second', null), /UNIQUE constraint failed: projects\.root_key/u);
    add('third', 5);
    const row = db.prepare("SELECT scout_mode, remotes, check_command FROM projects WHERE id = 'first'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { scout_mode: 'off', remotes: '[]', check_command: null });
    assert.throws(() => db.prepare("UPDATE projects SET scout_mode = 'always' WHERE id = 'first'").run(), /CHECK constraint failed/u);
  } finally { db.close(); }
  assert.throws(() => openDatabase(path, MIGRATIONS.slice(0, 19)), /newer than this app/u);
});
