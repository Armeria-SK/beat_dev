import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Conversation as ConversationRow, type Profile, type Project, type WorkerStatus } from '../api.ts';
import { useRunEvents, type Draft, type RunEvent } from '../events.ts';
import { toast } from '../feedback.ts';
import { loadServerSettings, useT } from '../i18n/index.ts';
import { agentState, countChecks, countTasks, footLine, kanbanCount, type Waiting } from './agent-state.ts';
import { composerDrafts } from './composer-state.ts';
import { Conversation } from './Conversation.tsx';
import { EMPTY, reduce, type Action, type Effect, type LiveState, type RunNotice } from './live-state.ts';
import { NarrowBar, TabBar } from './NarrowBar.tsx';
import { Onboarding } from './Onboarding.tsx';
import { Panes, usePanes } from './Panes.tsx';
import { paneTarget, pendingFor, pendingRouteReady, pendingTotal, sessionCounts, taskCounts, withPendingCounts } from './pending.ts';
import type { PaneView } from './panes.ts';
import { questionsFor, taskQuestions, withQuestionCounts } from './questions.ts';
import { PLAN_EDITS, planStays, runningIn } from './plan.ts';
import { markSetupShown, wasSetupShown, type OnboardingState } from '../onboarding.ts';
import { ONBOARD_DONE_HASH, opensOnLoad, resumeIndex, setupLoads, setupPending } from './onboarding-steps.ts';
import { pickFocus, underHead } from './focus.ts';
import { productOf, throttled } from './products.ts';
import { awaitingProduct, productsMissing, projectLoads, settleLeave } from './product-nav.ts';
import { HOME, isConversation, parseRoute, routeBehind, routeHash, routeProductId, settingsCloser, settingsDepth, type Route } from './routes.ts';
import { Archived } from './screens/Archived.tsx';
import { Kanban } from './screens/Kanban.tsx';
import { Memory } from './screens/Memory.tsx';
import { NewProduct } from './screens/NewProduct.tsx';
import { Notifications } from './screens/Notifications.tsx';
import { ProductSettings } from './screens/ProductSettings.tsx';
import { Overview } from './screens/Overview.tsx';
import { PendingScreen } from './screens/Pending.tsx';
import { QuestionsScreen } from './screens/Questions.tsx';
import { ProductHome } from './screens/ProductHome.tsx';
import { Runs } from './screens/Runs.tsx';
import { Schedule } from './screens/Schedule.tsx';
import { Skills } from './screens/Skills.tsx';
import { TaskScreen } from './screens/Task.tsx';
import { Settings } from './settings/Settings.tsx';
import { Sidebar } from './Sidebar.tsx';
import { notificationToast } from './toast-list.ts';
import { Toasts } from './toasts.tsx';
import { Button, Notice } from './parts.tsx';
import { clearUnsaved, followLeave, hasUnsavedEdits, historyIndex, holdLeave, leaveAsks, leaveMove, popIndex, SCREEN_EDITS, SETTINGS_EDITS, settingsHold, unloadGuard, type HeldLeave, type LeaveEnv } from './unsaved.ts';

const NARROW = '(max-width: 760px)';
const NO_NOTICES: RunNotice[] = [];
const DISCONNECT_GRACE_MS = 3000;
const PRODUCT_COUNTS_MS = 2000;
const PENDING_MS = 500;
const LEAVE_ENV: LeaveEnv = { go: by => history.go(by), replace: hash => location.replace(hash), push: hash => { location.hash = hash; } };

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
    case 'pending': return t('ui.nav.pending');
    case 'questions': return t('ui.nav.questions');
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
  const settingsStart = useRef<number | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [onboard, setOnboard] = useState<'first' | 'replay' | null>(null);
  const [setup, setSetup] = useState<OnboardingState | null>(null);
  const [leave, setLeave] = useState<HeldLeave | null>(null);
  const [settingsLeave, setSettingsLeave] = useState<HeldLeave | null>(null);
  const settingsHeld = useMemo(() => (settingsLeave ? () => { setSettingsLeave(null); followLeave(settingsLeave, historyIndex(), LEAVE_ENV); } : null), [settingsLeave]);
  const entryIndex = useRef(historyIndex());
  const entryHash = useRef(location.hash);

  const behind = routeBehind(route, behindRef.current);
  if (route.view !== 'settings') behindRef.current = route;

  const runRef = useRef<(effects: Effect[]) => void>(() => undefined);
  const dispatch = useCallback((action: Action) => {
    const next = reduce(liveRef.current, action);
    liveRef.current = next.state;
    setLive(next.state);
    runRef.current(next.effects);
  }, []);

  const [projectsFailing, setProjectsFailing] = useState(false);
  const projectList = useMemo(() => projectLoads(() => api.projects(), projects => dispatch({ type: 'projects', projects }), undefined, undefined, setProjectsFailing), [dispatch]);
  const upsertProject = useCallback((project: Project) => {
    projectList.supersede();
    dispatch({ type: 'project', project });
  }, [projectList, dispatch]);
  const load = useMemo(() => ({
    projects: () => { void projectList.load(); },
    projectCounts: throttled(() => { void projectList.load(); }, PRODUCT_COUNTS_MS),
    conversations: () => { void api.conversations().then(r => dispatch({ type: 'conversations', conversations: r.conversations, more: r.more })).catch(() => dispatch({ type: 'conversationsFailed' })); },
    pending: throttled(() => {
      void Promise.all([api.pendingCounts(), api.pending({ status: 'waiting' })]).then(([counts, list]) => dispatch({ type: 'pending', counts, waiting: list.items })).catch(() => undefined);
    }, PENDING_MS),
    questions: throttled(() => { void api.questionCounts().then(counts => dispatch({ type: 'questions', counts })).catch(() => undefined); }, PENDING_MS),
    tasks: () => { void api.tasks().then(r => dispatch({ type: 'tasks', tasks: [...r.active, ...r.finished, ...(r.awaiting ?? [])] })).catch(() => undefined); },
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
        composerDrafts.forget(effect.conversationId);
        const now = parseRoute(location.hash);
        if (now.view === 'chat' && now.id === effect.conversationId) location.replace('#/');
      } else if (effect.kind === 'toast') {
        toast(notificationToast(effect.notification));
      } else if (granted) new Notification(t('browser.notification', effect.title), { body: effect.body });
    }
  };

  const hashGeneration = useRef(0);
  const closer = useMemo(() => settingsCloser({
    hasBehind: () => behindRef.current !== null,
    behindHash: () => routeHash(behindRef.current ?? HOME),
    depth: () => settingsDepth(settingsStart.current, historyIndex()),
    back: by => history.go(-by),
    replace: hash => location.replace(hash),
    currentHash: () => location.hash,
    generation: () => hashGeneration.current,
    later: (run, ms) => { setTimeout(run, ms); },
  }), []);
  const viewRef = useRef(route.view);
  viewRef.current = route.view;

  useEffect(() => {
    const reveal = (e: FocusEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inner = target?.closest<HTMLElement>('.bt-screen > .bt-screen__inner');
      const head = inner?.querySelector<HTMLElement>(':scope > .bt-screen__head');
      if (!target || !inner || !head || head.contains(target)) return;
      requestAnimationFrame(() => {
        if (getComputedStyle(head).position !== 'sticky') return;
        const hidden = underHead(head.getBoundingClientRect().bottom, target.getBoundingClientRect().top, 8, target.matches(':focus-visible'));
        if (hidden > 0) inner.scrollTop -= hidden;
      });
    };
    document.addEventListener('focusin', reveal);
    return () => document.removeEventListener('focusin', reveal);
  }, []);
  useEffect(() => {
    addEventListener('beforeunload', unloadGuard);
    return () => removeEventListener('beforeunload', unloadGuard);
  }, []);
  const discardEdits = useCallback(() => {
    const to = leave;
    clearUnsaved(SCREEN_EDITS);
    setLeave(null);
    if (to !== null) followLeave(to, historyIndex(), LEAVE_ENV);
  }, [leave]);

  useEffect(() => {
    const onPop = () => { closer.reset(); entryIndex.current = popIndex(entryIndex.current, entryHash.current, location.hash, historyIndex()); };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, [closer]);

  useEffect(() => {
    const onHash = () => {
      const next = readRoute();
      const hold = settingsHold(hasUnsavedEdits(SETTINGS_EDITS), viewRef.current, entryHash.current, next, entryIndex.current, historyIndex());
      if (hold) { setSettingsLeave(hold.leave); holdLeave(hold.leave.moved, hold.back, LEAVE_ENV); return; }
      const held = behindRef.current;
      const kept = held ? planStays(held, next, id => { const c = liveRef.current.conversations.find(x => x.id === id); return c ? c.project_id ?? null : undefined; }) : null;
      if (held && leaveAsks(hasUnsavedEdits(SCREEN_EDITS, kept === null ? undefined : PLAN_EDITS + kept), held, next)) {
        const moved = leaveMove(entryIndex.current, historyIndex());
        setLeave({ to: routeHash(next), moved, at: entryIndex.current });
        holdLeave(moved, routeHash(held), LEAVE_ENV);
        return;
      }
      entryIndex.current = historyIndex();
      entryHash.current = location.hash;
      hashGeneration.current += 1;
      closer.reset();
      if (next.view === 'settings' && viewRef.current !== 'settings') { settingsOpener.current = document.activeElement; settingsStart.current = historyIndex(); }
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

  useEffect(() => { for (const what of ['conversations', 'tasks', 'drafts', 'unread', 'worker', 'profile', 'projects', 'pending', 'questions'] as const) load[what](); }, [load]);
  useEffect(() => {
    settleLeave(route, live.projectsLoaded ? live.projects.map(p => p.id) : null, { clearEdits: () => { clearUnsaved(SCREEN_EDITS); setLeave(null); }, replace: hash => location.replace(hash) });
  }, [route, live.projects, live.projectsLoaded]);
  const loadSetup = useCallback(() => api.onboarding().then(state => { setSetup(state); return state; }), []);
  useEffect(() => {
    const loads = setupLoads(
      () => api.onboarding(),
      state => { setSetup(state); if (opensOnLoad(state.done, wasSetupShown())) setOnboard(old => old ?? 'first'); },
      () => toast({ kind: 'info', icon: 'alert', title: t('ui.ob.loadFailed'), body: t('ui.ob.loadRetry') }),
    );
    void loads.load();
    return loads.stop;
  }, []);
  useEffect(() => { const timer = setInterval(load.worker, 30_000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { void loadServerSettings(api.settings); }, []);

  const onEvent = useCallback((event: RunEvent) => dispatch({ type: 'event', event, hidden: document.hidden, now: Date.now() }), [dispatch]);
  const onResync = useCallback((drafts: Draft[]) => dispatch({ type: 'resync', drafts }), [dispatch]);
  const { connected, reconnect } = useRunEvents(onEvent, onResync);
  const disconnected = useDisconnected(connected);

  const { conversations, drafts, checklists, streaming, skillDrafts, unread } = live;
  const projects = useMemo(() => withQuestionCounts(withPendingCounts(live.projects, live.pendingCounts), live.questionCounts), [live.projects, live.pendingCounts, live.questionCounts]);
  const questionsAll = live.questionCounts?.open ?? 0;
  const questionsByTask = useMemo(() => taskQuestions(live.questionCounts), [live.questionCounts]);
  const questionRevision = `${live.questionRevision}:${live.epoch}`;
  const fixRevision = `${live.taskRevision}:${live.epoch}`;
  const pendingAll = live.pendingCounts ? pendingTotal(live.pendingCounts, live.projects) : 0;
  const sessionPending = useMemo(() => sessionCounts(live.pendingWaiting), [live.pendingWaiting]);
  const pendingByTask = useMemo(() => taskCounts(live.pendingWaiting), [live.pendingWaiting]);
  const pendingRevision = `${live.pendingRevision}:${live.epoch}`;
  const waiting: Waiting = useMemo(
    () => ({ drafts: skillDrafts, pending: pendingAll, questions: questionsAll, ...countTasks([...live.tasks].map(([id, m]) => [id, m.status, m.waitingKind] as const), questionsByTask), checks: countChecks(live.tasks.values(), new Set(live.projectsLoaded ? live.projects.map(p => p.id) : [])) }),
    [skillDrafts, live.tasks, live.projects, live.projectsLoaded, pendingAll, questionsAll, questionsByTask],
  );
  const working = drafts.length > 0 || (worker?.runningAll.length ?? 0) > 0;
  const state = agentState(waiting, working);
  const running = useMemo(() => new Set(drafts.map(d => d.conversationId)), [drafts]);
  const runningTitle = worker?.running?.title ?? conversations.find(c => running.has(c.id))?.title ?? null;
  const foot = footLine(waiting, working, drafts.map(d => checklists.get(d.conversationId) ?? []), runningTitle);

  useEffect(() => {
    if ((waiting.pending || waiting.answers || waiting.questions) && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
  }, [waiting.pending, waiting.answers, waiting.questions]);

  const settingsOpen = route.view === 'settings';
  const wasSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    const closed = wasSettingsOpen.current && !settingsOpen;
    wasSettingsOpen.current = settingsOpen;
    if (!closed) return;
    setSettingsLeave(null);
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
  const routeProduct = productOf(projects, routeProductId(behind));
  const title = viewTitle(t, behind, conversation, routeProduct);
  const kanban = kanbanCount(waiting);
  const convo = isConversation(behind) || behind.view === 'productNew';
  const convoProduct = behind.view === 'productNew' ? routeProduct : productOf(projects, conversation?.project_id);
  const isStreaming = behind.view === 'chat' && streaming.has(behind.id);
  const covered = drawer || settingsOpen || onboard !== null;
  const shut = settingsOpen || onboard !== null;
  const paneProduct = convo ? convoProduct?.id ?? null : null;
  const panes = usePanes(paneProduct);
  const paneCount = convo ? panes.shown.length : 0;
  const [want, setWant] = useState<{ productId: string; view: PaneView } | null>(null);
  const openPaneOf = useCallback((productId: string, view: PaneView) => {
    setWant({ productId, view });
    location.replace(routeHash(paneTarget(productId, conversations)));
  }, [conversations]);
  const openPlanOf = useCallback((productId: string) => openPaneOf(productId, 'plan'), [openPaneOf]);
  const paneRoute = route.view === 'pending' || route.view === 'questions' ? route.view : null;
  const paneRouteProduct = route.view === 'pending' || route.view === 'questions' ? route.productId ?? null : null;
  useEffect(() => {
    if (paneRoute === null || paneRouteProduct === null || !pendingRouteReady(live.projectsLoaded, live.conversationsSettled)) return;
    if (productOf(projects, paneRouteProduct)) openPaneOf(paneRouteProduct, paneRoute);
    else location.replace(routeHash({ view: paneRoute }));
  }, [paneRoute, paneRouteProduct, live.projectsLoaded, live.conversationsSettled, projects, openPaneOf]);
  useEffect(() => {
    if (!want || paneProduct !== want.productId) return;
    if (want.view === 'plan') panes.openPlan(false); else panes.openPane(want.view);
    setWant(null);
  }, [want, paneProduct, panes]);
  const paneToggle = paneProduct ? { open: paneCount > 0, onToggle: panes.toggle, onOpenPlan: panes.openPlan, onOpenPending: () => panes.openPane('pending') } : undefined;

  return (
    <div className={`ui-frame${drawer ? ' is-drawer-open' : ''}`}>
      <NarrowBar title={title} unread={unread} expanded={drawer} covered={covered} menuRef={menuButton} onMenu={() => setDrawer(true)} panes={paneToggle} judgeOff={worker?.judgeOff === true} />
      <div className={convo ? `bt-app${paneCount ? ' has-panes' : ''}${paneCount && panes.single ? ' is-pane-single' : ''}` : 'bt-shell'} data-panes={convo ? String(paneCount) : undefined} inert={shut}
        style={paneCount && !panes.single ? { '--ui-panes-w': `${panes.width}px` } as CSSProperties : undefined}>
        <Sidebar state={state} route={behind} foot={foot} kanban={kanban} questions={questionsAll} pending={pendingAll} sessionPending={sessionPending} drafts={skillDrafts} unread={unread} conversations={conversations} conversationsMore={live.conversationsMore} projects={projects} running={running} color={profile?.color} setupPending={setupPending(setup?.done ?? null, onboard !== null)} onSetup={resumeSetup} judgeOff={worker?.judgeOff === true} />
        {productsMissing(behind, live.projectsLoaded, projectsFailing) ? (
          <main className={convo ? 'bt-app__main' : 'bt-screen'} inert={drawer}>
            <div className="bt-screen__inner">
              <Notice tone="warn" icon="alert" title={t('ui.product.listFailed')} text={t('ui.product.listRetry')} action={{ label: t('ui.fail.retry'), run: load.projects }} />
            </div>
          </main>
        ) : convo && awaitingProduct(behind, routeProduct) ? (
          <main className="bt-app__main" inert={drawer} />
        ) : convo ? (
          <main className={`bt-app__main${isStreaming ? ' is-streaming' : ''}`} inert={drawer}>
            <Conversation
              key={chatId ?? (behind.view === 'productNew' ? `new:${behind.id}` : 'new')} id={chatId} listTitle={conversation?.title ?? null} aiName={profile?.name} product={convoProduct}
              draft={chatId ? drafts.find(d => d.conversationId === chatId) : undefined}
              notices={(chatId && live.notices.get(chatId)) || NO_NOTICES}
              liveChecklist={chatId ? checklists.get(chatId) : undefined}
              revision={(chatId ? live.revisions.get(chatId) ?? 0 : 0) + live.epoch}
              disconnected={disconnected} onReconnect={reconnect}
              onClearNotices={clearNotices} onInterrupt={interrupt} panes={paneToggle} waits={worker?.waiting}
            />
          </main>
        ) : (
          <main className="bt-screen" inert={drawer}>
            {behind.view === 'kanban' ? (
              <Kanban conversations={conversations} drafts={drafts} checklists={checklists} revision={live.taskRevision + live.epoch} projects={projects} pendingByTask={pendingByTask} questionsByTask={questionsByTask} waits={worker?.waiting} />
            ) : behind.view === 'task' ? (
              <TaskScreen key={behind.id} id={behind.id} revision={`${live.taskRevision}:${live.epoch}:${live.pendingRevision}`} worker={worker} projects={projects} pending={pendingByTask.get(behind.id) ?? 0} />
            ) : behind.view === 'overview' ? (
              <Overview waiting={waiting} conversations={conversations} drafts={drafts} checklists={checklists} worker={worker} onWorker={setWorker} revision={live.taskRevision + live.epoch} projects={projects} projectsLoaded={live.projectsLoaded} questionCounts={live.questionCounts} pendingCounts={live.pendingCounts} />
            ) : behind.view === 'product' ? (
              <ProductHome key={behind.id} id={behind.id} project={productOf(projects, behind.id)} conversations={conversations} drafts={drafts} checklists={checklists} worker={worker} revision={live.taskRevision + live.epoch} />
            ) : behind.view === 'schedule' ? (
              <Schedule revision={live.taskRevision + live.epoch} projects={projects} />
            ) : behind.view === 'notifications' ? (
              <Notifications unread={unread} epoch={live.epoch} onUnread={setUnread} projects={projects} />
            ) : behind.view === 'memory' ? (
              <Memory revision={live.libraryRevision + live.epoch} />
            ) : behind.view === 'skills' ? (
              <Skills target={behind.target} revision={`${live.libraryRevision}:${live.epoch}:${skillDrafts}`} running={working} onDrafts={setDrafts} />
            ) : behind.view === 'runs' ? (
              <Runs tab={behind.tab} revision={live.libraryRevision + live.epoch + live.taskRevision} conversations={conversations} projects={projects} />
            ) : behind.view === 'archived' ? (
              <Archived revision={live.libraryRevision + live.epoch} projects={projects} projectsLoaded={live.projectsLoaded} />
            ) : behind.view === 'pending' ? (
              behind.productId ? <div className="bt-screen__inner" /> : <PendingScreen waiting={live.pendingWaiting} counts={live.pendingCounts} projects={projects} conversations={conversations} revision={pendingRevision} onOpenPlan={openPlanOf} />
            ) : behind.view === 'questions' ? (
              behind.productId ? <div className="bt-screen__inner" /> : <QuestionsScreen counts={live.questionCounts} revision={questionRevision} fixRevision={fixRevision} />
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
          <Panes panes={panes} productId={paneProduct} scope={chatId ?? 'new'} inert={drawer} isGit={convoProduct?.is_git ?? true} taskRevision={`${live.taskRevision}:${live.epoch}`} waits={worker?.waiting}
            revision={`${live.planRevisions.get(paneProduct) ?? 0}:${live.epoch}:${runningIn(drafts, conversations, paneProduct)}`}
            pending={{ waiting: live.pendingWaiting, counts: live.pendingCounts, projects, conversations, revision: pendingRevision, count: live.pendingCounts ? pendingFor(live.pendingCounts, paneProduct) : 0 }}
            questions={{ counts: live.questionCounts, revision: questionRevision, fixRevision, count: questionsFor(live.questionCounts, paneProduct) }} />
        )}
      </div>
      {drawer && <div className="ui-navveil" onClick={closeDrawer} inert={shut} />}
      <TabBar route={behind} kanban={kanban} questions={questionsAll} pending={pendingAll} covered={covered} />
      {settingsOpen && onboard === null && (
        <Settings section={route.view === 'settings' ? route.section : undefined} onClose={closeSettings} held={settingsHeld} onReplay={replay} onSaved={load.worker} onProfile={load.profile} />
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
