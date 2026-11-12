import { useEffect, useRef, useState } from 'react';
import { api, type Conversation, type HistoryHit } from '../api.ts';
import { useT } from '../i18n/index.ts';
import type { AgentState, FootLine } from './agent-state.ts';
import { Avatar, CountBadge, Icon } from './parts.tsx';
import type { UiIconName } from './icons.ts';
import { routeHash, type Route } from './routes.ts';

export interface SidebarProps {
  state: AgentState;
  route: Route;
  foot: FootLine;
  kanban: number;
  drafts: number;
  unread: number;
  conversations: Conversation[];
  running: ReadonlySet<string>;
}

function SideLink({ href, icon, name, active, count, countLabel }: {
  href: string; icon: UiIconName; name: string; active: boolean; count?: number; countLabel?: string;
}) {
  return (
    <a className={`bt-side${active ? ' is-active' : ''}`} href={href} aria-current={active ? 'page' : undefined}>
      <Icon name={icon} /><span className="bt-side__name">{name}</span>
      {count !== undefined && <CountBadge n={count} label={countLabel} />}
    </a>
  );
}

function footText(t: ReturnType<typeof useT>, foot: FootLine): string {
  switch (foot.kind) {
    case 'waiting': return t('ui.foot.waiting', foot.n);
    case 'building': return t('ui.foot.building', foot.step, foot.total);
    case 'running': return foot.title ? t('ui.foot.running', foot.title) : t('ui.foot.runningPlain');
    default: return t('ui.foot.idle');
  }
}

function SessionSearch({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<HistoryHit[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits(null); return undefined; }
    let live = true;
    const timer = setTimeout(() => { void api.history(q).then(r => { if (live) setHits(r.hits); }).catch(() => { if (live) setHits([]); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  const seen = new Set<string>();
  const unique = (hits ?? []).filter(h => (seen.has(h.conversationId) ? false : (seen.add(h.conversationId), true)));
  return (
    <div className="ui-search">
      <div className="ui-search__row">
        <input className="bt-field" type="text" autoFocus value={query} aria-label={t('ui.search.field')} placeholder={t('ui.search.field')}
          onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
        <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.search.close')} onClick={onClose}><Icon name="x" /></button>
      </div>
      {hits !== null && unique.length === 0 && <span className="bt-meta ui-search__none">{t('ui.search.none')}</span>}
      {unique.map(h => (
        <a key={h.conversationId} className="bt-side bt-side--session ui-search__hit" href={routeHash({ view: 'chat', id: h.conversationId })}>
          <span className="bt-side__name">{h.title || t('ui.session.untitled')}<span className="bt-meta ui-search__snippet">{h.snippet}</span></span>
        </a>
      ))}
    </div>
  );
}

export function Sidebar({ state, route, foot, kanban, drafts, unread, conversations, running }: SidebarProps) {
  const t = useT();
  const [searching, setSearching] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => { if (!searching && refocus.current) { refocus.current = false; searchButton.current?.focus(); } }, [searching]);
  const at = (view: Route['view']) => route.view === view;
  return (
    <nav className={`bt-sidebar is-${state}`} aria-label={t('ui.sidebar')}>
      <div className="bt-sidebar__head">
        <a className="bt-wordmark" href="#/">{t('ui.wordmark')}</a>
        <Avatar state={state} size="sm" />
      </div>
      <div className="bt-mode" role="radiogroup" aria-label={t('ui.mode')} data-mode="dev">
        <button className="bt-mode__opt" type="button" role="radio" aria-checked="true" tabIndex={0}><Icon name="code" />{t('ui.mode.dev')}</button>
        <button className="bt-mode__opt" type="button" role="radio" aria-checked="false" aria-disabled="true" tabIndex={-1} title={t('ui.mode.botLater')}><Icon name="msg" />{t('ui.mode.bot')}</button>
      </div>
      <div className="bt-sidebar__scroll">
        <span className="bt-label bt-sidebar__label">{t('ui.section.workspace')}</span>
        <SideLink href="#/overview" icon="grid" name={t('ui.nav.overview')} active={at('overview')} />
        <SideLink href="#/kanban" icon="columns" name={t('ui.nav.kanban')} active={at('kanban')} count={kanban} countLabel={t('ui.count.waiting', kanban)} />
        <SideLink href="#/schedule" icon="calendar" name={t('ui.nav.schedule')} active={at('schedule')} />

        <div className="ui-sidebar__labelrow">
          <span className="bt-label bt-sidebar__label">{t('ui.section.noProduct')}</span>
          {!searching && <button ref={searchButton} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.search.open')} onClick={() => setSearching(true)}><Icon name="search" /></button>}
        </div>
        {searching && <SessionSearch onClose={() => { refocus.current = true; setSearching(false); }} />}
        {conversations.map(c => {
          const active = route.view === 'chat' && route.id === c.id;
          const live = running.has(c.id);
          return (
            <a key={c.id} className={`bt-side bt-side--session${active ? ' is-active' : ''}`} href={routeHash({ view: 'chat', id: c.id })} aria-current={active ? 'page' : undefined}>
              <span className={`bt-side__state${live ? ' bt-side__state--running' : ''}`} role="img" aria-label={live ? t('ui.session.running') : t('ui.session.idle')} />
              <span className="bt-side__name">{c.title || t('ui.session.untitled')}</span>
            </a>
          );
        })}
        <SideLink href="#/" icon="plus" name={t('ui.session.new')} active={at('new')} />

        <span className="bt-label bt-sidebar__label">{t('ui.section.library')}</span>
        <SideLink href="#/memory" icon="book" name={t('ui.nav.memory')} active={at('memory')} />
        <SideLink href="#/skills" icon="layers" name={t('ui.nav.skills')} active={at('skills')} count={drafts} countLabel={t('ui.count.drafts', drafts)} />
        <SideLink href="#/runs" icon="menu" name={t('ui.nav.runs')} active={at('runs')} />
        <SideLink href="#/archived" icon="archive" name={t('ui.nav.archived')} active={at('archived')} />
      </div>
      <div className="bt-sidebar__foot">
        <span className="bt-side__name bt-meta">{footText(t, foot)}</span>
        <a className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost bt-bell" href="#/notifications" aria-label={t('ui.bell', unread)} aria-current={at('notifications') ? 'page' : undefined}>
          <Icon name="bell" /><CountBadge n={unread} />
        </a>
        <a className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" href="#/settings" aria-label={t('ui.nav.settings')} data-settings-button><Icon name="sliders" /></a>
      </div>
    </nav>
  );
}
