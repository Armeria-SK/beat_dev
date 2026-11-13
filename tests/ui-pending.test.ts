import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PendingAction, PendingCounts, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { holders, productTiles, tiles } from '../web/src/ui/overview.ts';
import {
  acceptanceRows, decidedShown, fromTitle, cleanReason, kindLabel, kindTile, mergeDecided, newestFirst, outcomeOf, paneTarget, pendingFor, pendingTotal, REASON_MAX, reasonLine, sessionCounts, waitingOf, withPendingCounts,
} from '../web/src/ui/pending.ts';
import { waitingTotal } from '../web/src/ui/products.ts';
import { productNav } from '../web/src/ui/product-nav.ts';

// Pending の欄・画面・数（beat 4-U1）。画面を持たない決まり: 並べ方・種類のラベルとタイル・数の合わせ方・決めたものの文（web/src/ui/pending.ts）。

const row = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 1, tool: 'shell_run', shown: 'rm -rf data/cache/', masked: 0, kind: 'delete', reason: 'deletes files that existed before the run',
  conversation_id: 'c1', task_id: null, project_id: 'prod01', task_title: null, project_name: 'Shop site',
  status: 'waiting', reject_reason: null, exit_code: null, output_preview: null, created_at: 1_000, decided_at: null, ran_at: null, ...over,
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: `name-${id}`, root: `/w/${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

const counts = (over: Partial<PendingCounts> = {}): PendingCounts => ({ waiting: 3, byProject: { prod01: 2 }, acceptanceChanges: { prod02: 1 }, judgedToday: { allowed: 41, parked: 3 }, ...over });

test('ui/pending: 種類のラベルは Design のとおり。Design に無い hook / policy は Your rule、owner は Protected、judge と judge_failed は Judge unsure', () => {
  const label = (kind: PendingAction['kind']) => en[kindLabel(kind)];
  assert.equal(label('send'), 'Send · outside');
  assert.equal(label('delete'), 'Delete · cannot be undone');
  assert.equal(label('judge'), 'Judge unsure');
  assert.equal(label('judge_failed'), 'Judge unsure');
  assert.equal(label('hook'), 'Your rule');
  assert.equal(label('policy'), 'Your rule');
  assert.equal(label('owner'), 'Protected');
});

test('ui/pending: タイルは Send が外向きの矢印、Delete だけが danger（bt-pending--delete）、ほかは Judge unsure と同じ形', () => {
  assert.equal(kindTile('send'), 'send');
  assert.equal(kindTile('delete'), 'delete');
  for (const kind of ['judge', 'judge_failed', 'hook', 'policy', 'owner'] as const) assert.equal(kindTile(kind), 'unsure', kind);
});

test('ui/pending: 理由の行は、Settings の Ask で積んだもの（policy）は決まった文、ほかはサーバーの理由。空なら出さない', () => {
  assert.deepEqual(reasonLine(row({ kind: 'policy', reason: 'tool policy ask' })), { key: 'ui.pending.reason.policy' });
  assert.equal(en['ui.pending.reason.policy'], 'Set to Ask in Settings');
  assert.deepEqual(reasonLine(row({ kind: 'judge', reason: '  fetches a script from the web  ' })), { text: 'fetches a script from the web' });
  assert.equal(reasonLine(row({ kind: 'judge', reason: '   ' })), null);
});

test('ui/pending: Waiting は新しい順（時刻が同じなら番号の大きい方が先）。製品を渡せばその製品の待ちだけ', () => {
  const rows = [row({ id: 1, created_at: 100 }), row({ id: 3, created_at: 300, project_id: 'prod02' }), row({ id: 2, created_at: 300 }), row({ id: 4, created_at: 400, status: 'ran' })];
  assert.deepEqual(newestFirst(rows).map(r => r.id), [4, 3, 2, 1]);
  assert.deepEqual(waitingOf(rows, null).map(r => r.id), [3, 2, 1], '決めたものは Waiting に入らない');
  assert.deepEqual(waitingOf(rows, 'prod01').map(r => r.id), [2, 1]);
});

test('ui/pending: Decided を前の日の分と合わせるとき、同じ行は新しい方で 1 つにし、決めた時刻の新しい順に並べる', () => {
  const today = [row({ id: 5, status: 'running', decided_at: 500 }), row({ id: 4, status: 'rejected', decided_at: 400 })];
  const fresh = [row({ id: 5, status: 'ran', exit_code: 0, decided_at: 500, ran_at: 520 })];
  const earlier = [row({ id: 2, status: 'ran', decided_at: 50 })];
  assert.deepEqual(mergeDecided(today, fresh).map(r => [r.id, r.status]), [[5, 'ran'], [4, 'rejected']]);
  assert.deepEqual(mergeDecided(today, earlier).map(r => r.id), [5, 4, 2]);
  assert.deepEqual(mergeDecided(today, [row({ id: 4, status: 'waiting' })]).map(r => r.id), [5], '待ちに戻った行は Decided から外す');
});

test('ui/pending: 決めたものの文は「実行した」を実行のあとにだけ言う（running は ran と言わない）', () => {
  assert.deepEqual(outcomeOf(row({ status: 'running', decided_at: 10 })), { kind: 'running', at: 10 });
  assert.deepEqual(outcomeOf(row({ status: 'ran', exit_code: 0, decided_at: 10, ran_at: 20 })), { kind: 'ran', at: 20, exit: 0 });
  assert.deepEqual(outcomeOf(row({ status: 'ran', exit_code: null, decided_at: 10, ran_at: null })), { kind: 'ran', at: 10, exit: null });
  assert.deepEqual(outcomeOf(row({ status: 'failed', decided_at: 10, output_preview: 'line 1\nnot allowed now\n' })), { kind: 'failed', at: 10, detail: 'not allowed now' });
  assert.deepEqual(outcomeOf(row({ status: 'stale', decided_at: 10 })), { kind: 'stale', at: 10 });
  assert.deepEqual(outcomeOf(row({ status: 'rejected', decided_at: 10, reject_reason: 'leave the cache' })), { kind: 'rejected', at: 10, reason: 'leave the cache' });
  assert.deepEqual(outcomeOf(row({ status: 'rejected', decided_at: 10, reject_reason: null })), { kind: 'rejected', at: 10, reason: null });
  assert.deepEqual(outcomeOf(row({ status: 'cancelled', decided_at: null, created_at: 7 })), { kind: 'cancelled', at: 7 });
  assert.equal(outcomeOf(row({ status: 'waiting' })), null);
});

test('ui/pending: Reject の理由は制御文字を除いて前後の空白を取り、500 文字まで', () => {
  assert.equal(REASON_MAX, 500);
  assert.equal(cleanReason('  leave\u0000 the\u0007 cache\n '), 'leave the cache');
  assert.equal(cleanReason('a\tb\r\nc'), 'a b c');
  assert.equal(cleanReason('x'.repeat(600)).length, 500);
  assert.equal(cleanReason('   '), '');
});

test('ui/pending: 製品ごとの数は、待ちの行の数と受け入れの一覧の変更の案の数の合計。全体の数も同じ足し方', () => {
  assert.equal(pendingFor(counts(), 'prod01'), 2);
  assert.equal(pendingFor(counts(), 'prod02'), 1, '変更の案だけの製品も数える');
  assert.equal(pendingFor(counts({ acceptanceChanges: { prod01: 2 } }), 'prod01'), 4);
  assert.equal(pendingFor(counts(), 'other1'), 0);
  assert.equal(pendingTotal(counts()), 4);
  assert.equal(pendingTotal(counts({ waiting: 0, acceptanceChanges: {} })), 0);
});

test('ui/pending: 数が読めたら、製品の pending を counts の数に置き換える（読めないあいだはサーバーの数のまま）', () => {
  const projects = [project('prod01', { waiting: { proposals: 1, questions: 0, pending: 9 } }), project('prod02')];
  assert.equal(withPendingCounts(projects, null), projects);
  const merged = withPendingCounts(projects, counts());
  assert.deepEqual(merged.map(p => p.waiting.pending), [2, 1]);
  assert.equal(merged[0]!.waiting.proposals, 1, 'ほかの数は変えない');
  assert.equal(projects[0]!.waiting.pending, 9, '元の行は書き換えない');
});

test('ui/pending: 同じ数がサイドバーの製品の行（合計）・欄のタブ・ProductHome のタイル・Overview のタイルで一致する（CountBadge の決まり）', () => {
  const projects = withPendingCounts([project('prod01', { waiting: { proposals: 2, questions: 1, pending: 0 } }), project('prod02')], counts());
  const nav = productNav(projects, [], {}, new Map());
  const sidebar = nav.rows.find(r => r.project.id === 'prod01')!.waiting;
  const tab = pendingFor(counts(), 'prod01');
  const home = productTiles(projects[0]!, []).find(tile => tile.id === 'pending')!.n;
  assert.equal(sidebar, 2 + 1 + tab);
  assert.equal(home, tab);
  assert.equal(waitingTotal(projects[0]!), sidebar);
  const all = tiles({ proposals: 0, answers: 0 }, pendingTotal(counts())).find(tile => tile.id === 'pending')!;
  assert.equal(all.n, 4);
  assert.deepEqual(holders(projects, 'pending', all.n), [{ name: 'name-prod01', n: 2 }, { name: 'name-prod02', n: 1 }, { name: null, n: 1 }]);
});

test('ui/pending: タイルの行き先は Pending（全製品は #/pending、製品はその製品の Pending の欄）。Kanban・Questions はそのまま', () => {
  assert.deepEqual(tiles({ proposals: 1, answers: 0 }, 0).map(tile => [tile.id, tile.href]), [['proposals', '#/kanban'], ['questions', '#/kanban'], ['pending', '#/pending']]);
  const home = productTiles(project('prod01'), []);
  assert.equal(home.find(tile => tile.id === 'pending')!.href, '#/pending/prod01');
});

test('ui/pending: 会話ごとの数は待ちの行だけを数える（サイドバーの会話の行の bt-count）', () => {
  const map = sessionCounts([row({ id: 1, conversation_id: 'a' }), row({ id: 2, conversation_id: 'a' }), row({ id: 3, conversation_id: 'b', status: 'ran' }), row({ id: 4, conversation_id: 'c' })]);
  assert.deepEqual([...map.entries()].sort(), [['a', 2], ['c', 1]]);
});

test('ui/pending: 受け入れの一覧の変更の案の行は、製品ごとに 1 行（サイドバーの順）。数が 0 の製品・知らない製品・しまった製品は出さない', () => {
  const projects = [project('prod02', { created_at: 2 }), project('prod01', { created_at: 1 }), project('prod03', { archived_at: 5 })];
  const c = counts({ acceptanceChanges: { prod02: 2, prod01: 1, prod03: 1, gone99: 1, prod04: 0 } });
  assert.deepEqual(acceptanceRows(c, projects, null), [{ projectId: 'prod01', name: 'name-prod01', n: 1 }, { projectId: 'prod02', name: 'name-prod02', n: 2 }]);
  assert.deepEqual(acceptanceRows(c, projects, 'prod02'), [{ projectId: 'prod02', name: 'name-prod02', n: 2 }]);
  assert.deepEqual(acceptanceRows(null, projects, null), []);
});

test('ui/pending: 製品の Pending の欄を開く先は、その製品のいちばん新しい会話。会話が無ければ新しい会話', () => {
  const conversations = [
    { id: 'old', title: null, created_at: 0, last_message_at: 10, project_id: 'prod01' },
    { id: 'new', title: null, created_at: 0, last_message_at: 20, project_id: 'prod01' },
    { id: 'other', title: null, created_at: 0, last_message_at: 30, project_id: 'prod02' },
  ];
  assert.deepEqual(paneTarget('prod01', conversations), { view: 'chat', id: 'new' });
  assert.deepEqual(paneTarget('prod03', conversations), { view: 'productNew', id: 'prod03' });
});

test('ui/pending: 承認して動いている行（running）は Waiting に出さず、Decided の頭に出す（サーバーは待ちの一覧に running を含める）', () => {
  const waiting = [row({ id: 9, status: 'running', decided_at: 900 }), row({ id: 8 }), row({ id: 7, status: 'running', decided_at: 800, project_id: 'prod02' })];
  const decided = [row({ id: 3, status: 'ran', decided_at: 300 })];
  assert.deepEqual(waitingOf(waiting, null).map(r => r.id), [8]);
  assert.deepEqual(decidedShown(decided, waiting, null).map(r => [r.id, r.status]), [[9, 'running'], [7, 'running'], [3, 'ran']]);
  assert.deepEqual(decidedShown(decided, waiting, 'prod01').map(r => r.id), [9, 3]);
  assert.deepEqual(decidedShown([row({ id: 9, status: 'ran', decided_at: 900 })], waiting, 'prod01').map(r => r.status), ['ran'], '待ちの一覧が古くても、終わった行は終わったまま');
});

test('ui/pending: from の題はタスクの題、無ければ会話の題（画面の会話の一覧から）、どちらも無ければ null', () => {
  const titles = new Map([['c1', 'Clean up'], ['c2', null]]);
  assert.equal(fromTitle(row({ task_title: 'Release 0.3' }), titles), 'Release 0.3');
  assert.equal(fromTitle(row({ conversation_id: 'c1' }), titles), 'Clean up');
  assert.equal(fromTitle(row({ conversation_id: 'c2' }), titles), null);
  assert.equal(fromTitle(row({ conversation_id: 'zz' }), titles), null);
});
