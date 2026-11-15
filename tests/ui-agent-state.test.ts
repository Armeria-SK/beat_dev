import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChecklistItem, TaskStatus } from '../web/src/api.ts';
import { agentState, checklistStep, countTasks, footLine, kanbanCount, waitingTotal, type Waiting } from '../web/src/ui/agent-state.ts';

// 新しい画面の状態（is-idle / is-working / is-waiting）と、サイドバーの足の 1 行。p1-ui.md の「枠」:
// 待ち = 承認待ちの提案（inbox）・返事待ちのタスク（waiting）・登録待ちのスキルの下書き・Pending の行。待ちが動いているより強い。

const NONE: Waiting = { proposals: 0, answers: 0, drafts: 0, pending: 0, questions: 0, checks: 0 };
const items = (...statuses: ChecklistItem['status'][]): ChecklistItem[] => statuses.map((status, i) => ({ text: `step ${i + 1}`, status }));

test('ui/agent-state: タスクの状態から、提案（inbox）と返事待ち（waiting）だけを数える', () => {
  const statuses: TaskStatus[] = ['inbox', 'inbox', 'waiting', 'ready', 'running', 'scheduled', 'done', 'failed', 'cancelled'];
  assert.deepEqual(countTasks(statuses.map((s, i) => [`t${i}`, s] as const)), { proposals: 2, answers: 1 });
  assert.deepEqual(countTasks([]), { proposals: 0, answers: 0 });
});

test('ui/agent-state: 急ぎの質問で待っているタスクは返事待ちに数えない（質問の数で 1 つだけ数える。5-2-u）', () => {
  const tasks = [['t1', 'waiting'], ['t2', 'waiting']] as const;
  const asked = new Map([['t1', 1]]);
  const counted = countTasks(tasks, asked);
  assert.deepEqual(counted, { proposals: 0, answers: 1 });
  assert.equal(waitingTotal({ ...NONE, ...countTasks([['t1', 'waiting']], asked), questions: 1 }), 1, '1 つの急ぎの質問で止まったタスクは合計 1');
});

test('ui/agent-state: Kanban の数は提案・返事待ち・確かめ待ちの和、待ちの合計は 6 つの和（Pending の一覧と Open の質問を含む。4-U1・5-2-u・5-3c-u）', () => {
  const w: Waiting = { proposals: 2, answers: 3, drafts: 4, pending: 5, questions: 6, checks: 7 };
  assert.equal(kanbanCount(w), 12, 'Open の質問は Kanban の数に入れない');
  assert.equal(waitingTotal(w), 27);
});

test('ui/agent-state: 5 つの待ちのどれか 1 つでもあれば waiting', () => {
  for (const key of ['proposals', 'answers', 'drafts', 'pending', 'questions'] as const) {
    assert.equal(agentState({ ...NONE, [key]: 1 }, false), 'waiting', key);
  }
});

test('ui/agent-state: 待ちが動いているより強い。何も無ければ idle、動いているだけなら working', () => {
  assert.equal(agentState({ ...NONE, answers: 1 }, true), 'waiting');
  assert.equal(agentState(NONE, true), 'working');
  assert.equal(agentState(NONE, false), 'idle');
});

test('ui/agent-state: 作業の一覧の今の段（やっている項目、無ければ済んだ数 + 1）。全部済んだ・空の一覧は無いのと同じ', () => {
  assert.deepEqual(checklistStep(items('done', 'done', 'in_progress', 'pending', 'pending', 'pending')), { step: 3, total: 6 });
  assert.deepEqual(checklistStep(items('done', 'pending', 'pending')), { step: 2, total: 3 });
  assert.deepEqual(checklistStep(items('pending')), { step: 1, total: 1 });
  assert.equal(checklistStep(items('done', 'done')), null);
  assert.equal(checklistStep([]), null);
});

test('ui/agent-state: 足の 1 行は、待ち → 一覧のある動き（Building）→ 動き（Running）→ Idle の順', () => {
  const list = [items('done', 'in_progress', 'pending')];
  assert.deepEqual(footLine({ ...NONE, pending: 2, drafts: 2 }, true, list, 'x'), { kind: 'waiting', n: 4 });
  assert.deepEqual(footLine(NONE, true, list, 'x'), { kind: 'building', step: 2, total: 3 });
  assert.deepEqual(footLine(NONE, true, [[], items('done'), ...list], 'x'), { kind: 'building', step: 2, total: 3 });
  assert.deepEqual(footLine(NONE, true, [items('done')], 'Morning summary'), { kind: 'running', title: 'Morning summary' });
  assert.deepEqual(footLine(NONE, true, [], null), { kind: 'running', title: null });
  assert.deepEqual(footLine(NONE, false, list, 'x'), { kind: 'idle' });
});

test('ui/agent-state: Pending の承認を待つタスクは返事待ちに数えない（Pending の数で 1 つだけ数える。beat 5-u2）', () => {
  const tasks = [['t1', 'waiting', 'approval'], ['t2', 'waiting', 'question'], ['t3', 'waiting']] as const;
  assert.deepEqual(countTasks(tasks), { proposals: 0, answers: 2 });
  assert.equal(waitingTotal({ ...NONE, ...countTasks([['t1', 'waiting', 'approval']]), pending: 1 }), 1, 'Pending の 1 行で止まったタスクは合計 1');
});
