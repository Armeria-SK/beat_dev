import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const counts = (db: DatabaseSync): Record<string, number> => {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' AND name <> 'pending_actions' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
  return Object.fromEntries(tables.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
};

function seedV24(path: string): Record<string, number> {
  const db = openDatabase(path, MIGRATIONS.slice(0, 24));
  try {
    assert.equal(version(db), 24);
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('c1', 'chat', 'c', 1, 1)").run();
    db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('r1', 'chat', 'c1', 1)").run();
    db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, created_at) VALUES ('t1', 'r1', 'c1', 'shell_run', '{}', 'allow', 'builtin', 1)").run();
    db.prepare("INSERT INTO tasks (id, title, body, status, origin, created_at, updated_at) VALUES ('k1', 'T', 'b', 'ready', 'user', 1, 1)").run();
    return counts(db);
  } finally { db.close(); }
}

test('移し替え 25: 形 24 の DB を開くと pending_actions ができ、前からある行の数は変わらず、控えができ、開き直しても変わらない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV24(path);
  assert.ok(MIGRATIONS.length >= 25);

  const db = openDatabase(path, MIGRATIONS.slice(0, 25), { backupDir: backups });
  try {
    assert.equal(version(db), 25);
    assert.deepEqual(counts(db), before);
    const columns = (db.prepare('PRAGMA table_info(pending_actions)').all() as Array<{ name: string }>).map(c => c.name);
    assert.deepEqual(columns, ['id', 'tool', 'input', 'shown', 'masked', 'cwd', 'kind', 'reason', 'checks', 'bind', 'state', 'files', 'run_id', 'run_kind', 'conversation_id', 'task_id', 'project_id', 'tainted', 'status', 'reject_reason', 'exit_code', 'output_preview', 'full_ref', 'created_at', 'decided_at', 'ran_at']);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pending_actions' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    assert.deepEqual(indexes, ['ix_pending_actions_project', 'ix_pending_actions_status']);
    const insert = db.prepare("INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, status, created_at) VALUES ('shell_run', '{}', 'x', ?, 'r', 'r1', 'chat', 'c1', ?, 1)");
    assert.throws(() => insert.run('other', 'waiting'), /CHECK/u);
    assert.throws(() => insert.run('send', 'done'), /CHECK/u);
    insert.run('send', 'waiting');
  } finally { db.close(); }

  assert.match(readdirSync(backups).join(','), /-v24-.+\.db/u);
  const again = openDatabase(path, MIGRATIONS.slice(0, 25), { backupDir: backups });
  try {
    assert.equal(version(again), 25);
    assert.deepEqual(counts(again), before);
    assert.equal(Number((again.prepare('SELECT COUNT(*) AS n FROM pending_actions').get() as { n: number }).n), 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
