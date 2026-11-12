import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type NotificationItem } from '../../api.ts';
import { formatDateTime, formatRelative, startOfDay, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import {
  groupByDay, lastNotificationAt, markOf, markRead, notificationTarget, visibleNotifications, type DayGroupId, type NotificationFilter,
} from '../notifications.ts';
import { Button, CountBadge, EmptyState, Icon, Notice } from '../parts.tsx';
import { reportOpError } from '../task-ops.ts';
import type { View } from '../routes.ts';

export interface NotificationsProps { unread: number; epoch: number; onUnread: (count: number) => void }

const GROUP_KEY = { today: 'ui.notifications.today', yesterday: 'ui.notifications.yesterday', earlier: 'ui.notifications.earlier' } as const satisfies Record<DayGroupId, string>;
const OPEN_KEY: Partial<Record<View, 'ui.notifications.open.task' | 'ui.notifications.open.kanban' | 'ui.notifications.open.session' | 'ui.notifications.open.skills' | 'ui.notifications.open.overview'>> = {
  task: 'ui.notifications.open.task', kanban: 'ui.notifications.open.kanban', chat: 'ui.notifications.open.session', skills: 'ui.notifications.open.skills', overview: 'ui.notifications.open.overview',
};

const firstLine = (text: string | null): string => text?.split('\n').find(line => line.trim())?.trim() ?? '';

export function Notifications({ unread, epoch, onUnread }: NotificationsProps) {
  const t = useT();
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>('unread');
  const [busy, setBusy] = useState(false);
  const loads = useRef(latestOnly());
  const now = useNow(60_000);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const result = await api.notifications();
      if (!loads.current.isCurrent(ticket)) return;
      setItems(result.notifications);
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load, unread, epoch]);

  const groups = useMemo(() => (items ? groupByDay(visibleNotifications(items, filter), now, startOfDay) : []), [items, filter, now]);
  const last = items ? lastNotificationAt(items) : null;

  const open = (item: NotificationItem, hash: string | null) => {
    if (item.read_at === null) {
      setItems(current => current && markRead(current, [item.id], Date.now()));
      void api.readNotifications([item.id]).then(result => onUnread(result.unread)).catch(error => { reportOpError(error); void load(); });
    }
    if (hash) location.hash = hash;
  };
  const readAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.readNotifications();
      setItems(current => current && markRead(current, null, Date.now()));
      onUnread(result.unread);
    } catch (error) { reportOpError(error); } finally { setBusy(false); }
  };

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.notifications')}</h1>
        <div className="bt-screen__tools">
          <div className="bt-seg" role="group" aria-label={t('ui.notifications.filter')}>
            <button type="button" className="bt-seg__opt" aria-pressed={filter === 'unread'} onClick={() => setFilter('unread')}>{t('ui.notifications.unread')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>{t('ui.notifications.all')}</button>
          </div>
          <Button disabled={busy || unread === 0} onClick={() => void readAll()}>{t('ui.notifications.readAll')}</Button>
        </div>
      </header>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {items && groups.length === 0 && (
        <EmptyState title={t('ui.notifications.empty')} text={<span className="bt-meta">{last !== null ? t('ui.notifications.last', formatDateTime(last, 'full')) : t('ui.notifications.none')}</span>} />
      )}
      {groups.map((group, index) => (
        <section key={group.id} className="bt-section bt-rise" style={{ '--bt-i': index + 1 } as CSSProperties} aria-label={t(GROUP_KEY[group.id])}>
          <div className="bt-section__head"><span className="bt-label">{t(GROUP_KEY[group.id])}</span><CountBadge n={group.unread} label={t('ui.notifications.unreadCount', group.unread)} /></div>
          <ul className="bt-list">
            {group.items.map(item => {
              const mark = markOf(item);
              const target = notificationTarget(item.link);
              const isUnread = item.read_at === null;
              const body = firstLine(item.body);
              const active = target !== null || isUnread;
              return (
                <li key={item.id} className={`bt-row ui-notif${active ? ' bt-row--link' : ''}`} data-read={isUnread ? '0' : '1'} onClick={active ? () => open(item, target?.hash ?? null) : undefined}>
                  {mark === 'dot' ? <span className="bt-dot" role="img" aria-label={t('ui.notifications.unread')} />
                    : <Icon name={mark === 'alert' ? 'alert' : item.kind === 'task_done' ? 'check' : 'bell'} className={mark === 'alert' ? 'bt-del' : undefined} />}
                  <div className="bt-row__main">
                    <span className={`bt-row__title${mark === 'plain' ? ' ui-notif__quiet' : ''}`}>{item.title}</span>
                    {body && <span className="bt-row__sub bt-meta">{body}</span>}
                  </div>
                  <div className="bt-row__end">
                    <span className="bt-meta" title={formatDateTime(item.created_at, 'full')}>{formatRelative(item.created_at, now)}</span>
                    {target ? <Button small>{t(OPEN_KEY[target.view] ?? 'ui.notifications.open')}</Button> : isUnread ? <Button small variant="ghost">{t('ui.notifications.markRead')}</Button> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
