import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Approval, type Conversation as ConversationRow, type WorkerStatus } from '../api.ts';
import { useRunEvents, type Draft, type RunEvent } from '../events.ts';
import { toast } from '../feedback.ts';
import { loadServerSettings, useT } from '../i18n/index.ts';
import { agentState, countTasks, footLine, kanbanCount, type Waiting } from './agent-state.ts';
import { Conversation } from './Conversation.tsx';
import { EMPTY, reduce, type Action, type Effect, type LiveState, type RunNotice } from './live-state.ts';
import { NarrowBar, TabBar } from './NarrowBar.tsx';
import { Icon } from './parts.tsx';
import { pickFocus } from './focus.ts';
import { HOME, isConversation, parseRoute, routeBehind, routeHash, settingsCloser, type Route } from './routes.ts';
import { Kanban } from './screens/Kanban.tsx';
import { Notifications } from './screens/Notifications.tsx';
import { Overview } from './screens/Overview.tsx';
import { Schedule } from './screens/Schedule.tsx';
import { TaskScreen } from './screens/Task.tsx';
import { Sidebar } from './Sidebar.tsx';
import { notificationToast } from './toast-list.ts';
import { Toasts } from './toasts.tsx';

const NARROW = '(max-width: 760px)';
const NO_APPROVALS: Approval[] = [];
const NO_NOTICES: RunNotice[] = [];
const DISCONNECT_GRACE_MS = 3000;

function useDisconnected(connected: boolean): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (connected) { setShown(false); return undefined; }
    const timer = setTimeout(() => setShown(true), DISCONNECT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  return shown;
}

type T = ReturnType<typeof useT>;

function viewTitle(t: T, route: Route, conversation: ConversationRow | undefined): string {
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

function focusFirst(...candidates: Array<Element | null>): void {
  requestAnimationFrame(() => {
    const elements = candidates.filter((el): el is HTMLElement => el instanceof HTMLElement);
    pickFocus(elements, document.body, el => getComputedStyle(el).visibility === 'hidden')?.focus();
  });
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
  const [live, setLive] = useState<LiveState>(EMPTY);
  const liveRef = useRef(live);
  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const settingsOpener = useRef<Element | null>(null);

  const behind = routeBehind(route, behindRef.current);
  if (route.view !== 'settings') behindRef.current = route;

  const runRef = useRef<(effects: Effect[]) => void>(() => undefined);
  const dispatch = useCallback((action: Action) => {
    const next = reduce(liveRef.current, action);
    liveRef.current = next.state;
    setLive(next.state);
    runRef.current(next.effects);
  }, []);

  const load = useMemo(() => ({
    conversations: () => { void api.conversations().then(r => dispatch({ type: 'conversations', conversations: r.conversations })).catch(() => undefined); },
    approvals: () => { void api.approvals().then(r => dispatch({ type: 'approvals', approvals: r.approvals })).catch(() => undefined); },
    tasks: () => { void api.tasks().then(r => dispatch({ type: 'tasks', tasks: [...r.active, ...r.finished] })).catch(() => undefined); },
    drafts: () => { void api.review().then(r => dispatch({ type: 'skillDrafts', count: r.skillDrafts.length })).catch(() => undefined); },
    unread: () => { void api.notifications().then(r => dispatch({ type: 'unread', count: r.unread })).catch(() => undefined); },
    worker: () => { void api.worker().then(setWorker).catch(() => undefined); },
  }), [dispatch]);

  runRef.current = (effects: Effect[]) => {
    const granted = 'Notification' in window && Notification.permission === 'granted';
    for (const effect of effects) {
      if (effect.kind === 'refresh') load[effect.what]();
      else if (effect.kind === 'checklist') {
        const id = effect.conversationId;
        void api.checklist(id).then(r => dispatch({ type: 'checklist', conversationId: id, items: r.items })).catch(() => undefined);
      } else if (effect.kind === 'gone') {
        const now = parseRoute(location.hash);
        if (now.view === 'chat' && now.id === effect.conversationId) location.replace('#/');
      } else if (effect.kind === 'toast') {
        toast(notificationToast(effect.notification));
      } else if (effect.kind === 'notifyApproval') {
        if (granted) new Notification(t('browser.approvalNeeded'), { body: effect.title });
      } else if (granted) new Notification(t('browser.notification', effect.title), { body: effect.body });
    }
  };

  const hashGeneration = useRef(0);
  const closer = useMemo(() => settingsCloser({
    hasBehind: () => behindRef.current !== null,
    behindHash: () => routeHash(behindRef.current ?? HOME),
    back: () => history.back(),
    replace: hash => location.replace(hash),
    currentHash: () => location.hash,
    generation: () => hashGeneration.current,
    later: (run, ms) => { setTimeout(run, ms); },
  }), []);
  const viewRef = useRef(route.view);
  viewRef.current = route.view;

  useEffect(() => {
    const onPop = () => closer.reset();
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [closer]);

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      hashGeneration.current += 1;
      closer.reset();
      if (next.view === 'settings' && viewRef.current !== 'settings') settingsOpener.current = document.activeElement;
      setRoute(next);
      if (drawerRef.current) {
        setDrawer(false);
        if (next.view !== 'settings') focusFirst(menuButton.current);
      }
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [closer]);

  useEffect(() => {
    const query = matchMedia(NARROW);
    const onChange = () => { if (!query.matches) setDrawer(false); };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { for (const what of ['conversations', 'approvals', 'tasks', 'drafts', 'unread', 'worker'] as const) load[what](); }, [load]);
  useEffect(() => { const timer = setInterval(load.worker, 30_000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { void loadServerSettings(api.settings); }, []);

  const onEvent = useCallback((event: RunEvent) => dispatch({ type: 'event', event, hidden: document.hidden, now: Date.now() }), [dispatch]);
  const onResync = useCallback((drafts: Draft[]) => dispatch({ type: 'resync', drafts }), [dispatch]);
  const { connected, reconnect } = useRunEvents(onEvent, onResync);
  const disconnected = useDisconnected(connected);

  const { conversations, drafts, checklists, streaming, skillDrafts, unread } = live;
  const waiting: Waiting = useMemo(
    () => ({ approvals: live.approvals.length, drafts: skillDrafts, ...countTasks([...live.tasks.values()].map(m => m.status)) }),
    [live.approvals, skillDrafts, live.tasks],
  );
  const working = drafts.length > 0 || (worker?.runningAll.length ?? 0) > 0;
  const state = agentState(waiting, working);
  const running = useMemo(() => new Set(drafts.map(d => d.conversationId)), [drafts]);
  const runningTitle = worker?.running?.title ?? conversations.find(c => running.has(c.id))?.title ?? null;
  const foot = footLine(waiting, working, drafts.map(d => checklists.get(d.conversationId) ?? []), runningTitle);

  useEffect(() => {
    if ((waiting.approvals || waiting.answers) && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, [waiting.approvals, waiting.answers]);

  const settingsOpen = route.view === 'settings';
  const wasSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    const closed = wasSettingsOpen.current && !settingsOpen;
    wasSettingsOpen.current = settingsOpen;
    if (!closed) return;
    const opener = settingsOpener.current;
    settingsOpener.current = null;
    focusFirst(opener, document.querySelector('[data-settings-button]'), menuButton.current);
  }, [settingsOpen]);

  const closeSettings = closer.fire;
  const clearNotices = useCallback((id: string) => dispatch({ type: 'clearNotices', conversationId: id }), [dispatch]);
  const interrupt = useCallback((id: string, on: boolean) => dispatch({ type: 'interrupt', conversationId: id, on }), [dispatch]);
  const closeDrawer = useCallback(() => { setDrawer(false); focusFirst(menuButton.current); }, []);
  const setUnread = useCallback((count: number) => dispatch({ type: 'unread', count }), [dispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (settingsOpen) { e.preventDefault(); closeSettings(); return; }
      if (drawer) { e.preventDefault(); closeDrawer(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [settingsOpen, drawer, closeSettings, closeDrawer]);

  useEffect(() => {
    if (drawer) focusFirst(document.querySelector('.bt-sidebar .bt-wordmark'));
  }, [drawer]);

  const chatId = behind.view === 'chat' ? behind.id : null;
  const conversation = chatId ? conversations.find(c => c.id === chatId) : undefined;
  const title = viewTitle(t, behind, conversation);
  const kanban = kanbanCount(waiting);
  const convo = isConversation(behind);
  const isStreaming = behind.view === 'chat' && streaming.has(behind.id);
  const covered = drawer || settingsOpen;

  return (
    <div className={`ui-frame${drawer ? ' is-drawer-open' : ''}`}>
      <NarrowBar title={title} unread={unread} expanded={drawer} covered={covered} menuRef={menuButton} onMenu={() => setDrawer(true)} />
      <div className={convo ? 'bt-app' : 'bt-shell'} data-panes={convo ? '0' : undefined} inert={settingsOpen}>
        <Sidebar state={state} route={behind} foot={foot} kanban={kanban} drafts={skillDrafts} unread={unread} conversations={conversations} running={running} />
        {convo ? (
          <main className={`bt-app__main${isStreaming ? ' is-streaming' : ''}`} inert={drawer}>
            <Conversation
              key={chatId ?? 'new'} id={chatId} listTitle={conversation?.title ?? null}
              draft={chatId ? drafts.find(d => d.conversationId === chatId) : undefined}
              approvals={chatId ? live.approvals.filter(a => a.conversationId === chatId) : NO_APPROVALS}
              notices={(chatId && live.notices.get(chatId)) || NO_NOTICES}
              liveChecklist={chatId ? checklists.get(chatId) : undefined}
              revision={(chatId ? live.revisions.get(chatId) ?? 0 : 0) + live.epoch}
              disconnected={disconnected} onReconnect={reconnect}
              onClearNotices={clearNotices} onInterrupt={interrupt}
            />
          </main>
        ) : (
          <main className="bt-screen" inert={drawer}>
            {behind.view === 'kanban' ? (
              <Kanban conversations={conversations} drafts={drafts} checklists={checklists} revision={live.taskRevision + live.epoch} />
            ) : behind.view === 'task' ? (
              <TaskScreen key={behind.id} id={behind.id} revision={`${live.taskRevision}:${live.epoch}:${live.approvals.length}`} worker={worker} />
            ) : behind.view === 'overview' ? (
              <Overview waiting={waiting} approvals={live.approvals} conversations={conversations} drafts={drafts} checklists={checklists} worker={worker} onWorker={setWorker} revision={live.taskRevision + live.epoch} />
            ) : behind.view === 'schedule' ? (
              <Schedule revision={live.taskRevision + live.epoch} />
            ) : behind.view === 'notifications' ? (
              <Notifications unread={unread} epoch={live.epoch} onUnread={setUnread} />
            ) : (
              <div className="bt-screen__inner">
                <header className="bt-screen__head"><h1 className="bt-screen__title">{title}</h1></header>
                <p className="bt-meta">{t('ui.later')}</p>
              </div>
            )}
          </main>
        )}
      </div>
      {drawer && <div className="ui-navveil" onClick={closeDrawer} inert={settingsOpen} />}
      <TabBar route={behind} kanban={kanban} covered={covered} />
      {settingsOpen && <SettingsShell onClose={closeSettings} />}
      <Toasts />
    </div>
  );
}
