import type { NotificationItem } from '../api.ts';
import { parseRoute, routeHash, type View } from './routes.ts';
import { FAILED_KINDS, WAITING_KINDS } from './toast-list.ts';

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
