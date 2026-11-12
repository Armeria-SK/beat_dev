import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, NotificationItem, Task } from '../web/src/api.ts';
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

test('ui/live-state: ブラウザの通知は、承認待ちは approval.requested の 1 回だけ（approval_needed の通知では出さない）、返事待ちは task_waiting で。どちらも画面が隠れているときだけ', () => {
  const approval = { type: 'approval.requested', runId: 'r', conversationId: 'c', approval: { id: 'a', title: 'Write x' } } as unknown as RunEvent;
  assert.deepEqual(reduce(EMPTY, ev(approval, true)).effects.filter(e => e.kind !== 'refresh'), [{ kind: 'notifyApproval', title: 'Write x' }]);
  assert.deepEqual(reduce(EMPTY, ev(approval, false)).effects.filter(e => e.kind !== 'refresh'), []);
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
  assert.deepEqual(refreshes(ended.effects), ['approvals', 'conversations', 'drafts', 'worker']);
});

test('ui/live-state: 未読の数は notification で 1 増え、notification.read と読み込みで置き換わる', () => {
  const s = run(EMPTY, { type: 'unread', count: 2 }, ev({ type: 'notification', notification: note('info') }));
  assert.equal(s.unread, 3);
  assert.equal(run(s, ev({ type: 'notification.read', ids: [1], unread: 0 })).unread, 0);
});

test('ui/live-state: つなぎ直し（resync）は、サーバーの下書きを入れ、全部を読み直す', () => {
  const r = reduce(EMPTY, { type: 'resync', drafts: [{ runId: 'r', conversationId: 'c', modelId: 'm', text: 'x' }, { runId: 'q', conversationId: 'd', modelId: 'm', text: '' }] });
  assert.deepEqual([...r.state.streaming], ['c']);
  assert.deepEqual(refreshes(r.effects), ['approvals', 'conversations', 'drafts', 'tasks', 'unread', 'worker']);
  assert.equal(r.effects.filter(e => e.kind === 'checklist').length, 2);
});

test('ui/live-state: 会話の中の動き（返事の文・道具の呼び出し・お知らせ・承認の一覧・会話ごとの読み直しの数）', () => {
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
  assert.deepEqual(s4.notices.get('c'), [{ runId: 'r', kind: 'denied', tool: 'shell_run', detail: 'no way more' }]);
  const approval = { id: 'a1', title: 'Write', tool: 'file_write' } as unknown as Extract<RunEvent, { type: 'approval.requested' }>['approval'];
  const s5 = run(s4, ev({ type: 'approval.requested', runId: 'r', conversationId: 'c', approval }));
  assert.deepEqual(s5.approvals.map(a => [a.id, a.conversationId, a.runId]), [['a1', 'c', 'r']]);
  assert.deepEqual(run(s5, ev({ type: 'approval.resolved', runId: 'r', conversationId: 'c', approvalId: 'a1', outcome: 'once' })).approvals, []);
  const failed = reduce(s5, ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: false, errorKind: 'timeout', errorMessage: 'slow' }));
  assert.deepEqual(failed.state.notices.get('c')!.at(-1), { runId: 'r', kind: 'error', errorKind: 'timeout', errorCode: undefined, errorParams: undefined, errorMessage: 'slow', hint: undefined, measured: undefined, required: undefined });
  const stopped = run(s5, ev({ type: 'run.end', runId: 'r', conversationId: 'c', ok: false, errorKind: 'cancelled' }));
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

test('ui/live-state: 新しい実行が始まると、その会話の前の実行のお知らせは片づける（会話の最後に古い失敗や警告を残さない）', () => {
  const s = run(EMPTY, ev({ type: 'run.end', runId: 'r1', conversationId: 'c', ok: false, errorKind: 'timeout' }), ev({ type: 'compaction', runId: 'r1', conversationId: 'd', summarized: 2 }));
  const next = run(s, ev({ type: 'run.start', runId: 'r2', conversationId: 'c', modelId: 'm' }));
  assert.equal(next.notices.has('c'), false);
  assert.equal(next.notices.get('d')?.length, 1, 'ほかの会話のお知らせは残す');
});
