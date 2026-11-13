import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChecklistItem, Project, Task } from '../web/src/api.ts';
import { buildBoard } from '../web/src/ui/kanban.ts';
import {
  cardProduct, conversationOwners, finishedPaging, finishedSince, hasSomething, holders, LAST_LOOK_KEY, listsProducts, miniBoard, productLookKey, productSection, productTiles, readLastLook,
  runningRows, taskOwners, tiles,
} from '../web/src/ui/overview.ts';

// 新しい画面の Overview（steps/p1-ui.md の「画面」の Overview と PR 1-4b）の決まり。画面を持たない純粋な関数（web/src/ui/overview.ts）。

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});

test('ui/overview: タイルは Proposals・Questions・Pending の 3 つで、0 でも隠さない。Pending は Pending の一覧の数で、全製品の Pending の画面へ行く（4-U1）', () => {
  assert.deepEqual(tiles({ proposals: 2, answers: 1 }, 2), [
    { id: 'proposals', n: 2, href: '#/kanban' }, { id: 'questions', n: 1, href: '#/kanban' }, { id: 'pending', n: 2, href: '#/pending' },
  ]);
  assert.deepEqual(tiles({ proposals: 0, answers: 0 }, 0).map(tile => [tile.id, tile.n, tile.href]), [['proposals', 0, '#/kanban'], ['questions', 0, '#/kanban'], ['pending', 0, '#/pending']]);
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

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

test('ui/overview: 最後に見た時刻は製品ごとに別の鍵で覚える（Workspace の鍵とも別）', () => {
  assert.equal(productLookKey('p1aaaa'), 'beat.lastLook.p1aaaa');
  assert.notEqual(productLookKey('p1aaaa'), productLookKey('p2aaaa'));
  assert.notEqual(productLookKey('p1aaaa'), LAST_LOOK_KEY);
});

test('ui/overview: 会話の持ち主の製品は、会話の行とタスクの会話から引く（無ければ引けない）', () => {
  const owners = conversationOwners([{ id: 'c1', project_id: 'p1aaaa' }, { id: 'c2' }], [task('t1', 'running', { conversation_id: 'tc1', project_id: 'p2aaaa' }), task('t2', 'done', { conversation_id: 'tc2' })]);
  assert.deepEqual([...owners], [['tc1', 'p2aaaa'], ['tc2', null], ['c1', 'p1aaaa'], ['c2', null]]);
  assert.equal(owners.has('other'), false);
});

test('ui/overview: ProductHome のタイルは製品の行の待ちの数。Questions はその製品の返事待ちのタスク、Pending はその製品の Pending の欄へ（4-U1）。0 も出す', () => {
  const p = project('p1aaaa', { waiting: { proposals: 2, questions: 1, pending: 1 } });
  const tasks = [task('q-other', 'waiting', { project_id: 'p2aaaa' }), task('q-none', 'waiting'), task('q-mine', 'waiting', { project_id: 'p1aaaa' })];
  assert.deepEqual(productTiles(p, tasks), [
    { id: 'proposals', n: 2, href: '#/kanban' }, { id: 'questions', n: 1, href: '#/tasks/q-mine' }, { id: 'pending', n: 1, href: '#/pending/p1aaaa' },
  ]);
  assert.deepEqual(productTiles(project('p1aaaa'), tasks.slice(0, 2)), [
    { id: 'proposals', n: 0, href: '#/kanban' }, { id: 'questions', n: 0, href: '#/kanban' }, { id: 'pending', n: 0, href: '#/pending/p1aaaa' },
  ]);
});

test('ui/overview: AllProducts のタイルの下の行は「どの製品に何件」。待ちの多い製品から、0 の製品は書かない、しまった製品は入れない', () => {
  const projects = [
    project('few111', { waiting: { proposals: 1, questions: 0, pending: 0 }, created_at: 1 }),
    project('many11', { waiting: { proposals: 2, questions: 3, pending: 0 }, created_at: 2 }),
    project('gone11', { waiting: { proposals: 5, questions: 0, pending: 0 }, archived_at: 9 }),
  ];
  assert.deepEqual(holders(projects, 'proposals', 3), [{ name: 'many11', n: 2 }, { name: 'few111', n: 1 }]);
  assert.deepEqual(holders(projects, 'proposals', 7), [{ name: 'many11', n: 2 }, { name: 'few111', n: 1 }, { name: null, n: 4 }], '製品の外の分は最後に「製品なし」で');
  assert.deepEqual(holders(projects, 'questions', 3), [{ name: 'many11', n: 3 }]);
  assert.deepEqual(holders(projects, 'pending', 2), [], 'どの製品にも無ければ書かない（ふつうの文のまま）');
});

test('ui/overview: 製品の節は、その製品のタスクの実行と会話だけを Running に、最後に見たあとの失敗を Failed に、終わった数を数える', () => {
  const input = {
    worker: [{ kind: 'task' as const, taskId: 't-mine', runId: 'r1', title: 'Mine' }, { kind: 'task' as const, taskId: 't-none', runId: 'r2', title: 'None' }, { kind: 'review' as const, taskId: null, runId: 'r3', title: 'review' }],
    drafts: [{ runId: 'r4', conversationId: 'c-mine' }, { runId: 'r5', conversationId: 'c-none' }],
    conversations: [{ id: 'c-mine', title: 'Chat mine', project_id: 'p1aaaa' }, { id: 'c-none', title: 'Chat none' }],
    checklists: new Map<string, ChecklistItem[]>(),
  };
  const owners = taskOwners([task('t-mine', 'running', { project_id: 'p1aaaa' }), task('t-none', 'running')]);
  const done = [task('f-mine', 'failed', { project_id: 'p1aaaa' }), task('d-mine', 'done', { project_id: 'p1aaaa' }), task('f-none', 'failed')];
  const mine = productSection('p1aaaa', input, owners, done);
  assert.deepEqual(mine.running.map(row => row.runId), ['r1', 'r4']);
  assert.deepEqual(mine.failed.map(t => t.id), ['f-mine']);
  assert.equal(mine.finished, 2);
  const none = productSection(null, input, owners, done);
  assert.deepEqual(none.running.map(row => row.runId), ['r2', 'r3', 'r5'], '製品なしの節に振り返りと製品なしの会話');
  assert.deepEqual(none.failed.map(t => t.id), ['f-none']);
  assert.deepEqual(productSection('p2aaaa', input, owners, done), { running: [], failed: [], finished: 0 });
});

test('ui/overview: 終わったタスクは、最後に見た時刻より前まで読み足す。上限で止まったら capped（数が少なく見えるのを黙らない）', () => {
  const at = (...stamps: number[]) => stamps.map((s, i) => task(`t${i}`, 'done', { completed_at: s }));
  assert.equal(finishedPaging(at(500, 400), false, 100, 2), 'done', '次のページが無ければ終わり');
  assert.equal(finishedPaging([], true, 100, 2), 'more');
  assert.equal(finishedPaging(at(500, 400), true, 100, 2), 'more', '最後に見た時刻にまだ届いていない');
  assert.equal(finishedPaging(at(500, 90), true, 100, 2), 'done', '届いた');
  assert.equal(finishedPaging(at(90), true, 100, 2), 'more', '届いても、板に要る数までは読む');
  assert.equal(finishedPaging(at(500, 400, 300), true, 100, 2, 3), 'capped', '上限で止まって、まだ届いていない');
  assert.equal(finishedPaging(at(500, 400, 90), true, 100, 2, 3), 'done');
  const reviewer = [...Array.from({ length: 25 }, (_, i) => task(`a${i}`, 'done', { completed_at: 1000 - i, project_id: 'A' })), task('b', 'failed', { completed_at: 900, project_id: 'B' })];
  let loaded = 0;
  while (finishedPaging(reviewer.slice(0, loaded), loaded < reviewer.length, 50, 20) === 'more') loaded += 20;
  const done = finishedSince(reviewer.slice(0, loaded), 50, Number.POSITIVE_INFINITY).tasks;
  const input = { worker: [], drafts: [], conversations: [], checklists: new Map<string, ChecklistItem[]>() };
  assert.deepEqual(productSection('B', input, new Map(), done), { running: [], failed: [reviewer[25]], finished: 1 }, '静かな製品の失敗が押し出されない');
  assert.equal(productSection('A', input, new Map(), done).finished, 25);
});

test('ui/overview: "No product" の節は、動いている・失敗したものが無くても、最後に見たあとに終わったものがあれば出す', () => {
  const row = runningRows({ worker: [{ kind: 'review', taskId: null, runId: 'r', title: 'x' }], drafts: [], conversations: [], checklists: new Map() })[0]!;
  assert.equal(hasSomething({ running: [], failed: [], finished: 0 }), false);
  assert.equal(hasSomething({ running: [], failed: [], finished: 3 }), true);
  assert.equal(hasSomething({ running: [row], failed: [], finished: 0 }), true);
  assert.equal(hasSomething({ running: [], failed: [task('f', 'failed')], finished: 0 }), true);
});

test('ui/overview: 製品が 5 つ以上なら 1 つの一覧にする。カードの製品はタスクの行か会話の持ち主から', () => {
  assert.deepEqual([0, 1, 4, 5, 9].map(listsProducts), [false, false, false, true, true]);
  const board = buildBoard({
    active: [task('t1', 'inbox', { project_id: 'p1aaaa' }), task('t2', 'inbox')], finished: [], hasMore: false, finishedTotal: 0,
    sessions: [{ kind: 'session', key: 's:c1:progress', column: 'progress', conversationId: 'c1', title: 'x', at: 1, startedAt: 1, step: null, outcome: 'running' }],
  });
  const owners = new Map<string, string | null>([['c1', 'p2aaaa']]);
  const cards = board.columns.flatMap(column => column.cards);
  assert.deepEqual(cards.map(card => cardProduct(card, owners)), cards.map(card => (card.kind === 'task' ? (card.task.id === 't1' ? 'p1aaaa' : null) : 'p2aaaa')));
  assert.equal(cards.length, 3);
});
