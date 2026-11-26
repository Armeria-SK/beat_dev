import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

// AR-8a: pending_actions takes a kind "runtime" and a status "answered". SQLite cannot change a CHECK, so the table is rebuilt; found by its content so a renumbering touches only migrations.ts

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE pending_actions_next'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync): string[] => (db.prepare('PRAGMA table_info(pending_actions)').all() as Array<{ name: string }>).map(c => c.name);
const indexes = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_actions' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const insert = (db: DatabaseSync, kind: string, status: string, id?: number) => db.prepare(`INSERT INTO pending_actions (${id === undefined ? '' : 'id, '}tool, input, shown, kind, reason, run_id, run_kind, conversation_id, status, created_at) VALUES (${id === undefined ? '' : `${id}, `}'t', '{}', 's', ?, 'r', 'r1', 'chat', 'c1', ?, 1)`).run(kind, status);

test('移し替え（AR-8a の pending_actions）: 今までの行は 1 つも欠けず、runtime の種類と answered の状態が入れられ、索引も戻り、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'the rebuild migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: unknown[];
  const kinds = ['send', 'delete', 'hook', 'policy', 'owner', 'judge', 'judge_failed'];
  try {
    assert.throws(() => insert(old, 'runtime', 'waiting'), /CHECK/u, 'premise: the old table refuses the new kind');
    assert.throws(() => insert(old, 'judge', 'answered'), /CHECK/u, 'premise: and the new status');
    kinds.forEach((kind, i) => insert(old, kind, 'waiting', 10 + i));
    old.prepare("UPDATE pending_actions SET status = 'ran', exit_code = 0, output_preview = 'ok', full_ref = 'ref', reject_reason = 'why', bind = 'b', state = '{\"a\":1}', files = '[\"f\"]', task_id = 'tk', project_id = 'p', cwd = 'C:/x', masked = 2, tainted = 1, decided_at = 5, ran_at = 6 WHERE id = 12").run();
    before = old.prepare('SELECT * FROM pending_actions ORDER BY id').all();
    assert.equal(before.length, kinds.length);
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(db.prepare('SELECT * FROM pending_actions ORDER BY id').all(), before, 'every row is copied, column by column');
    assert.deepEqual(columns(db), Object.keys(before[0] as object));
    assert.deepEqual(indexes(db), ['ix_pending_actions_project', 'ix_pending_actions_status']);
    insert(db, 'runtime', 'waiting');
    insert(db, 'runtime', 'answered');
    assert.throws(() => insert(db, 'something_else', 'waiting'), /CHECK/u, 'an unknown kind is still refused');
    assert.throws(() => insert(db, 'runtime', 'something_else'), /CHECK/u, 'and an unknown status');
    const next = db.prepare('SELECT MAX(id) AS id FROM pending_actions').get() as { id: number };
    assert.ok(next.id > 16, 'new rows continue after the old ids');
    assert.ok(!(db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_actions_next'").get()), 'the working table is gone');
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM pending_actions').get() as { n: number }).n, kinds.length + 2);
  } finally { again.close(); }
});
