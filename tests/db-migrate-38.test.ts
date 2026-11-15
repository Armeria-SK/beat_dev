import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('ALTER TABLE memory_jobs ADD COLUMN kind'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

test('migration 38: memory_jobs.kind (old rows become memory, skill can be queued, other values are refused) and skill_drafts.outside (old rows 0)', t => {
  assert.equal(AT, 37, 'the kind column is migration 38');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const seed = openDatabase(path, MIGRATIONS.slice(0, AT));
  try {
    seed.prepare("INSERT INTO memory_jobs (trigger, dedup_key, created_at) VALUES ('idle', 'idle:old:1', 1)").run();
    seed.prepare("INSERT INTO skill_drafts (name, description, body, created_at) VALUES ('old-one', 'd', 'b', 1)").run();
  } finally { seed.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual({ ...db.prepare('SELECT dedup_key, kind FROM memory_jobs').get() }, { dedup_key: 'idle:old:1', kind: 'memory' });
    db.prepare("INSERT INTO memory_jobs (kind, trigger, dedup_key, created_at) VALUES ('skill', 'heavy_run', 'skill:tools:c:0:1', 2)").run();
    assert.throws(() => db.prepare("INSERT INTO memory_jobs (kind, trigger, dedup_key, created_at) VALUES ('other', 'task', 'x', 3)").run(), /CHECK/u);
    assert.deepEqual({ ...db.prepare('SELECT name, outside FROM skill_drafts').get() }, { name: 'old-one', outside: 0 });
    assert.throws(() => db.prepare("INSERT INTO skill_drafts (name, description, body, created_at, outside) VALUES ('n', 'd', 'b', 1, 2)").run(), /CHECK/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);
});
