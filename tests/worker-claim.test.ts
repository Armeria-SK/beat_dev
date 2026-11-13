import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';
import { reply } from './helpers.ts';

const count = (s: Awaited<ReturnType<typeof startApp>>): number => Number((s.app.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n);

test('worker: タスクを取れなかったとき（ほかで消された・状態が変わった）は、中身の無い会話を作らない', async t => {
  const s = await startApp(t);
  const task = s.app.tasks.create({ title: 'Tidy the notes', body: 'x', origin: 'user', actor: 'test' });
  const before = count(s);
  s.app.tasks.claim = () => false;
  assert.equal(await s.app.worker.tick(), 'busy');
  assert.equal(count(s), before);
  assert.equal(s.app.tasks.get(task.id)?.conversation_id, null);
});

test('worker: タスクを取ったあと会話を作るのに失敗しても、次の回で会話を作り直してタスクを動かす', async t => {
  const s = await startApp(t);
  s.adapter().scripts = [reply('All tidy.')];
  const task = s.app.tasks.create({ title: 'Tidy the notes', body: 'x', origin: 'user', actor: 'test' });
  const create = s.app.conversations.create.bind(s.app.conversations);
  let failOnce = true;
  s.app.conversations.create = (input = {}) => {
    if (failOnce) { failOnce = false; throw new Error('database is locked'); }
    return create(input);
  };
  await assert.rejects(s.app.worker.tick());
  const stuck = s.app.tasks.get(task.id)!;
  assert.ok(stuck.conversation_id);
  assert.equal(s.app.conversations.get(stuck.conversation_id), undefined);
  s.app.tasks.recoverExpiredLeases({ all: true });
  await s.app.worker.tick();
  const after = s.app.tasks.get(task.id)!;
  assert.equal(after.conversation_id, stuck.conversation_id);
  const made = s.app.conversations.get(after.conversation_id!);
  assert.equal(made?.kind, 'task', 'a task conversation, not a chat');
  assert.match(made?.title ?? '', /Tidy the notes/u);
  assert.ok(s.app.conversations.messages(after.conversation_id!).length > 0, 'the task ran in it');
});
