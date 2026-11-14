import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

test('移し替え 33: 形 32 の DB を 33 に上げると skill_drafts に change_summary が足され、前からある下書きは空のまま中身も変わらない', t => {
  assert.ok(MIGRATIONS.length >= 33);
  const path = join(tempDir(t), 'beat.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 32));
  try {
    assert.equal(version(before), 32);
    assert.equal(columns(before, 'skill_drafts').includes('change_summary'), false);
    before.prepare("INSERT INTO skill_drafts (name, description, body, reason, conversation_id, run_id, created_at) VALUES ('old', 'd', 'b', 'r', 'c1', 'r1', 1)").run();
  } finally { before.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, 33));
  try {
    assert.equal(version(db), 33);
    assert.equal(columns(db, 'skill_drafts').at(-1), 'change_summary');
    assert.deepEqual({ ...(db.prepare('SELECT name, description, body, reason, status, conversation_id, run_id, created_at, change_summary FROM skill_drafts').get() as object) }, {
      name: 'old', description: 'd', body: 'b', reason: 'r', status: 'pending', conversation_id: 'c1', run_id: 'r1', created_at: 1, change_summary: null,
    });
  } finally { db.close(); }
});
