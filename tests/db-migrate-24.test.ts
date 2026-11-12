import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { eraseConversation } from '../src/db/erase.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { taskText } from '../src/shared/messages/tasks.ts';
import { TaskStore, UNTRUSTED_RUN } from '../src/tasks/store.ts';
import { tempDir } from './helpers.ts';

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, taskId?: string): number => {
  const row = (taskId === undefined
    ? db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE run_id = 'untrusted-input' AND kind = 'context'").get()
    : db.prepare("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND run_id = 'untrusted-input' AND kind = 'context'").get(taskId)) as { n: number };
  return row.n;
};

function seedV23(path: string): void {
  const db = openDatabase(path, MIGRATIONS.slice(0, 23));
  try {
    assert.equal(version(db), 23);
    const convo = db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at, ever_tainted) VALUES (?, 'chat', 'c', 1, 1, ?)");
    convo.run('chat-read', 1);
    convo.run('chat-clean', 0);
    const run = db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, started_at, tainted) VALUES (?, ?, ?, 1, ?)');
    run.run('r-clean-in-read', 'chat', 'chat-read', 0);
    run.run('r-read', 'chat', 'chat-clean', 1);
    run.run('r-ok', 'chat', 'chat-clean', 0);
    convo.run('chat-early', 1);
    run.run('r-early', 'chat', 'chat-early', 0);
    const task = db.prepare("INSERT INTO tasks (id, title, body, status, origin, cron, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)");
    task.run('t-note', 'Owner task', 'owner body\n- EVIL', 'ready', 'user', null, null);
    task.run('t-run', 'Run task', 'body', 'ready', 'user', null, null);
    task.run('t-gone', 'Gone task', 'body', 'ready', 'user', null, null);
    task.run('t-marked', 'Marked task', 'body', 'ready', 'user', null, null);
    task.run('t-clean', 'Clean task', 'body\n- fine', 'ready', 'user', null, null);
    task.run('tpl', 'Daily', 'tb\n- EVIL2', 'scheduled', 'user', '0 9 * * *', null);
    task.run('t-child', 'Daily', 'tb\n- EVIL2', 'done', 'schedule', null, 'tpl');
    task.run('tpl-clean', 'Weekly', 'clean body', 'scheduled', 'user', '0 9 * * 1', null);
    task.run('t-child-clean', 'Weekly', 'clean body', 'done', 'schedule', null, 'tpl-clean');
    task.run('t-orphan', 'Hourly', 'hb\n- EVIL3', 'done', 'schedule', null, null);
    task.run('t-erased', 'Owner task', 'owner body\n- INJECTED', 'ready', 'user', null, null);
    task.run('t-approved', 'Approved', 'body', 'ready', 'self', null, null);
    const event = db.prepare('INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, 1)');
    event.run('t-erased', 'note', 'beat','INJECTED', 'r-early');
    event.run('t-approved', 'created', 'beat',null, null);
    event.run('t-approved', 'edited', 'beat',null, 'r-clean-in-read');
    event.run('t-approved', 'approved', 'user', null, null);
    event.run('t-note', 'note', 'beat','EVIL', 'r-clean-in-read');
    event.run('t-run', 'context', 'beat','ctx', 'r-read');
    event.run('t-gone', 'edited', 'beat',null, 'r-gone');
    event.run('t-marked', 'context', 'build', 'old mark', UNTRUSTED_RUN);
    event.run('t-marked', 'note', 'beat','x', 'r-clean-in-read');
    event.run('t-clean', 'note', 'beat','fine', 'r-ok');
    event.run('t-clean', 'reason', 'beat','not text', 'r-read');
    event.run('tpl', 'note', 'beat','EVIL2', 'r-clean-in-read');
    eraseConversation({ db, uploadsDir: dirname(path), toolOutputsDir: dirname(path) }, 'chat-early');
    assert.equal((db.prepare("SELECT conversation_id FROM engine_runs WHERE id = 'r-early'").get() as { conversation_id: string | null }).conversation_id, null);
    assert.equal(new TaskStore(db).judgeRequest('t-erased'), 'Owner task\nowner body\n- INJECTED', '前提: 移し替えの前は、消した会話の AI の文が判定役に届く');
  } finally { db.close(); }
}

test('移し替え 24: 前からある、外を読んだ実行・会話の書いたタスクの経過に印 untrusted-input を付ける。会話を消しても判定役に文が届かない。きれいなタスクは読めるまま。開き直しても印は増えない', t => {
  const dir = tempDir(t);
  const path = join(dir, 'beat.db');
  const backups = join(dir, 'backups');
  seedV23(path);
  assert.equal(MIGRATIONS.length, 24);
  assert.match(String(MIGRATIONS[23]), /untrusted-input/u);

  const db = openDatabase(path, MIGRATIONS, { backupDir: backups });
  try {
    assert.equal(version(db), 24);
    for (const id of ['t-note', 't-run', 't-gone', 'tpl']) assert.equal(count(db, id), 1, id);
    assert.equal(count(db, 't-erased'), 1, '会話を前に消した実行（会話の分からない実行）の書いた経過');
    assert.equal(count(db, 't-orphan'), 1, '予定を前に消した実行のタスク（予定の本文を写したまま証拠が無い）');
    assert.equal(count(db, 't-marked'), 1, '前からある印には重ねない');
    assert.equal(count(db, 't-clean'), 0, 'きれいな実行の経過・文でない経過では付けない');
    assert.equal(count(db, 't-child'), 0, '実行のタスクには、予定が残っているあいだは付けない（親の経過を読む）');
    assert.equal(count(db, 'tpl-clean') + count(db, 't-child-clean'), 0, 'きれいな予定とその実行には付けない');
    const added = db.prepare("SELECT actor, content FROM task_events WHERE task_id = 't-note' AND run_id = 'untrusted-input'").get() as { actor: string; content: string };
    assert.deepEqual({ ...added }, { actor: 'system', content: taskText('en', 'event.run_untrusted') });
    const orphan = db.prepare("SELECT actor, content FROM task_events WHERE task_id = 't-orphan' AND run_id = 'untrusted-input'").get() as { actor: string; content: string };
    assert.deepEqual({ ...orphan }, { actor: 'system', content: taskText('en', 'event.schedule_untrusted') });
    const total = count(db);
    db.exec(String(MIGRATIONS[23]));
    assert.equal(count(db), total, '同じ移し替えを重ねても印は増えない');

    const tasks = new TaskStore(db);
    eraseConversation({ db, uploadsDir: dir, toolOutputsDir: dir }, 'chat-read');
    eraseConversation({ db, uploadsDir: dir, toolOutputsDir: dir }, 'chat-clean');
    for (const id of ['t-note', 't-run', 't-gone', 't-marked', 't-child', 't-erased', 't-orphan']) assert.equal(tasks.judgeRequest(id), '', id);
    assert.equal(tasks.judgeRequest('t-clean'), 'Clean task\nbody\n- fine');
    assert.equal(tasks.judgeRequest('t-child-clean'), 'Weekly\nclean body');
    assert.equal(count(db, 't-approved'), 1, '前提: 承認のあとに印が足された');
    assert.equal(tasks.unapprove('t-approved').status, 'inbox', '印は承認の取り消しを妨げない');
    tasks.remove('tpl');
    assert.equal(tasks.get('t-child')!.parent_id, null);
    assert.equal(tasks.judgeRequest('t-child'), '', '予定を消しても、写した本文は判定役に届かない');
  } finally { db.close(); }

  assert.match(readdirSync(backups).join(','), /-v23-.+\.db/u);
  const again = openDatabase(path, MIGRATIONS, { backupDir: backups });
  try {
    assert.equal(version(again), 24);
    assert.equal(readdirSync(backups).length, 1);
  } finally { again.close(); }
});
