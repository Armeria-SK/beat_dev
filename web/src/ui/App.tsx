import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Approval, type Conversation as ConversationRow, type Profile, type Project, type WorkerStatus } from '../api.ts';
import { useRunEvents, type Draft, type RunEvent } from '../events.ts';
import { toast } from '../feedback.ts';
import { loadServerSettings, useT } from '../i18n/index.ts';
import { agentState, countTasks, footLine, kanbanCount, type Waiting } from './agent-state.ts';
import { Conversation } from './Conversation.tsx';
import { EMPTY, reduce, type Action, type Effect, type LiveState, type RunNotice } from './live-state.ts';
import { NarrowBar, TabBar } from './NarrowBar.tsx';
import { Onboarding } from './Onboarding.tsx';
import { Panes, usePanes } from './Panes.tsx';
import { runningIn } from './plan.ts';
import { markSetupShown, wasSetupShown, type OnboardingState } from '../onboarding.ts';
import { ONBOARD_DONE_HASH, opensOnLoad, resumeIndex, setupPending } from './onboarding-steps.ts';
import { pickFocus } from './focus.ts';
import { productOf, throttled } from './products.ts';
import { awaitingProduct, projectLoads, settleLeave } from './product-nav.ts';
import { HOME, isConversation, parseRoute, routeBehind, routeHash, routeProductId, settingsCloser, type Route } from './routes.ts';
import { Archived } from './screens/Archived.tsx';
import { Kanban } from './screens/Kanban.tsx';
import { Memory } from './screens/Memory.tsx';
import { NewProduct } from './screens/NewProduct.tsx';
import { Notifications } from './screens/Notifications.tsx';
import { ProductSettings } from './screens/ProductSettings.tsx';
import { Overview } from './screens/Overview.tsx';
import { ProductHome } from './screens/ProductHome.tsx';
import { Runs } from './screens/Runs.tsx';
import { Schedule } from './screens/Schedule.tsx';
import { Skills } from './screens/Skills.tsx';
import { TaskScreen } from './screens/Task.tsx';
import { Settings } from './settings/Settings.tsx';
import { Sidebar } from './Sidebar.tsx';
import { notificationToast } from './toast-list.ts';
import { Toasts } from './toasts.tsx';
import { Button } from './parts.tsx';
import { clearUnsaved, hasUnsavedEdits, leaveAsks, SCREEN_EDITS, unloadGuard } from './unsaved.ts';

const NARROW = '(max-width: 760px)';
const NO_APPROVALS: Approval[] = [];
const NO_NOTICES: RunNotice[] = [];
const DISCONNECT_GRACE_MS = 3000;
const PRODUCT_COUNTS_MS = 2000;

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

function viewTitle(t: T, route: Route, conversation: ConversationRow | undefined, product: Project | undefined): string {
  switch (route.view) {
    case 'product': return product?.name ?? t('ui.nav.overview');
    case 'productSettings': return t('ui.product.settings');
    case 'newProduct': return t('ui.product.new');
    case 'productNew':
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
  const [profile, setProfile] = useState<Profile | null>(null);
  const [onboard, setOnboard] = useState<'first' | 'replay' | null>(null);
  const [setup, setSetup] = useState<OnboardingState | null>(null);
  const [leave, setLeave] = useState<string | null>(null);
  const onboardRef = useRef(onboard);
  onboardRef.current = onboard;

  const behind = routeBehind(route, behindRef.current);
  if (route.view !== 'settings') behindRef.current = route;

  const runRef = useRef<(effects: Effect[]) => void>(() => undefined);
  const dispatch = useCallback((action: Action) => {
    const next = reduce(liveRef.current, action);
    liveRef.current = next.state;
    setLive(next.state);
    runRef.current(next.effects);
  }, []);

  const projectList = useMemo(() => projectLoads(() => api.projects(), projects => dispatch({ type: 'projects', projects })), [dispatch]);
  const upsertProject = useCallback((project: Project) => {
    projectList.supersede();
    dispatch({ type: 'project', project });
  }, [projectList, dispatch]);
  const load = useMemo(() => ({
    projects: () => { void projectList.load(); },
    projectCounts: throttled(() => { void projectList.load(); }, PRODUCT_COUNTS_MS),
    conversations: () => { void api.conversations().then(r => dispatch({ type: 'conversations', conversations: r.conversations, more: r.more })).catch(() => undefined); },
    approvals: () => { void api.approvals().then(r => dispatch({ type: 'approvals', approvals: r.approvals })).catch(() => undefined); },
    tasks: () => { void api.tasks().then(r => dispatch({ type: 'tasks', tasks: [...r.active, ...r.finished] })).catch(() => undefined); },
    drafts: () => { void api.review().then(r => dispatch({ type: 'skillDrafts', count: r.skillDrafts.length })).catch(() => undefined); },
    unread: () => { void api.notifications().then(r => dispatch({ type: 'unread', count: r.unread })).catch(() => undefined); },
    worker: () => { void api.worker().then(setWorker).catch(() => undefined); },
    profile: () => { void api.profile().then(setProfile).catch(() => undefined); },
  }), [dispatch, projectList]);

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
    addEventListener('beforeunload', unloadGuard);
    return () => removeEventListener('beforeunload', unloadGuard);
  }, []);
  const discardEdits = useCallback(() => {
    const to = leave;
    clearUnsaved(SCREEN_EDITS);
    setLeave(null);
    if (to !== null) location.hash = to;
  }, [leave]);

  useEffect(() => {
    const onPop = () => closer.reset();
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [closer]);

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      const held = behindRef.current;
      if (held && leaveAsks(hasUnsavedEdits(SCREEN_EDITS), held, next)) {
        setLeave(routeHash(next));
        location.replace(routeHash(held));
        return;
      }
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

  useEffect(() => { for (const what of ['conversations', 'approvals', 'tasks', 'drafts', 'unread', 'worker', 'profile', 'projects'] as const) load[what](); }, [load]);
  useEffect(() => {
    settleLeave(route, live.projectsLoaded ? live.projects.map(p => p.id) : null, { clearEdits: () => { clearUnsaved(SCREEN_EDITS); setLeave(null); }, replace: hash => location.replace(hash) });
  }, [route, live.projects, live.projectsLoaded]);
  const loadSetup = useCallback(() => api.onboarding().then(state => { setSetup(state); return state; }), []);
  useEffect(() => { void loadSetup().then(state => { if (opensOnLoad(state.done, wasSetupShown())) setOnboard(old => old ?? 'first'); }).catch(() => undefined); }, [loadSetup]);
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
  const setDrafts = useCallback((count: number) => dispatch({ type: 'skillDrafts', count }), [dispatch]);

  const closeOnboard = useCallback(() => {
    markSetupShown();
    setOnboard(null);
    void loadSetup().catch(() => undefined);
    focusFirst(document.querySelector('[data-settings-button]'), menuButton.current);
  }, [loadSetup]);
  const resumeSetup = useCallback(() => { setDrawer(false); setOnboard('first'); }, []);
  const replay = useCallback(() => {
    setOnboard('replay');
    closeSettings();
  }, [closeSettings]);
  const finishOnboard = useCallback(() => {
    setOnboard(null);
    load.profile();
    void loadSetup().catch(() => undefined);
    location.hash = ONBOARD_DONE_HASH;
  }, [load, loadSetup]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (onboard) { e.preventDefault(); closeOnboard(); return; }
      if (settingsOpen) { e.preventDefault(); closeSettings(); return; }
      if (drawer) { e.preventDefault(); closeDrawer(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onboard, closeOnboard, settingsOpen, drawer, closeSettings, closeDrawer]);

  useEffect(() => {
    if (drawer) focusFirst(document.querySelector('.bt-sidebar .bt-wordmark'));
  }, [drawer]);

  const chatId = behind.view === 'chat' ? behind.id : null;
  const conversation = chatId ? conversations.find(c => c.id === chatId) : undefined;
  const routeProduct = productOf(live.projects, routeProductId(behind));
  const title = viewTitle(t, behind, conversation, routeProduct);
  const kanban = kanbanCount(waiting);
  const convo = isConversation(behind) || behind.view === 'productNew';
  const convoProduct = behind.view === 'productNew' ? routeProduct : productOf(live.projects, conversation?.project_id);
  const isStreaming = behind.view === 'chat' && streaming.has(behind.id);
  const covered = drawer || settingsOpen || onboard !== null;
  const shut = settingsOpen || onboard !== null;
  const paneProduct = convo ? convoProduct?.id ?? null : null;
  const panes = usePanes(paneProduct);
  const paneCount = convo ? panes.shown.length : 0;
  const paneToggle = paneProduct ? { open: paneCount > 0, onToggle: panes.toggle } : undefined;

  return (
    <div className={`ui-frame${drawer ? ' is-drawer-open' : ''}`}>
      <NarrowBar title={title} unread={unread} expanded={drawer} covered={covered} menuRef={menuButton} onMenu={() => setDrawer(true)} panes={paneToggle} />
      <div className={convo ? `bt-app${paneCount ? ' has-panes' : ''}` : 'bt-shell'} data-panes={convo ? String(paneCount) : undefined} inert={shut}
        style={paneCount && !panes.narrow ? { '--ui-panes-w': `${panes.width}px` } as CSSProperties : undefined}>
        <Sidebar state={state} route={behind} foot={foot} kanban={kanban} drafts={skillDrafts} unread={unread} conversations={conversations} conversationsMore={live.conversationsMore} projects={live.projects} running={running} color={profile?.color} setupPending={setupPending(setup?.done ?? null, onboard !== null)} onSetup={resumeSetup} />
        {convo && awaitingProduct(behind, routeProduct) ? (
          <main className="bt-app__main" inert={drawer} />
        ) : convo ? (
          <main className={`bt-app__main${isStreaming ? ' is-streaming' : ''}`} inert={drawer}>
            <Conversation
              key={chatId ?? (behind.view === 'productNew' ? `new:${behind.id}` : 'new')} id={chatId} listTitle={conversation?.title ?? null} aiName={profile?.name} product={convoProduct}
              draft={chatId ? drafts.find(d => d.conversationId === chatId) : undefined}
              approvals={chatId ? live.approvals.filter(a => a.conversationId === chatId) : NO_APPROVALS}
              notices={(chatId && live.notices.get(chatId)) || NO_NOTICES}
              liveChecklist={chatId ? checklists.get(chatId) : undefined}
              revision={(chatId ? live.revisions.get(chatId) ?? 0 : 0) + live.epoch}
              disconnected={disconnected} onReconnect={reconnect}
              onClearNotices={clearNotices} onInterrupt={interrupt} panes={paneToggle}
            />
          </main>
        ) : (
          <main className="bt-screen" inert={drawer}>
            {behind.view === 'kanban' ? (
              <Kanban conversations={conversations} drafts={drafts} checklists={checklists} revision={live.taskRevision + live.epoch} projects={live.projects} />
            ) : behind.view === 'task' ? (
              <TaskScreen key={behind.id} id={behind.id} revision={`${live.taskRevision}:${live.epoch}:${live.approvals.length}`} worker={worker} projects={live.projects} />
            ) : behind.view === 'overview' ? (
              <Overview waiting={waiting} approvals={live.approvals} conversations={conversations} drafts={drafts} checklists={checklists} worker={worker} onWorker={setWorker} revision={live.taskRevision + live.epoch} projects={live.projects} projectsLoaded={live.projectsLoaded} />
            ) : behind.view === 'product' ? (
              <ProductHome key={behind.id} id={behind.id} project={productOf(live.projects, behind.id)} approvals={live.approvals} conversations={conversations} drafts={drafts} checklists={checklists} worker={worker} revision={live.taskRevision + live.epoch} />
            ) : behind.view === 'schedule' ? (
              <Schedule revision={live.taskRevision + live.epoch} projects={live.projects} />
            ) : behind.view === 'notifications' ? (
              <Notifications unread={unread} epoch={live.epoch} onUnread={setUnread} projects={live.projects} />
            ) : behind.view === 'memory' ? (
              <Memory revision={live.libraryRevision + live.epoch} />
            ) : behind.view === 'skills' ? (
              <Skills target={behind.target} revision={`${live.libraryRevision}:${live.epoch}:${skillDrafts}`} running={working} onDrafts={setDrafts} />
            ) : behind.view === 'runs' ? (
              <Runs tab={behind.tab} revision={live.libraryRevision + live.epoch + live.taskRevision} conversations={conversations} projects={live.projects} />
            ) : behind.view === 'archived' ? (
              <Archived revision={live.libraryRevision + live.epoch} projects={live.projects} />
            ) : behind.view === 'newProduct' ? (
              <NewProduct onProject={upsertProject} />
            ) : behind.view === 'productSettings' ? (
              routeProduct ? <ProductSettings key={routeProduct.id} project={routeProduct} onProject={upsertProject} /> : <div className="bt-screen__inner" />
            ) : (
              <div className="bt-screen__inner">
                <header className="bt-screen__head"><h1 className="bt-screen__title">{title}</h1></header>
                <p className="bt-meta">{t('ui.later')}</p>
              </div>
            )}
          </main>
        )}
        {paneProduct && paneCount > 0 && (
          <Panes panes={panes} productId={paneProduct} scope={chatId ?? 'new'} inert={drawer}
            revision={`${live.planRevisions.get(paneProduct) ?? 0}:${live.epoch}:${runningIn(drafts, conversations, paneProduct)}`} />
        )}
      </div>
      {drawer && <div className="ui-navveil" onClick={closeDrawer} inert={shut} />}
      <TabBar route={behind} kanban={kanban} covered={covered} />
      {settingsOpen && onboard === null && (
        <Settings section={route.view === 'settings' ? route.section : undefined} onClose={closeSettings} onReplay={replay} onSaved={load.worker} onProfile={load.profile} />
      )}
      {onboard !== null && <Onboarding profile={profile} replay={onboard === 'replay'} start={onboard === 'first' && setup ? resumeIndex(setup.steps) : 0} onProfile={load.profile} onDone={finishOnboard} onSkip={closeOnboard} />}
      {leave !== null && (
        <div className="ui-confirm ui-leave" role="alertdialog" aria-label={t('ui.set.leave.title')}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setLeave(null); } }}>
          <span className="bt-label bt-del">{t('ui.set.leave.title')}</span>
          <span className="ui-confirm__buttons">
            <Button variant="danger" small onClick={discardEdits}>{t('ui.set.leave.discard')}</Button>
            <Button variant="ghost" small autoFocus onClick={() => setLeave(null)}>{t('ui.set.leave.keep')}</Button>
          </span>
        </div>
      )}
      <Toasts />
    </div>
  );
}
