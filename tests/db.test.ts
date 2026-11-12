import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { tempDir } from './helpers.ts';

test('マイグレーションは新規でも再オープンでも同じ状態になる', t => {
  const path = join(tempDir(t), 'clive.db');
  openDatabase(path, MIGRATIONS).close();
  const db = openDatabase(path, MIGRATIONS);
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(user_version, MIGRATIONS.length);
  db.close();
});

test('アプリより新しいスキーマは開かない', t => {
  const path = join(tempDir(t), 'clive.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDatabase(path, MIGRATIONS), /newer/);
});

test('未適用のマイグレーションがあれば、適用前にバックアップを取る', t => {
  const dir = tempDir(t);
  const path = join(dir, 'clive.db');
  openDatabase(path, MIGRATIONS.slice(0, 1)).close();
  openDatabase(path, [...MIGRATIONS, 'CREATE TABLE extra (id INTEGER) STRICT;'], { backupDir: join(dir, 'backups') }).close();
  assert.equal(readdirSync(join(dir, 'backups')).length, 1);
});

test('発言を追加すると、会話の行が無くても同じトランザクションで作る', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const saved = conversations.append('c1', { role: 'user', content: 'こんにちは' });
  assert.ok(saved.id > 0);
  assert.ok(conversations.get('c1'));
  conversations.append('c1', { role: 'assistant', content: 'やあ' });
  assert.deepEqual(conversations.messages('c1').map(m => m.message), [
    { role: 'user', content: 'こんにちは' },
    { role: 'assistant', content: 'やあ' },
  ]);
});

test('発言は trigram で日本語の部分一致検索ができる', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  conversations.append('c1', { role: 'user', content: 'ローカルLLMのコンテキスト長を確認したい' });
  const hits = db.prepare(`SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?`).all('"コンテキスト"');
  assert.equal(hits.length, 1);
});

test('凍結スナップショットは一度しか書かれない', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  conversations.create({ id: 'c1' });
  assert.equal(conversations.setSnapshotOnce('c1', 'A', 'ha'), true);
  assert.equal(conversations.setSnapshotOnce('c1', 'B', 'hb'), false);
  assert.equal(conversations.get('c1')?.snapshot, 'A');
});

test('実行記録の開始・終了と、再起動時の片付け', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  let now = 1000;
  const runs = new Runs(db, () => now);
  runs.start('r1', 'chat', 'c1');
  now = 1500;
  runs.finish('r1', { ok: true, attempts: 2, modelId: 'm', usage: { inputTokens: 10, outputTokens: 5 }, flags: ['x'] });
  const row = runs.get('r1')!;
  assert.equal(row.ok, 1);
  assert.equal(row.duration_ms, 500);
  assert.equal(row.attempts, 2);
  assert.equal(row.flags, '["x"]');
  runs.start('r2', 'chat');
  assert.equal(runs.closeDangling(), 1);
  assert.equal(runs.get('r2')!.error_kind, 'cancelled');
});

test('KV の読み書き', () => {
  const kv = new KV(openDatabase(':memory:', MIGRATIONS));
  kv.setJson('a', { b: 1 });
  assert.deepEqual(kv.getJson('a'), { b: 1 });
  kv.set('a', 'not json');
  assert.equal(kv.getJson('a'), undefined);
  kv.delete('a');
  assert.equal(kv.get('a'), undefined);
});

test('マイグレーション 8: tasks に created_in_conversation が足される。前からある行は NULL', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 7));
  before.prepare(`INSERT INTO tasks (id, title, status, origin, created_at, updated_at) VALUES ('old', '前からあるタスク', 'ready', 'user', 1, 1)`).run();
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(columns.includes('created_in_conversation'));
    assert.equal((db.prepare("SELECT created_in_conversation FROM tasks WHERE id = 'old'").get() as { created_in_conversation: string | null }).created_in_conversation, null);
    db.prepare("UPDATE tasks SET created_in_conversation = 'c1' WHERE id = 'old'").run();
  } finally { db.close(); }
});

test('マイグレーション 7: tasks に cancelled_from が足される。前からある行は NULL（戻せない）で、不正な値は入らない', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 6));
  before.prepare(`INSERT INTO tasks (id, title, status, origin, created_at, updated_at, completed_at) VALUES ('old', '前に取り消したもの', 'cancelled', 'user', 1, 1, 1)`).run();
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const columns = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(c => c.name);
    assert.ok(columns.includes('cancelled_from'));
    assert.equal((db.prepare("SELECT cancelled_from FROM tasks WHERE id = 'old'").get() as { cancelled_from: string | null }).cancelled_from, null);
    db.prepare("UPDATE tasks SET cancelled_from = 'running' WHERE id = 'old'").run();
    assert.throws(() => db.prepare("UPDATE tasks SET cancelled_from = 'done' WHERE id = 'old'").run(), /CHECK/u);
  } finally { db.close(); }
});

test('マイグレーション 16: 振り返りの会話が、材料にした会話・タスクを自分で覚える。前からあるもので、振り返りの記録から辿れるものは、記録の値で埋める', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 15));
  const conversation = (id: string, kind: 'chat' | 'task') => before.prepare('INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, ?, 1, 1)').run(id, kind);
  for (const [id, kind] of [['src', 'chat'], ['rv1', 'task'], ['rv2', 'task'], ['rv3', 'task'], ['loose', 'task']] as const) conversation(id, kind);
  const job = (key: string, trigger: string, conversationId: string | null, taskId: string | null, review: string | null) =>
    before.prepare('INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, task_id, review_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, 1)').run(trigger, key, conversationId, taskId, review);
  job('k1', 'idle', 'src', null, 'rv1');
  job('k2', 'task', null, 'tk', 'rv2');
  job('k3', 'book_full', null, null, 'rv3');
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const row = (id: string) => db.prepare('SELECT source_conversation_id AS c, source_task_id AS t FROM conversations WHERE id = ?').get(id) as { c: string | null; t: string | null };
    assert.deepEqual({ ...row('rv1') }, { c: 'src', t: null });
    assert.deepEqual({ ...row('rv2') }, { c: null, t: 'tk' });
    assert.deepEqual({ ...row('rv3') }, { c: null, t: null }, '材料が無い振り返り（記憶の整理）は NULL');
    assert.deepEqual({ ...row('loose') }, { c: null, t: null }, '振り返りの記録から辿れない会話は NULL のまま');
    assert.deepEqual({ ...row('src') }, { c: null, t: null });
  } finally { db.close(); }
});

test('マイグレーション 9〜24 を続けて当てる: main の段階（8）の DB から更新しても、振り返りの会話の材料が埋まり、前からあるすべての会話に外から読んだ印が付く。16 は 15 のあとに、17（スキルの登録簿）は 16 のあとに、18（子の担当の親）は 17 のあとに足される', t => {
  assert.equal(MIGRATIONS.length, 24);
  assert.match(String(MIGRATIONS[23]), /untrusted-input/u);
  assert.match(String(MIGRATIONS[22]), /CREATE TABLE acceptance_changes/u);
  assert.match(String(MIGRATIONS[21]), /acceptance_items/u);
  assert.match(String(MIGRATIONS[20]), /CREATE TABLE acceptance_versions/u);
  assert.match(String(MIGRATIONS[19]), /CREATE TABLE projects/u);
  assert.match(String(MIGRATIONS[18]), /local_only/u);
  assert.match(String(MIGRATIONS[17]), /parent_run_id/u);
  assert.match(String(MIGRATIONS[16]), /skill_registry/u);
  assert.match(String(MIGRATIONS[15]), /source_conversation_id/u);
  assert.match(String(MIGRATIONS[14]), /grant_folder/u);
  const path = join(tempDir(t), 'clive.db');
  const main = openDatabase(path, MIGRATIONS.slice(0, 8));
  for (const [id, kind] of [['src', 'chat'], ['rv', 'task']] as const) main.prepare('INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, ?, 1, 1)').run(id, kind);
  main.prepare("INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, review_conversation_id, created_at) VALUES ('idle', 'k1', 'src', 'rv', 1)").run();
  main.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    const row = db.prepare('SELECT source_conversation_id AS c, ever_tainted AS tainted, permission_mode AS mode FROM conversations WHERE id = ?').get('rv') as { c: string | null; tainted: number; mode: string };
    assert.deepEqual({ ...row }, { c: 'src', tainted: 1, mode: 'normal' });
    assert.equal((db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get('src') as { ever_tainted: number }).ever_tainted, 1);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 24);
  } finally { db.close(); }
});

test('マイグレーション 18: 会話と実行の記録に親の実行 parent_run_id が足される。前からある行は NULL。子の会話は kind task のまま作れ、親の実行を覚える（AU-4）', t => {
  const path = join(tempDir(t), 'clive.db');
  const before = openDatabase(path, MIGRATIONS.slice(0, 17));
  before.prepare('INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, ?, 1, 1)').run('old', 'chat');
  before.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('oldrun', 'chat', 'old', 1)").run();
  before.close();
  const db = openDatabase(path, MIGRATIONS);
  try {
    assert.equal((db.prepare('SELECT parent_run_id AS p FROM conversations WHERE id = ?').get('old') as { p: string | null }).p, null);
    assert.equal((db.prepare('SELECT parent_run_id AS p FROM engine_runs WHERE id = ?').get('oldrun') as { p: string | null }).p, null);
    const conversations = new Conversations(db);
    const runs = new Runs(db);
    const child = conversations.create({ kind: 'task', title: 'child', source: { conversationId: 'old' }, parentRunId: 'oldrun' });
    assert.equal(child.kind, 'task');
    assert.equal(child.parent_run_id, 'oldrun');
    assert.equal(child.source_conversation_id, 'old');
    assert.equal(conversations.create({ kind: 'task' }).parent_run_id, null, '指定しなければ NULL');
    runs.start('childrun', 'agent', child.id, 'oldrun');
    runs.start('plain', 'chat', 'old');
    assert.equal((runs.get('childrun') as { parent_run_id?: string | null } | undefined)?.parent_run_id, 'oldrun');
    assert.equal((runs.get('plain') as { parent_run_id?: string | null } | undefined)?.parent_run_id, null);
    assert.deepEqual(conversations.list().map(c => c.id), ['old'], '子の会話は一覧に出ない（kind が chat でない）');
  } finally { db.close(); }
});