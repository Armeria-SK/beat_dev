import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs, type RunRow } from '../src/db/runs.ts';
import type { Usage } from '../src/engine/types.ts';
import { tempDir } from './helpers.ts';

test('マイグレーションは新規でも再オープンでも同じ状態になる', t => {
  const path = join(tempDir(t), 'beat.db');
  openDatabase(path, MIGRATIONS).close();
  const db = openDatabase(path, MIGRATIONS);
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  assert.equal(user_version, MIGRATIONS.length);
  db.close();
});

test('アプリより新しいスキーマは開かない', t => {
  const path = join(tempDir(t), 'beat.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDatabase(path, MIGRATIONS), /newer/);
});

test('未適用のマイグレーションがあれば、適用前にバックアップを取る', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
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

// 止められた・落ちた実行の量（self-fix S4）。量は model_calls の turn と discarded の合計、tool_calls は tool_calls の表の行数
const call = (runs: Runs, runId: string, purpose: 'turn' | 'compact' | 'discarded', model: string, usage: Usage): void => runs.recordCall({ runId, purpose, model, usage, tools: [], system: { frozen: 'f', dynamic: 'd' }, startedAt: 1 });
const toolRow = (db: DatabaseSync, runId: string, id: string): void => {
  db.prepare("INSERT INTO tool_calls (id, run_id, tool, input, decision, decided_by, created_at) VALUES (?, ?, 'file_read', '{}', 'allow', 'rule', 1)").run(id, runId);
};
const counts = (row: RunRow) => [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens];

test('止められた実行は、量を渡されなくても model_calls の turn と discarded の合計が engine_runs の量になる（compact は入らない）', () => {
  const runs = new Runs(openDatabase(':memory:', MIGRATIONS));
  runs.start('r1', 'chat', 'c1');
  call(runs, 'r1', 'turn', 'm', { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 200 });
  call(runs, 'r1', 'discarded', 'm', { inputTokens: 500, outputTokens: 64_000, cacheReadTokens: 100, cacheWriteTokens: 50 });
  call(runs, 'r1', 'compact', 'm', { inputTokens: 4000, outputTokens: 300 });
  runs.finish('r1', { ok: false, attempts: 1, errorKind: 'cancelled', modelId: 'm', toolCalls: 2 });
  const row = runs.get('r1')!;
  assert.deepEqual(counts(row), [1500, 64_010, 800, 250]);
  assert.equal(row.tool_calls, 2, '道具の数は渡された値のまま');
});

test('止められた実行でも、量つきで終えたときは渡した値のまま。呼び出しの記録が 1 行も無ければ今までどおり空', () => {
  const runs = new Runs(openDatabase(':memory:', MIGRATIONS));
  runs.start('r1', 'chat');
  call(runs, 'r1', 'turn', 'm', { inputTokens: 1000, outputTokens: 10 });
  runs.finish('r1', { ok: false, attempts: 1, errorKind: 'cancelled', usage: { inputTokens: 7, outputTokens: 3 } });
  assert.deepEqual(counts(runs.get('r1')!), [7, 3, null, null]);
  runs.start('r2', 'chat');
  runs.finish('r2', { ok: false, attempts: 1, errorKind: 'cancelled' });
  assert.deepEqual(counts(runs.get('r2')!), [null, null, null, null]);
});

test('ok・失敗で終えた実行は今までどおり。量を渡さなければ空のまま（model_calls を足さない）', () => {
  const runs = new Runs(openDatabase(':memory:', MIGRATIONS));
  runs.start('r1', 'chat');
  call(runs, 'r1', 'turn', 'm', { inputTokens: 1000, outputTokens: 10 });
  runs.finish('r1', { ok: true, attempts: 1 });
  assert.deepEqual(counts(runs.get('r1')!), [null, null, null, null]);
  runs.start('r2', 'chat');
  call(runs, 'r2', 'turn', 'm', { inputTokens: 1000, outputTokens: 10 });
  runs.finish('r2', { ok: false, attempts: 1, errorKind: 'rate_limit' });
  assert.deepEqual(counts(runs.get('r2')!), [null, null, null, null]);
  runs.start('r3', 'chat');
  runs.finish('r3', { ok: true, attempts: 1, usage: { inputTokens: 10, outputTokens: 5 } });
  assert.deepEqual(counts(runs.get('r3')!), [10, 5, null, null]);
});

test('再起動時に閉じた実行（落ちた実行）は、model_calls の合計・tool_calls の行数・最後に呼んだモデルが残る。ほかの実行や終わった実行には触らない', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const runs = new Runs(db);
  runs.start('r1', 'chat', 'c1');
  call(runs, 'r1', 'turn', 'm-first', { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 700, cacheWriteTokens: 200 });
  call(runs, 'r1', 'discarded', 'm-first', { inputTokens: 500, outputTokens: 64_000, cacheReadTokens: 100, cacheWriteTokens: 50 });
  call(runs, 'r1', 'compact', 'm-first', { inputTokens: 4000, outputTokens: 300 });
  call(runs, 'r1', 'turn', 'm-last', { inputTokens: 2000, outputTokens: 20, cacheReadTokens: 1500, cacheWriteTokens: 0 });
  for (const id of ['t1', 't2', 't3']) toolRow(db, 'r1', id);
  runs.start('r-other', 'chat');
  call(runs, 'r-other', 'turn', 'm-other', { inputTokens: 9, outputTokens: 9 });
  toolRow(db, 'r-other', 't9');
  runs.start('r-done', 'chat');
  runs.finish('r-done', { ok: true, attempts: 1, modelId: 'm-done', usage: { inputTokens: 5, outputTokens: 5 }, toolCalls: 4 });
  const done = runs.get('r-done')!;
  assert.equal(runs.closeDangling(), 2);
  const row = runs.get('r1')!;
  assert.deepEqual(counts(row), [3500, 64_030, 2300, 250], 'turn と discarded の合計。compact（4000 / 300）は入らない');
  assert.equal(row.tool_calls, 3);
  assert.equal(row.model_id, 'm-last');
  assert.equal(row.error_kind, 'cancelled');
  assert.deepEqual([runs.get('r-other')!.input_tokens, runs.get('r-other')!.tool_calls, runs.get('r-other')!.model_id], [9, 1, 'm-other'], '自分の実行の分だけを足す');
  assert.deepEqual(runs.get('r-done'), done, '終わっていた実行は変わらない');
});

test('再起動時に閉じた実行に model_calls も tool_calls も無ければ、今までどおり量は空・道具は 0・モデルは空', () => {
  const runs = new Runs(openDatabase(':memory:', MIGRATIONS));
  runs.start('r1', 'chat');
  assert.equal(runs.closeDangling(), 1);
  const row = runs.get('r1')!;
  assert.deepEqual(counts(row), [null, null, null, null]);
  assert.deepEqual([row.tool_calls, row.model_id], [0, null]);
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
  const path = join(tempDir(t), 'beat.db');
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
  const path = join(tempDir(t), 'beat.db');
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
  const path = join(tempDir(t), 'beat.db');
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
  assert.ok(MIGRATIONS.length >= 24);
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
  const path = join(tempDir(t), 'beat.db');
  const main = openDatabase(path, MIGRATIONS.slice(0, 8));
  for (const [id, kind] of [['src', 'chat'], ['rv', 'task']] as const) main.prepare('INSERT INTO conversations (id, kind, created_at, last_message_at) VALUES (?, ?, 1, 1)').run(id, kind);
  main.prepare("INSERT INTO memory_jobs (trigger, dedup_key, conversation_id, review_conversation_id, created_at) VALUES ('idle', 'k1', 'src', 'rv', 1)").run();
  main.close();
  const db = openDatabase(path, MIGRATIONS.slice(0, 24));
  try {
    const row = db.prepare('SELECT source_conversation_id AS c, ever_tainted AS tainted, permission_mode AS mode FROM conversations WHERE id = ?').get('rv') as { c: string | null; tainted: number; mode: string };
    assert.deepEqual({ ...row }, { c: 'src', tainted: 1, mode: 'normal' });
    assert.equal((db.prepare('SELECT ever_tainted FROM conversations WHERE id = ?').get('src') as { ever_tainted: number }).ever_tainted, 1);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 24);
  } finally { db.close(); }
});

test('マイグレーション 18: 会話と実行の記録に親の実行 parent_run_id が足される。前からある行は NULL。子の会話は kind task のまま作れ、親の実行を覚える（AU-4）', t => {
  const path = join(tempDir(t), 'beat.db');
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
test('walk-1118 D4: 最初の発言からの題は 40 字に収め、長いときは単語の切れ目で切って … を付ける（空白の無い文は 39 字で切る。サロゲートの片割れを残さない）', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const titled = (text: string) => {
    const c = conversations.create({});
    conversations.autoTitle(c.id, text);
    return conversations.get(c.id)!.title;
  };
  assert.equal(titled('Please create hello.txt with the word hello in it'), 'Please create hello.txt with the word…');
  assert.equal(titled('  Short   request  '), 'Short request', '40 字までは今までどおり、そのまま');
  assert.equal(titled('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(titled('a'.repeat(60)), `${'a'.repeat(39)}…`, '切れ目が無ければ字数で切る');
  assert.equal(titled('あ'.repeat(50)), `${'あ'.repeat(39)}…`);
  assert.equal(titled(`${'a'.repeat(38)}😀 tail text`), `${'a'.repeat(38)}…`, 'サロゲートの片割れを残さない');
  assert.ok([...titled('word '.repeat(20))!].length <= 40);
  db.close();
});
test('A6: 自動の題は、絵文字・国旗・結合文字の途中では切らない（見た目の 1 文字の境目で切る。40 字までの決まりと単語の切れ目は今のまま）', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const titled = (text: string) => {
    const c = conversations.create({});
    conversations.autoTitle(c.id, text);
    return conversations.get(c.id)!.title;
  };
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'; // 家族の絵文字（8 つ分。ZWJ でつながる）
  assert.equal(titled(`${'a'.repeat(34)}${family}b tail`), `${'a'.repeat(34)}…`, 'ZWJ でつながる絵文字を、途中の別の絵文字にして残さない');
  assert.equal(titled(`${'a'.repeat(37)}\u{1F1EF}\u{1F1F5} tail`), `${'a'.repeat(37)}…`, '国旗（地域の記号 2 つ）の片方だけを残さない');
  assert.equal(titled(`${'a'.repeat(38)}e\u0301${'b'.repeat(10)}`), `${'a'.repeat(38)}…`, '結合文字だけを切り落として、字の形を変えない');
  assert.equal(titled(`${'a'.repeat(37)}\u{1F44D}\u{1F3FD}${'b'.repeat(10)}`), `${'a'.repeat(37)}…`, '肌の色の指定だけを切り落とさない');
  // 収まるものは今までどおり、切れ目で切る・字数で切る
  assert.equal(titled(`${'a'.repeat(30)}${family}`), `${'a'.repeat(30)}${family}`, '40 字に収まるときは切らない');
  assert.equal(titled(`${'a'.repeat(30)}${'\u{1F600}'.repeat(6)}`),`${'a'.repeat(30)}\u{1F600}\u{1F600}\u{1F600}\u{1F600}…`, '1 つで 1 文字の絵文字は、境目のところまで残す（サロゲートの片割れを残さない）');
  assert.equal(titled(`a${'\u0301'.repeat(60)}`), `a${'\u0301'.repeat(38)}…`, '先頭の 1 文字が上限より長いときだけ、字数で切る（題を空にしない）');
  assert.equal(titled('Please create hello.txt with the word hello in it'), 'Please create hello.txt with the word…');
  assert.equal(titled('a'.repeat(60)), `${'a'.repeat(39)}…`);
  assert.equal(titled('あ'.repeat(50)), `${'あ'.repeat(39)}…`);
  assert.equal(titled(`${'a'.repeat(38)}\u{1F600} tail text`), `${'a'.repeat(38)}…`);
  db.close();
});
