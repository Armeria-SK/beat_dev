import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, NotificationItem, Project, Task } from '../web/src/api.ts';
import type { RunEvent } from '../web/src/events.ts';
import { EMPTY, reduce, type Action, type Effect, type LiveState } from '../web/src/ui/live-state.ts';

// 新しい画面の SSE と API の読み込みを、画面の状態と「読み直す・知らせる」の手続きに変える純粋な関数（web/src/ui/live-state.ts）。

const ev = (event: RunEvent, hidden = false): Action => ({ type: 'event', event, hidden });
const refreshes = (effects: Effect[]) => effects.filter(e => e.kind === 'refresh').map(e => (e as { what: string }).what).sort();
const conv = (id: string): Conversation => ({ id, title: id, created_at: 0, last_message_at: 0 });
const task = (id: string, status: Task['status'], updated: number): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 0, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: updated, completed_at: null,
});
const note = (kind: string): NotificationItem => ({ id: 1, kind, title: 'T', body: 'B', link: null, read_at: null, created_at: 0 });
const run = (s: LiveState, ...actions: Action[]) => actions.reduce((acc, a) => reduce(acc, a).state, s);

test('ui/live-state: 会話を消したら未読の数も読み直す（消した会話の通知はサーバーで消え、notification.read は来ない）', () => {
  assert.deepEqual(refreshes(reduce(EMPTY, ev({ type: 'conversation.changed', conversationId: 'c', change: 'deleted' })).effects), ['conversations', 'unread']);
  for (const change of ['renamed', 'archived', 'unarchived'] as const) {
    assert.deepEqual(refreshes(reduce(EMPTY, ev({ type: 'conversation.changed', conversationId: 'c', change })).effects), ['conversations'], change);
  }
});

test('ui/live-state: ブラウザの通知は返事待ち（task_waiting）だけで、画面が隠れているときだけ。Pending の行（pendingAction.changed・approval_needed の通知）では出さない', () => {
  const parked: RunEvent = { type: 'pendingAction.changed', id: 1, status: 'waiting', projectId: null, conversationId: 'c', taskId: null };
  assert.deepEqual(reduce(EMPTY, ev(parked, true)).effects.filter(e => e.kind !== 'refresh'), []);
  const notified = (kind: string, hidden: boolean) => reduce(EMPTY, ev({ type: 'notification', notification: note(kind) }, hidden)).effects.filter(e => e.kind === 'notify');
  assert.deepEqual(notified('approval_needed', true), []);
  assert.deepEqual(notified('task_waiting', true), [{ kind: 'notify', title: 'T', body: 'B' }]);
  assert.deepEqual(notified('task_waiting', false), []);
  assert.deepEqual(notified('task_done', true), []);
});

test('ui/live-state: タスクの読み込みは、新しい task.changed を古い一覧で上書きしない（updated_at の新しい方を残す）', () => {
  const s = run(EMPTY, ev({ type: 'task.changed', task: task('t1', 'waiting', 200) }), { type: 'tasks', tasks: [task('t1', 'ready', 100), task('t2', 'inbox', 100)] });
  assert.equal(s.tasks.get('t1')?.status, 'waiting');
  assert.equal(s.tasks.get('t2')?.status, 'inbox');
  const newer = run(s, { type: 'tasks', tasks: [task('t1', 'done', 300)] });
  assert.equal(newer.tasks.get('t1')?.status, 'done');
  assert.equal(newer.tasks.has('t2'), false, '読み込みに無く、出来事から来たのでもないものは消える');
  const fromEvent = run(EMPTY, ev({ type: 'task.changed', task: task('t3', 'inbox', 50) }), { type: 'tasks', tasks: [] });
  assert.equal(fromEvent.tasks.get('t3')?.status, 'inbox', '出来事で知ったばかりで、読み込みにまだ無いものは残す');
  const stale = run(fromEvent, ev({ type: 'task.changed', task: task('t3', 'ready', 10) }));
  assert.equal(stale.tasks.get('t3')?.status, 'inbox', '古い task.changed は無視する');
});

test('ui/live-state: 実行の始まりと終わり（下書き・流れている会話・知らない会話の読み直し・作業の一覧）', () => {
  const known = run(EMPTY, { type: 'conversations', conversations: [conv('c1')] });
  const startKnown = reduce(known, ev({ type: 'run.start', runId: 'r1', conversationId: 'c1', modelId: 'm' }));
  assert.deepEqual(refreshes(startKnown.effects), ['worker']);
  assert.ok(startKnown.effects.some(e => e.kind === 'checklist' && e.conversationId === 'c1'));
  assert.deepEqual(refreshes(reduce(known, ev({ type: 'run.start', runId: 'r2', conversationId: 'c9', modelId: 'm' })).effects), ['conversations', 'worker']);
  const streaming = run(startKnown.state, ev({ type: 'text.delta', runId: 'r1', conversationId: 'c1', text: 'hi' }));
  assert.equal(streaming.drafts.length, 1);
  assert.ok(streaming.streaming.has('c1'));
  const ended = reduce(streaming, ev({ type: 'run.end', runId: 'r1', conversationId: 'c1', ok: true }));
  assert.equal(ended.state.drafts.length, 0);
  assert.equal(ended.state.streaming.has('c1'), false);
  assert.deepEqual(refreshes(ended.effects), ['conversations', 'drafts', 'worker']);
});

test('ui/live-state: 未読の数は notification で 1 増え、notification.read と読み込みで置き換わる', () => {
  const s = run(EMPTY, { type: 'unread', count: 2 }, ev({ type: 'notification', notification: note('info') }));
  assert.equal(s.unread, 3);
  assert.equal(run(s, ev({ type: 'notification.read', ids: [1], unread: 0 })).unread, 0);
});

test('ui/live-state: つなぎ直し（resync）は、サーバーの下書きを入れ、全部を読み直す', () => {
  const r = reduce(EMPTY, { type: 'resync', drafts: [{ runId: 'r', conversationId: 'c', modelId: 'm', text: 'x' }, { runId: 'q', conversationId: 'd', modelId: 'm', text: '' }] });
  assert.deepEqual([...r.state.streaming], ['c']);
  assert.deepEqual(refreshes(r.effects), ['conversations', 'drafts', 'pending', 'projects', 'questions', 'tasks', 'unread', 'worker']);
  assert.equal(r.effects.filter(e => e.kind === 'checklist').length, 2);
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});


test('ui/live-state: project.changed は製品の一覧を読み直す（しまう・戻すは会話の一覧と、Pending の待ちの一覧も。walk-1118 D7: 待ちの行の「しまった」の印を読み直さずに出す）', () => {
  for (const change of ['created', 'updated'] as const) {
    const r = reduce(EMPTY, ev({ type: 'project.changed', projectId: 'p1aaaa', change }));
    assert.deepEqual(refreshes(r.effects), ['projects'], change);
    assert.equal(r.state, EMPTY);
  }
  for (const change of ['archived', 'restored'] as const) {
    assert.deepEqual(refreshes(reduce(EMPTY, ev({ type: 'project.changed', projectId: 'p1aaaa', change })).effects), ['conversations', 'pending', 'projects'], change);
  }
});

test('ui/live-state: plan.changed はその製品の計画書の読み直しの数を進め、製品の一覧（has_plan）を読み直す（beat 3-1a-u）', () => {
  const r = reduce(EMPTY, ev({ type: 'plan.changed', projectId: 'p1aaaa', conversationId: 'c1', hash: 'h2', by: 'ai' }));
  assert.equal(r.state.planRevisions.get('p1aaaa'), 1);
  assert.equal(r.state.planRevisions.get('p2bbbb'), undefined);
  assert.deepEqual(refreshes(r.effects), ['projects']);
  const again = reduce(r.state, ev({ type: 'plan.changed', projectId: 'p1aaaa', conversationId: 'c2', hash: 'h3', by: 'owner' }));
  assert.equal(again.state.planRevisions.get('p1aaaa'), 2);
});

test('ui/live-state: acceptance.changed はその製品の Plan の欄を読み直させ、Pending の数（変更の案）と、確かめ待ちのカードのためにタスクを読み直す。ほかは読み直さない（beat 3-1b-u・4-U1・R13）', () => {
  const r = reduce(EMPTY, ev({ type: 'acceptance.changed', projectId: 'p1aaaa', version: 0, draft: true }));
  assert.equal(r.state.planRevisions.get('p1aaaa'), 1);
  assert.equal(r.state.planRevisions.get('p2bbbb'), undefined);
  assert.equal(r.state.taskRevision, EMPTY.taskRevision + 1, 'R13: the awaiting cards read their items again');
  assert.deepEqual(refreshes(r.effects), ['pending', 'tasks']);
});

test('ui/live-state: Pending の行の pendingAction.changed は Pending の数と一覧を読み直し、製品の数も読み直す。送る前の発言の pending.changed は今までどおり会話だけ（4-U1）', () => {
  const withProject = run(EMPTY, { type: 'projects', projects: [project('p1aaaa')] });
  const r = reduce(withProject, ev({ type: 'pendingAction.changed', id: 12, status: 'ran', projectId: 'p1aaaa', conversationId: 'c1', taskId: null }));
  assert.equal(r.state.pendingRevision, 1);
  assert.deepEqual(refreshes(r.effects), ['pending', 'projectCounts']);
  assert.equal(r.state.revisions.get('c1'), undefined, '会話の読み直しはしない');
  const queued = reduce(withProject, ev({ type: 'pending.changed', conversationId: 'c1' }));
  assert.equal(queued.state.pendingRevision, 0);
  assert.equal(queued.state.revisions.get('c1'), 1);
  assert.deepEqual(refreshes(queued.effects), []);
});

test('ui/live-state: question.changed は質問の数を読み直し、製品の数も読み直す。欄の一覧は questionRevision で読み直す（5-2-u）', () => {
  const before = reduce(EMPTY, ev({ type: 'question.changed', id: 3, projectId: null, status: 'open' }));
  assert.equal(before.state.questionRevision, 1);
  assert.deepEqual(refreshes(before.effects), ['questions'], '製品がまだ無ければ製品の数は読まない');
  const withProject = run(EMPTY, { type: 'projects', projects: [project('p1aaaa')] });
  const r = reduce(withProject, ev({ type: 'question.changed', id: 3, projectId: 'p1aaaa', status: 'answered' }));
  assert.equal(r.state.questionRevision, 1);
  assert.deepEqual(refreshes(r.effects), ['projectCounts', 'questions']);
  const counts = { open: 2, byProject: { p1aaaa: 2 }, byTask: { t1: 1 }, answered: 6, changed: 1 };
  assert.deepEqual(reduce(r.state, { type: 'questions', counts }).state.questionCounts, counts);
});

test('ui/live-state: Pending の数と待ちの一覧は読み込みで入れ替わる（4-U1）', () => {
  const counts = { waiting: 1, byProject: { p1aaaa: 1 }, acceptanceChanges: {}, judgedToday: { allowed: 3, parked: 1 } };
  const s = run(EMPTY, { type: 'pending', counts, waiting: [] });
  assert.deepEqual(s.pendingCounts, counts);
  assert.deepEqual(s.pendingWaiting, []);
  assert.equal(EMPTY.pendingCounts, null, '読めるまでは null（製品の数はサーバーのまま）');
});

test('ui/live-state: 製品があるときだけ、タスクと Pending の出来事で製品の数を読み直す（製品が無ければ今までと同じ）', () => {
  const events: RunEvent[] = [
    { type: 'task.changed', task: task('t1', 'inbox', 5) },
    { type: 'task.deleted', id: 't1' },
    { type: 'pendingAction.changed', id: 1, status: 'waiting', projectId: 'p1aaaa', conversationId: 'c', taskId: null },
  ];
  const withProducts = run(EMPTY, { type: 'projects', projects: [project('p1aaaa')] });
  for (const event of events) {
    assert.equal(refreshes(reduce(EMPTY, ev(event)).effects).includes('projectCounts'), false, event.type);
    assert.equal(refreshes(reduce(withProducts, ev(event)).effects).filter(w => w === 'projectCounts').length, 1, event.type);
    assert.equal(refreshes(reduce(withProducts, ev(event)).effects).includes('projects'), false, event.type);
  }
});

test('ui/live-state: 製品の一覧と、会話の一覧の more を入れる（more の無い応答は空）', () => {
  assert.equal(EMPTY.projectsLoaded, false);
  const s = run(EMPTY, { type: 'projects', projects: [project('p1aaaa'), project('p2aaaa')] }, { type: 'conversations', conversations: [conv('c1')], more: { p1aaaa: 4, none: 2 } });
  assert.equal(s.projectsLoaded, true);
  assert.deepEqual(s.projects.map(p => p.id), ['p1aaaa', 'p2aaaa']);
  assert.deepEqual(s.conversationsMore, { p1aaaa: 4, none: 2 });
  assert.deepEqual(run(s, { type: 'conversations', conversations: [conv('c1')] }).conversationsMore, {});
  assert.equal(run(EMPTY, { type: 'projects', projects: [] }).projectsLoaded, true, '製品の口が無いサーバー（空の一覧）でも読み終えた扱い');

  const renamed = run(s, { type: 'project', project: project('p1aaaa', { name: 'Renamed' }) });
  assert.deepEqual(renamed.projects.map(p => p.name), ['Renamed', 'p2aaaa'], '同じ ID は場所を変えずに置き換える');
  assert.deepEqual(run(s, { type: 'project', project: project('p3aaaa') }).projects.map(p => p.id), ['p1aaaa', 'p2aaaa', 'p3aaaa']);
  assert.deepEqual(run(s, { type: 'project', project: project('p1aaaa', { archived_at: 9 }) }).projects.map(p => p.id), ['p2aaaa'], 'しまった製品は一覧から外す');
});

test('ui/live-state: 会話の中の動き（返事の文・道具の呼び出し・お知らせ・会話ごとの読み直しの数）', () => {
  const s0 = run(EMPTY, { type: 'conversations', conversations: [conv('c')] }, { type: 'event', event: { type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' }, hidden: false, now: 100 });
  const s1 = run(s0, ev({ type: 'text.delta', runId: 'r', conversationId: 'c', text: 'He' }), ev({ type: 'text.delta', runId: 'r', conversationId: 'c', text: 'llo' }));
  assert.equal(s1.drafts[0]!.text, 'Hello');
  const s2 = run(s1, ev({ type: 'message.saved', runId: 'r', conversationId: 'c', messageId: 1, role: 'assistant' }));
  assert.equal(s2.drafts[0]!.text, '', '保存された文は下書きから外す');
  assert.equal(s2.revisions.get('c'), 1);
  const s3 = run(s2, { type: 'event', event: { type: 'tool.call', runId: 'r', conversationId: 'c', callId: 'x', name: 'shell_run', input: '{}' }, hidden: false, now: 200 });
  assert.deepEqual([s3.drafts[0]!.activeTool, s3.drafts[0]!.toolStartedAt, s3.drafts[0]!.toolCallId], ['shell_run', 200, 'x']);
  const s4 = run(s3, ev({ type: 'tool.result', runId: 'r', conversationId: 'c', callId: 'x', name: 'shell_run', ok: false, decision: 'deny', preview: 'head\nno way\nmore' }));
  assert.equal(s4.drafts[0]!.activeTool, undefined);
  assert.deepEqual(s4.drafts[0]!.settled, [{ callId: 'x', name: 'shell_run', input: '{}' }], '結果が届いた呼び出しは、保存された発言を読むまで行を残すために覚える');
  assert.equal(s4.notices.has('c'), false, '断られた道具は理由を道具の行の中だけに出し、会話に別の警告の行を足さない');
  const failed = reduce(s4, ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: false, errorKind: 'timeout', errorMessage: 'slow' }));
  assert.deepEqual(failed.state.notices.get('c')!.at(-1), { runId: 'r', after: 1, kind: 'error', errorKind: 'timeout', errorCode: undefined, errorParams: undefined, errorMessage: 'slow', hint: undefined, measured: undefined, required: undefined });
  const stopped = run(s4, ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
  assert.equal(stopped.notices.get('c')!.at(-1)!.kind, 'stopped');
  assert.equal(run(stopped, { type: 'clearNotices', conversationId: 'c' }).notices.has('c'), false);
});

test('ui/live-state: 要約の件数のお知らせは同じ実行の中で置き換え、会話を消したら開いている画面を閉じる手続きを出す', () => {
  const s = run(EMPTY, ev({ type: 'compaction', runId: 'r', conversationId: 'c', summarized: 3 }), ev({ type: 'compaction', runId: 'r', conversationId: 'c', summarized: 7 }));
  assert.deepEqual(s.notices.get('c'), [{ runId: 'r', kind: 'compaction', key: 'compaction', summarized: 7 }]);
  const gone = reduce(EMPTY, ev({ type: 'conversation.changed', conversationId: 'c', change: 'deleted' }));
  assert.ok(gone.effects.some(e => e.kind === 'gone' && e.conversationId === 'c'));
  assert.equal(reduce(EMPTY, { type: 'resync', drafts: [] }).state.epoch, 1, 'つなぎ直しで、開いている会話を読み直す');
});

test('ui/live-state: お知らせは起きた位置（その会話で最後に保存された発言の番号）を持ち、新しい実行が始まっても消さない（会話の流れに残り、話が進めば上へ流れる）', () => {
  const saved = (id: number, role = 'user'): Action => ev({ type: 'message.saved', runId: 'r1', conversationId: 'c', messageId: id, role });
  const s = run(EMPTY, saved(4), ev({ type: 'compaction', runId: 'r1', conversationId: 'c', summarized: 2 }), saved(5, 'assistant'), ev({ type: 'warning', runId: 'r1', conversationId: 'c', code: 'context_trimmed', message: 'x', params: { count: 3 } }));
  assert.deepEqual(s.notices.get('c')!.map(n => [n.kind, n.after]), [['compaction', 4], ['warning', 5]]);
  const ended = run(s, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'timeout' }), ev({ type: 'compaction', runId: 'r1', conversationId: 'd', summarized: 2 }));
  const next = run(ended, saved(9), ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.deepEqual(next.notices.get('c')!.map(n => [n.kind, n.after]), [['compaction', 4], ['warning', 5], ['error', 5]], '前の実行のお知らせも、起きた位置に残す');
  assert.equal(next.notices.get('d')?.length, 1, 'ほかの会話のお知らせは残す');
  assert.deepEqual(next.notices.get('d')![0]!.after, undefined, '発言の番号を知らない会話では位置を持たない（会話の最後に出す）');
  assert.equal(run(next, saved(3)).lastMessage.get('c'), 9, '古い番号で位置を戻さない');
});

test('ui/live-state: 出力の上限で続きを頼んだ知らせ（output_continued）は画面に出さない。続けても切れた知らせ（output_continue_limit）などは出す', () => {
  const warn = (code: string): Action => ev({ type: 'warning', runId: 'r', conversationId: 'c', code, message: code });
  assert.equal(run(EMPTY, warn('output_continued')).notices.has('c'), false);
  assert.equal(run(EMPTY, warn('compacted')).notices.has('c'), false);
  assert.deepEqual(run(EMPTY, warn('output_continued'), warn('output_continue_limit'), warn('context_trimmed')).notices.get('c')!.map(n => n.kind === 'warning' && n.code), ['output_continue_limit', 'context_trimmed']);
});

test('ui/live-state: 割り込み（Interrupted）の知らせは、止まった実行の最後の発言のすぐ後に位置を持つ（待っていた発言が 2 つ流れ込んでも、その間に入らない）', () => {
  const saved = (id: number, role: string, runId: string): Action => ev({ type: 'message.saved', runId, conversationId: 'c', messageId: id, role });
  const s = run(EMPTY, saved(7, 'assistant', 'r1'), { type: 'interrupt', conversationId: 'c', on: true }, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'cancelled' }),
    saved(8, 'user', 'r2'), saved(9, 'user', 'r2'), ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.deepEqual(s.notices.get('c'), [{ runId: 'r2', kind: 'interrupted', after: 7 }]);
  assert.equal(s.cutAt.has('c'), false, '使った止まった位置は片づける');
});

test('ui/live-state: 位置の分からないうちに出たお知らせ（読み込み直後・Changes の Undo）は、次に保存された発言の直前に位置を持つ', () => {
  const s = run(EMPTY, { type: 'notice', conversationId: 'c', notice: { runId: 'undo:1', kind: 'undo', projectId: 'p', batch: null, undone: 1, refused: 0, more: 0 } });
  assert.equal(s.notices.get('c')![0]!.after, undefined);
  const placed = run(s, ev({ type: 'message.saved', runId: 'r', conversationId: 'c', messageId: 3, role: 'user' }), ev({ type: 'message.saved', runId: 'r', conversationId: 'c', messageId: 4, role: 'assistant' }));
  assert.equal(placed.notices.get('c')![0]!.after, 2.5);
});

test('ui/live-state: やり直し中（retrying）の知らせは同じ実行の中で 1 つに置き換え、その実行が終われば消える（履歴に残さない）', () => {
  const retrying = (attempt: number, runId = 'r'): Action => ev({ type: 'warning', runId, conversationId: 'c', code: 'retrying', message: 'm', params: { attempt } });
  const during = run(EMPTY, retrying(1), retrying(2), retrying(1, 'other'), ev({ type: 'warning', runId: 'r', conversationId: 'c', code: 'context_trimmed', message: 'x' }));
  assert.deepEqual(during.notices.get('c')!.map(n => [n.runId, n.kind === 'warning' && n.code]), [['r', 'retrying'], ['other', 'retrying'], ['r', 'context_trimmed']]);
  const ended = run(during, ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: true }));
  assert.deepEqual(ended.notices.get('c')!.map(n => [n.runId, n.kind === 'warning' && n.code]), [['other', 'retrying'], ['r', 'context_trimmed']], 'ほかの実行の分と、ほかの知らせは残す');
  const failed = run(run(EMPTY, retrying(1)), ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: false, errorKind: 'timeout' }));
  assert.deepEqual(failed.notices.get('c')!.map(n => n.kind), ['error'], '失敗で終わっても、やり直し中の知らせは残さない');
});

test('ui/live-state: Retry で片づけるのは、失敗した実行のお知らせだけ', () => {
  const s = run(EMPTY, ev({ type: 'compaction', runId: 'r1', conversationId: 'c', summarized: 2 }), ev({ type: 'run.end', runId: 'r2', conversationId: 'c', ok: false, errorKind: 'timeout' }));
  assert.deepEqual(run(s, { type: 'clearNotices', conversationId: 'c', runId: 'r2' }).notices.get('c')!.map(n => n.runId), ['r1']);
  assert.equal(run(s, { type: 'clearNotices', conversationId: 'c' }).notices.has('c'), false, 'runId が無ければ全部');
});

test('ui/live-state: タスクの変化と削除で、タスクの画面を読み直す番号が進む。消したタスクは数から外れ、一覧を読み直す（残る過去の実行には task.changed が来ないため）', () => {
  const changed = reduce(EMPTY, ev({ type: 'task.changed', task: task('a', 'inbox', 5) }));
  assert.equal(changed.state.taskRevision, 1);
  const stale = reduce(changed.state, ev({ type: 'task.changed', task: task('a', 'ready', 2) }));
  assert.equal(stale.state.taskRevision, 1, '古い知らせでは進めない');
  const deleted = reduce(changed.state, ev({ type: 'task.deleted', id: 'a' }));
  assert.equal(deleted.state.taskRevision, 2);
  assert.equal(deleted.state.tasks.has('a'), false);
  assert.deepEqual(refreshes(deleted.effects), ['tasks', 'worker']);
});

test('ui/live-state: サーバーの通知はトーストにする手続きを出す。実行の始まりは下書きに時刻を持たせる（Kanban の経過の時間）', () => {
  const got = reduce(EMPTY, ev({ type: 'notification', notification: note('task_done') }));
  assert.deepEqual(got.effects.filter(e => e.kind === 'toast'), [{ kind: 'toast', notification: note('task_done') }]);
  const started = reduce(EMPTY, { type: 'event', event: { type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' }, hidden: false, now: 1234 });
  assert.equal(started.state.drafts[0]!.startedAt, 1234);
});

test('ui/live-state: Library の画面を読み直す合図（libraryRevision）は、記憶の変化・実行の始まりと終わり・道具の結果・会話の変化・通知で進み、文字の流れでは進まない', () => {
  const bumps: RunEvent[] = [
    { type: 'memory.changed', runId: 'r', conversationId: 'c', memoryId: 1, book: 'user', action: 'create', content: 'x', eventId: 1 },
    { type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' },
    { type: 'tool.result', runId: 'r', conversationId: 'c', callId: 'k', name: 'file_read', ok: true, decision: 'allow', preview: '' },
    { type: 'run.end', runId: 'r', conversationId: 'c', ok: true },
    { type: 'conversation.changed', conversationId: 'c', change: 'archived' },
    { type: 'notification', notification: note('info') },
  ];
  for (const event of bumps) assert.equal(reduce(EMPTY, ev(event)).state.libraryRevision, 1, event.type);
  assert.equal(reduce(EMPTY, ev({ type: 'text.delta', runId: 'r', conversationId: 'c', text: 'a' })).state.libraryRevision, 0);
});

test('ui/live-state: 割り込みの発言が始まらなかった知らせ（queued_not_started）で割り込みの印を外す。ほかの警告では外さない', () => {
  const forced = run(EMPTY, ev({ type: 'run.start', runId: 'r1', conversationId: 'c', modelId: 'm' }), { type: 'interrupt', conversationId: 'c', on: true });
  const other = run(forced, ev({ type: 'warning', runId: 'r1', conversationId: 'c', code: 'context_trimmed', message: 'x' }));
  assert.ok(other.interrupting.has('c'));
  const dropped = run(forced, ev({ type: 'warning', runId: 'r1', conversationId: 'c', code: 'queued_not_started', message: 'not started' }));
  assert.equal(dropped.interrupting.has('c'), false);
  assert.deepEqual(dropped.notices.get('c')!.map(n => n.kind), ['warning'], '知らせそのものは出す');
  const next = run(dropped, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: true }), ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.deepEqual(next.notices.get('c')!.map(n => n.kind), ['warning'], '次のふつうの実行に Interrupted は付かない');
});

test('ui/live-state: 返事を待ち始めた時刻（「考え中 N 秒」の元）は、実行の始まり・道具の結果・返事の保存で進む', () => {
  const at = (event: RunEvent, now: number): Action => ({ type: 'event', event, hidden: false, now });
  const started = run(EMPTY, at({ type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' }, 100));
  assert.equal(started.drafts[0]!.waitingSince, 100);
  const called = run(started, at({ type: 'tool.call', runId: 'r', conversationId: 'c', callId: 'k', name: 'file_read', input: '{}' }, 200));
  assert.equal(called.drafts[0]!.waitingSince, 100);
  const result = run(called, at({ type: 'tool.result', runId: 'r', conversationId: 'c', callId: 'k', name: 'file_read', ok: true, decision: 'allow', preview: '' }, 300));
  assert.equal(result.drafts[0]!.waitingSince, 300);
  const saved = run(result, at({ type: 'message.saved', runId: 'r', conversationId: 'c', messageId: 1, role: 'assistant' }, 400));
  assert.equal(saved.drafts[0]!.waitingSince, 400);
  assert.equal(run(saved, at({ type: 'message.saved', runId: 'r', conversationId: 'c', messageId: 2, role: 'user' }, 500)).drafts[0]!.waitingSince, 400);
});

test('ui/live-state: 結果が届いた道具の覚えは新しい 20 件まで（古いものから外れる）', () => {
  let s = run(EMPTY, ev({ type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' }));
  for (let i = 1; i <= 23; i++) {
    s = run(s,
      ev({ type: 'tool.call', runId: 'r', conversationId: 'c', callId: `k${i}`, name: 'file_read', input: '{}' }),
      ev({ type: 'tool.result', runId: 'r', conversationId: 'c', callId: `k${i}`, name: 'file_read', ok: true, decision: 'allow', preview: '' }));
  }
  const settled = s.drafts[0]!.settled!;
  assert.equal(settled.length, 20);
  assert.deepEqual([settled[0]!.callId, settled.at(-1)!.callId], ['k4', 'k23']);
  assert.equal(s.drafts[0]!.settledCount, 23, '外れた分も含めて、その回で結果が届いた数を数える');
});

test('ui/live-state: Build のタスク（acceptance_items を持つ）の状態が変わったら、その製品の Plan の欄を読み直す（取り消し・失敗・戻しで unbuilt と open_build_task_id が変わる）', () => {
  const build = (status: Task['status'], updated: number): Task => ({ ...task('b1', status, updated), project_id: 'p1aaaa', acceptance_items: '["A-1"]' });
  const started = run(EMPTY, ev({ type: 'task.changed', task: build('ready', 1) }));
  assert.equal(started.planRevisions.get('p1aaaa'), 1);
  const cancelled = run(started, ev({ type: 'task.changed', task: build('cancelled', 2) }));
  assert.equal(cancelled.planRevisions.get('p1aaaa'), 2);
  const same = run(cancelled, ev({ type: 'task.changed', task: build('cancelled', 3) }));
  assert.equal(same.planRevisions.get('p1aaaa'), 2, '状態が同じなら読み直さない');
  const plain = run(EMPTY, ev({ type: 'task.changed', task: { ...task('t1', 'cancelled', 1), project_id: 'p1aaaa', acceptance_items: null } }));
  assert.equal(plain.planRevisions.get('p1aaaa'), undefined, 'Build でないタスクでは読み直さない');
});

test('ui/live-state: 判定役が通した・Pending に積んだ・動かさなかったは、結果の出来事の gate で道具の行に残り、お知らせの行は足さない', () => {
  const started = run(EMPTY, ev({ type: 'run.start', runId: 'r', conversationId: 'c', modelId: 'm' }));
  const step = (s: LiveState, callId: string, gate: { by: 'judge'; reason: string } | { by: 'pending'; id: number } | { by: 'not-parked' } | undefined): LiveState => run(s,
    ev({ type: 'tool.call', runId: 'r', conversationId: 'c', callId, name: 'shell_run', input: '{}' }),
    ev({ type: 'tool.auto', runId: 'r', conversationId: 'c', callId, name: 'shell_run', state: 'checking' }),
    ev({ type: 'tool.auto', runId: 'r', conversationId: 'c', callId, name: 'shell_run', state: 'allowed', reason: 'fine' }),
    ev({ type: 'tool.result', runId: 'r', conversationId: 'c', callId, name: 'shell_run', ok: true, decision: 'allow', preview: '', ...(gate ? { gate } : {}) }));
  const s = step(step(step(step(started, 'a', { by: 'judge', reason: 'fine' }), 'b', { by: 'pending', id: 12 }), 'c', { by: 'not-parked' }), 'd', undefined);
  assert.deepEqual(s.drafts[0]!.settled!.map(x => [x.callId, x.gate]), [['a', { by: 'judge', reason: 'fine' }], ['b', { by: 'pending', id: 12 }], ['c', { by: 'not-parked' }], ['d', undefined]]);
  assert.equal(s.notices.has('c'), false, '「自動で許した」のお知らせは出さない（理由は道具の行に出る）');
});

test('ui/live-state: タスクの印は返事待ちの種類（質問か Pending の承認か）を持つ。読み込みでも task.changed でも（beat 5-u2）', () => {
  const s = run(EMPTY, { type: 'tasks', tasks: [{ ...task('t1', 'waiting', 100), waiting_kind: 'approval' }, task('t2', 'waiting', 100)] });
  assert.equal(s.tasks.get('t1')?.waitingKind, 'approval');
  assert.equal(s.tasks.get('t2')?.waitingKind, undefined);
  const live = run(s, ev({ type: 'task.changed', task: { ...task('t2', 'waiting', 200), waiting_kind: 'question' } }));
  assert.equal(live.tasks.get('t2')?.waitingKind, 'question');
});

test('ui/live-state: Build のタスクが押された会話を持てば、そのタスクの変化とそのタスクの会話の Checklist の更新で、押された会話を読み直す', () => {
  const build = (status: Task['status'], updated: number, conversation: string | null): Task => ({ ...task('b1', status, updated), project_id: 'p1aaaa', acceptance_items: '["A-1"]', created_in_conversation: 'chat1', conversation_id: conversation });
  const queued = run(EMPTY, ev({ type: 'task.changed', task: build('ready', 1, null) }));
  assert.equal(queued.revisions.get('chat1'), 1);
  const running = run(queued, ev({ type: 'task.changed', task: build('running', 2, 'tc1') }));
  assert.equal(running.revisions.get('chat1'), 2);
  const ticked = run(running, ev({ type: 'checklist.updated', runId: 'r', conversationId: 'tc1', items: [{ text: 'Do it', status: 'in_progress' }], tainted: false }));
  assert.equal(ticked.revisions.get('chat1'), 3);
  assert.equal(ticked.revisions.get('tc1'), undefined);
  const reloaded = run(EMPTY, { type: 'tasks', tasks: [build('running', 2, 'tc1')] }, ev({ type: 'checklist.updated', runId: 'r', conversationId: 'tc1', items: [], tainted: false }));
  assert.equal(reloaded.revisions.get('chat1'), 1, '読み込んだ一覧からも、タスクの会話と押された会話を結ぶ');
  const plain = run(EMPTY, ev({ type: 'task.changed', task: { ...task('t1', 'ready', 1), created_in_conversation: 'chat1' } }), ev({ type: 'checklist.updated', runId: 'r', conversationId: 'other', items: [], tainted: false }));
  assert.equal(plain.revisions.get('chat1'), undefined, 'Build でないタスクでは読み直さない');
});

test('ui/live-state: Build のタスクの task.changed で押した会話を読み直すのは、状態・返事待ちの種類・確かめ待ち・タスクの会話が変わったときだけ。子の担当のタスクは結ばない', () => {
  const build = (updated: number, extra: Partial<Task> = {}): Task => ({ ...task('b1', 'running', updated), project_id: 'p1aaaa', acceptance_items: '["A-1"]', created_in_conversation: 'chat1', conversation_id: 'tc1', ...extra });
  const started = run(EMPTY, ev({ type: 'task.changed', task: build(1) }));
  assert.equal(started.revisions.get('chat1'), 1);
  const same = run(started, ev({ type: 'task.changed', task: build(2, { title: 'renamed' }) }));
  assert.equal(same.revisions.get('chat1'), 1, '題だけの変化では読み直さない');
  const waiting = run(same, ev({ type: 'task.changed', task: build(3, { status: 'waiting', waiting_kind: 'approval' }) }));
  assert.equal(waiting.revisions.get('chat1'), 2);
  const child = run(EMPTY, ev({ type: 'task.changed', task: build(1, { id: 'k1', spawned_by: 'b0', conversation_id: 'tc9' }) }), ev({ type: 'checklist.updated', runId: 'r', conversationId: 'tc9', items: [], tainted: false }));
  assert.equal(child.revisions.get('chat1'), undefined);
});
