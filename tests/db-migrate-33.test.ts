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
const rowsOf = (db: DatabaseSync, sql: string): Array<Record<string, unknown>> => db.prepare(sql).all().map(r => ({ ...r }));

const TASKS = 'SELECT id, status, origin, curiosity_id, updated_at FROM tasks ORDER BY id';
const ITEMS = 'SELECT * FROM curiosity_items ORDER BY id';
const EVENTS = 'SELECT * FROM task_events ORDER BY id';

function seedV32(path: string) {
  const db = openDatabase(path, MIGRATIONS.slice(0, 32));
  try {
    assert.equal(version(db), 32);
    const item = db.prepare("INSERT INTO curiosity_items (id, topic, status, task_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'beat', 1, 1)");
    item.run(1, 'FTS5', 'researching', 'c-ready');
    item.run(2, 'Croner', 'researching', 'c-ready-2');
    item.run(3, 'WebGPU', 'open', null);
    const task = db.prepare('INSERT INTO tasks (id, title, status, origin, curiosity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)');
    task.run('c-ready', 'Look into: FTS5', 'ready', 'curiosity', 1);
    task.run('c-ready-2', 'Look into: Croner', 'ready', 'curiosity', 2);
    for (const status of ['inbox', 'running', 'waiting', 'done', 'failed', 'cancelled']) task.run(`c-${status}`, status, status, 'curiosity', null);
    task.run('s-ready', 'Self', 'ready', 'self', null);
    task.run('u-ready', 'User', 'ready', 'user', null);
    task.run('x-ready', 'Scheduled run', 'ready', 'schedule', null);
    db.prepare("INSERT INTO task_events (task_id, kind, actor, content, created_at) VALUES ('c-ready', 'created', 'worker', NULL, 1)").run();
    return { counts: counts(db), tasks: rowsOf(db, TASKS), items: rowsOf(db, ITEMS), events: rowsOf(db, EVENTS) };
  } finally { db.close(); }
}

test('移し替え 33: 好奇心の ready のタスクだけを inbox に移し、更新の時刻を今の ms にする。ほかのタスク・好奇心の行・経過の行・ほかの表の数は変わらず、控えが 1 つでき、2 回目は何もしない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  const before = seedV32(path);
  assert.ok(MIGRATIONS.length >= 33);
  const started = Date.now();

  const db = openDatabase(path, MIGRATIONS.slice(0, 33), { backupDir: backups });
  let moved: Array<Record<string, unknown>>;
  try {
    assert.equal(version(db), 33);
    assert.deepEqual(counts(db), before.counts);
    assert.deepEqual(rowsOf(db, ITEMS), before.items);
    assert.deepEqual(rowsOf(db, EVENTS), before.events);
    const after = rowsOf(db, TASKS);
    moved = after.filter(r => r.id === 'c-ready' || r.id === 'c-ready-2');
    assert.deepEqual(moved.map(r => [r.id, r.status]), [['c-ready', 'inbox'], ['c-ready-2', 'inbox']]);
    for (const r of moved) assert.ok(Number(r.updated_at) >= Math.floor(started / 1000) * 1000 && Number(r.updated_at) <= Date.now(), String(r.updated_at));
    assert.deepEqual(after.filter(r => !moved.includes(r)), before.tasks.filter(r => r.id !== 'c-ready' && r.id !== 'c-ready-2'));
  } finally { db.close(); }
  assert.deepEqual(readdirSync(backups).map(name => /-v(\d+)-/u.exec(name)?.[1]), ['32']);

  const again = openDatabase(path, MIGRATIONS.slice(0, 33), { backupDir: backups });
  try {
    assert.equal(version(again), 33);
    assert.deepEqual(rowsOf(again, TASKS).filter(r => r.id === 'c-ready' || r.id === 'c-ready-2'), moved);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});

test('移し替え 33: 新しい DB にそのまま当てても落ちず、好奇心の行もタスクも無いまま', t => {
  const db = openDatabase(join(tempDir(t), 'beat.db'), MIGRATIONS.slice(0, 33));
  try {
    assert.equal(version(db), 33);
    assert.equal(rowsOf(db, TASKS).length, 0);
    assert.equal(rowsOf(db, ITEMS).length, 0);
  } finally { db.close(); }
});
