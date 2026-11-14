import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChecklistItem, RunRow, Task } from '../web/src/api.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildBoard, cardProject, COLUMN_TABS_MEDIA, columnOf, COLUMNS, KANBAN_PAGE, mergeFinished, pagesToReload, sessionCards, stepPercent, tabStep, type Board, type ColumnId, type SessionCard,
} from '../web/src/ui/kanban.ts';

const matchesCss = (media: string): boolean => {
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'styles', 'frame.css'), 'utf8');
  const block = css.slice(css.indexOf(`@media ${media}`));
  return css.includes(`@media ${media}`) && block.includes('.ui-coltabs { display: flex;');
};

// 新しい画面の Kanban（steps/p1-ui.md の「画面」の Kanban と PR 1-4a）の決まり。画面を持たない純粋な関数（web/src/ui/kanban.ts）。

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});
const runRow = (id: string, conversation: string, extra: Partial<RunRow> = {}): RunRow => ({
  id, kind: 'chat', conversation_id: conversation, model_id: 'm', attempts: 1, started_at: 1000, duration_ms: 500, ok: 1, error_kind: null, error_message: null,
  input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: null, flags: [], ...extra,
});
const ids = (board: Board, column: ColumnId): string[] => board.columns.find(c => c.id === column)!.cards.map(card => (card.kind === 'task' ? card.task.id : `s:${card.conversationId}`));
const board = (active: Task[], finished: Task[] = [], extra: Partial<Parameters<typeof buildBoard>[0]> = {}): Board =>
  buildBoard({ active, finished, hasMore: false, finishedTotal: finished.length, sessions: [], ...extra });
const NONE = new Map<string, ChecklistItem[]>();

test('ui/kanban: 列は Proposed・Approved・In progress・Done・Failed の順で、状態ごとに 1 つの列に入る', () => {
  assert.deepEqual([...COLUMNS], ['proposed', 'approved', 'progress', 'done', 'failed']);
  assert.equal(columnOf(task('a', 'inbox')), 'proposed');
  assert.equal(columnOf(task('a', 'ready')), 'approved');
  assert.equal(columnOf(task('a', 'running')), 'progress');
  assert.equal(columnOf(task('a', 'waiting')), 'progress');
  assert.equal(columnOf(task('a', 'done')), 'done');
  assert.equal(columnOf(task('a', 'failed')), 'failed');
  assert.equal(columnOf(task('a', 'cancelled')), 'failed');
});

test('ui/kanban: 繰り返しのひな形はどの列にも出ない（止めたひな形が Failed に入らない）。毎回の実行は列に入り Repeating の印が付く', () => {
  const template = { cron: '0 9 * * *', parent_id: null };
  for (const status of ['scheduled', 'cancelled', 'done', 'failed'] as const) assert.equal(columnOf(task('t', status, template)), null, status);
  const b = board(
    [task('t', 'scheduled', template), task('child-run', 'running', { parent_id: 't' })],
    [task('paused', 'cancelled', template), task('child-done', 'done', { parent_id: 't', completed_at: 5 }), task('child-failed', 'failed', { parent_id: 't', completed_at: 4 })],
  );
  assert.deepEqual(ids(b, 'failed'), ['child-failed']);
  assert.deepEqual(ids(b, 'done'), ['child-done']);
  assert.deepEqual(ids(b, 'progress'), ['child-run']);
  const card = b.columns.find(c => c.id === 'progress')!.cards[0]!;
  assert.equal(card.kind === 'task' && card.repeating, true);
  const plain = board([task('x', 'running')]).columns.find(c => c.id === 'progress')!.cards[0]!;
  assert.equal(plain.kind === 'task' && plain.repeating, false, 'ひな形を消したあとの実行（parent_id が空）には印が付かない');
});

test('ui/kanban: 並び。In progress は待っているカードが先、Approved は優先度と作った順、Done と Failed は終わった時刻の新しい順', () => {
  const b = board([
    task('run-new', 'running', { updated_at: 9 }), task('wait-old', 'waiting', { updated_at: 1 }), task('run-old', 'running', { updated_at: 2 }),
    task('low', 'ready', { priority: 3, created_at: 1 }), task('high-late', 'ready', { priority: 1, created_at: 5 }), task('high-early', 'ready', { priority: 1, created_at: 2 }),
    task('p-old', 'inbox', { updated_at: 1 }), task('p-new', 'inbox', { updated_at: 7 }),
  ], [task('d1', 'done', { completed_at: 10 }), task('d3', 'done', { completed_at: 30 }), task('d2', 'done', { completed_at: null, updated_at: 20 }), task('f1', 'cancelled', { completed_at: 15 })]);
  assert.deepEqual(ids(b, 'progress'), ['wait-old', 'run-new', 'run-old']);
  assert.deepEqual(ids(b, 'approved'), ['high-early', 'high-late', 'low']);
  assert.deepEqual(ids(b, 'proposed'), ['p-new', 'p-old']);
  assert.deepEqual(ids(b, 'done'), ['d3', 'd2', 'd1']);
  assert.deepEqual(ids(b, 'failed'), ['f1']);
  assert.deepEqual(b.columns.map(c => c.accent), [true, false, false, false, false], '光る数は Proposed だけ');
  assert.equal(board([]).columns[0]!.accent, false);
});

test('ui/kanban: 同じタスクが動いている一覧と終わった一覧の両方にあるときは、新しい方の 1 枚だけ', () => {
  const b = board([task('a', 'running', { updated_at: 5 })], [task('a', 'done', { updated_at: 9, completed_at: 9 })]);
  assert.deepEqual(ids(b, 'done'), ['a']);
  assert.deepEqual(ids(b, 'progress'), []);
});

test('ui/kanban: 返事を作っている会話は In progress の Session のカードになり、終わると Done（失敗・止めたものは Failed）に移る', () => {
  const conversations = [{ id: 'c1', title: 'First' }, { id: 'c2', title: 'Second' }, { id: 'c3', title: null }, { id: 'quiet', title: 'Never ran' }];
  const steps: ChecklistItem[] = [{ text: 'a', status: 'done' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }];
  const runs = [
    runRow('r-live', 'c1', { ok: null, duration_ms: null, started_at: 5000 }),
    runRow('r-old', 'c1', { started_at: 100 }),
    runRow('r2-old', 'c2', { started_at: 100, ok: 0, error_kind: 'timeout' }),
    runRow('r2-new', 'c2', { started_at: 2000, duration_ms: 300 }),
    runRow('r3', 'c3', { started_at: 3000, ok: 0, error_kind: 'cancelled' }),
    runRow('task-run', 'c2', { kind: 'task', started_at: 9000 }),
    runRow('other', 'not-listed', { started_at: 9000 }),
  ];
  const running = sessionCards({ conversations, drafts: [{ runId: 'r-live', conversationId: 'c1' }, { runId: 'task-run-live', conversationId: 'task-conversation' }], runs, checklists: new Map([['c1', steps]]) });
  assert.deepEqual(running.map(c => [c.conversationId, c.column, c.outcome]), [['c1', 'progress', 'running'], ['c2', 'done', 'ok'], ['c3', 'failed', 'stopped']]);
  assert.deepEqual(running[0]!.step, { step: 2, total: 3 });
  assert.equal(running[0]!.startedAt, 5000, '始まりの時刻は、下書きに無ければ実行の記録から');
  assert.equal(running[1]!.at, 2300, '終わった時刻 = 始まり + 長さ（その会話の最後のチャットの実行）');
  assert.equal(sessionCards({ conversations, drafts: [{ runId: 'r-live', conversationId: 'c1', startedAt: 7000 }], runs, checklists: NONE })[0]!.startedAt, 7000);

  const ended = sessionCards({ conversations, drafts: [], runs: [...runs.filter(r => r.id !== 'r-live'), runRow('r-live', 'c1', { started_at: 5000, duration_ms: 1000 })], checklists: NONE });
  assert.deepEqual(ended.find(c => c.conversationId === 'c1'), {
    kind: 'session', key: 's:c1:done', column: 'done', conversationId: 'c1', title: 'First', at: 6000, startedAt: 5000, step: null, outcome: 'ok',
  });
  const failed = sessionCards({ conversations: [{ id: 'c2', title: 'x' }], drafts: [], runs: [runRow('r', 'c2', { ok: 0, error_kind: 'timeout' })], checklists: NONE });
  assert.deepEqual(failed.map(c => [c.column, c.outcome]), [['failed', 'failed']]);

  const b = board([task('t', 'running', { updated_at: 1 })], [task('d', 'done', { completed_at: 4000 })], { sessions: running });
  assert.deepEqual(ids(b, 'progress'), ['s:c1', 't']);
  assert.deepEqual(ids(b, 'done'), ['d', 's:c2']);
  assert.deepEqual(ids(b, 'failed'), ['s:c3']);
});

test('ui/kanban: "N more" は、まだ読んでいない終わったタスクの数。読み終えるまで、読んだ範囲より古い Session のカードは出さずに数える', () => {
  const finished = Array.from({ length: KANBAN_PAGE }, (_, i) => task(`d${i}`, i % 4 === 0 ? 'failed' : 'done', { completed_at: 1000 - i }));
  const session = (id: string, at: number, column: SessionCard['column'] = 'done'): SessionCard =>
    ({ kind: 'session', key: `s:${id}:${column}`, column, conversationId: id, title: id, at, startedAt: at, step: null, outcome: column === 'progress' ? 'running' : 'ok' });
  const sessions = [session('new', 995), session('old', 10), session('live', 0, 'progress')];
  const first = buildBoard({ active: [], finished, hasMore: true, finishedTotal: 45, sessions });
  assert.equal(first.more, 26, '45 件のうち 20 件を読んだ残り 25 件 + 隠した古い Session 1 枚');
  assert.equal(ids(first, 'done').includes('s:new'), true);
  assert.equal(ids(first, 'done').includes('s:old'), false);
  assert.deepEqual(ids(first, 'progress'), ['s:live'], '動いている Session は時刻で隠さない');
  assert.equal(ids(first, 'done').length + ids(first, 'failed').length, KANBAN_PAGE + 1);

  const all = buildBoard({ active: [], finished, hasMore: false, finishedTotal: KANBAN_PAGE, sessions });
  assert.equal(all.more, 0);
  assert.equal(ids(all, 'done').at(-1), 's:old');
  assert.equal(buildBoard({ active: [], finished, hasMore: false, finishedTotal: 3, sessions: [] }).more, 0, '件数が古くても負にならない');
});

test('ui/kanban: ページの足し方（同じタスクを 2 枚にしない）と、読み直すときの件数（20 件の倍数に切り上げ）', () => {
  const merged = mergeFinished([task('a', 'done'), task('b', 'done')], [task('b', 'done'), task('c', 'failed')]);
  assert.deepEqual(merged.map(t => t.id), ['a', 'b', 'c']);
  assert.equal(pagesToReload(0), 20);
  assert.equal(pagesToReload(20), 20);
  assert.equal(pagesToReload(21), 40);
  assert.equal(pagesToReload(40), 40);
});

test('ui/kanban: 動いているタスクは、その会話の作業の一覧があれば段の位置を持つ。進みの % は済んだ段の割合', () => {
  const items: ChecklistItem[] = [{ text: 'a', status: 'done' }, { text: 'b', status: 'done' }, { text: 'c', status: 'in_progress' }, { text: 'd', status: 'pending' }];
  const b = board([task('t', 'running', { conversation_id: 'conv', updated_at: 2 }), task('u', 'running', { updated_at: 1 })], [], { checklists: new Map([['conv', items]]) });
  const cards = b.columns.find(c => c.id === 'progress')!.cards;
  assert.deepEqual(cards.map(card => card.step), [{ step: 3, total: 4 }, null]);
  assert.equal(stepPercent({ step: 3, total: 4 }), 50);
  assert.equal(stepPercent({ step: 1, total: 6 }), 0);
  assert.equal(stepPercent(null), 0);
});

test('ui/kanban: 狭い幅の列のタブは矢印キーで移る（端でひと回り）。Home は最初、End は最後', () => {
  assert.equal(tabStep(0, 5, 'ArrowRight'), 1);
  assert.equal(tabStep(4, 5, 'ArrowRight'), 0);
  assert.equal(tabStep(0, 5, 'ArrowLeft'), 4);
  assert.equal(tabStep(2, 5, 'ArrowLeft'), 1);
  assert.equal(tabStep(2, 5, 'Home'), 0);
  assert.equal(tabStep(2, 5, 'End'), 4);
  assert.equal(tabStep(2, 5, 'Enter'), null);
  assert.equal(tabStep(2, 5, 'ArrowDown'), null, '縦の矢印はページの送りに残す');
  assert.equal(tabStep(0, 0, 'ArrowRight'), null);
  assert.equal(matchesCss(COLUMN_TABS_MEDIA), true, 'タブが出る幅は CSS の区切りと同じ');
});

test('ui/kanban: カードの製品は、タスクは行の project_id、Session は会話の project_id（製品なしは null）', () => {
  const conversations = [{ id: 'c1', title: 'A', project_id: 'p1aaaa' }, { id: 'c2', title: 'B', project_id: null }, { id: 'c3', title: 'C' }];
  const runs = [runRow('r1', 'c1'), runRow('r2', 'c2'), runRow('r3', 'c3')];
  const cards = sessionCards({ conversations, drafts: [{ runId: 'live', conversationId: 'c1' }], runs, checklists: NONE });
  assert.deepEqual(cards.map(card => [card.conversationId, cardProject(card)]), [['c1', 'p1aaaa'], ['c2', null], ['c3', null]]);
  const b = board([task('t1', 'inbox', { project_id: 'p2aaaa' }), task('t2', 'inbox')]);
  assert.deepEqual(b.columns[0]!.cards.map(cardProject).sort(), ['p2aaaa', null].sort());
});

test('kanban: 動いている会話のカードも、終わった会話のカードも、会話の製品を持つ（製品の絞り込みに入る）', () => {
  const conversations = [{ id: 'live', title: 'Live', project_id: 'p1aaaa' }, { id: 'done', title: 'Done', project_id: 'p2aaaa' }, { id: 'plain', title: 'Plain', project_id: null }];
  const runs = [runRow('r-live', 'live', { ok: null, duration_ms: null }), runRow('r-done', 'done'), runRow('r-plain', 'plain')];
  const cards = sessionCards({ conversations, drafts: [{ runId: 'r-live', conversationId: 'live' }], runs, checklists: NONE });
  assert.deepEqual(cards.map(c => [c.conversationId, cardProject(c)]), [['live', 'p1aaaa'], ['done', 'p2aaaa'], ['plain', null]]);
});

test('ui/kanban: Pending の承認を待つタスクは「Waiting on Pending #12」の番号と、製品の Pending への行き先を持つ（beat 5-u2）', async () => {
  const { pendingWait } = await import('../web/src/ui/kanban.ts');
  const { routeHash } = await import('../web/src/ui/routes.ts');
  const { t } = await import('../web/src/i18n/index.ts');
  const wait = pendingWait({ status: 'waiting', waiting_kind: 'approval', waiting_text: '#12, #13, #12', project_id: 'prod-abc123' });
  assert.ok(wait);
  assert.equal(t('ui.kanban.waitingPending', wait.refs), 'Waiting on Pending #12, #13');
  assert.equal(routeHash(wait.route), '#/pending/prod-abc123');
  assert.equal(routeHash(pendingWait({ status: 'waiting', waiting_kind: 'approval', waiting_text: null, project_id: null })!.route), '#/pending');
  assert.equal(t('ui.kanban.waitingPending', pendingWait({ status: 'waiting', waiting_kind: 'approval', waiting_text: null })!.refs), 'Waiting on Pending');
  assert.equal(pendingWait({ status: 'waiting', waiting_kind: 'question', waiting_text: '#12' }), null, '質問の返事待ちは Pending 待ちではない');
  assert.equal(pendingWait({ status: 'ready', waiting_kind: null, waiting_text: null }), null);
});
