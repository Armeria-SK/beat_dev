import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONVERSATION_LIST_LIMIT, conversationCountLabel, classifyRun, type RunContext } from '../web/src/conversation-state.ts';
import { en } from '../web/src/i18n/en.ts';
import { formatElapsed, formatRelativeCompact, setTimezone } from '../web/src/i18n/index.ts';
import { isComposing } from '../web/src/keys.ts';
import { notificationIcon, notificationKindLabel } from '../web/src/notification-meta.ts';

// 画面を持たない小さな決まり（実行の種類・相対時刻・変換中のキー・通知の種類）。
// 前の画面の枠（タブ・パレット・右のパネル・Esc の順・ステータスバー・幅の CSS）の項は、前の画面と一緒に消した（beat 1-6）。

const reset = () => { setTimezone('Asia/Tokyo'); };

test('classifyRun: 会話かタスクかは、一覧に載っているかではなく実行の種類で決める', () => {
  const context = (patch: Partial<RunContext> = {}): RunContext => ({ taskConversations: new Map([['task-conv', 't1']]), running: null, ...patch });
  const listed = new Set(['listed-chat']);
  assert.equal(classifyRun('r1', 'listed-chat', context(), listed), 'chat', '一覧（chat だけが載る）に載っている会話');
  assert.equal(classifyRun('r1', 'old-chat', context(), listed), 'unknown', '一覧の外の会話は決めつけず、サーバーに会話の種類を尋ねる');
  assert.equal(classifyRun('r1', 'task-conv', context(), listed), 'background', 'タスクの会話');
  assert.equal(classifyRun('r5', 'x', context({ running: { kind: 'review', taskId: null, runId: 'r5' } }), listed), 'background', '実行中の振り返り・タスク');
  assert.equal(classifyRun('r6', 'review-conv', context(), listed), 'unknown', '短い振り返りで worker の状態がまだ届いていないときは、会話として扱わない');
});

test('conversationCountLabel: 一覧は 100 件までなので、100 件に届いたら「100+」と出す', () => {
  assert.equal(CONVERSATION_LIST_LIMIT, 100);
  assert.equal(conversationCountLabel(0), '0');
  assert.equal(conversationCountLabel(99), '99');
  assert.equal(conversationCountLabel(100), '100+');
});

test('isComposing: 日本語の変換中のキーは何にも使わない', () => {
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ keyCode: 13 }), false);
});

test('formatRelativeCompact: サイドバー用の短い相対時刻', () => {
  reset();
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const ago = (ms: number) => formatRelativeCompact(now - ms, now);
  assert.equal(ago(10_000), 'now');
  assert.equal(ago(5 * 60_000), '5m');
  assert.equal(ago(2 * 3_600_000), '2h');
  assert.equal(ago(3 * 86_400_000), '3d');
  assert.equal(ago(45 * 86_400_000), '1mo');
  assert.equal(ago(400 * 86_400_000), '1y');
  assert.equal(ago(-5000), 'now', '未来の時刻は今として扱う');
  reset();
});

test('formatElapsed: 実行中の経過時間', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000 + 4 * 60_000 + 7_000), '1:04:07');
  assert.equal(formatElapsed(-5000), '00:00');
});

test('notificationIcon / notificationKindLabel: サーバーの通知の種類ごとに絵と名前があり、知らない種類は「お知らせ」の絵になる', () => {
  for (const kind of ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'health_alert', 'info']) {
    assert.ok(notificationIcon(kind), `${kind}: 絵が無い`);
    const label = notificationKindLabel(kind);
    assert.ok(label && typeof (en as Record<string, unknown>)[label] === 'string', `${kind}: 名前が辞書に無い`);
  }
  assert.equal(notificationIcon('approval_needed'), 'shield');
  assert.equal(notificationIcon('task_failed'), 'circleX');
  assert.equal(notificationIcon('from-the-future'), 'info');
  assert.equal(notificationKindLabel('from-the-future'), null);
});
