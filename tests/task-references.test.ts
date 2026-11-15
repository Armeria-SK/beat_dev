import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TASK_KV_PREFIXES, TASK_SOFT_REFERENCES } from '../src/tasks/store.ts';
import { taskApp } from './helpers/task-app.ts';

// DELETE /api/tasks/:id（元に戻せない）が頼る、タスクへの参照の一覧。
// あとの DB の移し替えやコードの変更で参照が増えたら、ここが落ちる。落ちたら、TaskStore.remove が新しい参照をどう扱うか（消す・切る・断る）を決めてから一覧を直す。

// 決まりのある参照（FOREIGN KEY）: remove が自分で片づける（子の parent_id は空にし、経過は消す）
const HARD = ['task_events.task_id', 'tasks.parent_id'];
// やわらかい参照（決まりの無い列）: 行があれば remove は 409 で断る
const SOFT = ['acceptance_versions.build_task_id', 'conversations.source_task_id', 'curiosity_items.task_id', 'memory_jobs.task_id', 'pending_actions.task_id', 'questions.fix_task_id', 'questions.task_id'];
// kv の鍵: remove が一緒に消す
const KV = ['created:task:', 'task-idle:', 'task-owner-run:', 'task-split:'];
// 文字として残すもの（結び付きだけ切れる）: notifications.link の `#/tasks/<ID>` と notifications.dedup_key（approval: / waiting: / stuck: / failed: / split: に ID が入る）

function tablesOf(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name);
}

function foreignKeysToTasks(db: DatabaseSync): string[] {
  const found: string[] = [];
  for (const table of tablesOf(db)) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{ table: string; from: string }>) {
      if (fk.table === 'tasks') found.push(`${table}.${fk.from}`);
    }
  }
  return found.sort();
}

function taskIdColumns(db: DatabaseSync): string[] {
  const found: string[] = [];
  for (const table of tablesOf(db)) {
    for (const column of db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>) {
      if (/task/iu.test(column.name)) found.push(`${table}.${column.name}`);
    }
  }
  return found.sort();
}

test('tasks を参照する FOREIGN KEY は tasks.parent_id と task_events.task_id だけ', async t => {
  const { app } = await taskApp(t);
  assert.ok(tablesOf(app.db).length > 10);
  assert.deepEqual(foreignKeysToTasks(app.db), HARD);
  // この見張りが、あとから足した参照を本当に拾うこと
  app.db.exec('CREATE TABLE zz_probe (id INTEGER PRIMARY KEY, owner TEXT REFERENCES tasks (id))');
  assert.deepEqual(foreignKeysToTasks(app.db), [...HARD, 'zz_probe.owner']);
});

test('やわらかい参照の一覧は、DELETE の守りが見る表と同じ。名前に task が入る列は、ほかに無い（task_id で終わらない名前も拾う）', async t => {
  const { app } = await taskApp(t);
  assert.deepEqual(TASK_SOFT_REFERENCES.map(r => `${r.table}.${r.column}`).sort(), SOFT);
  const expected = [...SOFT, ...HARD.filter(c => c !== 'tasks.parent_id')].sort();
  assert.deepEqual(taskIdColumns(app.db), expected);
  app.db.exec('CREATE TABLE zz_probe (id INTEGER PRIMARY KEY, origin_task_id TEXT, task_ref TEXT, owningTask TEXT, title TEXT)');
  assert.deepEqual(taskIdColumns(app.db), [...expected, 'zz_probe.origin_task_id', 'zz_probe.owningTask', 'zz_probe.task_ref']);
});

test('タスクごとの kv の鍵は task-split: と task-idle: と task-owner-run:（持ち主が頼んだ印）と created:task:（この作業で作ったものの控え）だけで、DELETE が消す鍵と同じ', () => {
  assert.deepEqual([...TASK_KV_PREFIXES].sort(), KV);
  const root = join(import.meta.dirname, '..', 'src');
  const found = new Set<string>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(join(entry.parentPath, entry.name), 'utf8');
    for (const m of source.matchAll(/[`'"](task-[a-z-]+:)/gu)) found.add(m[1]!);
  }
  assert.deepEqual([...found].sort(), KV.filter(prefix => prefix.startsWith('task-')));
  const created = readFileSync(join(root, 'projects', 'created.ts'), 'utf8');
  assert.ok(created.includes('`created:${scope.kind}:${scope.id}`'), '控えの鍵の形が変わったら、ここと KV を直す');
});

test('タスクを消すと、そのタスクの kv（作ったものの控え created:task:<ID> も）が一緒に消える', async t => {
  const { app } = await taskApp(t);
  const task = app.tasks.create({ title: 'later', origin: 'user', runAt: Date.now() + 3_600_000, actor: 'test' });
  for (const prefix of KV) app.kv.setJson(`${prefix}${task.id}`, [['a.txt', 'f:1']]);
  app.kv.setJson('created:task:other', [['b.txt', 'f:2']]);
  app.tasks.remove(task.id);
  for (const prefix of KV) assert.equal(app.kv.getJson(`${prefix}${task.id}`), undefined, prefix);
  assert.deepEqual(app.kv.getJson('created:task:other'), [['b.txt', 'f:2']], 'ほかのタスクの控えは残す');
});
