import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiError, type Acceptance, type AcceptanceChange, type AcceptanceItem, type AcceptanceVersion, type AcceptanceVersionDetail, type Task } from '../web/src/api.ts';
import { t } from '../web/src/i18n/index.ts';
import {
  ASK_TEXT, approveDisabled, askAfterSave, askSend, buildAction, editAccess, editBase, editHint, loadedAcceptance, noticeAfterReload, problemField, versionItems, watchedBuild, decisionFailure, diffLabel, editOp, editRequest, formProblem, itemForm, previousVersion, proposalRows, proposalStale, removeOp,
  revealSection, versionDiff, versionSourceLabel, versionsShown,
} from '../web/src/ui/acceptance.ts';

const item = (id: string, over: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id, result: `Result ${id}`, source: { kind: 'owner_words', quote: 'resume after a restart', messageId: 4, conversationId: 'c1' },
  check: { kind: 'command', command: 'npm test' }, state: 'open', evidence: [], changedIn: null, removedIn: null, ...over,
});
const frozen = { version: 1, hash: 'ah', plan_hash: 'p1', created_at: 5, source: 'build', build_task_id: 'T1' };
const acc = (over: Partial<Acceptance> = {}): Acceptance => ({ version: 1, language: 'en', items: [], not_doing: [], draft: false, hash: 'ah', frozen, ...over });
const draft = (over: Partial<Acceptance> = {}): Acceptance => acc({ version: 0, draft: true, frozen: null, ...over });
const change = (over: Partial<AcceptanceChange> = {}): AcceptanceChange => ({ id: 'ch1', base_version: 1, ops: [], language: 'en', conversation_id: 'c1', tainted: false, status: 'pending', created_at: 9, ...over });
const version = (n: number, source = 'build', at = n): AcceptanceVersion => ({ project_id: 'P1', version: n, hash: `h${n}`, plan_hash: null, source, build_task_id: null, created_at: at });

test('ui/acceptance 3-3: 変更の案の行は Added / Changed / Removed と、その出どころ', () => {
  const a = acc({ items: [item('A-1'), item('A-2', { result: 'Old text' }), item('A-3')] });
  const rows = proposalRows(a, change({
    ops: [
      { op: 'add', item: { result: 'Works offline', check: { kind: 'look' } }, source: { kind: 'ai_added' } },
      { op: 'change', id: 'A-2', item: { result: 'New text', check: { kind: 'command', command: 'npm test' } }, source: { kind: 'owner_words', quote: 'make it new text', messageId: 7, conversationId: 'c1' } },
      { op: 'remove', id: 'A-3', source: { kind: 'owner_choice', question: 'Keep A-3?', answer: 'no' } },
    ],
  }));
  assert.deepEqual(rows.map(r => [r.kind, r.id, r.result, r.before]), [
    ['added', null, 'Works offline', null],
    ['changed', 'A-2', 'New text', 'Old text'],
    ['removed', 'A-3', 'Result A-3', null],
  ]);
  assert.deepEqual(rows.map(r => r.source?.kind), ['ai_added', 'owner_words', 'owner_choice']);
  assert.deepEqual(rows.map(r => t(diffLabel(r.kind))), ['Added', 'Changed', 'Removed']);
});

test('ui/acceptance 3-3: 文を変えない Changed は前の文を出さない。確かめ方だけの変更は新しい確かめ方を持つ', () => {
  const a = acc({ items: [item('A-1')] });
  const [row] = proposalRows(a, change({ ops: [{ op: 'change', id: 'A-1', item: { result: 'Result A-1', check: { kind: 'read' } }, source: { kind: 'ai_added' } }] }));
  assert.equal(row?.before, null);
  assert.equal(row?.result, 'Result A-1');
  assert.deepEqual(row?.check, { kind: 'read' });
});

test('ui/acceptance 3-3: 案が今の版より前の版に向けたものなら古い案（Approve させない）', () => {
  assert.equal(proposalStale(acc({ version: 2 }), change({ base_version: 1 })), true);
  assert.equal(proposalStale(acc({ version: 1 }), change({ base_version: 1 })), false);
});

test('ui/acceptance 3-3: 版どうしの違い。外した項目は Removed、足した項目は Added、固定の部分が違えば Changed。state と evidence の違いは数えない', () => {
  const before = [item('A-1'), item('A-2'), item('A-3'), item('A-4', { removedIn: 1 })];
  const after = [
    item('A-1', { state: 'met', evidence: ['log'] }),
    item('A-2', { result: 'Changed text', changedIn: 2 }),
    item('A-3', { removedIn: 2 }),
    item('A-5'),
    item('A-10', { check: { kind: 'look' } }),
  ];
  const rows = versionDiff(before, after);
  assert.deepEqual(rows.map(r => [r.kind, r.id, r.result, r.before]), [
    ['changed', 'A-2', 'Changed text', 'Result A-2'],
    ['removed', 'A-3', 'Result A-3', null],
    ['added', 'A-5', 'Result A-5', null],
    ['added', 'A-10', 'Result A-10', null],
  ]);
  assert.equal(rows.find(r => r.kind === 'removed')!.source, null, '消した行に、消された項目を足した人の出どころを出さない（版の出どころで示す）');
});

test('ui/acceptance 3-3: 確かめ方だけが違っても Changed（前の文は出さない）', () => {
  const rows = versionDiff([item('A-1')], [item('A-1', { check: { kind: 'command', command: 'npm run e2e' } })]);
  assert.deepEqual(rows.map(r => [r.kind, r.before]), [['changed', null]]);
});

test('ui/acceptance 3-3: 前の版が無い版（v1）は全部 Added', () => {
  assert.deepEqual(versionDiff(null, [item('A-2'), item('A-1')]).map(r => [r.kind, r.id]), [['added', 'A-1'], ['added', 'A-2']]);
});

test('ui/acceptance 3-3: 版の一覧は新しい順。前の版は、その版より小さい中でいちばん大きい版', () => {
  const list = [version(1), version(3, 'change'), version(2, 'question')];
  assert.deepEqual(versionsShown(list).map(v => v.version), [3, 2, 1]);
  assert.equal(previousVersion(list, 3), 2);
  assert.equal(previousVersion(list, 1), null);
  assert.equal(previousVersion([version(1), version(4)], 4), 1);
});

test('ui/acceptance 3-3: 版のどこからの札は Build / Change / Question / Proposal。知らない値は出さない', () => {
  assert.deepEqual(['build', 'change', 'question', 'proposal'].map(s => { const k = versionSourceLabel(s); return k && t(k); }), ['Build', 'Change', 'Question', 'Proposal']);
  assert.equal(versionSourceLabel('other'), null);
});

test('ui/acceptance 3-3: 直す欄の始まりは、その項目の文と確かめ方とコマンド。新しい項目は空で Look', () => {
  assert.deepEqual(itemForm(item('A-1')), { result: 'Result A-1', check: 'command', command: 'npm test' });
  assert.deepEqual(itemForm(item('A-1', { check: { kind: 'read' } })), { result: 'Result A-1', check: 'read', command: '' });
  assert.deepEqual(itemForm(null), { result: '', check: 'look', command: '' });
});

test('ui/acceptance 3-3: 直す欄の誤り。空の文・長すぎる文・Command なのにコマンドが空・長すぎるコマンド', () => {
  assert.equal(formProblem({ result: '  ', check: 'look', command: '' }), 'ui.acc.edit.empty');
  assert.equal(formProblem({ result: 'x'.repeat(301), check: 'look', command: '' }), 'ui.acc.edit.long');
  assert.equal(formProblem({ result: 'x'.repeat(300), check: 'look', command: '' }), null);
  assert.equal(formProblem({ result: 'ok', check: 'command', command: ' ' }), 'ui.acc.edit.noCommand');
  assert.equal(formProblem({ result: 'ok', check: 'command', command: 'x'.repeat(1001) }), 'ui.acc.edit.longCommand');
  assert.equal(formProblem({ result: 'ok', check: 'read', command: '' }), null);
});

test('ui/acceptance 3-3: 直しの op。新しい項目は add、変えた項目は change、何も変えなければ送らない。前後の空白は落とす', () => {
  assert.deepEqual(editOp({ result: ' Works offline ', check: 'look', command: 'ignored' }, null), { op: 'add', item: { result: 'Works offline', check: { kind: 'look' } } });
  const a1 = item('A-1');
  assert.equal(editOp({ result: 'Result A-1 ', check: 'command', command: ' npm test' }, a1), null);
  assert.deepEqual(editOp({ result: 'Result A-1', check: 'command', command: 'npm run e2e' }, a1), { op: 'change', id: 'A-1', item: { result: 'Result A-1', check: { kind: 'command', command: 'npm run e2e' } } });
  assert.deepEqual(editOp({ result: 'Other', check: 'look', command: 'npm test' }, a1), { op: 'change', id: 'A-1', item: { result: 'Other', check: { kind: 'look' } } });
  assert.deepEqual(removeOp(a1), { op: 'remove', id: 'A-1' });
});

test('ui/acceptance 3-3: 直しは、Edit・Remove・Add を開いたときの版とハッシュで送る。開いたあとに一覧が書き直されても、Save のときの一覧を使わない', () => {
  const opened = draft({ hash: 'd1' });
  const base = editBase(opened);
  assert.deepEqual(base, { baseVersion: 0, baseHash: 'd1' });
  const rewritten = draft({ hash: 'd2', items: [item('A-1', { result: 'Rewritten by the AI' })] });
  const op = removeOp(item('A-1'));
  assert.deepEqual(editRequest(base, op), { baseVersion: 0, baseHash: 'd1', ops: [op] }, 'AI が書き直したあとでも、開いたときのハッシュのまま（サーバーが古いと断る）');
  assert.notEqual(editRequest(base, op).baseHash, rewritten.hash);
  assert.deepEqual(editRequest(editBase(acc({ version: 3, hash: 'v3' })), op), { baseVersion: 3, baseHash: 'v3', ops: [op] });
  assert.deepEqual(editBase(draft({ hash: null })), { baseVersion: 0, baseHash: null });
  assert.equal('source' in op, false, '持ち主の直しに source を載せない（サーバーは知らない欄を 400 で断る）');
});

test('ui/acceptance 3-3: 直す欄の添え書き。固定のあとは新しい版になること、案があるときは案を捨てること', () => {
  assert.equal(editHint(acc({ version: 2 }), null), 'Saving makes v3');
  assert.equal(editHint(draft(), null), null);
  assert.equal(editHint(acc({ version: 2 }), change({ base_version: 2 })), 'Saving makes v3 · Saving discards the proposed change');
  assert.equal(editHint(draft(), change({ base_version: 0 })), 'Saving discards the proposed change');
});

test('ui/acceptance 3-3: 項目を直せるのは読むとき。計画書を書いている最中・Build を送っている最中は止める（開いた欄は消さず、押せなくする）', () => {
  assert.equal(editAccess({ acc: acc(), state: 'ready', mode: 'read', pending: false }), 'on');
  assert.equal(editAccess({ acc: draft(), state: 'empty', mode: 'read', pending: false }), 'on');
  assert.equal(editAccess({ acc: null, state: 'ready', mode: 'read', pending: false }), 'off');
  assert.equal(editAccess({ acc: acc(), state: 'ready', mode: 'edit', pending: false }), 'off');
  assert.equal(editAccess({ acc: acc(), state: 'writing', mode: 'read', pending: false }), 'locked');
  assert.equal(editAccess({ acc: acc(), state: 'ready', mode: 'read', pending: true }), 'locked');
});

test('ui/acceptance 3-3: 直す欄の誤りは、その誤りの欄に結びつける（文の誤りは結果の欄、コマンドの誤りはコマンドの欄）', () => {
  assert.equal(problemField('ui.acc.edit.empty'), 'result');
  assert.equal(problemField('ui.acc.edit.long'), 'result');
  assert.equal(problemField('ui.acc.edit.noCommand'), 'command');
  assert.equal(problemField('ui.acc.edit.longCommand'), 'command');
});

test('ui/acceptance 3-3: 古い案は Approve を押せない（Reject は押せる）', () => {
  assert.equal(approveDisabled(acc({ version: 2 }), change({ base_version: 1 }), false), true);
  assert.equal(approveDisabled(acc({ version: 1 }), change({ base_version: 1 }), false), false);
  assert.equal(approveDisabled(acc({ version: 1 }), change({ base_version: 1 }), true), true);
});

test('ui/acceptance 3-3: 一覧を読み直したら、案は acceptance.change から取る', () => {
  const c = change();
  const coverage = { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 };
  const a = acc({ change: c });
  assert.deepEqual(loadedAcceptance({ acceptance: a, coverage }), { acc: a, change: c, coverage });
  assert.deepEqual(loadedAcceptance({ acceptance: acc() }), { acc: acc(), change: null, coverage: null });
});

test('ui/acceptance 3-3: api.send は generated: true を送る本文に載せる', async () => {
  const seen: unknown[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return new Response('{"runId":"r1"}', { status: 200 }); }) as typeof fetch;
  try {
    const out = askSend(null, 'P1', () => 'fresh');
    await api.send(out.id, out.text, [], out.choice, out.options);
    await api.send('c1', 'hello');
  } finally { globalThis.fetch = real; }
  assert.deepEqual(seen[0], { text: ASK_TEXT, permissionMode: 'plan', projectId: 'P1', generated: true });
  assert.deepEqual(seen[1], { text: 'hello' }, 'ふつうの送信には載せない');
});

test('ui/acceptance 3-3: Approve / Reject / 直しの失敗。409 は古い版（読み直す）、ほかはサーバーの理由つき', () => {
  assert.deepEqual(decisionFailure(new ApiError(409, { code: 'acceptance.stale', errorMessage: 'stale' })), { kind: 'stale' });
  assert.deepEqual(decisionFailure(new ApiError(409, { code: 'acceptance.not_pending', errorMessage: 'decided' })), { kind: 'stale' }, 'もう決まった案も読み直す');
  assert.deepEqual(decisionFailure(new ApiError(404, { code: 'acceptance.no_change', errorMessage: 'gone' })), { kind: 'stale' }, '無くなった案も読み直す');
  assert.deepEqual(decisionFailure(new ApiError(404, { code: 'not_found', errorMessage: 'Project missing' })), { kind: 'failed', detail: 'Project missing' });
  assert.deepEqual(decisionFailure(new ApiError(400, { errorMessage: 'Bad command' })), { kind: 'failed', detail: 'Bad command' });
  assert.deepEqual(decisionFailure(new Error('network')), { kind: 'failed', detail: null });
});

test('ui/acceptance 3-3: 「一覧も変えますか」は、固定のあとに計画書を Save したときだけ', () => {
  assert.equal(askAfterSave(acc()), true);
  assert.equal(askAfterSave(draft()), false);
  assert.equal(askAfterSave(null), false);
});

test('ui/acceptance 3-3: Ask beat は決まった文を generated: true で送る。会話が無ければ新しい製品の会話を計画モードで作る', () => {
  const existing = askSend('newest', 'P1', () => 'fresh');
  assert.deepEqual(existing, { id: 'newest', text: ASK_TEXT, choice: {}, options: { generated: true } });
  const fresh = askSend(null, 'P1', () => 'fresh');
  assert.deepEqual(fresh, { id: 'fresh', text: ASK_TEXT, choice: { permissionMode: 'plan' }, options: { projectId: 'P1', generated: true } });
  assert.match(ASK_TEXT, /acceptance_change/);
});

test('ui/acceptance: /build の見せ方は、欄の頭（バー）を上にそろえて対応表へフォーカスする。対応表そのものはスクロールさせない（バーが隠れるため）', () => {
  const calls: string[] = [];
  const top = { scrollIntoView: (o: ScrollIntoViewOptions) => { calls.push(`top:${o.block}`); } };
  const section = { scrollIntoView: () => { calls.push('section'); }, focus: (o: FocusOptions) => { calls.push(`focus:${o.preventScroll}`); } };
  revealSection(top, section);
  assert.deepEqual(calls, ['top:start', 'focus:true']);
});

test('ui/acceptance 3-3: 版の中身は content の items（無い・壊れた中身は空）', () => {
  const detail = (content: unknown): AcceptanceVersionDetail => ({ ...version(2), content } as AcceptanceVersionDetail);
  assert.deepEqual(versionItems(detail({ schema: 1, version: 2, language: 'en', items: [item('A-1')], notDoing: [] })).map(i => i.id), ['A-1']);
  assert.deepEqual(versionItems(detail(null)), []);
  assert.deepEqual(versionItems(detail({ items: 'x' })), []);
});

const run = (status: Task['status'], id = 'T9'): Task => ({
  id, title: 'Build', body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 0, cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null,
  conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 1, updated_at: 1, completed_at: null,
});

test('ui/acceptance 3-3: 固定のあとも、受け持つタスクの無い Open の項目が残っていれば Build をもう一度出す（サーバーの unbuilt に従う）', () => {
  const left = acc({ unbuilt: ['A-4'] });
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: left, task: null, isGit: true }), { kind: 'build', label: 'ui.plan.build', disabled: false });
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: left, task: run('done'), isGit: false }), { kind: 'build', label: 'ui.plan.start', disabled: false });
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: left, task: run('running'), isGit: true }), { kind: 'building' });
  assert.equal(buildAction({ state: 'ready', mode: 'read', acc: acc({ unbuilt: [] }), task: null, isGit: true }), null, '残りが無ければ出さない');
  assert.equal(buildAction({ state: 'ready', mode: 'read', acc: acc(), task: null, isGit: true }), null, 'unbuilt を返さないサーバーでは、今までどおり出さない');
});

test('ui/acceptance 3-3: 固定のあとの Build の知らせは、読み直しても Build を出しているあいだは消さない', () => {
  assert.deepEqual(noticeAfterReload({ kind: 'changed' }, acc({ unbuilt: ['A-4'] })), { kind: 'changed' });
  assert.equal(noticeAfterReload({ kind: 'changed' }, acc({ unbuilt: [] })), null);
  assert.equal(noticeAfterReload({ kind: 'changed' }, acc()), null);
  assert.deepEqual(noticeAfterReload({ kind: 'changed' }, draft()), { kind: 'changed' });
});

test('ui/acceptance 3-3: 見張る Build のタスクは、サーバーの open_build_task_id。読み直しが届くまでは、この欄で今送った Build', () => {
  assert.equal(watchedBuild(null, acc({ open_build_task_id: 'T7' })), 'T7');
  assert.equal(watchedBuild('T9', acc({ open_build_task_id: 'T7' })), 'T7', '読み直したあとはサーバーの値を先にする');
  assert.equal(watchedBuild('T9', acc({ open_build_task_id: null })), 'T9');
  assert.equal(watchedBuild(null, acc({ open_build_task_id: null })), null);
  assert.equal(watchedBuild(null, null), null);
});

test('ui/acceptance 3-3: 版の build_task_id には頼らない（approve・edit で作った版では null、v1 のタスクは古い）', () => {
  assert.equal(watchedBuild(null, acc({ open_build_task_id: null, frozen: { ...frozen, version: 3, build_task_id: null } })), null);
  assert.equal(watchedBuild(null, acc({ open_build_task_id: null })), null, 'v1 の Build のタスク T1 が版に残っていても見張らない');
});

test('ui/acceptance 3-3: 固定のあとの Build は unbuilt だけで決まる。版の build_task_id が null の版でも、残りがあれば出す', () => {
  const v3 = { ...frozen, version: 3, build_task_id: null };
  assert.deepEqual(buildAction({ state: 'ready', mode: 'read', acc: acc({ version: 3, frozen: v3, unbuilt: ['A-5'], open_build_task_id: null }), task: null, isGit: true }), { kind: 'build', label: 'ui.plan.build', disabled: false });
  assert.equal(buildAction({ state: 'ready', mode: 'read', acc: acc({ version: 3, frozen: v3, unbuilt: [], open_build_task_id: null }), task: null, isGit: true }), null);
});
