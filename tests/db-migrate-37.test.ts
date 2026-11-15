import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('ALTER TABLE questions ADD COLUMN category'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

test('移し替え 37: questions.category を足し、前からある質問は other になり、ほかの表の行の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.equal(AT, 36, 'the category column is migration 37');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    seed.prepare("INSERT INTO questions (kind, question, options, chosen, created_at) VALUES ('ai', 'Old question', '[\"a\",\"b\"]', 0, 1)").run();
    before = counts(seed);
  } finally { seed.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), before);
    assert.deepEqual({ ...db.prepare('SELECT question, category FROM questions').get() }, { question: 'Old question', category: 'other' });
    assert.throws(() => db.prepare("INSERT INTO questions (kind, category, question, options, created_at) VALUES ('ai', 'colour', 'q', '[]', 1)").run(), /CHECK/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
