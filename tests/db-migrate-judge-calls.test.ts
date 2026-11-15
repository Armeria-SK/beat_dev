import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { recordJudgeCall } from '../src/tools/judge-stats.ts';
import { tempDir } from './helpers.ts';

const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE judge_calls'));
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));

test('判定役の記録の移し替え: 前の版の DB に当てると空の judge_calls ができ、ほかの表の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.ok(AT > 0, 'judge_calls を作る移し替えがある');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const old = openDatabase(path, MIGRATIONS.slice(0, AT));
  let before: Record<string, number>;
  try {
    old.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES ('c1', 'chat', 1, 1)").run();
    old.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('r1', 'chat', 'c1', 1)").run();
    before = counts(old);
    assert.ok(!tables(old).includes('judge_calls'));
  } finally { old.close(); }

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), { ...before, judge_calls: 0 });
    recordJudgeCall(db, { runId: 'r1', runKind: 'chat', projectId: null, tool: 'shell_run', reasonKeys: ['ask.curl'], askKinds: ['egress'], outcome: 'ask', spend: { ms: 3 } });
    assert.equal(counts(db).judge_calls, 1);
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.equal(counts(again).judge_calls, 1);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('判定役の記録の移し替え: 答えは決まった値だけ入り、実行の種類は新しい種類でも落とさない', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    const insert = (kind: string, outcome: string) => db.prepare('INSERT INTO judge_calls (run_id, run_kind, tool, outcome, duration_ms, created_at) VALUES (?, ?, ?, ?, 0, 0)').run('r', kind, 't', outcome);
    assert.throws(() => insert('chat', 'maybe'), /CHECK/u);
    insert('a-future-kind', 'allow');
    insert('task', 'failed');
    assert.deepEqual(db.prepare('SELECT run_kind FROM judge_calls ORDER BY id').all().map(r => r.run_kind), ['a-future-kind', 'task']);
  } finally { db.close(); }
});
