import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { fakeModel, startApp } from './app-setup.ts';

test('質問の口: 行が無ければ一覧は空・数は 0。知らない番号の答えは 404、知らない状態と番号は 400。store は App の tasks・projects・acceptance を持ち、変化は question.changed で流れる', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], tools: builtinTools() });
  assert.deepEqual(await s.json('/api/questions', 'GET'), { status: 200, body: { items: [] } });
  assert.deepEqual(await s.json('/api/questions?status=answered&projectId=p1&before=5', 'GET'), { status: 200, body: { items: [] } });
  assert.deepEqual(await s.json('/api/questions/counts', 'GET'), { status: 200, body: { open: 0, byProject: {}, byTask: {}, answered: 0, changed: 0 } });
  const answer = await s.json('/api/questions/7/answer', 'POST', { choice: 0 });
  assert.equal(answer.status, 404);
  assert.equal(answer.body.code, 'question.not_found');
  assert.equal((await s.json('/api/questions?status=closed', 'GET')).status, 400);
  assert.equal((await s.json('/api/questions?before=x', 'GET')).status, 400);
  assert.equal((await s.json('/api/questions/abc/answer', 'POST', { choice: 0 })).status, 400);
  assert.equal(s.app.questions.get(7), undefined);
  assert.equal(s.app.questions.options.tasks, s.app.tasks);
  assert.equal(s.app.questions.options.projects, s.app.projects);
  assert.equal(s.app.questions.options.acceptance, s.app.acceptance);
  const seen: unknown[] = [];
  s.app.bus.subscribe(e => { if (e.event.type === 'question.changed') seen.push(e.event); });
  const row = s.app.questions.add({ question: 'q', options: ['a', 'b'], chosen: 1 });
  const listed = await s.json('/api/questions', 'GET');
  assert.deepEqual(listed.body.items.map((q: { id: number; status: string }) => [q.id, q.status]), [[row.id, 'open']]);
  const kept = await s.json(`/api/questions/${row.id}/answer`, 'POST', { choice: 1 });
  assert.deepEqual([kept.status, kept.body.kind, kept.body.question.status], [200, 'kept', 'answered']);
  assert.deepEqual(seen, [{ type: 'question.changed', id: row.id, projectId: null, status: 'open' }, { type: 'question.changed', id: row.id, projectId: null, status: 'answered' }]);
});
