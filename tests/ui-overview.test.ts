import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChecklistItem, Task } from '../web/src/api.ts';
import { buildBoard } from '../web/src/ui/kanban.ts';
import { finishedSince, miniBoard, readLastLook, runningRows, tiles } from '../web/src/ui/overview.ts';

// 新しい画面の Overview（steps/p1-ui.md の「画面」の Overview と PR 1-4b）の決まり。画面を持たない純粋な関数（web/src/ui/overview.ts）。

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});

test('ui/overview: タイルは Proposals・Questions・Pending の 3 つで、0 でも隠さない。Pending は承認を待つ道具の呼び出しの数で、いちばん古いものの会話へ行く', () => {
  assert.deepEqual(tiles({ proposals: 2, answers: 1 }, [{ conversationId: 'c 1' }, { conversationId: 'c2' }]), [
    { id: 'proposals', n: 2, href: '#/kanban' }, { id: 'questions', n: 1, href: '#/kanban' }, { id: 'pending', n: 2, href: '#/c/c%201' },
  ]);
  assert.deepEqual(tiles({ proposals: 0, answers: 0 }, []).map(tile => [tile.id, tile.n, tile.href]), [['proposals', 0, '#/kanban'], ['questions', 0, '#/kanban'], ['pending', 0, null]]);
});

test('ui/overview: 小さな盤は列ごとに上の 2 枚と "N more"。Done と Failed の N には、まだ読んでいない古い分も入る', () => {
  const finished = [1, 2, 3, 4].map(n => task(`d${n}`, 'done', { completed_at: n }));
  const board = buildBoard({ active: [task('p1', 'inbox'), task('r1', 'ready'), task('r2', 'ready'), task('r3', 'ready')], finished, hasMore: true, finishedTotal: 30, sessions: [] });
  const mini = miniBoard(board);
  assert.deepEqual(mini.map(c => [c.id, c.count, c.cards.length, c.more, c.accent]), [
    ['proposed', 1, 1, 0, true], ['approved', 3, 2, 1, false], ['progress', 0, 0, 0, false], ['done', 4, 2, 28, false], ['failed', 0, 0, 26, false],
  ]);
  assert.deepEqual(mini[3]!.cards.map(card => (card.kind === 'task' ? card.task.id : '')), ['d4', 'd3']);
});

test('ui/overview: Running now は、ワーカーの実行（タスク・振り返り）と返事を作っている会話。同じ実行を 2 回出さず、一覧に無い会話（タスクの会話）は出さない', () => {
  const checklists = new Map<string, ChecklistItem[]>([['c1', [{ text: 'a', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }]]]);
  const rows = runningRows({
    worker: [{ kind: 'task', taskId: 't1', runId: 'r-task', title: 'Backup' }, { kind: 'review', taskId: null, runId: 'r-review', title: 'review' }],
    drafts: [{ runId: 'r-task', conversationId: 'task-conv' }, { runId: 'r-chat', conversationId: 'c1', startedAt: 500 }, { runId: 'r-hidden', conversationId: 'not-listed' }],
    conversations: [{ id: 'c1', title: 'Plan the week' }, { id: 'task-conv', title: 'x' }],
    checklists,
  });
  assert.deepEqual(rows.map(row => [row.kind, row.runId, row.title, row.href, row.step, row.startedAt]), [
    ['task', 'r-task', 'Backup', '#/tasks/t1', null, null],
    ['review', 'r-review', null, null, null, null],
    ['session', 'r-chat', 'Plan the week', '#/c/c1', { step: 2, total: 3 }, 500],
  ]);
  assert.deepEqual(runningRows({ worker: [], drafts: [], conversations: [], checklists }), []);
});

test('ui/overview: Finished since は、最後に見たあとに終わった done と failed を新しい順に。取り消したタスクとひな形は出さない', () => {
  const finished = [
    task('old', 'done', { completed_at: 50 }), task('ok', 'done', { completed_at: 200 }), task('bad', 'failed', { completed_at: 300 }),
    task('cancelled', 'cancelled', { completed_at: 400 }), task('template', 'done', { completed_at: 500, cron: '0 9 * * *' }), task('noStamp', 'done', { updated_at: 250 }),
  ];
  assert.deepEqual(finishedSince(finished, 100).tasks.map(t => t.id), ['bad', 'noStamp', 'ok']);
  assert.deepEqual(finishedSince(finished, 100, 2), { tasks: [finished[2], finished[5]], more: 1 });
  assert.deepEqual(finishedSince(finished, 1000), { tasks: [], more: 0 });
});

test('ui/overview: 最後に見た時刻はブラウザに保存した値。無い・読めない・未来の値のときは今日の始まりからにする', () => {
  const dayStart = (ms: number): number => Math.floor(ms / 1000) * 1000;
  assert.deepEqual(readLastLook('4200', 5500, dayStart), { at: 4200, known: true });
  for (const raw of [null, '', 'abc', '-5', '0', '9999', '1e3']) assert.deepEqual(readLastLook(raw, 5500, dayStart), { at: 5000, known: false }, String(raw));
});
