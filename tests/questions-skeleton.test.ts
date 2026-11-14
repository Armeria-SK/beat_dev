import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { fakeModel, startApp } from './app-setup.ts';

test('5-0 質問の口（骨組み）: 一覧は空、数は 0、答えの口は 404。知らない状態と番号は 400。store は行を持たず、足す口は「まだ使えない」', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')], tools: builtinTools() });
  assert.deepEqual(await s.json('/api/questions', 'GET'), { status: 200, body: { items: [] } });
  assert.deepEqual(await s.json('/api/questions?status=answered&projectId=p1&before=5', 'GET'), { status: 200, body: { items: [] } });
  assert.deepEqual(await s.json('/api/questions/counts', 'GET'), { status: 200, body: { open: 0, byProject: {}, byTask: {}, answered: 0, changed: 0 } });
  const answer = await s.json('/api/questions/7/answer', 'POST', { choice: 0 });
  assert.equal(answer.status, 404);
  assert.equal(answer.body.code, 'question.not_found');
  assert.equal((await s.json('/api/questions?status=closed', 'GET')).status, 400);
  assert.equal((await s.json('/api/questions/abc/answer', 'POST', { choice: 0 })).status, 400);
  assert.equal(s.app.questions.get(7), undefined);
  assert.throws(() => s.app.questions.add({ question: 'q', options: ['a', 'b'] }), /not available yet/u);
  assert.equal(s.app.questions.options.tasks, s.app.tasks);
  assert.equal(s.app.questions.options.projects, s.app.projects);
  assert.equal(s.app.questions.options.acceptance, s.app.acceptance);
});
