import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project, Question, QuestionCounts } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { questionsRoute } from '../web/src/ui/kanban.ts';
import { productTiles, tiles } from '../web/src/ui/overview.ts';
import { countTasks, waitingTotal as workspaceTotal } from '../web/src/ui/agent-state.ts';
import { waitingTotal } from '../web/src/ui/products.ts';
import {
  answeredToast, answerOf, assumedText, BUTTON_KEY, buttonOf, choiceOrder, earlierCursor, firstPick, fixPill, headKey, historyOf, isRetry, leaveChoice, mergeAnswered, openedId, openShown, OTHER, questionsFor, resultLine, retryChoice, sendOnce, taskQuestions, withQuestionCounts,
} from '../web/src/ui/questions.ts';
import { routeHash } from '../web/src/ui/routes.ts';

// Questions の欄・画面・数（beat 5-2-u）。画面を持たない決まり: 並び・開く 1 枚・ボタンの文・押す前の結果の 1 行・Fix の印・数（web/src/ui/questions.ts）。

const q = (over: Partial<Question> = {}): Question => ({
  id: 1, project_id: 'prod01', task_id: 't1', kind: 'ai', question: 'How many times should a failed upload retry?', why: 'The plan has no limit.', options: ['Three times', 'Until it works'], chosen: 0,
  blocking: false, acceptance_item: null, status: 'open', answer: null, answer_kind: null, fix_task_id: null, created_at: 1_000, answered_at: null, product: 'Shop site', task: 'Add retry', fix: null, ...over,
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: `name-${id}`, root: `/w/${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

const counts = (over: Partial<QuestionCounts> = {}): QuestionCounts => ({ open: 3, byProject: { prod01: 2 }, byTask: { t1: 2 }, answered: 6, changed: 1, ...over });

test('ui/questions: Open は新しい順で、開くのは先頭の 1 枚だけ。別の 1 枚を開くとそれだけが開き、答えて消えた 1 枚を選んでいたら先頭に戻る', () => {
  const rows = [q({ id: 1, created_at: 100 }), q({ id: 3, created_at: 300 }), q({ id: 2, created_at: 300 })];
  const shown = openShown(rows, new Set());
  assert.deepEqual(shown.map(r => r.id), [3, 2, 1]);
  assert.equal(openedId(shown, null), 3);
  assert.equal(openedId(shown, 1), 1);
  const after = openShown(rows, new Set([1]));
  assert.deepEqual(after.map(r => r.id), [3, 2]);
  assert.equal(openedId(after, 1), 3);
  assert.equal(openedId([], null), null);
});

test('ui/questions: 仮の選択は先頭に出て、はじめから選ばれている。仮の選択の無い急ぎの質問は何も選ばない', () => {
  const card = q({ options: ['A', 'B', 'C'], chosen: 2 });
  assert.deepEqual(choiceOrder(card), [2, 0, 1]);
  assert.equal(firstPick(card), 2);
  assert.equal(assumedText(card), 'C');
  const blocking = q({ blocking: true, chosen: null });
  assert.deepEqual(choiceOrder(blocking), [0, 1]);
  assert.equal(firstPick(blocking), null);
  assert.equal(assumedText(blocking), null);
  assert.equal(answerOf(firstPick(blocking), ''), null, '選ぶまで送れない');
});

test('ui/questions: ボタンの文は選択に合わせる。仮の選択 → Keep assumption、ほか・Something else → Answer and fix。急ぎの質問は Answer', () => {
  const card = q();
  const label = (pick: number | null, row = card) => en[BUTTON_KEY[buttonOf(row, pick)]];
  assert.equal(label(0), 'Keep assumption');
  assert.equal(label(1), 'Answer and fix');
  assert.equal(label(OTHER), 'Answer and fix');
  const blocking = q({ blocking: true });
  assert.equal(label(0, blocking), 'Keep assumption');
  assert.equal(label(1, blocking), 'Answer');
});

test('ui/questions: 押す前の結果の 1 行。違う答えは「直しが始まる」、受け入れの項目に結ばれた質問はその項目が開き直されると言う', () => {
  const text = (line: ReturnType<typeof resultLine>) => (line.key === 'ui.q.result.fixItem' ? en[line.key](line.item) : en[line.key]);
  assert.equal(text(resultLine(q(), 0)), 'Built with this choice. Nothing to redo.');
  assert.equal(text(resultLine(q(), 1)), 'Differs from the assumption. Triggers a fix.');
  assert.equal(text(resultLine(q(), OTHER)), 'Differs from the assumption. Triggers a fix.');
  assert.equal(text(resultLine(q({ acceptance_item: 'A-3' }), 1)), 'Differs from the assumption. Triggers a fix and reopens item A-3.');
  assert.equal(text(resultLine(q({ acceptance_item: 'A-3' }), 0)), 'Built with this choice. Nothing to redo.', '仮の選択のままなら項目は開き直さない');
  assert.equal(text(resultLine(q({ blocking: true }), 1)), 'The task goes on with this answer.');
  assert.equal(text(resultLine(q({ kind: 'stuck' }), 0)), 'Retry reopens the task. Leave it closes this question.');
});

test('ui/questions: 送る答え。選択肢は番号、Something else は書いた文だけ（空なら送れない）', () => {
  assert.deepEqual(answerOf(1, 'ignored'), { choice: 1 });
  assert.deepEqual(answerOf(OTHER, '  Five times  '), { choice: null, text: 'Five times' });
  assert.equal(answerOf(OTHER, '   '), null);
  assert.equal(answerOf(null, 'x'), null);
});

test('ui/questions: stuck・check_failed のカードは Retry / Leave it。Retry は仮の選択でない選択肢、Leave it は仮の選択（仮の選択が無ければ出さない）', () => {
  const stuck = q({ kind: 'stuck', options: ['Retry', 'Leave it'], chosen: 1 });
  assert.equal(isRetry(stuck), true);
  assert.equal(isRetry(q({ kind: 'check_failed' })), true);
  assert.equal(isRetry(q({ kind: 'submit_refused' })), false);
  assert.equal(retryChoice(stuck), 0);
  assert.equal(leaveChoice(stuck), 1);
  assert.equal(leaveChoice(q({ kind: 'stuck', chosen: null })), null);
  assert.equal(en[headKey(stuck)], 'Task stuck');
  assert.equal(en[headKey(q({ kind: 'check_failed' }))], 'Check failed');
  assert.equal(en[headKey(q({ blocking: true }))], 'Blocking · the task is waiting');
  assert.equal(en[headKey(q())], 'Question');
});

test('ui/questions: Answered の Fix の印は違う答えで直しのタスクがあるときだけ。stuck の行は Retry の文', () => {
  const pill = (over: Partial<Question>) => { const p = fixPill(q({ status: 'answered', answer_kind: 'changed', fix_task_id: 'f1', ...over })); return p && [en[p.key], p.tone]; };
  assert.deepEqual(pill({ fix: 'queued' }), ['Fix queued', 'running']);
  assert.deepEqual(pill({ fix: 'running' }), ['Fixing', 'running']);
  assert.deepEqual(pill({ fix: 'done' }), ['Fix done', 'ok']);
  assert.deepEqual(pill({ fix: 'failed' }), ['Fix failed', 'danger']);
  assert.deepEqual(pill({ kind: 'stuck', fix: 'running' }), ['Retrying', 'running']);
  assert.equal(pill({ answer_kind: 'kept', fix: null, fix_task_id: null }), null);
  assert.equal(pill({ fix: null, fix_task_id: null }), null, '急ぎの質問の答え（直しのタスクなし）には印を出さない');
});

test('ui/questions: Answered はめくりで足す（同じ番号は新しい方、答えた時刻の新しい順、同じなら番号の新しい順）。次のめくりの目印はいちばん小さい番号', () => {
  const merged = mergeAnswered([q({ id: 9, fix: 'queued', answered_at: 50 }), q({ id: 7, answered_at: 50 })], [q({ id: 9, fix: 'done', answered_at: 50 }), q({ id: 5, answered_at: 50 }), q({ id: 2, answered_at: 90 })]);
  assert.deepEqual(merged.map(r => [r.id, r.fix]), [[2, null], [9, 'done'], [7, null], [5, null]], 'いま答えた古い質問が一覧の頭に来る');
  assert.equal(earlierCursor(merged), 2);
  assert.equal(earlierCursor([]), null);
});

test('ui/questions: 「6 answered · 1 led to a fix」。読み切った Answered の行から数える。読み切っていなければ全製品は数の口の answered だけ、製品の欄は出さない', () => {
  assert.deepEqual(historyOf(counts(), [], true, false), { answered: 6, changed: 0 }, '読み切る前は数の口の changed（直しを作らない答えも入る）を led to a fix に出さない');
  assert.equal(en['ui.q.history'](6, 0), '6 answered');
  assert.equal(historyOf(counts({ answered: 0, changed: 0 }), [], true, true), null);
  assert.equal(historyOf(null, [], true, true), null);
  const rows = [q({ id: 3, answer_kind: 'changed', fix_task_id: 'f3' }), q({ id: 4, answer_kind: 'changed', blocking: true }), q({ id: 2, answer_kind: 'kept' })];
  assert.deepEqual(historyOf(counts(), rows, false, true), { answered: 3, changed: 1 }, '急ぎの質問の答え（直しのタスクなし）は fix に数えない');
  assert.equal(historyOf(counts(), rows, false, false), null);
  assert.deepEqual(historyOf(counts(), rows, true, true), { answered: 3, changed: 1 }, '全製品でも読み切っていれば行から数える');
  assert.equal(en['ui.q.history'](6, 1), '6 answered · 1 led to a fix');
  assert.equal(en['ui.q.history'](4, 0), '4 answered');
});

test('ui/questions: 同じ数がサイドバー（Workspace の行と製品の行）・欄のタブ・ProductHome / Overview のタイル・Kanban のカードで一致する', () => {
  const c = counts();
  const projects = withQuestionCounts([project('prod01', { waiting: { proposals: 1, questions: 9, pending: 0 } }), project('prod02')], c);
  assert.equal(projects[0]!.waiting.questions, 2, '製品の行の数は数の口で置き換える');
  assert.equal(projects[1]!.waiting.questions, 0);
  assert.equal(waitingTotal(projects[0]!), 3);
  assert.equal(questionsFor(c, 'prod01'), 2);
  assert.equal(productTiles(projects[0]!).find(tile => tile.id === 'questions')!.n, 2);
  assert.equal(tiles({ proposals: 0, questions: c.open }, 0).find(tile => tile.id === 'questions')!.n, 3);
  assert.equal(taskQuestions(c).get('t1'), 2);
  assert.equal(taskQuestions(null).size, 0);
  assert.equal(withQuestionCounts(projects, null), projects);
  assert.equal(en['ui.task.questions'](2), '2 questions recorded');
  assert.equal(en['ui.task.questions'](1), '1 question recorded');
});

test('ui/questions: 行き先。Kanban のカードと ProductHome のタイルはその製品の Questions の欄、製品の無いタスクは全製品の Questions', () => {
  assert.equal(routeHash(questionsRoute({ project_id: 'prod01' })), '#/questions/prod01');
  assert.equal(routeHash(questionsRoute({ project_id: null })), '#/questions');
  assert.equal(productTiles(project('prod01')).find(tile => tile.id === 'questions')!.href, '#/questions/prod01');
});

test('ui/questions: 答えたあとのトーストは起きたことに合わせる', () => {
  const base = { kind: 'changed' as const, fixTaskId: null, reopenedTaskId: null, resumedTaskId: null };
  assert.equal(en[answeredToast({ ...base, kind: 'kept' })], 'Assumption kept');
  assert.equal(en[answeredToast({ ...base, fixTaskId: 'f1' })], 'Fix queued');
  assert.equal(en[answeredToast({ ...base, reopenedTaskId: 't1' })], 'Task reopened');
  assert.equal(en[answeredToast({ ...base, resumedTaskId: 't1' })], 'The task goes on');
  assert.equal(en[answeredToast(base)], 'Answer saved');
});

test('ui/questions: 急ぎの質問で止まったタスク 1 つは、Workspace の待ちの合計でも製品の行の合計でも 1', () => {
  const c = counts({ open: 1, byProject: { prod01: 1 }, byTask: { t1: 1 } });
  const [row] = withQuestionCounts([project('prod01')], c);
  const workspace = workspaceTotal({ drafts: 0, pending: 0, questions: c.open, ...countTasks([['t1', 'waiting']], taskQuestions(c)) });
  assert.equal(workspace, 1);
  assert.equal(waitingTotal(row!), 1);
  assert.equal(workspace, waitingTotal(row!), 'Workspace の合計は製品の行の和と同じ');
});

test('ui/questions: 同じ質問は答えが返るまで 2 度は送らない。失敗して外せばもう一度送れる', () => {
  const sent = new Set<number>();
  assert.equal(sendOnce(sent, 4), true);
  assert.equal(sendOnce(sent, 4), false, '二度押しは送らない');
  assert.equal(sendOnce(sent, 5), true, '別の質問は送れる');
  sent.delete(4);
  assert.equal(sendOnce(sent, 4), true);
});

test('ui/questions の配線: App は数の口の数を製品の行・サイドバー・スマホのタブ・Kanban・欄・待ちの合計へ渡す', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../web/src/ui/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('withQuestionCounts(withPendingCounts(live.projects, live.pendingCounts), live.questionCounts)'), '製品の行の数');
  assert.ok(app.includes('const questionsAll = live.questionCounts?.open ?? 0;'));
  assert.ok(/<Sidebar [^>]*questions=\{questionsAll\}[^>]*projects=\{projects\}/u.test(app), 'サイドバー');
  assert.ok(/<TabBar [^>]*questions=\{questionsAll\}/u.test(app), 'スマホのタブ');
  assert.ok(/<Kanban [^>]*questionsByTask=\{questionsByTask\}/u.test(app), 'Kanban のカード');
  assert.ok(app.includes('count: questionsFor(live.questionCounts, paneProduct)'), '欄のタブ');
  assert.ok(app.includes('questions: questionsAll, ...countTasks([...live.tasks].map(([id, m]) => [id, m.status] as const), questionsByTask)'), '待ちの合計');
  assert.ok(app.includes("if ((waiting.pending || waiting.answers || waiting.questions) && 'Notification' in window"),'急ぎの質問で止まったときもブラウザの知らせの許可を聞く');
  const pane = readFileSync(new URL('../web/src/ui/panes/QuestionsPane.tsx', import.meta.url), 'utf8');
  assert.ok(pane.includes('if (!sendOnce(sent.current, q.id)) return;'), '二度押しの守り');
});
