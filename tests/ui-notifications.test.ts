import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotificationItem } from '../web/src/api.ts';
import { groupByDay, lastNotificationAt, markOf, markRead, notificationTarget, visibleNotifications } from '../web/src/ui/notifications.ts';

// 新しい画面の Notifications（steps/p1-ui.md の「画面」の Notifications と PR 1-4b）の決まり。画面を持たない純粋な関数（web/src/ui/notifications.ts）。

const DAY = 86_400_000;
const item = (id: number, kind: string, extra: Partial<NotificationItem> = {}): NotificationItem =>
  ({ id, kind, title: `n${id}`, body: null, link: null, read_at: null, created_at: 10 * DAY + id, ...extra });
const utcDay = (ms: number): number => Math.floor(ms / DAY) * DAY;

test('ui/notifications: 印は、未読で持ち主を待つものが点、未読の失敗が alert、既読か何も要らないものは静かな印', () => {
  assert.equal(markOf(item(1, 'task_waiting')), 'dot');
  assert.equal(markOf(item(1, 'approval_needed')), 'dot');
  assert.equal(markOf(item(1, 'task_failed')), 'alert');
  assert.equal(markOf(item(1, 'health_alert')), 'alert');
  assert.equal(markOf(item(1, 'task_done')), 'plain');
  assert.equal(markOf(item(1, 'info')), 'plain');
  assert.equal(markOf(item(1, 'task_waiting', { read_at: 5 })), 'plain');
  assert.equal(markOf(item(1, 'task_failed', { read_at: 5 })), 'plain');
});

test('ui/notifications: Unread は未読だけ、All は全部（並びは変えない）', () => {
  const list = [item(3, 'info'), item(2, 'info', { read_at: 1 }), item(1, 'task_done')];
  assert.deepEqual(visibleNotifications(list, 'unread').map(n => n.id), [3, 1]);
  assert.deepEqual(visibleNotifications(list, 'all').map(n => n.id), [3, 2, 1]);
});

test('ui/notifications: 日ごとの見出しは Today・Yesterday・Earlier。空の日は出さず、見出しの数は未読の数', () => {
  const now = 10 * DAY + 5000;
  const list = [item(1, 'info'), item(2, 'info', { read_at: 9 }), item(3, 'info', { created_at: 9 * DAY + 1 }), item(4, 'info', { created_at: 2 * DAY }), item(5, 'info', { created_at: 8 * DAY, read_at: 1 })];
  assert.deepEqual(groupByDay(list, now, utcDay).map(g => [g.id, g.items.map(n => n.id), g.unread]), [['today', [1, 2], 1], ['yesterday', [3], 1], ['earlier', [4, 5], 1]]);
  assert.deepEqual(groupByDay([item(1, 'info')], now, utcDay).map(g => g.id), ['today']);
  assert.deepEqual(groupByDay([], now, utcDay), []);
});

test('ui/notifications: 行き先は通知のリンク。古い経路は読み替え、読めないリンク・会話の入口・通知の画面そのものは行き先にしない', () => {
  assert.deepEqual(notificationTarget('#/tasks/t1'), { hash: '#/tasks/t1', view: 'task' });
  assert.deepEqual(notificationTarget('#/tasks'), { hash: '#/kanban', view: 'kanban' });
  assert.deepEqual(notificationTarget('#/review'), { hash: '#/skills', view: 'skills' });
  assert.deepEqual(notificationTarget('#/c/abc'), { hash: '#/c/abc', view: 'chat' });
  for (const link of [null, '', '#/', '#/nowhere', 'https://example.com/x', '#/notifications']) assert.equal(notificationTarget(link), null, String(link));
});

test('ui/notifications: 開いた行だけ（または全部）を既読にする。もう既読の行の時刻は変えない', () => {
  const list = [item(1, 'info'), item(2, 'info', { read_at: 7 }), item(3, 'info')];
  assert.deepEqual(markRead(list, [1, 2], 99).map(n => n.read_at), [99, 7, null]);
  assert.deepEqual(markRead(list, null, 99).map(n => n.read_at), [99, 7, 99]);
  assert.equal(lastNotificationAt(list), 10 * DAY + 3);
  assert.equal(lastNotificationAt([]), null);
});

test('ui/notifications: 行のボタンは 1 つで決める場所へ。Pending・Questions は製品の一覧へ、サーバーの行き先（action）を先に使い、知らない値は読み飛ばす（beat 5-u2）', async () => {
  const { notificationGo } = await import('../web/src/ui/notifications.ts');
  const P = 'prod-abc123';
  assert.deepEqual(notificationGo(item(1, 'approval_needed', { link: '#/pending', project_id: P })), { hash: `#/pending/${P}`, label: 'ui.notifications.open.pending' });
  assert.deepEqual(notificationGo(item(1, 'approval_needed', { link: '#/pending' })), { hash: '#/pending', label: 'ui.notifications.open.pending' });
  assert.deepEqual(notificationGo(item(1, 'approval_needed')), { hash: '#/pending', label: 'ui.notifications.open.pending' }, 'リンクが無くても種類から');
  assert.deepEqual(notificationGo(item(1, 'question_new', { project_id: P })), { hash: `#/questions/${P}`, label: 'ui.notifications.open.questions' });
  assert.deepEqual(notificationGo(item(1, 'question_new', { action: 'questions', link: `#/questions/${P}` })), { hash: `#/questions/${P}`, label: 'ui.notifications.open.questions' });
  assert.deepEqual(notificationGo(item(1, 'task_done', { action: 'kanban', link: '#/tasks/t1' })), { hash: '#/kanban', label: 'ui.notifications.open.kanban' });
  assert.deepEqual(notificationGo(item(1, 'task_failed', { action: 'retry', link: '#/tasks/t1' })), { hash: '#/tasks/t1', label: 'ui.notifications.retry' });
  assert.deepEqual(notificationGo(item(1, 'task_failed', { action: 'retry' })), { hash: '#/kanban', label: 'ui.notifications.retry' });
  assert.deepEqual(notificationGo(item(1, 'task_failed', { action: 'launch', link: '#/tasks/t1' })), { hash: '#/tasks/t1', label: 'ui.notifications.open.task' }, '知らない行き先は読み飛ばす');
  assert.deepEqual(notificationGo(item(1, 'task_waiting', { link: '#/tasks/t1', project_id: P })), { hash: '#/tasks/t1', label: 'ui.notifications.open.task' });
  assert.equal(notificationGo(item(1, 'approval_needed', { project_id: '../x' }))?.hash, '#/pending', '製品の番号の形でないものは使わない');
  assert.equal(notificationGo(item(1, 'info')), null);
  assert.equal(markOf(item(1, 'question_new')), 'dot', '新しい質問は持ち主を待つ印');
});

test('ui/notifications: Object の持つ名前（constructor・toString）の種類でも行き先を作らない（beat 5-u2）', async () => {
  const { notificationGo } = await import('../web/src/ui/notifications.ts');
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(notificationGo(item(1, kind)), null, kind);
});
