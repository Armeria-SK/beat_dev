import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

// beat R (Revision 3): the migration that adds the research run columns, found by its content
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('ADD COLUMN research_settings'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

test('移し替え（R の 46 番）: 調べた記録に列が足され、既にある行は既定の値を持ち、ほかの表の行の数は変わらず、2 回目は何もしない', t => {
  assert.equal(AT, 45, 'the research migration is number 46 (index 45)');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO research_runs (id, project_id, phase, mode, status, created_at) VALUES ('r1', 'p1', 'products', 'batch', 'done', 1)").run();
    before = counts(old);
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1));
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), before);
    for (const name of ['source_conversation_id', 'parts', 'partial', 'auto', 'stop_reason']) assert.ok(columns(db, 'research_runs').includes(name), name);
    assert.ok(columns(db, 'projects').includes('research_settings'));
    const row = db.prepare("SELECT parts, partial, auto, source_conversation_id FROM research_runs WHERE id = 'r1'").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { parts: '[]', partial: 0, auto: 0, source_conversation_id: null });
    assert.throws(() => db.prepare("UPDATE research_runs SET partial = 2 WHERE id = 'r1'").run(), /CHECK/u);
  } finally { db.close(); }

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1));
  try {
    assert.equal(version(again), AT + 1);
    assert.deepEqual(counts(again), before);
  } finally { again.close(); }
});
