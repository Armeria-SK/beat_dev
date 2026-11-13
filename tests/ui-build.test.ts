import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Acceptance, type AcceptanceItem, type Coverage, type PlanDoc, type Task } from '../web/src/api.ts';
import { BuildError } from '../src/projects/build.ts';
import { buildText } from '../src/shared/messages/build.ts';
import { domainProblem } from '../src/web/http.ts';
import { en } from '../web/src/i18n/en.ts';
import { t } from '../web/src/i18n/index.ts';
import {
  addPage, beforeBuildShown, buildAction, buildFailure, buildRequest, changedAfterBuild, coverageCounts, coverageGroups, mergeUnreferenced, noticeAfterReload, pagingCursor, revealStep, startPaging, unreferencedCursor,
} from '../web/src/ui/acceptance.ts';

const item = (id: string, over: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id, result: `Result ${id}`, source: { kind: 'owner_words', quote: 'resume after a restart', messageId: 4, conversationId: 'c1' },
  check: { kind: 'command', command: 'npm test' }, state: 'open', evidence: [], changedIn: null, removedIn: null, ...over,
});
const acc = (over: Partial<Acceptance> = {}): Acceptance => ({ version: 0, language: 'en', items: [], not_doing: [], draft: true, hash: 'ah', frozen: null, ...over });
const doc = (over: Partial<PlanDoc> = {}): PlanDoc => ({ content: '# Plan', hash: 'p1', updated_at: 1, updated_by: 'ai', tainted: false, writing: false, reviewLocked: false, ...over });
const frozen = (over: Partial<NonNullable<Acceptance['frozen']>> = {}): NonNullable<Acceptance['frozen']> =>
  ({ version: 1, hash: 'ah', plan_hash: 'p1', created_at: 5, source: 'build', build_task_id: 'T1', ...over });
const task = (status: Task['status']): Task => ({
  id: 'T1', title: 'Build: Demo', body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 0, cron: null, cron_text: null, run_at: null, parent_id: null,
  waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 1, updated_at: 1, completed_at: null,
});
const unref = (id: number, at: number) => ({ message_id: id, conversation_id: 'c1', text: `message ${id}`, created_at: at });
const cov = (over: Partial<Coverage> = {}): Coverage => ({ owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0, ...over });

test('ui/build: 主ボタンは計画書があり何も固定していないときだけ Build。git でない製品は Start。書いている最中は押せない', () => {
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: null, isGit: true }), { kind: 'build', label: 'ui.plan.build', disabled: false });
  assert.equal(t('ui.plan.build'), 'Build with this plan');
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: null, isGit: false }), { kind: 'build', label: 'ui.plan.start', disabled: false });
  assert.equal(t('ui.plan.start'), 'Start with this plan');
  assert.deepEqual(buildAction({ state: 'writing', mode: 'read', acc: acc(), task: null, isGit: true }), { kind: 'build', label: 'ui.plan.build', disabled: true });
  assert.equal(buildAction({ state: 'empty', mode: 'read', acc: acc(), task: null, isGit: true }), null, '計画書が無ければ出さない');
  assert.equal(buildAction({ state: 'ready', mode: 'edit', acc: acc(), task: null, isGit: true }), null, 'Edit のあいだは Save が主ボタン');
  assert.equal(buildAction({ state: 'ready', mode: 'read', acc: null, task: null, isGit: true }), null, '一覧を読めていなければ、送るハッシュが無いので出さない');
});

test('ui/build: 固定したあと、Build のタスクが ready / running / waiting のあいだは Running の札。終わったら主ボタンは出さない', () => {
  const built = acc({ draft: false, version: 1, frozen: frozen() });
  for (const status of ['ready', 'running', 'waiting'] as const) assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: built, task: task(status), isGit: true }), { kind: 'building' }, status);
  assert.deepEqual(buildAction({ state: 'ready', mode: 'edit', acc: built, task: task('running'), isGit: true }), { kind: 'building' }, '作っている最中は Edit でも札');
  for (const status of ['done', 'failed', 'cancelled'] as const) assert.equal(buildAction({ state: 'ready', mode: 'read', acc: built, task: task(status), isGit: true }), null, status);
  assert.equal(buildAction({ state: 'ready', mode: 'read', acc: built, task: null, isGit: true }), null, 'タスクをまだ読めていない・消えたときは押させない');
  assert.equal(t('ui.plan.building'), 'Running');
});

test('ui/build: Build に送るのは、表に出している計画書と一覧のハッシュ。一覧が無ければ null', () => {
  assert.deepEqual(buildRequest(doc(), acc()), { planHash: 'p1', acceptanceHash: 'ah' });
  assert.deepEqual(buildRequest(doc(), acc({ hash: null })), { planHash: 'p1', acceptanceHash: null });
  assert.equal(buildRequest(doc({ hash: null, content: null }), acc()), null);
  assert.equal(buildRequest(null, acc()), null);
});

test('ui/build: Build のあとで計画書を直すと "changed after the build started"', () => {
  const built = acc({ draft: false, version: 1, frozen: frozen({ plan_hash: 'p1' }) });
  assert.equal(changedAfterBuild(doc(), built), false);
  assert.equal(changedAfterBuild(doc({ hash: 'p2' }), built), true);
  assert.equal(changedAfterBuild(doc({ hash: 'p2' }), acc()), false, '固定の前は出さない');
  assert.equal(changedAfterBuild(null, built), false);
  assert.equal(t('ui.plan.changedAfterBuild'), 'changed after the build started');
});

test('ui/build: Build の失敗の見分け: 409 build.changed は読み直し、409 build.running は作っている最中、ほかはサーバーの文', () => {
  assert.deepEqual(buildFailure(new ApiError(409, { code: 'build.changed', message: 'x' })), { kind: 'changed' });
  assert.deepEqual(buildFailure(new ApiError(409, { code: 'build.running', message: 'x' })), { kind: 'running' });
  const missing = new ApiError(409, { code: 'project.folder_missing', message: 'The folder is missing' });
  assert.deepEqual(buildFailure(missing), { kind: 'failed', detail: missing.message });
  assert.ok(missing.message.length > 0);
  assert.deepEqual(buildFailure(new ApiError(400, { code: 'build.no_plan', message: 'No plan' })), { kind: 'failed', detail: buildText('en', 'no_plan') }, 'build のコードは画面の文の表で訳す');
  assert.deepEqual(buildFailure(new ApiError(400, { code: 'build.mystery', message: 'From the server' })), { kind: 'failed', detail: 'From the server' }, '表に無いコードはサーバーの文');
  assert.deepEqual(buildFailure(new Error('network')), { kind: 'failed', detail: null });
});

test('ui/build: 対応表の数は 4 つ（Your words / Your answers / AI added / by hand）。You edited は 1 つ以上のときだけ', () => {
  const lines = coverageCounts(cov({ owner_words: 3, owner_choice: 0, ai_added: 2, by_hand: 1 })).map(([key, n]) => t(key, n));
  assert.deepEqual(lines, ['Your words → 3 items', 'Your answers → 0 items', 'AI added 2', 'You will check 1 by hand']);
  assert.deepEqual(coverageCounts(cov({ owner_words: 1, owner_edit: 2 })).map(([key, n]) => t(key, n)).slice(0, 1), ['Your words → 1 item']);
  assert.equal(coverageCounts(cov({ owner_edit: 2 })).map(([key, n]) => t(key, n)).at(-1), 'You edited 2');
  assert.equal(t('ui.cov.empty'), "No acceptance items. The build will be checked only by the product's check command.");
});

test('ui/build: 対応表の塊: あなたの言葉 ↔ 項目、選んだ答え ↔ 項目、AI が足した項目、あなたが直した項目。外した項目は入れない', () => {
  const a = acc({
    items: [
      item('A-2', { source: { kind: 'owner_words', quote: 'keep it small', messageId: 7, conversationId: 'c1' } }),
      item('A-1'),
      item('A-3', { source: { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: 'Which?', answer: 'A' } }),
      item('A-4', { source: { kind: 'owner_choice', question: 'Where do files go?', answer: 'B' } }),
      item('A-5', { source: { kind: 'owner_edit' } }),
      item('A-6', { removedIn: 2 }),
    ],
  });
  const g = coverageGroups(a);
  assert.deepEqual(g.words.map(w => [w.quote, w.item.id]), [['resume after a restart', 'A-1'], ['keep it small', 'A-2']]);
  assert.deepEqual(g.answers.map(w => [w.question, w.answer, w.item.id]), [['Where do files go?', 'B', 'A-4']]);
  assert.deepEqual(g.ai.map(i => i.id), ['A-3'], '選択肢の答えは確かめられないので AI added に出る（サーバーが付け替えたまま）');
  assert.deepEqual(g.edited.map(i => i.id), ['A-5']);
});

test('ui/build: 引かれていない発言は 50 件ずつ。続きのカーソルは読んだ中でいちばん古い時刻。全部読んだら null。重なりは 1 つに', () => {
  const first = cov({ unreferenced: [unref(9, 900), unref(8, 800)], unreferenced_total: 3 });
  assert.equal(unreferencedCursor(first.unreferenced, first.unreferenced_total), 800);
  const merged = mergeUnreferenced(first.unreferenced, [unref(8, 800), unref(7, 700)]);
  assert.deepEqual(merged.map(m => m.message_id), [9, 8, 7]);
  assert.equal(unreferencedCursor(merged, 3), null);
  assert.equal(unreferencedCursor([], 0), null);
  assert.equal(t('ui.cov.unreferenced', 120), '120 of your messages are not quoted by any item');
  assert.equal(t('ui.cov.unreferenced', 1), '1 of your messages is not quoted by any item');
});

test('ui/build: 仮の "Proceed with this plan" は表から消えている', () => {
  const table = en as Record<string, unknown>;
  for (const key of ['ui.plan.proceed', 'ui.plan.proceedHint', 'ui.plan.proceedRequest']) assert.equal(key in table, false, key);
  assert.equal(Object.values(table).some(v => typeof v === 'string' && /Proceed with this plan|go ahead with this plan/u.test(v)), false);
});

test('ui/build: /build で欄を開いたとき、計画書を読み込んでいるあいだは送り先の節を待つ。節が出たらそこへ送り、出ないと決まってから捨てる', () => {
  const base = { reveal: true, accLoaded: true, accFailed: false, state: 'loading' as const, shown: false };
  assert.equal(revealStep(base), 'wait', '一覧が先に届いても、計画書がまだなら捨てない');
  assert.equal(revealStep({ ...base, accLoaded: false, state: 'ready' }), 'wait');
  assert.equal(revealStep({ ...base, state: 'ready', shown: true }), 'scroll');
  assert.equal(revealStep({ ...base, state: 'ready', shown: false }), 'drop', '固定済み・Edit などで節が出ないと決まった');
  assert.equal(revealStep({ ...base, state: 'empty' }), 'drop');
  assert.equal(revealStep({ ...base, accLoaded: false, accFailed: true, state: 'ready' }), 'drop');
  assert.equal(revealStep({ ...base, reveal: false, state: 'ready', shown: true }), 'none');
});

test('ui/build: "Before you build" は読むとき・Build を出しているとき・coverage があるときだけ', () => {
  const action = { kind: 'build', label: 'ui.plan.build', disabled: false } as const;
  assert.equal(beforeBuildShown({ mode: 'read', acc: acc(), coverage: cov(), action }), true);
  assert.equal(beforeBuildShown({ mode: 'edit', acc: acc(), coverage: cov(), action }), false);
  assert.equal(beforeBuildShown({ mode: 'read', acc: acc(), coverage: null, action }), false);
  assert.equal(beforeBuildShown({ mode: 'read', acc: acc(), coverage: cov(), action: { kind: 'building' } }), false);
  assert.equal(beforeBuildShown({ mode: 'read', acc: null, coverage: cov(), action }), false);
});

test('ui/build: 押している最中は押せない。Build が通った直後（一覧の読み直しの前）も、返ってきたタスクで Running を出し、押せるボタンに戻らない', () => {
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: null, isGit: true, pending: true }), { kind: 'build', label: 'ui.plan.build', disabled: true });
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: task('ready'), isGit: true }), { kind: 'building' }, '一覧はまだ下書きでも、動いている Build のタスクがあれば Running');
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: task('done'), isGit: true }), { kind: 'build', label: 'ui.plan.build', disabled: false });
});

test('ui/build: 409 build.frozen（もう固定済み）はサーバーの文で知らせる。changed・failed・frozen の知らせは、読み直して固定が見えたら消す', () => {
  const frozenErr = new ApiError(409, { code: 'build.frozen', message: 'The acceptance list is already fixed (version 1). Change it before building again' });
  assert.deepEqual(buildFailure(frozenErr), { kind: 'frozen', detail: frozenErr.message });
  const built = acc({ draft: false, version: 1, frozen: frozen() });
  assert.equal(noticeAfterReload({ kind: 'changed' }, built), null);
  assert.equal(noticeAfterReload({ kind: 'failed', detail: 'x' }, built), null);
  assert.equal(noticeAfterReload({ kind: 'frozen', detail: 'y' }, built), null, '固定が見えたら frozen の知らせも消す');
  assert.deepEqual(noticeAfterReload({ kind: 'changed' }, acc()), { kind: 'changed' }, '固定の前は残す');
  assert.equal(noticeAfterReload(null, built), null);
});

test('ui/build: 引かれていない発言の続き: 読み直しのあとに届いた古い続きは捨てる。空のページが返ったら Show more を出さない。50 件を超えるページ（同じ時刻をまとめる）も受ける', () => {
  const first = startPaging([unref(9, 900), unref(8, 800)], 1);
  assert.equal(pagingCursor(first, 200), 800);
  const big = Array.from({ length: 53 }, (_, i) => unref(700 - i, 700));
  const next = addPage(first, 1, big);
  assert.equal(next.list.length, 55);
  assert.equal(pagingCursor(next, 200), 700);
  const reloaded = startPaging([unref(9, 900)], 2);
  assert.equal(addPage(reloaded, 1, big), reloaded, '前の世代の続きは無視');
  const empty = addPage(first, 1, []);
  assert.equal(empty.exhausted, true);
  assert.equal(pagingCursor(empty, 200), null, '空が返ったらもう続きは無い');
});

test('ui/build: サーバーの BuildError の本文（domainProblem）をそのまま受けて、知らせの種類と文を決める', () => {
  const wire = (status: number, error: BuildError) => new ApiError(status, domainProblem(status, 'build', error).body);
  assert.deepEqual(buildFailure(wire(409, new BuildError('changed'))), { kind: 'changed' });
  assert.deepEqual(buildFailure(wire(409, new BuildError('running'))), { kind: 'running' });
  const frozenOut = buildFailure(wire(409, new BuildError('frozen', { version: 3 })));
  assert.equal(frozenOut.kind, 'frozen');
  assert.match(frozenOut.kind === 'frozen' ? frozenOut.detail ?? '' : '', /already locked \(version 3\)/u);
  const noPlan = buildFailure(wire(400, new BuildError('no_plan')));
  assert.equal(noPlan.kind, 'failed');
  assert.match(noPlan.kind === 'failed' ? noPlan.detail ?? '' : '', /no plan yet/u);
});
