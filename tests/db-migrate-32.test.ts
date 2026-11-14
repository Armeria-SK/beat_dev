import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const columns = (db: DatabaseSync, table: string): string[] => (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(r => r.name);
const indexes = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map(r => r.name);
const rowsOf = (db: DatabaseSync, sql: string): Array<Record<string, unknown>> => db.prepare(sql).all().map(r => ({ ...r }));

const OLD_ROWS = {
  tasks: "SELECT id, title, status, origin, parent_id, owner_request FROM tasks ORDER BY id",
  notifications: 'SELECT id, kind, title, link, dedup_key, local_only FROM notifications ORDER BY id',
  tool_calls: 'SELECT id, run_id, conversation_id, tool, decision, ok FROM tool_calls ORDER BY id',
  acceptance_versions: 'SELECT project_id, version, hash, content, source FROM acceptance_versions ORDER BY version',
  conversations: 'SELECT id, permission_mode FROM conversations ORDER BY id',
};

function seedV27(path: string): { counts: Record<string, number>; rows: Record<string, unknown> } {
  const db = openDatabase(path, MIGRATIONS.slice(0, 27));
  try {
    assert.equal(version(db), 27);
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, permission_mode) VALUES ('c-task', 'task', 'Task', 1, 1, 'auto')").run();
    db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, permission_mode) VALUES ('c-plan', 'chat', 'Plan', 1, 1, 'plan')").run();
    const task = db.prepare('INSERT INTO tasks (id, title, body, status, origin, parent_id, conversation_id, waiting_kind, waiting_text, owner_request, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)');
    task.run('t-parent', 'Parent', 'body', 'scheduled', 'user', null, null, null, null, 'do it');
    task.run('t-run', 'Run', '', 'done', 'schedule', 't-parent', 'c-task', null, null, null);
    task.run('t-wait', 'Waiting', '', 'waiting', 'self', null, null, 'question', 'Which one?', null);
    db.prepare("INSERT INTO task_events (task_id, kind, actor, content, created_at) VALUES ('t-run', 'run', 'worker', NULL, 1)").run();
    const notification = db.prepare('INSERT INTO notifications (kind, title, body, link, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, 1)');
    notification.run('task_waiting', 'Asked', 'Which one?', '#/tasks/t-wait', 'waiting:t-wait:1');
    notification.run('info', 'Note', null, null, null);
    const toolCall = db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, 'r1', ?, ?, '{}', ?, ?, ?, 1)");
    toolCall.run('k1', 'c-task', 'shell_run', 'allow', 'policy', 1);
    toolCall.run('k2', 'c-task', 'shell_run', 'ask', 'pending', 1);
    toolCall.run('k3', null, 'file_read', 'deny', 'registry', 0);
    db.prepare("INSERT INTO acceptance_versions (project_id, version, hash, content, plan_hash, source, build_task_id, created_at) VALUES ('p1', 1, 'h1', '{\"items\":[]}', NULL, 'build', 't-run', 1)").run();
    return { counts: counts(db), rows: Object.fromEntries(Object.entries(OLD_ROWS).map(([name, sql]) => [name, rowsOf(db, sql)])) };
  } finally { db.close(); }
}

test('移し替え 28〜32: 形 27 の DB を 32 に上げても、前からある行は 1 つも減らず変わらず、新しい欄は NULL、questions は空。控えが 1 つでき、2 回目は何もしない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV27(path);
  assert.ok(MIGRATIONS.length >= 32);

  const db = openDatabase(path, MIGRATIONS.slice(0, 32), { backupDir: backups });
  try {
    assert.equal(version(db), 32);
    assert.deepEqual(counts(db), { ...before.counts, questions: 0 });
    for (const [name, sql] of Object.entries(OLD_ROWS)) assert.deepEqual(rowsOf(db, sql), before.rows[name], name);
    assert.deepEqual(rowsOf(db, 'SELECT DISTINCT spawned_by, check_state FROM tasks'), [{ spawned_by: null, check_state: null }]);
    assert.deepEqual(rowsOf(db, 'SELECT DISTINCT project_id FROM notifications'), [{ project_id: null }]);
    assert.deepEqual(rowsOf(db, 'SELECT DISTINCT evidence_no FROM tool_calls'), [{ evidence_no: null }]);
    assert.deepEqual(rowsOf(db, 'SELECT DISTINCT item_states FROM acceptance_versions'), [{ item_states: null }]);
    assert.deepEqual(columns(db, 'questions'), [
      'id', 'project_id', 'task_id', 'conversation_id', 'kind', 'question', 'why', 'options', 'chosen', 'blocking', 'acceptance_item', 'status', 'answer', 'answer_kind', 'fix_task_id', 'tainted', 'created_at', 'answered_at',
    ]);
    for (const name of ['ix_questions_status', 'ix_questions_project', 'ix_questions_task', 'ix_tasks_spawned_by', 'ix_tool_calls_evidence']) assert.ok(indexes(db).includes(name), name);
  } finally { db.close(); }

  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), ['27']);
  const restored = openDatabase(join(backups, readdirSync(backups)[0]!), MIGRATIONS.slice(0, 27));
  try {
    assert.equal(version(restored), 27);
    assert.deepEqual(counts(restored), before.counts);
  } finally { restored.close(); }

  const again = openDatabase(path, MIGRATIONS.slice(0, 32), { backupDir: backups });
  try {
    assert.equal(version(again), 32);
    assert.deepEqual(counts(again), { ...before.counts, questions: 0 });
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('移し替え 28〜32: 1 つずつ上げても同じ形になり、それぞれの番号が決めた欄だけを足す', t => {
  const path = join(tempDir(t), 'beat.db');
  seedV27(path);
  const added = (upTo: number): Record<string, string[]> => {
    const db = openDatabase(path, MIGRATIONS.slice(0, upTo));
    try {
      assert.equal(version(db), upTo);
      return Object.fromEntries(tables(db).map(name => [name, columns(db, name)]));
    } finally { db.close(); }
  };
  const diff = (from: Record<string, string[]>, to: Record<string, string[]>): string[] =>
    Object.entries(to).flatMap(([table, names]) => names.filter(name => !(from[table] ?? []).includes(name)).map(name => `${table}.${name}`)).sort();
  const v27 = added(27);
  const v28 = added(28);
  const v29 = added(29);
  const v30 = added(30);
  const v31 = added(31);
  const v32 = added(32);
  assert.deepEqual(diff(v27, v28), []);
  assert.deepEqual(diff(v28, v29).filter(name => !name.startsWith('questions.')), []);
  assert.equal(diff(v28, v29).length, 18);
  assert.deepEqual(diff(v29, v30), ['tasks.spawned_by']);
  assert.deepEqual(diff(v30, v31), ['notifications.project_id']);
  assert.deepEqual(diff(v31, v32), ['acceptance_versions.item_states', 'tasks.check_state', 'tool_calls.evidence_no']);
});

test('移し替え 28〜32 のあと: questions と check_state は決めた値だけを受け、既定の値が入る。waiting_kind の決まりは変わらない', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS);
  try {
    const id = Number(db.prepare("INSERT INTO questions (question, created_at) VALUES ('Which date format?', 5)").run().lastInsertRowid);
    assert.deepEqual(rowsOf(db, `SELECT * FROM questions WHERE id = ${id}`), [{
      id, project_id: null, task_id: null, conversation_id: null, kind: 'ai', question: 'Which date format?', why: null, options: '[]', chosen: null, blocking: 0,
      acceptance_item: null, status: 'open', answer: null, answer_kind: null, fix_task_id: null, tainted: 0, created_at: 5, answered_at: null,
    }]);
    for (const kind of ['ai', 'stuck', 'check_failed', 'submit_refused']) db.prepare('INSERT INTO questions (question, kind, created_at) VALUES (?, ?, 1)').run('q', kind);
    assert.throws(() => db.prepare("INSERT INTO questions (question, kind, created_at) VALUES ('q', 'owner', 1)").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO questions (question, status, created_at) VALUES ('q', 'closed', 1)").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO questions (question, answer_kind, created_at) VALUES ('q', 'other', 1)").run(), /CHECK/u);
    assert.throws(() => db.prepare("INSERT INTO questions (question, blocking, created_at) VALUES ('q', 2, 1)").run(), /CHECK/u);
    db.prepare("INSERT INTO questions (question, status, answer, answer_kind, fix_task_id, answered_at, created_at) VALUES ('q', 'answered', '11/14', 'changed', 't1', 2, 1)").run();

    const task = db.prepare("INSERT INTO tasks (id, title, status, origin, check_state, spawned_by, waiting_kind, created_at, updated_at) VALUES (?, 'T', 'done', 'user', ?, ?, ?, 1, 1)");
    task.run('t-null', null, null, null);
    task.run('t-awaiting', 'awaiting', 't-null', null);
    task.run('t-checked', 'checked', null, 'approval');
    assert.throws(() => task.run('t-bad', 'pending', null, null), /CHECK/u);
    assert.throws(() => task.run('t-kind', null, null, 'pending'), /CHECK/u);
    db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, evidence_no, created_at) VALUES ('k', 'r', 'c', 'shell_run', '{}', 'allow', 'policy', 1, 3, 1)").run();
    assert.deepEqual(rowsOf(db, "SELECT evidence_no FROM tool_calls WHERE conversation_id = 'c' AND evidence_no = 3"), [{ evidence_no: 3 }]);
  } finally { db.close(); }
});
