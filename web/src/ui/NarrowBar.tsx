import type { RefObject } from 'react';
import { useT } from '../i18n/index.ts';
import { CountBadge, Icon } from './parts.tsx';
import type { Route } from './routes.ts';

export function NarrowBar({ title, unread, expanded, covered, menuRef, onMenu }: {
  title: string; unread: number; expanded: boolean; covered: boolean; menuRef: RefObject<HTMLButtonElement | null>; onMenu: () => void;
}) {
  const t = useT();
  return (
    <header className="ui-narrowbar" inert={covered}>
      <button ref={menuRef} type="button" className="bt-btn bt-btn--icon bt-btn--ghost" aria-label={t('ui.menu')} aria-expanded={expanded} onClick={onMenu}><Icon name="menu" /></button>
      <span className="ui-narrowbar__title">{title}</span>
      <a className="bt-btn bt-btn--icon bt-btn--ghost bt-bell" href="#/notifications" aria-label={t('ui.bell', unread)}>
        <Icon name="bell" /><CountBadge n={unread} quiet />
      </a>
    </header>
  );
}

export function TabBar({ route, kanban, covered }: { route: Route; kanban: number; covered: boolean }) {
  const t = useT();
  const tab = (view: 'overview' | 'kanban', icon: 'grid' | 'columns', name: string, count = 0) => {
    const active = route.view === view;
    return (
      <a className={`ui-tab${active ? ' is-active' : ''}`} href={`#/${view}`} aria-current={active ? 'page' : undefined}>
        <span className="ui-tab__icon"><Icon name={icon} /><CountBadge n={count} label={t('ui.count.waiting', count)} /></span>
        {name}
      </a>
    );
  };
  return (
    <nav className="ui-tabbar" aria-label={t('ui.tabs')} inert={covered}>
      {tab('overview', 'grid', t('ui.nav.overview'))}
      {tab('kanban', 'columns', t('ui.nav.kanban'), kanban)}
    </nav>
  );
}
