import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(r => r.name);

test('移し替え 35: 表 research_runs と research_items を足すだけで、ほかの表の行の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, 34));
  let before: Record<string, number>;
  try {
    assert.equal(version(seed), 34);
    seed.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('c1', 'chat', 'Hi', 1, 1)").run();
    seed.prepare("INSERT INTO tasks (id, title, status, origin, created_at, updated_at) VALUES ('t1', 'Task', 'inbox', 'user', 1, 1)").run();
    before = counts(seed);
  } finally { seed.close(); }
  assert.ok(MIGRATIONS.length >= 35);

  const db = openDatabase(path, MIGRATIONS.slice(0, 35), { backupDir: backups });
  try {
    assert.equal(version(db), 35);
    const after = counts(db);
    assert.deepEqual({ ...after, research_runs: undefined, research_items: undefined }, { ...before, research_runs: undefined, research_items: undefined });
    assert.deepEqual([after.research_runs, after.research_items], [0, 0]);
    assert.deepEqual(columns(db, 'research_runs'), ['id', 'project_id', 'conversation_id', 'run_id', 'phase', 'mode', 'status', 'shown_hash', 'confirmed_at', 'created_at', 'finished_at', 'limits']);
    assert.deepEqual(columns(db, 'research_items'), ['id', 'research_id', 'kind', 'name_or_label', 'detail', 'url', 'license', 'updated', 'language', 'evidence', 'products', 'options', 'default_checked', 'default_reason', 'decision', 'reason', 'recommended', 'answer_kind']);
    db.prepare("INSERT INTO research_runs (id, project_id, phase, mode, status, created_at) VALUES ('r1', 'p1', 'products', 'batch', 'running', 1)").run();
    assert.throws(() => db.prepare("INSERT INTO research_runs (id, project_id, phase, mode, status, created_at) VALUES ('r2', 'p1', 'products', 'batch', 'later', 1)").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO research_items (research_id, kind, name_or_label) VALUES ('r1', 'other', 'x')").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO research_items (research_id, kind, name_or_label) VALUES ('missing', 'feature', 'x')").run(), /FOREIGN KEY/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), ['34']);

  const again = openDatabase(path, MIGRATIONS.slice(0, 35), { backupDir: backups });
  try {
    assert.equal(version(again), 35);
    assert.equal(counts(again).research_runs, 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('移し替え 35: 新しい DB にそのまま当てても落ちない', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS.slice(0, 35));
  try {
    assert.equal(version(db), 35);
    assert.deepEqual(counts(db).research_runs, 0);
  } finally { db.close(); }
});
