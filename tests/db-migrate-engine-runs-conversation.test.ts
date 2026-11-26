import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { tempDir } from './helpers.ts';

// The engine_runs.conversation_id index migration, found by its content so a renumbering touches only migrations.ts
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('ix_engine_runs_conversation'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const indexes = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'engine_runs' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);

// The statements TaskStore.schedule() really prepares (no copy of its SQL here), with the plan SQLite picks for each
function schedulePlans(db: DatabaseSync): Array<{ sql: string; plan: string }> {
  const seen: string[] = [];
  const spy = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string): StatementSync => { seen.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  new TaskStore(spy).schedule(0, 2_000_000_000_000);
  return seen.filter(sql => sql.includes('engine_runs')).map(sql => ({
    sql,
    plan: (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...sql.split('?').slice(1).map(() => 1)) as Array<{ detail: string }>).map(r => r.detail).join('\n'),
  }));
}

test('schedule: engine_runs.conversation_id に索引があり、/api/schedule の読み取りが engine_runs を全部なめない', t => {
  assert.ok(AT > 0, 'the index migration exists');
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  assert.ok(indexes(db).includes('ix_engine_runs_conversation'));
  const plans = schedulePlans(db);
  assert.ok(plans.length >= 2, `schedule() reads engine_runs in at least two statements (saw ${plans.length})`);
  const lastLength = plans.find(p => p.sql.includes('t.parent_id = ?'));
  assert.ok(lastLength, 'the per-template last-run-length statement is among them');
  assert.match(lastLength.plan, /^SEARCH r USING INDEX ix_engine_runs_conversation \(conversation_id=\?\)/mu, `it looks the runs up by the task's conversation through the index:\n${lastLength.plan}`);
  for (const { plan } of plans) assert.doesNotMatch(plan, /^SCAN (?:r|engine_runs)\b/mu, `no statement walks every engine_runs row:\n${plan}`);
});

test('移し替え（engine_runs の conversation_id の索引）: 索引だけが足されて、行は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'the index migration exists');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  try {
    old.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('r1', 'task', 'c1', 1), ('r2', 'chat', NULL, 2)").run();
    assert.ok(!indexes(old).includes('ix_engine_runs_conversation'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.ok(indexes(db).includes('ix_engine_runs_conversation'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM engine_runs').get() as { n: number }).n, 2);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
