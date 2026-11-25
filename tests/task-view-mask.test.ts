import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Proposal } from '../src/tasks/proposal.ts';
import { maskedTaskView } from '../src/web/task-view.ts';
import { taskApp } from './helpers/task-app.ts';

// 登録済みの鍵（提供元の鍵）と、形で見つかる鍵（偽の値）
const SECRET = 'exact-provider-secret-0123456789';
const SHAPED = 'sk-ant-test-0000000000000000';
const leaks = (value: unknown): boolean => { const text = JSON.stringify(value); return text.includes(SECRET) || text.includes(SHAPED); };

const PROPOSAL: Proposal = {
  kind: 'bug', why: `Calls the API with ${SECRET}`, area: [`src/${SHAPED}.ts`, 'src/b.ts'], size: 'S',
  goal: `Stop printing ${SHAPED}`, evidence: `line 1\nkey ${SECRET}\nline 3`, ledger: `L ${SHAPED}`, fixable: true,
};

test('V1: タスクの「待っている質問」と提案の文は、画面と出来事に出すとき鍵を伏せる。#12 の参照は残る', async t => {
  const s = await taskApp(t);
  s.app.registry.secrets = () => [SECRET];
  const asking = s.userTask('Ask');
  s.app.tasks.setWaiting(asking.id, 'question', `Which one, #12 or #13? I tried ${SECRET} and ${SHAPED}`);

  const waiting = maskedTaskView(s.app, s.app.tasks.get(asking.id)!);
  assert.equal(leaks(waiting), false, 'waiting_text');
  assert.match(waiting.waiting_text!, /^Which one, #12 or #13\? I tried \[REDACTED\] and \[REDACTED\]$/u);

  const proposed = s.app.tasks.create({ title: 'Idea', body: 'x', origin: 'self', propose: true, proposal: PROPOSAL, actor: 'beat' });
  const view = maskedTaskView(s.app, s.app.tasks.get(proposed.id)!);
  assert.equal(leaks(view.proposal), false, 'proposal');
  assert.deepEqual(view.proposal, {
    kind: 'bug', why: 'Calls the API with [REDACTED]', area: ['src/[REDACTED].ts', 'src/b.ts'], size: 'S',
    goal: 'Stop printing [REDACTED]', evidence: 'line 1\nkey [REDACTED]\nline 3', ledger: 'L [REDACTED]', fixable: true,
  });

  // 画面へ出る道（出来事・詳細・一覧・見直し）のどれにも出ない
  const changed = s.events.filter(e => e.type === 'task.changed');
  assert.ok(changed.some(e => e.type === 'task.changed' && e.task.id === asking.id && e.task.status === 'waiting'));
  assert.equal(leaks(changed), false, 'task.changed の出来事（画面への SSE）');
  assert.equal(leaks((await s.api(`/api/tasks/${asking.id}`)).body.task), false, 'GET /api/tasks/:id');
  assert.equal(leaks((await s.api(`/api/tasks/${proposed.id}`)).body.task), false, 'GET /api/tasks/:id の提案');
  assert.equal(leaks((await s.api('/api/review')).body.taskProposals), false, 'GET /api/review');
  assert.equal(JSON.stringify((await s.api('/api/tasks')).body.active).includes(SHAPED), false, 'GET /api/tasks');
});

test('V1: 持ち主が画面で直して送り返す欄（body・next_action・title）は伏せない。伏せた印が保存されて本物を壊すため', async t => {
  const s = await taskApp(t);
  s.app.registry.secrets = () => [SECRET];
  const task = s.userTask(`Title ${SHAPED}`, { body: `Body ${SHAPED}` });
  s.app.tasks.update(task.id, { nextAction: `Next ${SHAPED}` }, 'user');
  const view = maskedTaskView(s.app, s.app.tasks.get(task.id)!);
  assert.equal(view.title, `Title ${SHAPED}`);
  assert.equal(view.body, `Body ${SHAPED}`);
  assert.equal(view.next_action, `Next ${SHAPED}`);
});
