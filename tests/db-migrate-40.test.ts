import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { OWNER_RUN_KV, SCOUT_RUN } from '../src/tasks/store.ts';
import { tempDir } from './helpers.ts';

const AT = 39;
const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const tables = (db: DatabaseSync): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
const counts = (db: DatabaseSync): Record<string, number> => Object.fromEntries(tables(db).map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n)]));
const rowsOf = (db: DatabaseSync, sql: string): Array<Record<string, unknown>> => db.prepare(sql).all().map(r => ({ ...r }));

const TASKS = 'SELECT id, status, origin, proposed_by, proposal, lease_until, updated_at FROM tasks ORDER BY id';
const MOVED = ['s-ready', 's-ready-child'];

function seedV39(path: string) {
  const db = openDatabase(path, MIGRATIONS.slice(0, AT));
  try {
    assert.equal(version(db), AT);
    const task = db.prepare('INSERT INTO tasks (id, title, status, origin, proposed_by, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1)');
    task.run('s-ready', 'Tidy the notes', 'ready', 'self', null, null);
    task.run('s-template', 'Every morning', 'scheduled', 'self', null, null);
    task.run('s-ready-child', 'Every morning (run)', 'ready', 'self', null, 's-template');
    task.run('s-pressed', 'Pressed by the owner', 'ready', 'self', null, null);
    for (const status of ['inbox', 'running', 'waiting', 'done', 'failed', 'cancelled']) task.run(`s-${status}`, status, status, 'self', null, null);
    task.run('scout-ready', 'Scout: shop', 'ready', 'self', SCOUT_RUN, null);
    task.run('scout-running', 'Scout: shop', 'running', 'self', SCOUT_RUN, null);
    task.run('u-ready', 'Owner task', 'ready', 'user', null, null);
    task.run('u-approved', 'Approved proposal', 'ready', 'user', 'self', null);
    task.run('x-ready', 'Scheduled run', 'ready', 'schedule', null, null);
    task.run('c-ready', 'Look into: FTS5', 'ready', 'curiosity', null, null);
    db.prepare("UPDATE tasks SET proposal = '{\"kind\":\"feature\"}' WHERE id = 's-inbox'").run();
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, '1', 1)").run(`${OWNER_RUN_KV}s-pressed`);
    db.prepare("INSERT INTO task_events (task_id, kind, actor, content, created_at) VALUES ('s-ready', 'created', 'beat', NULL, 1)").run();
    return { counts: counts(db), tasks: rowsOf(db, TASKS), kv: rowsOf(db, 'SELECT * FROM kv ORDER BY key'), events: rowsOf(db, 'SELECT * FROM task_events ORDER BY id') };
  } finally { db.close(); }
}

test('移し替え 40（7-4）: beat が自分で決めた実行待ち（self の ready）だけを inbox に移し、更新の時刻を今の ms にする。考える実行の行・持ち主が今すぐ実行した行・ほかの状態と出どころは変えず、控えが 1 つでき、2 回目は何もしない', t => {
  assert.equal(MIGRATIONS.length, AT + 1, 'this is migration 40');
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV39(path);
  const started = Date.now();

  const db = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  let moved: Array<Record<string, unknown>>;
  try {
    assert.equal(version(db), AT + 1);
    assert.deepEqual(counts(db), before.counts);
    assert.deepEqual(rowsOf(db, 'SELECT * FROM kv ORDER BY key'), before.kv);
    assert.deepEqual(rowsOf(db, 'SELECT * FROM task_events ORDER BY id'), before.events);
    const after = rowsOf(db, TASKS);
    moved = after.filter(r => MOVED.includes(String(r.id)));
    assert.deepEqual(moved.map(r => [r.id, r.status, r.origin, r.proposed_by]), [['s-ready', 'inbox', 'self', null], ['s-ready-child', 'inbox', 'self', null]]);
    for (const r of moved) assert.ok(Number(r.updated_at) >= Math.floor(started / 1000) * 1000 && Number(r.updated_at) <= Date.now(), String(r.updated_at));
    assert.deepEqual(after.filter(r => !MOVED.includes(String(r.id))), before.tasks.filter(r => !MOVED.includes(String(r.id))), 'scout rows, the pressed row and every other row are unchanged');
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), [String(AT)]);

  const again = openDatabase(path, MIGRATIONS.slice(0, AT + 1), { backupDir: backups });
  try {
    assert.equal(version(again), AT + 1);
    assert.deepEqual(rowsOf(again, TASKS).filter(r => MOVED.includes(String(r.id))), moved);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('移し替え 40: 新しい DB にそのまま当てても落ちず、タスクは無いまま', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS.slice(0, AT + 1));
  try {
    assert.equal(version(db), AT + 1);
    assert.equal(rowsOf(db, TASKS).length, 0);
  } finally { db.close(); }
});
