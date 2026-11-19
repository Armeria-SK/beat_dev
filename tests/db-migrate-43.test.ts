import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

// The approval_rules migration, found by its content so a renumbering touches only migrations.ts and this file name
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE approval_rules'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

test('移し替え（J-5 の approval_rules）: approval_rules の表ができて空。ほかの表の行の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'the approval_rules migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO projects (id, name, root, root_key, created_at, updated_at) VALUES ('p1', 'Shop', 'C:/Work/Shop', 'c:/work/shop', 1, 1)").run();
    old.prepare("INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, project_id, status, created_at) VALUES ('shell_run', '{}', 'x', 'judge', 'r', 'r1', 'chat', 'c1', 'p1', 'waiting', 1)").run();
    before = counts(old);
    assert.ok(!tables(old).includes('approval_rules'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    const after = counts(db);
    assert.equal(after.approval_rules, 0);
    delete after.approval_rules;
    assert.deepEqual(after, before);
    assert.throws(() => db.prepare("INSERT INTO approval_rules (project_id, kind, tool, base, base_key, keys, shown, created_at) VALUES ('p1', 'hook', 't', '{}', 'k', '[]', 's', 1)").run(), /CHECK/u, 'hook / owner rows can never become rules');
    assert.throws(() => db.prepare("INSERT INTO approval_rules (project_id, kind, tool, base, base_key, keys, shown, created_at) VALUES ('nope', 'judge', 't', '{}', 'k', '[]', 's', 1)").run(), /FOREIGN KEY/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
