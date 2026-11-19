import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

// The model_calls migration (token-efficiency TE-0), found by its content so a renumbering touches only migrations.ts
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE model_calls'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

test('移し替え（TE-0 の model_calls）: 表ができて空。ほかの表の行の数は変わらず、控えが 1 つでき、2 回目は何もしない。purpose と (run_id, seq) を守る', t => {
  assert.ok(AT > 0, 'the model_calls migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, input_tokens) VALUES ('r1', 'chat', 'c1', 1, 100)").run();
    before = counts(old);
    assert.ok(!tables(old).includes('model_calls'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    const after = counts(db);
    assert.equal(after.model_calls, 0);
    delete after.model_calls;
    assert.deepEqual(after, before);
    const insert = (purpose: string, seq: number) => db.prepare("INSERT INTO model_calls (run_id, seq, purpose, model, tools_hash, frozen_hash, dynamic_hash, started_at, duration_ms) VALUES ('r1', ?, ?, 'm', 't', 'f', 'd', 1, 0)").run(seq, purpose);
    for (const [i, purpose] of ['turn', 'compact', 'discarded'].entries()) insert(purpose, i + 1);
    assert.throws(() => insert('judge', 9), /CHECK/u);
    assert.throws(() => insert('turn', 1), /UNIQUE/u);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
