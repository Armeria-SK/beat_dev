import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Conversation, type Project } from '../api.ts';
import { toast } from '../feedback.ts';
import { useT } from '../i18n/index.ts';
import type { AgentState, FootLine } from './agent-state.ts';
import { Avatar, CountBadge, Icon } from './parts.tsx';
import type { UiIconName } from './icons.ts';
import { productNav } from './product-nav.ts';
import { routeHash, type Route } from './routes.ts';
import { searchView, type SearchState } from './search-state.ts';

export interface SidebarProps {
  state: AgentState;
  route: Route;
  foot: FootLine;
  kanban: number;
  pending: number;
  sessionPending: ReadonlyMap<string, number>;
  drafts: number;
  unread: number;
  conversations: Conversation[];
  conversationsMore: Readonly<Record<string, number>>;
  projects: Project[];
  running: ReadonlySet<string>;
  color?: string | undefined;
  setupPending: boolean;
  onSetup: () => void;
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
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  useEffect(() => {
    const q = query.trim();
    if (!q) { setSearch({ kind: 'idle' }); return undefined; }
    let live = true;
    const timer = setTimeout(() => { void api.history(q).then(r => { if (live) setSearch({ kind: 'loaded', hits: r.hits }); }).catch(() => { if (live) setSearch({ kind: 'failed' }); }); }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  const view = searchView(search);
  return (
    <div className="ui-search">
      <div className="ui-search__row">
        <input className="bt-field" type="text" autoFocus value={query} aria-label={t('ui.search.field')} placeholder={t('ui.search.field')}
          onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
        <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.search.close')} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div role="status" className="ui-search__status">
        {view.note === 'none' && <span className="bt-meta ui-search__none">{t('ui.search.none')}</span>}
        {view.note === 'failed' && <span className="bt-meta ui-search__none ui-danger">{t('ui.kanban.loadFailed')}</span>}
      </div>
      {view.hits.map(h => (
        <a key={h.conversationId} className="bt-side bt-side--session ui-search__hit" href={routeHash({ view: 'chat', id: h.conversationId })}>
          <span className="bt-side__name">{h.title || t('ui.session.untitled')}<span className="bt-meta ui-search__snippet">{h.snippet}</span></span>
        </a>
      ))}
    </div>
  );
}

function SessionRow({ conversation: c, route, running, pending }: { conversation: Conversation; route: Route; running: ReadonlySet<string>; pending: ReadonlyMap<string, number> }) {
  const t = useT();
  const waiting = pending.get(c.id) ?? 0;
  const active = route.view === 'chat' && route.id === c.id;
  const live = running.has(c.id);
  return (
    <a className={`bt-side bt-side--session${active ? ' is-active' : ''}`} href={routeHash({ view: 'chat', id: c.id })} aria-current={active ? 'page' : undefined}>
      <span className={`bt-side__state${live ? ' bt-side__state--running' : ''}`} role="img" aria-label={live ? t('ui.session.running') : t('ui.session.idle')} />
      <span className="bt-side__name">{c.title || t('ui.session.untitled')}</span>
      <CountBadge n={waiting} label={t('ui.count.waiting', waiting)} />
    </a>
  );
}

function useMoreSessions(conversations: Conversation[]): { extra: ReadonlyMap<string, Conversation[]>; expand: (projectId: string) => void } {
  const t = useT();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [extra, setExtra] = useState<ReadonlyMap<string, Conversation[]>>(new Map());
  useEffect(() => {
    let live = true;
    for (const id of expanded) {
      void api.conversationsOf(id).then(r => { if (live) setExtra(old => new Map(old).set(id, r.conversations)); })
        .catch(() => { if (!live) return; setExpanded(old => { const next = new Set(old); next.delete(id); return next; }); toast({ icon: 'alert', title: t('ui.product.moreFailed') }); });
    }
    return () => { live = false; };
  }, [conversations, expanded, t]);
  const expand = useCallback((projectId: string) => setExpanded(old => new Set(old).add(projectId)), []);
  return { extra, expand };
}

export function Sidebar({ state, route, foot, kanban, pending, sessionPending, drafts, unread, conversations, conversationsMore, projects, running, color, setupPending, onSetup }: SidebarProps) {
  const t = useT();
  const { extra, expand } = useMoreSessions(conversations);
  const nav = useMemo(() => productNav(projects, conversations, conversationsMore, extra), [projects, conversations, conversationsMore, extra]);
  const [searching, setSearching] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => { if (!searching && refocus.current) { refocus.current = false; searchButton.current?.focus(); } }, [searching]);
  const at = (view: Route['view']) => route.view === view;
  return (
    <nav className={`bt-sidebar is-${state}`} aria-label={t('ui.sidebar')}>
      <div className="bt-sidebar__head">
        <a className="bt-wordmark" href="#/">{t('ui.wordmark')}</a>
        <Avatar state={state} size="sm" color={color} />
      </div>
      <div className="bt-mode" role="radiogroup" aria-label={t('ui.mode')} data-mode="dev">
        <button className="bt-mode__opt" type="button" role="radio" aria-checked="true" tabIndex={0}><Icon name="code" />{t('ui.mode.dev')}</button>
        <button className="bt-mode__opt" type="button" role="radio" aria-checked="false" aria-disabled="true" tabIndex={-1} title={t('ui.mode.botLater')}><Icon name="msg" />{t('ui.mode.bot')}</button>
      </div>
      <div className="bt-sidebar__scroll">
        {setupPending && <button type="button" className="bt-side ui-side-setup" onClick={onSetup}><Icon name="person" /><span className="bt-side__name">{t('ui.ob.resume')}</span></button>}
        <span className="bt-label bt-sidebar__label">{t('ui.section.workspace')}</span>
        <SideLink href="#/overview" icon="grid" name={t('ui.nav.overview')} active={at('overview')} />
        <SideLink href="#/kanban" icon="columns" name={t('ui.nav.kanban')} active={at('kanban')} count={kanban} countLabel={t('ui.count.waiting', kanban)} />
        <SideLink href="#/pending" icon="pause" name={t('ui.nav.pending')} active={at('pending')} count={pending} countLabel={t('ui.count.waiting', pending)} />
        <SideLink href="#/schedule" icon="calendar" name={t('ui.nav.schedule')} active={at('schedule')} />

        <span className="bt-label bt-sidebar__label">{t('ui.product.section')}</span>
        {nav.rows.map(row => {
          const { project } = row;
          const home = route.view === 'product' && route.id === project.id;
          const fresh = route.view === 'productNew' && route.id === project.id;
          return (
            <Fragment key={project.id}>
              <div className="bt-side bt-side--product">
                <a className={`bt-side__ov${home ? ' is-active' : ''}${row.waiting > 0 ? ' has-waiting' : ''}`} href={routeHash({ view: 'product', id: project.id })}
                  aria-label={row.waiting > 0 ? t('ui.product.overviewWaiting', project.name) : t('ui.product.overviewOf', project.name)} title={t('ui.nav.overview')} aria-current={home ? 'page' : undefined}><Icon name="grid" /></a>
                <a className="bt-side__name" href={row.nameHref}>{project.name}</a>
                {project.folder_missing && <span className="bt-meta ui-side-missing">{t('ui.product.folderMissing')}</span>}
                <CountBadge n={row.waiting} label={t('ui.count.waiting', row.waiting)} />
              </div>
              {row.sessions.map(c => <SessionRow key={c.id} conversation={c} route={route} running={running} pending={sessionPending} />)}
              {row.more > 0 && (
                <button type="button" className="bt-side bt-side--session ui-side-more" onClick={() => expand(project.id)}>
                  <span className="bt-side__name bt-meta">{t('ui.product.more', row.more)}</span>
                </button>
              )}
              <a className={`bt-side bt-side--session ui-side-new${fresh ? ' is-active' : ''}`} href={routeHash({ view: 'productNew', id: project.id })} aria-current={fresh ? 'page' : undefined}>
                <Icon name="plus" /><span className="bt-side__name">{t('ui.session.new')}</span>
              </a>
            </Fragment>
          );
        })}
        <SideLink href={routeHash({ view: 'newProduct' })} icon="plus" name={t('ui.product.new')} active={at('newProduct')} />

        <div className="ui-sidebar__labelrow">
          <span className="bt-label bt-sidebar__label">{t('ui.section.noProduct')}</span>
          {!searching && <button ref={searchButton} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.search.open')} onClick={() => setSearching(true)}><Icon name="search" /></button>}
        </div>
        {searching && <SessionSearch onClose={() => { refocus.current = true; setSearching(false); }} />}
        {nav.none.map(c => <SessionRow key={c.id} conversation={c} route={route} running={running} pending={sessionPending} />)}
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
