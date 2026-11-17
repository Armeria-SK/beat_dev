import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('ALTER TABLE tasks ADD COLUMN proposal'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const row = (db: DatabaseSync) => ({ ...db.prepare("SELECT id, title, status, origin, proposed_by, proposal, updated_at FROM tasks WHERE id = 'old'").get() });

test('migration 39: tasks.proposal (old rows unchanged and NULL, running it twice changes nothing, a backup is taken first)', t => {
  assert.equal(AT, 38, 'the proposal column is migration 39');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, AT));
  try {
    seed.prepare("INSERT INTO tasks (id, title, status, origin, created_at, updated_at) VALUES ('old', 'Old idea', 'inbox', 'self', 1, 2)").run();
  } finally { seed.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  let after: Record<string, unknown>;
  try {
    assert.equal(version(db), AT + 1);
    after = row(db);
    assert.deepEqual(after, { id: 'old', title: 'Old idea', status: 'inbox', origin: 'self', proposed_by: null, proposal: null, updated_at: 2 });
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.deepEqual(row(again), after);
  } finally { again.close(); }
  assert.equal(readdirSync(backups).length, 1, 'no second backup when nothing is migrated');
});
