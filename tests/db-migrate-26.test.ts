import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const counts = (db: DatabaseSync): Record<string, number> => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
  return Object.fromEntries(tables.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
};

function seedV25(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 25));
  try {
    assert.equal(version(db), 25);
    db.prepare("INSERT INTO tasks (id, title, body, status, origin, created_at, updated_at) VALUES ('k1', 'Old task', 'old body', 'ready', 'user', 1, 1)").run();
    db.prepare("INSERT INTO tasks (id, title, body, status, origin, created_at, updated_at) VALUES ('k2', 'Marked', 'b', 'ready', 'user', 1, 1)").run();
    db.prepare("INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at) VALUES ('k2', 'context', 'system', 'm', 'untrusted-input', 1)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 26: 形 25 の DB を開くと tasks.owner_request（NULL）が足され、行の数は変わらず、控えができ、前からあるタスクは今の読み方のまま', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV25(path);
  assert.ok(MIGRATIONS.length >= 26);

  const db = openDatabase(path, MIGRATIONS.slice(0, 26), { backupDir: backups });
  try {
    assert.equal(version(db), 26);
    assert.deepEqual(counts(db), before);
    const column = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>).find(c => c.name === 'owner_request');
    assert.deepEqual(column && { type: column.type, notnull: column.notnull, dflt: column.dflt_value }, { type: 'TEXT', notnull: 0, dflt: null });
    assert.deepEqual(db.prepare('SELECT id, owner_request FROM tasks ORDER BY id').all().map(r => ({ ...r })), [{ id: 'k1', owner_request: null }, { id: 'k2', owner_request: null }]);
    const tasks = new TaskStore(db);
    assert.equal(tasks.judgeRequest('k1'), 'Old task\nold body');
    assert.equal(tasks.judgeRequest('k2'), '');
  } finally { db.close(); }

  assert.match(readdirSync(backups).join(','), /-v25-.+\.db/u);
  const again = openDatabase(path, MIGRATIONS.slice(0, 26), { backupDir: backups });
  try {
    assert.equal(version(again), 26);
    assert.deepEqual(counts(again), before);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
