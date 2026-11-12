import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ChecklistItem, type Conversation, type TaskStatus, type WorkerStatus } from '../api.ts';
import { useRunEvents, type Draft, type RunEvent } from '../events.ts';
import { useT } from '../i18n/index.ts';
import { agentState, countTasks, footLine, kanbanCount, type Waiting } from './agent-state.ts';
import { NarrowBar, TabBar } from './NarrowBar.tsx';
import { Icon } from './parts.tsx';
import { HOME, isConversation, parseRoute, routeBehind, routeHash, type Route } from './routes.ts';
import { Sidebar } from './Sidebar.tsx';

const BROWSER_NOTIFY = new Set(['approval_needed', 'task_waiting']);
const NARROW = '(max-width: 760px)';

type T = ReturnType<typeof useT>;

function viewTitle(t: T, route: Route, conversation: Conversation | undefined): string {
  switch (route.view) {
    case 'new': return t('ui.session.new');
    case 'chat': return conversation?.title || t('ui.session.untitled');
    case 'overview': return t('ui.nav.overview');
    case 'kanban': return t('ui.nav.kanban');
    case 'schedule': return t('ui.nav.schedule');
    case 'notifications': return t('ui.nav.notifications');
    case 'memory': return t('ui.nav.memory');
    case 'skills': return t('ui.nav.skills');
    case 'runs': return t('ui.nav.runs');
    case 'archived': return t('ui.nav.archived');
    case 'task': return t('ui.nav.task');
    case 'settings': return t('ui.nav.settings');
  }
}

function readRoute(): Route {
  const route = parseRoute(location.hash);
  const canonical = routeHash(route);
  if (location.hash !== canonical && !(canonical === '#/' && (location.hash === '' || location.hash === '#'))) {
    history.replaceState(history.state, '', canonical);
  }
  return route;
}

function SettingsShell({ onClose }: { onClose: () => void }) {
  const t = useT();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, []);
  return (
    <div className="ui-overlay">
      <div className="bt-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <section className="bt-modal" role="dialog" aria-modal="true" aria-labelledby="ui-settings-title">
          <header className="bt-modal__bar">
            <h2 className="bt-modal__title" id="ui-settings-title">{t('ui.nav.settings')}</h2>
            <button ref={close} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.close')} onClick={onClose}><Icon name="x" /></button>
          </header>
          <div className="bt-modal__main"><p className="bt-meta">{t('ui.later')}</p></div>
        </section>
      </div>
    </div>
  );
}

export function App() {
  const t = useT();
  const [route, setRoute] = useState<Route>(readRoute);
  const behindRef = useRef<Route | null>(route.view === 'settings' ? null : route);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [approvals, setApprovals] = useState(0);
  const [tasks, setTasks] = useState<ReadonlyMap<string, TaskStatus>>(new Map());
  const [skillDrafts, setSkillDrafts] = useState(0);
  const [unread, setUnread] = useState(0);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [streaming, setStreaming] = useState<ReadonlySet<string>>(new Set());
  const [checklists, setChecklists] = useState<ReadonlyMap<string, ChecklistItem[]>>(new Map());
  const [drawer, setDrawer] = useState(false);
  const menuButton = useRef<HTMLElement | null>(null);

  const behind = routeBehind(route, behindRef.current);
  if (route.view !== 'settings') behindRef.current = route;

  useEffect(() => {
    const onHash = () => { setRoute(readRoute()); setDrawer(false); };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const query = matchMedia(NARROW);
    const onChange = () => { if (!query.matches) setDrawer(false); };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const refreshConversations = useCallback(() => { void api.conversations().then(r => setConversations(r.conversations)).catch(() => undefined); }, []);
  const refreshApprovals = useCallback(() => { void api.approvals().then(r => setApprovals(r.approvals.length)).catch(() => undefined); }, []);
  const refreshTasks = useCallback(() => { void api.tasks().then(r => setTasks(new Map(r.active.map(x => [x.id, x.status])))).catch(() => undefined); }, []);
  const refreshDrafts = useCallback(() => { void api.review().then(r => setSkillDrafts(r.skillDrafts.length)).catch(() => undefined); }, []);
  const refreshUnread = useCallback(() => { void api.notifications().then(r => setUnread(r.unread)).catch(() => undefined); }, []);
  const refreshWorker = useCallback(() => { void api.worker().then(setWorker).catch(() => undefined); }, []);
  const refreshChecklist = useCallback((id: string) => {
    void api.checklist(id).then(r => setChecklists(m => new Map(m).set(id, r.items))).catch(() => undefined);
  }, []);
  const refreshAll = useCallback(() => {
    refreshConversations(); refreshApprovals(); refreshTasks(); refreshDrafts(); refreshUnread(); refreshWorker();
  }, [refreshConversations, refreshApprovals, refreshTasks, refreshDrafts, refreshUnread, refreshWorker]);

  useEffect(() => { refreshAll(); }, [refreshAll]);
  useEffect(() => { const timer = setInterval(refreshWorker, 30_000); return () => clearInterval(timer); }, [refreshWorker]);

  const known = useRef(new Set<string>());
  known.current = new Set(conversations.map(c => c.id));

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.type) {
      case 'run.start':
        setDrafts(ds => [...ds.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '' }]);
        if (!known.current.has(e.conversationId)) refreshConversations();
        refreshChecklist(e.conversationId);
        refreshWorker();
        break;
      case 'text.delta':
        setStreaming(s => (s.has(e.conversationId) ? s : new Set(s).add(e.conversationId)));
        break;
      case 'run.end':
        setDrafts(ds => ds.filter(d => d.runId !== e.runId));
        setStreaming(s => { if (!s.has(e.conversationId)) return s; const next = new Set(s); next.delete(e.conversationId); return next; });
        refreshConversations(); refreshWorker(); refreshDrafts(); refreshApprovals();
        break;
      case 'approval.requested':
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(t('browser.approvalNeeded'), { body: e.approval.title });
        refreshApprovals();
        break;
      case 'approval.resolved':
        refreshApprovals();
        break;
      case 'checklist.updated':
        setChecklists(m => new Map(m).set(e.conversationId, e.items));
        break;
      case 'conversation.changed':
        refreshConversations();
        break;
      case 'task.changed':
        setTasks(m => new Map(m).set(e.task.id, e.task.status));
        refreshWorker();
        break;
      case 'notification':
        setUnread(n => n + 1);
        refreshDrafts();
        if (BROWSER_NOTIFY.has(e.notification.kind) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(t('browser.notification', e.notification.title), { body: e.notification.body ?? '' });
        }
        break;
      case 'notification.read':
        setUnread(e.unread);
        break;
      default:
        break;
    }
  }, [t, refreshConversations, refreshChecklist, refreshWorker, refreshDrafts, refreshApprovals]);

  const onResync = useCallback((serverDrafts: Draft[]) => {
    setDrafts(serverDrafts);
    setStreaming(new Set(serverDrafts.filter(d => d.text).map(d => d.conversationId)));
    for (const d of serverDrafts) refreshChecklist(d.conversationId);
    refreshAll();
  }, [refreshAll, refreshChecklist]);

  useRunEvents(onEvent, onResync);

  const waiting: Waiting = useMemo(() => ({ approvals, drafts: skillDrafts, ...countTasks(tasks.values()) }), [approvals, skillDrafts, tasks]);
  const working = drafts.length > 0 || (worker?.runningAll.length ?? 0) > 0;
  const state = agentState(waiting, working);
  const running = useMemo(() => new Set(drafts.map(d => d.conversationId)), [drafts]);
  const runningTitle = worker?.running?.title ?? conversations.find(c => running.has(c.id))?.title ?? null;
  const foot = footLine(waiting, working, drafts.map(d => checklists.get(d.conversationId) ?? []), runningTitle);

  useEffect(() => {
    if ((waiting.approvals || waiting.answers) && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, [waiting.approvals, waiting.answers]);

  const closeSettings = useCallback(() => {
    location.hash = routeHash(behindRef.current ?? HOME);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-settings-button]')?.focus());
  }, []);
  const closeDrawer = useCallback(() => { setDrawer(false); menuButton.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (route.view === 'settings') { e.preventDefault(); closeSettings(); return; }
      if (drawer) { e.preventDefault(); closeDrawer(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [route.view, drawer, closeSettings, closeDrawer]);

  useEffect(() => {
    if (drawer) document.querySelector<HTMLElement>('.bt-sidebar .bt-wordmark')?.focus();
  }, [drawer]);

  const conversation = behind.view === 'chat' ? conversations.find(c => c.id === behind.id) : undefined;
  const title = viewTitle(t, behind, conversation);
  const kanban = kanbanCount(waiting);
  const convo = isConversation(behind);
  const isStreaming = behind.view === 'chat' && streaming.has(behind.id);

  return (
    <div className={`ui-frame${drawer ? ' is-drawer-open' : ''}`}>
      <NarrowBar title={title} unread={unread} onMenu={e => { menuButton.current = e; setDrawer(true); }} />
      <div className={convo ? 'bt-app' : 'bt-shell'} data-panes={convo ? '0' : undefined}>
        <Sidebar state={state} route={behind} foot={foot} kanban={kanban} drafts={skillDrafts} unread={unread} conversations={conversations} running={running} />
        {convo ? (
          <main className={`bt-app__main${isStreaming ? ' is-streaming' : ''}`}>
            <header className="bt-app__bar"><span className="bt-app__bar-title">{title}</span></header>
            <div className="bt-thread" />
          </main>
        ) : (
          <main className="bt-screen">
            <div className="bt-screen__inner">
              <header className="bt-screen__head"><h1 className={`bt-screen__title${behind.view === 'overview' ? ' bt-screen__title--lg' : ''}`}>{title}</h1></header>
              <p className="bt-meta">{t('ui.later')}</p>
            </div>
          </main>
        )}
      </div>
      {drawer && <div className="ui-navveil" onClick={closeDrawer} />}
      <TabBar route={behind} kanban={kanban} />
      {route.view === 'settings' && <SettingsShell onClose={closeSettings} />}
    </div>
  );
}
