import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';

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
