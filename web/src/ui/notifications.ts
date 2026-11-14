import type { NotificationItem } from '../api.ts';
import { parseRoute, PRODUCT_ID, routeHash, type Route, type View } from './routes.ts';

export const WAITING_KINDS: ReadonlySet<string> = new Set(['task_waiting', 'approval_needed', 'question_new']);
export const FAILED_KINDS: ReadonlySet<string> = new Set(['task_failed', 'health_alert']);

export type NotificationAction = 'pending' | 'questions' | 'kanban' | 'retry';
export type NotificationFilter = 'unread' | 'all';
export type NotificationMark = 'dot' | 'alert' | 'plain';
export type DayGroupId = 'today' | 'yesterday' | 'earlier';

type Item = Pick<NotificationItem, 'id' | 'kind' | 'read_at' | 'created_at'>;

export function markOf(n: Pick<NotificationItem, 'kind' | 'read_at'>): NotificationMark {
  if (n.read_at !== null) return 'plain';
  return WAITING_KINDS.has(n.kind) ? 'dot' : FAILED_KINDS.has(n.kind) ? 'alert' : 'plain';
}

export const visibleNotifications = <T extends Item>(items: readonly T[], filter: NotificationFilter): T[] =>
  (filter === 'unread' ? items.filter(n => n.read_at === null) : [...items]);

export interface DayGroup<T> { id: DayGroupId; items: T[]; unread: number }

export function groupByDay<T extends Item>(items: readonly T[], now: number, dayStart: (ms: number) => number): Array<DayGroup<T>> {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const groups: Array<DayGroup<T>> = (['today', 'yesterday', 'earlier'] as const).map(id => ({ id, items: [], unread: 0 }));
  for (const item of items) {
    const group = groups[item.created_at >= today ? 0 : item.created_at >= yesterday ? 1 : 2]!;
    group.items.push(item);
    if (item.read_at === null) group.unread += 1;
  }
  return groups.filter(group => group.items.length > 0);
}

export function notificationTarget(link: string | null): { hash: string; view: View } | null {
  if (!link?.startsWith('#')) return null;
  const route = parseRoute(link);
  return route.view === 'new' || route.view === 'notifications' ? null : { hash: routeHash(route), view: route.view };
}

export const lastNotificationAt = (items: ReadonlyArray<Pick<NotificationItem, 'created_at'>>): number | null =>
  (items.length ? items.reduce((max, n) => Math.max(max, n.created_at), 0) : null);

export const markRead = <T extends Item>(items: readonly T[], ids: readonly number[] | null, now: number): T[] =>
  items.map(n => (n.read_at === null && (ids === null || ids.includes(n.id)) ? { ...n, read_at: now } : n));

export type GoLabel =
  | 'ui.notifications.open' | 'ui.notifications.open.task' | 'ui.notifications.open.kanban' | 'ui.notifications.open.session' | 'ui.notifications.open.skills'
  | 'ui.notifications.open.overview' | 'ui.notifications.open.pending' | 'ui.notifications.open.questions' | 'ui.notifications.retry';

const VIEW_LABEL: Partial<Record<View, GoLabel>> = {
  task: 'ui.notifications.open.task', kanban: 'ui.notifications.open.kanban', chat: 'ui.notifications.open.session', skills: 'ui.notifications.open.skills',
  overview: 'ui.notifications.open.overview', pending: 'ui.notifications.open.pending', questions: 'ui.notifications.open.questions',
};
const ACTION_LABEL: Record<NotificationAction, GoLabel> = {
  pending: 'ui.notifications.open.pending', questions: 'ui.notifications.open.questions', kanban: 'ui.notifications.open.kanban', retry: 'ui.notifications.retry',
};
const KIND_ACTION: Partial<Record<string, NotificationAction>> = { approval_needed: 'pending', question_new: 'questions' };

export interface NotificationGo { hash: string; label: GoLabel }

const isAction = (value: unknown): value is NotificationAction => typeof value === 'string' && Object.hasOwn(ACTION_LABEL, value);

function actionRoute(action: NotificationAction, linked: Route | null, productId: string | null): Route {
  if (action === 'pending' || action === 'questions') {
    if ((linked?.view === 'pending' || linked?.view === 'questions') && linked.view === action && linked.productId) return linked;
    return productId ? { view: action, productId } : { view: action };
  }
  if (action === 'retry' && linked?.view === 'task') return linked;
  return { view: 'kanban' };
}

export function notificationGo(n: Pick<NotificationItem, 'kind' | 'link' | 'project_id' | 'action'>): NotificationGo | null {
  const target = notificationTarget(n.link);
  const linked = target ? parseRoute(target.hash) : null;
  const action = isAction(n.action) ? n.action : linked?.view === 'pending' || linked?.view === 'questions' ? linked.view : linked ? undefined : KIND_ACTION[n.kind];
  if (action) {
    const productId = n.project_id && PRODUCT_ID.test(n.project_id) ? n.project_id : null;
    return { hash: routeHash(actionRoute(action, linked, productId)), label: ACTION_LABEL[action] };
  }
  return target ? { hash: target.hash, label: VIEW_LABEL[target.view] ?? 'ui.notifications.open' } : null;
}
