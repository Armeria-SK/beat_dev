import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PendingAction, PendingCounts, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { holders, productTiles, tiles, unownedWaits } from '../web/src/ui/overview.ts';
import {
  acceptanceRows, actionView, byteSize, decidedMore, decidedShown, decidedText, earlierQuery, effectFiles, extraShown, fileFacts, fromTitle, cleanReason, kindLabel, kindTile, mergeDecided, newestFirst, outcomeOf, paneTarget, pendingFor, pendingRouteReady, pendingTotal, REASON_MAX, reasonLine, sessionCounts, taskCounts, waitingOf, waitingShown, withPendingCounts,
} from '../web/src/ui/pending.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';
import { waitingTotal } from '../web/src/ui/products.ts';
import { productNav } from '../web/src/ui/product-nav.ts';

// Pending の欄・画面・数（beat 4-U1）。画面を持たない決まり: 並べ方・種類のラベルとタイル・数の合わせ方・決めたものの文（web/src/ui/pending.ts）。

const row = (over: Partial<PendingAction> = {}): PendingAction => ({
  id: 1, tool: 'shell_run', shown: 'rm -rf data/cache/', masked: 0, kind: 'delete', reason: 'deletes files that existed before the run',
  cwd: null, preview: [], files: [], conversation_id: 'c1', task_id: null, project_id: 'prod01', task_title: null, project_name: 'Shop site',
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
  assert.equal(pendingTotal(counts(), [project('prod01'), project('prod02')]), 4);
  assert.equal(pendingTotal(counts({ waiting: 0, acceptanceChanges: {} }), []), 0);
  assert.equal(pendingTotal(counts({ acceptanceChanges: { prod02: 1, gone99: 2, prod03: 4 } }), [project('prod02'), project('prod03', { archived_at: 5 })]), 4, 'しまった製品・知らない製品の変更の案は数えない（行に出ないので）');
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
  const home = productTiles(projects[0]!).find(tile => tile.id === 'pending')!.n;
  assert.equal(sidebar, 2 + 1 + tab);
  assert.equal(home, tab);
  assert.equal(waitingTotal(projects[0]!), sidebar);
  const all = tiles({ proposals: 0, questions: 0 }, pendingTotal(counts(), projects)).find(tile => tile.id === 'pending')!;
  assert.equal(all.n, 4);
  assert.deepEqual(holders(projects, 'pending', unownedWaits(null, null, counts()).pending), [{ name: 'name-prod01', n: 2 }, { name: 'name-prod02', n: 1 }, { name: null, n: 1 }]);
});

test('ui/pending: タイルの行き先は Pending（全製品は #/pending、製品はその製品の Pending の欄）。Kanban はそのまま', () => {
  assert.deepEqual(tiles({ proposals: 1, questions: 0 }, 0).map(tile => [tile.id, tile.href]), [['proposals', '#/kanban'], ['questions', '#/questions'], ['pending', '#/pending']]);
  const home = productTiles(project('prod01'));
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

test('ui/pending: #/pending/<製品> は、会話の一覧を読み終える（か、読めないと分かる）まで行き先を決めない（読む前に決めると新しい会話へ行ってしまう）', () => {
  assert.equal(EMPTY.conversationsSettled, false);
  assert.equal(pendingRouteReady(true, EMPTY.conversationsSettled), false, '会話の一覧がまだ無い');
  const loaded = reduce(EMPTY, { type: 'conversations', conversations: [{ id: 'new', title: null, created_at: 0, last_message_at: 20, project_id: 'prod01' }] }).state;
  assert.equal(pendingRouteReady(true, loaded.conversationsSettled), true);
  assert.deepEqual(paneTarget('prod01', loaded.conversations), { view: 'chat', id: 'new' });
  assert.equal(pendingRouteReady(false, loaded.conversationsSettled), false, '製品の一覧も要る');
  const failed = reduce(EMPTY, { type: 'conversationsFailed' }).state;
  assert.equal(pendingRouteReady(true, failed.conversationsSettled), true, '読めなかったときは待ち続けない（前と同じく新しい会話へ）');
  assert.deepEqual(failed.conversations, []);
});

test('ui/pending: 承認して動いている行（running）は Waiting に出さず、Decided の頭に出す（サーバーは待ちの一覧に running を含める）', () => {
  const waiting = [row({ id: 9, status: 'running', decided_at: 900 }), row({ id: 8 }), row({ id: 7, status: 'running', decided_at: 800, project_id: 'prod02' })];
  const decided = [row({ id: 3, status: 'ran', decided_at: 300 })];
  assert.deepEqual(waitingOf(waiting, null).map(r => r.id), [8]);
  assert.deepEqual(decidedShown(decided, waiting, [], null).map(r => [r.id, r.status]), [[9, 'running'], [7, 'running'], [3, 'ran']]);
  assert.deepEqual(decidedShown(decided, waiting, [], 'prod01').map(r => r.id), [9, 3]);
  assert.deepEqual(decidedShown([row({ id: 9, status: 'ran', decided_at: 900 })], waiting, [], 'prod01').map(r => r.status), ['ran'], '待ちの一覧が古くても、終わった行は終わったまま');
});

test('ui/pending: from の題はタスクの題、無ければ会話の題（画面の会話の一覧から）、どちらも無ければ null', () => {
  const titles = new Map([['c1', 'Clean up'], ['c2', null]]);
  assert.equal(fromTitle(row({ task_title: 'Release 0.3' }), titles), 'Release 0.3');
  assert.equal(fromTitle(row({ conversation_id: 'c1' }), titles), 'Clean up');
  assert.equal(fromTitle(row({ conversation_id: 'c2' }), titles), null);
  assert.equal(fromTitle(row({ conversation_id: 'zz' }), titles), null);
});

test('ui/pending: 画面で先に置いた行（承認・却下の直後）は、サーバーに同じ行があれば必ずサーバーの方を出す（早く終わった実行が running のまま残らない）', () => {
  const server = [row({ id: 5, status: 'stale', decided_at: 500 })];
  const local = [row({ id: 5, status: 'running', decided_at: 600 }), row({ id: 6, status: 'rejected', decided_at: 610, reject_reason: 'no' })];
  assert.deepEqual(decidedShown(server, [], local, null).map(r => [r.id, r.status]), [[6, 'rejected'], [5, 'stale']]);
  assert.deepEqual(decidedShown([], [row({ id: 5, status: 'running', decided_at: 590 })], local, null).map(r => [r.id, r.status, r.decided_at]), [[6, 'rejected', 610], [5, 'running', 590]], '待ちの一覧の running もサーバーの行');
  assert.deepEqual(decidedShown([], [row({ id: 5 })], local, null).map(r => [r.id, r.status]), [[6, 'rejected'], [5, 'running']], 'サーバーがまだ待ちと言う行は、画面の行を出す');
  assert.deepEqual(decidedShown([], [], [row({ id: 7, status: 'running', project_id: 'prod02' })], 'prod01'), [], '別の製品の行は出さない');
});

test('ui/pending: 消えていく途中の行は、待ちの一覧が先に読み直されても消え終わるまで残す。消え終わった行は一覧が古くても出さない', () => {
  const held = [row({ id: 4, created_at: 400 })];
  assert.deepEqual(waitingShown([row({ id: 3, created_at: 300 })], held, new Set(), null).map(r => r.id), [4, 3]);
  assert.deepEqual(waitingShown([row({ id: 4, created_at: 400 }), row({ id: 3, created_at: 300 })], held, new Set(), null).map(r => r.id), [4, 3], '同じ行を 2 回出さない');
  assert.deepEqual(waitingShown([row({ id: 4, created_at: 400 }), row({ id: 3, created_at: 300 })], [], new Set([4]), null).map(r => r.id), [3]);
  assert.deepEqual(waitingShown([], [row({ id: 4, project_id: 'prod02' })], new Set(), 'prod01'), []);
});

test('ui/pending: Show earlier は、出している Decided のいちばん下の行（決めた時刻のいちばん古い行）の番号を渡す。今日決めたものが無ければ「今日より前」を頼む', () => {
  const shown = decidedShown([row({ id: 2, status: 'ran', decided_at: 900 }), row({ id: 8, status: 'rejected', decided_at: 100 }), row({ id: 5, status: 'ran', decided_at: 500 })], [], [], null);
  assert.deepEqual(earlierQuery(shown), { before: 8 });
  assert.deepEqual(earlierQuery([]), { earlier: true });
});

test('ui/pending: Show earlier の目印は、決め終わった行（決めた時刻のある行）だけから取る。running や時刻の無い行しか無ければ「今日より前」', () => {
  const rows = [row({ id: 8, status: 'ran', decided_at: 800 }), row({ id: 9, status: 'rejected', decided_at: 700 }), row({ id: 12, status: 'running', decided_at: 600 }), row({ id: 13, status: 'stale', decided_at: null })];
  assert.deepEqual(earlierQuery(rows), { before: 9 });
  assert.deepEqual(earlierQuery([row({ id: 12, status: 'running', decided_at: 600 })]), { earlier: true });
});

test('ui/pending: 消す行の効き目はファイルの数で出す（0 や無いときは出さない）', () => {
  assert.deepEqual(effectFiles(row({ effect: { files: 214, bytes: 3_400_000 } })), { files: 214, more: false });
  assert.deepEqual(effectFiles(row({ effect: { files: 50_000, bytes: 9, more: true } })), { files: 50_000, more: true });
  assert.equal(effectFiles(row({ effect: { files: 0, bytes: 0 } })), null);
  assert.equal(effectFiles(row()), null);
  assert.equal(en['ui.pending.effect'](214), '(214 files)');
  assert.equal(en['ui.pending.effect'](1), '(1 file)');
});

test('ui/pending: 送るファイルは、いまの大きさと変えた時刻（フォルダはファイルの数、無いものは無いと）で出す', () => {
  const facts = fileFacts(row({ files: [
    { path: 'build/a.zip', exists: true, type: 'file', size: 1_536, mtime: 5_000 },
    { path: 'out', exists: true, type: 'dir', files: 12, more: true, newest: 6_000 },
    { path: 'gone.txt', exists: false },
  ] }));
  assert.deepEqual(facts, [
    { path: 'build/a.zip', kind: 'file', bytes: 1_536, at: 5_000 },
    { path: 'out', kind: 'dir', files: 12, more: true, at: 6_000 },
    { path: 'gone.txt', kind: 'missing' },
  ]);
  assert.deepEqual([512, 1_536, 3_400_000, 5 * 1024 ** 4].map(byteSize), [{ value: '512', unit: 'B' }, { value: '1.5', unit: 'KB' }, { value: '3.2', unit: 'MB' }, { value: '5120.0', unit: 'GB' }]);
  assert.equal(en['ui.pending.bytes']('1.5', 'KB'), '1.5 KB');
});
test('ui/pending: 行は parts から組む（4-2b の render() の出力そのまま）。コマンド・中身は body、作業フォルダは別の行、残りの入力はコマンドに混ぜない', () => {
  const nl = String.fromCharCode(10);
  const lines = (...parts: string[]) => parts.join(nl);
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const cwd = row({ tool: 'shell_run', title: 'Run a command', shown: lines('Run a command', 'Working folder: web', 'rm -rf dist'), parts: { body: 'rm -rf dist', cwd: 'web', extra: null } });
  assert.deepEqual(actionView(cwd), { title: null, inline: 'rm -rf dist', block: null, cwd: 'web', extra: null });
  const timeout = row({ tool: 'shell_run', title: 'Run a command', shown: lines('Run a command', 'npm publish', json({ timeoutSec: 120 })), parts: { body: 'npm publish', cwd: null, extra: json({ timeoutSec: 120 }) } });
  assert.deepEqual(actionView(timeout), { title: null, inline: 'npm publish', block: null, cwd: null, extra: json({ timeoutSec: 120 }) });
  const write = row({ tool: 'file_write', title: 'Write to a file: AGENTS.md', shown: lines('Write to a file: AGENTS.md', lines('# Agents', ''), json({ path: 'AGENTS.md' })), parts: { body: lines('# Agents', ''), cwd: null, extra: json({ path: 'AGENTS.md' }) } });
  assert.deepEqual(actionView(write), { title: 'Write to a file: AGENTS.md', inline: null, block: lines('# Agents', ''), cwd: null, extra: json({ path: 'AGENTS.md' }) }, 'ファイルの中身は下の枠、path の残りは別');
  const masked = lines('{', '  "command": "curl -H x-api-key",', '  "api_key": [REDACTED]', '}');
  const hidden = row({ tool: 'shell_run', title: 'Run a command', shown: lines('Run a command', masked), parts: { body: masked, cwd: null, extra: null } });
  assert.deepEqual(actionView(hidden), { title: null, inline: masked, block: null, cwd: null, extra: null }, '伏せた入力全体の JSON（JSON として読めない）は文字のまま本文に出す');
  const write2 = row({ tool: 'file_write', title: 'Write to a file: a.md', shown: lines('Write to a file: a.md', masked), parts: { body: masked, cwd: null, extra: null } });
  assert.equal(actionView(write2).block, masked);
  const click = row({ tool: 'browser_click', title: 'Click in the browser page', shown: lines('Click in the browser page', 'e12'), parts: { body: 'e12', cwd: null, extra: null } });
  assert.deepEqual(actionView(click), { title: 'Click in the browser page', inline: 'e12', block: null, cwd: null, extra: null }, 'ブラウザは何をするかの題を出す');
});

test('ui/pending: parts の無い古い行は shown をそのまま出す（題の行も含めて、手を加えない）', () => {
  const nl = String.fromCharCode(10);
  const shown = ['Run a command', 'Working folder: web', 'rm -rf dist'].join(nl);
  assert.deepEqual(actionView(row({ tool: 'shell_run', title: 'Run a command', shown })), { title: null, inline: shown, block: null, cwd: null, extra: null });
  assert.deepEqual(actionView(row({ tool: 'file_write', title: 'Write to a file: a.md', shown: 'x' })), { title: 'Write to a file: a.md', inline: null, block: 'x', cwd: null, extra: null }, 'ファイルの行は題を残す');
  assert.deepEqual(actionView(row({ tool: 'shell_run', title: 'Run a command', shown, status: 'ran', parts: { body: null, cwd: null, extra: null } })), { title: null, inline: shown, block: null, cwd: null, extra: null }, '中身を消した行は parts が全部 null なので、shown で出す');
});

test('ui/pending: Decided の行も Waiting と同じ actionView から組む（シェルはコマンドだけ、ファイルは題、作業フォルダは小さな行）。消した行でも何もない行にしない', () => {
  const nl = String.fromCharCode(10);
  const lines = (...parts: string[]) => parts.join(nl);
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  const write = row({ tool: 'file_write', status: 'rejected', decided_at: 900, title: 'Write to a file: AGENTS.md', shown: lines('Write to a file: AGENTS.md', '# Agents', json({ path: 'AGENTS.md' })), parts: { body: '# Agents', cwd: null, extra: json({ path: 'AGENTS.md' }) } });
  assert.deepEqual(decidedText(actionView(write)), { title: 'Write to a file: AGENTS.md', code: null, cwd: null });
  const shell = row({ tool: 'shell_run', status: 'ran', decided_at: 900, title: 'Run a command', shown: lines('Run a command', 'Working folder: web', 'rm -rf dist'), parts: { body: 'rm -rf dist', cwd: 'web', extra: null } });
  assert.deepEqual(decidedText(actionView(shell)), { title: null, code: 'rm -rf dist', cwd: 'web' });
  const erased = { body: null, cwd: null, extra: null };
  assert.deepEqual(decidedText(actionView(row({ tool: 'shell_run', status: 'ran', title: 'Run a command', shown: 'Run a command', parts: erased }))), { title: null, code: 'Run a command', cwd: null });
  assert.deepEqual(decidedText(actionView(row({ tool: 'file_edit', status: 'ran', title: 'Edit a file: a.ts', shown: 'Edit a file: a.ts', parts: erased }))), { title: 'Edit a file: a.ts', code: null, cwd: null });
  assert.deepEqual(decidedText(actionView(row({ tool: 'file_edit', status: 'ran', title: null, shown: 'file_edit', parts: erased }))), { title: null, code: 'file_edit', cwd: null }, '題も無ければ shown を出す');
  const gone = row({ tool: 'shell_run', status: 'rejected', decided_at: 900, title: null, shown: '', parts: erased });
  assert.deepEqual(decidedText(actionView(gone)), { title: null, code: null, cwd: null, erased: true }, '会話を消した行（shown も題も空）は、中身を消したと分かる印を返す');
  assert.ok(en['ui.pending.erased']);
});

test('ui/pending: Decided の行は decidedText の erased のときに "Details removed with the session" を出す（PendingPane の配線）', () => {
  const pane = readFileSync(new URL('../web/src/ui/panes/PendingPane.tsx', import.meta.url), 'utf8');
  assert.ok(pane.includes('const line = decidedText(actionView(row));'), 'Decided の行は decidedText から組む');
  assert.ok(pane.includes(`{line.erased && <span className="ui-pending__title bt-meta">{t('ui.pending.erased')}</span>}`), '中身を消した行に erased の文を出す');
});

test('4-4 タスクごとの Pending の数: 待っている行だけを task_id ごとに数え、タスクの無い行と決めた行は数えない', () => {
  const counts = taskCounts([
    row({ id: 1, task_id: 't1' }),
    row({ id: 2, task_id: 't1' }),
    row({ id: 3, task_id: 't2' }),
    row({ id: 4, task_id: null }),
    row({ id: 5, task_id: 't1', status: 'running' }),
    row({ id: 6, task_id: 't2', status: 'ran', decided_at: 2_000 }),
    row({ id: 7, task_id: 't3', status: 'rejected', decided_at: 2_000 }),
  ]);
  assert.deepEqual([...counts.entries()].sort(), [['t1', 2], ['t2', 1]]);
  assert.equal(counts.has('t3'), false);
  assert.equal(taskCounts([]).size, 0);
});

test('ui/pending: Other input は、題の終わりにもう出ている path を繰り返さない。残りの入力はそのまま出し、JSON として読めないもの（伏せた入力）には手を加えない', () => {
  const json = (value: unknown) => JSON.stringify(value, null, 2);
  assert.equal(extraShown('Write to a file: .github/workflows/ci.yml', json({ path: '.github/workflows/ci.yml' })), null, 'path だけなら欄ごと出さない');
  assert.equal(extraShown('Write to a file: a.md', json({ path: 'a.md', mode: 'append' })), json({ mode: 'append' }), 'path 以外は残す');
  assert.equal(extraShown('Run a command', json({ timeoutSec: 120 })), json({ timeoutSec: 120 }));
  assert.equal(extraShown('Write to a file: a.md', json({ path: 'b.md' })), json({ path: 'b.md' }), '題に出ていない path は消さない');
  assert.equal(extraShown('Write to a file: xa.md', json({ path: 'a.md' })), json({ path: 'a.md' }), '題の終わりの語とちょうど同じときだけ');
  assert.equal(extraShown(null, json({ path: 'a.md' })), json({ path: 'a.md' }), '題が無ければ消さない');
  assert.equal(extraShown('Write to a file: a.md', json({ path: '' })), json({ path: '' }));
  assert.equal(extraShown('Write to a file: a.md', json({ target: 'a.md' })), json({ target: 'a.md' }), 'path の鍵だけ');
  const masked = ['{', '  "path": "a.md",', '  "token": [REDACTED]', '}'].join(String.fromCharCode(10));
  assert.equal(extraShown('Write to a file: a.md', masked), masked);
  assert.equal(extraShown('Write to a file: a.md', '["a.md"]'), '["a.md"]');
  assert.equal(extraShown('Write to a file: a.md', null), null);
});

test('ui/pending: 行の Approve / Reject は見出しの横（1 段目）、中身（コマンド・書く中身・理由・パス・出どころ）は下の段で欄の幅いっぱい（持ち主 2026-11-14。PendingPane と pending.css の配線）', () => {
  const pane = readFileSync(new URL('../web/src/ui/panes/PendingPane.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/src/ui/styles/pending.css', import.meta.url), 'utf8');
  const item = pane.slice(pane.indexOf('function PendingItem('), pane.indexOf('function AcceptanceItem('));
  const at = (text: string) => { const i = item.indexOf(text); assert.ok(i >= 0, `${text} が PendingItem にある`); return i; };
  assert.ok(at('className="bt-pending__what"') < at('className="bt-pending__actions"'), 'ボタンは見出しのすぐあと');
  assert.ok(at('className="bt-pending__actions"') < at('className="ui-pending__detail"'), '中身はボタンのあとの段');
  const detail = item.slice(at('className="ui-pending__detail"'));
  for (const part of ['ui-pending__code', '<ActionBody', 'ui-pending__why', 'bt-pending__from']) assert.ok(detail.includes(part), `${part} は下の段の中`);
  assert.ok(!item.slice(at('className="bt-pending__what"'), at('className="bt-pending__actions"')).includes('view.inline'), 'コマンドは見出しの行に入れない');
  assert.match(css, /\.ui-pending__detail \{[^}]*grid-column: 1 \/ -1;/u, '下の段は列を全部使う');
  assert.match(css, /\.ui-pending__reject \{[^}]*grid-column: 1 \/ -1;/u, 'Reject の理由の欄も幅いっぱい');
  assert.ok(pane.includes('extraShown(row.title, view.extra)'), 'Other input は extraShown を通す');
});

test('ui/pending: Decided の行を開くと、却下の理由の全文と、実行の出力の頭が出る。出すものが無い行は開けない（backlog 489）', () => {
  const nl = String.fromCharCode(10);
  const out = ['line 1', 'not allowed now', ''].join(nl);
  assert.deepEqual(decidedMore(row({ status: 'ran', exit_code: 0, output_preview: out })), { reason: null, output: ['line 1', 'not allowed now'].join(nl) });
  assert.deepEqual(decidedMore(row({ status: 'failed', output_preview: out })), { reason: null, output: ['line 1', 'not allowed now'].join(nl) });
  assert.equal(decidedMore(row({ status: 'failed', output_preview: 'not allowed now' })), null, '1 行だけの失敗は、行の文にもう出ている');
  assert.deepEqual(decidedMore(row({ status: 'ran', output_preview: 'ok' })), { reason: null, output: 'ok' }, '実行した行の文には出力が無いので、1 行でも出す');
  assert.deepEqual(decidedMore(row({ status: 'rejected', reject_reason: '  wrong host  ' })), { reason: 'wrong host', output: null });
  assert.equal(decidedMore(row({ status: 'rejected', reject_reason: null })), null);
  assert.equal(decidedMore(row({ status: 'ran', exit_code: 0, output_preview: null })), null);
  assert.equal(decidedMore(row({ status: 'ran', output_preview: nl })), null);
  assert.equal(decidedMore(row({ status: 'stale', output_preview: null })), null);
  assert.equal(decidedMore(row({ status: 'running', output_preview: 'x' })), null, '動いている最中は出さない');
  assert.equal(decidedMore(row({ status: 'waiting', output_preview: 'x' })), null);
  assert.equal(en['ui.pending.more'], 'Details');
  assert.equal(en['ui.pending.output'], 'Output');
  assert.equal(en['ui.pending.reasonGiven'], 'Reason');
  const pane = readFileSync(new URL('../web/src/ui/panes/PendingPane.tsx', import.meta.url), 'utf8');
  assert.ok(pane.includes('const more = decidedMore(row);'), 'Decided の行は decidedMore から開く中身を組む');
  assert.ok(pane.includes(`<summary className="bt-meta">{t('ui.pending.more')}</summary>`), 'details で開く');
  assert.ok(pane.includes('<pre className="ui-pending__body"><code>{more.output}</code></pre>'), '出力は Waiting の中身と同じ枠');
});
