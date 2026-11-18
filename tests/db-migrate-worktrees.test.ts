import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE worktrees'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const insert = (db: DatabaseSync, id: string, kind: string, state: string) => db.prepare(
  "INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, state, created_at, updated_at) VALUES (?, 'p', 'C:/r', NULL, NULL, ?, NULL, 'beat/x-1a2b', 'abc', NULL, ?, 1, 1)").run(id, kind, state);

test('worktree の表の移し替え: 前の版の DB に当てると空の worktrees ができ、ほかの表の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.equal(AT, 41, 'worktrees is migration 42');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES ('c1', 'chat', 1, 1)").run();
    before = counts(old);
    assert.ok(!tables(old).includes('worktrees'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), { ...before, worktrees: 0 });
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'worktrees' AND name LIKE 'ix_%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    assert.deepEqual(indexes, ['ix_worktrees_project', 'ix_worktrees_task']);
    insert(db, 'w1', 'task', 'creating');
    assert.equal((db.prepare("SELECT keep_branch FROM worktrees WHERE id = 'w1'").get() as { keep_branch: number }).keep_branch, 1, '書かなければブランチを残す側');
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(counts(again).worktrees, 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('worktree の表の移し替え: 種類と状態は決まった値だけ入る', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    assert.throws(() => insert(db, 'w1', 'copy', 'active'), /CHECK/u);
    assert.throws(() => insert(db, 'w2', 'task', 'done'), /CHECK/u);
    for (const [i, state] of ['creating', 'active', 'branch', 'merged', 'discarded', 'removing', 'gone'].entries()) insert(db, `t${i}`, i % 2 ? 'fix' : 'task', state);
    assert.equal(counts(db).worktrees, 7);
    assert.throws(() => db.prepare("UPDATE worktrees SET ending = 'removing' WHERE id = 't0'").run(), /CHECK/u, '終わりの状態は終わりの値だけ');
    db.prepare("UPDATE worktrees SET note = 'any later value' WHERE id = 't0'").run();
    for (const ending of ['branch', 'merged', 'discarded', 'gone']) db.prepare('UPDATE worktrees SET ending = ? WHERE id = ?').run(ending, 't0');
    db.prepare("UPDATE worktrees SET note = 'not_on_branch', own_tip = 'abc' WHERE id = 't0'").run();
  } finally { db.close(); }
});
