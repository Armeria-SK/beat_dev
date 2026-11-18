import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskApp } from './helpers/task-app.ts';

const SECRET = 'exact-provider-secret-0123456789';
const SUMMARY = `Deployed with ${SECRET}\napi_key=abcd1234efgh5678`;
const leaks = (body: unknown) => {
  const text = JSON.stringify(body);
  return text.includes(SECRET) || text.includes('abcd1234efgh5678');
};

test('B3: タスクの結果の要約は、一覧・詳細・ひな形の最後の実行・提案のどれでも伏せて返す', async t => {
  const s = await taskApp(t);
  s.app.registry.secrets = () => [SECRET];
  const done = s.userTask('Deploy');
  s.app.tasks.finish(done.id, 'done', SUMMARY, 'beat');
  const template = s.userTask('Morning', { cron: '0 9 * * *', timezone: 'UTC' });
  const run = s.app.tasks.spawnNow(template.id)!;
  s.app.tasks.finish(run.id, 'failed', `${SECRET} broke`, 'worker');
  const proposal = s.userTask('Proposal', { propose: true });
  s.app.db.prepare('UPDATE tasks SET result_summary = ? WHERE id = ?').run(SUMMARY, proposal.id);

  const changed = s.events.filter(e => e.type === 'task.changed');
  assert.ok(changed.some(e => e.type === 'task.changed' && e.task.id === done.id && e.task.status === 'done'));
  assert.equal(leaks(changed), false, 'task.changed の出来事（画面への SSE）');

  const list = (await s.api('/api/tasks')).body;
  assert.match(list.finished.find((x: any) => x.id === done.id).result_summary, /\[REDACTED\]/u);
  assert.match(list.repeating.find((x: any) => x.id === template.id).last_run.summary, /\[REDACTED\] broke/u);
  assert.equal(leaks(list), false, 'GET /api/tasks');
  const page = (await s.api('/api/tasks/finished?limit=50')).body;
  assert.ok(page.tasks.some((x: any) => x.id === done.id));
  assert.equal(leaks(page), false, 'GET /api/tasks/finished');
  const detail = (await s.api(`/api/tasks/${done.id}`)).body;
  assert.match(detail.task.result_summary, /^Deployed with \[REDACTED\]/u);
  assert.equal(leaks(detail), false, 'GET /api/tasks/:id');
  const parent = (await s.api(`/api/tasks/${template.id}`)).body;
  assert.ok(parent.runs.some((x: any) => x.id === run.id));
  assert.equal(leaks(parent), false, 'GET /api/tasks/:id の runs');
  const review = (await s.api('/api/review')).body;
  assert.ok(review.taskProposals.some((x: any) => x.id === proposal.id));
  assert.equal(leaks(review), false, 'GET /api/review');
});
