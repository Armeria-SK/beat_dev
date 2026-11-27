import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PermissionMode } from '../../../src/shared/permission-mode.ts';
import { api, ApiError, type ChatBuild, type ChecklistItem, type Conversation as ConversationRow, type Message, type ModelChoice, type ModelView, type PendingMessage, type Project, type UploadView, type WaitReason } from '../api.ts';
import { waitText } from './wait.ts';
import { endsWithUserTurn, isNearBottom, newConversationId, sendChoiceOf, sendFailureOf, TextThrottle, type SendFailure } from '../chat-logic.ts';
import { copyText } from '../clipboard.ts';
import { toast } from '../feedback.ts';
import { Composer } from './Composer.tsx';
import { openAsk } from './ask.ts';
import { AskCard } from './AskCard.tsx';
import { cancelClearsInterrupt, firstMode, NEW_DRAFT, queuedLine, submitMessage, type SubmitKind, type UiSlash } from './composer-state.ts';
import { getExplainLanguage, useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import { Markdown } from '../Markdown.tsx';
import { undoMemoryEvent, undoMemoryNoteEvent, useMemoryNoteUndone, useMemoryUndone } from '../memory-undo.ts';
import { serverText, warningText } from '../server-text.ts';
import { useContextUsage } from '../use-context-usage.ts';
import { RedoAction } from './ChangesRedo.tsx';
import { Checklist } from './Checklist.tsx';
import { useNow } from './hooks.ts';
import { latestOnly } from './latest.ts';
import { newSessionHash, sendOptions } from './product-nav.ts';
import type { LiveDraft, RunNotice } from './live-state.ts';
import { PanesButton, type PanesToggle } from './Panes.tsx';
import { Button, EmptyState, Icon, Notice } from './parts.tsx';
import { reportOpError } from './task-ops.ts';
import { notePath } from './memory-notes.ts';
import { messageTarget, parseRoute, routeHash } from './routes.ts';
import { RuntimeNote } from './RuntimeNote.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { buildStage, contextMeter, isRising, messageStamp, replyMeta, thinkingSeconds, threadGutter, threadItems, type ThreadItem, type ToolItem } from './thread.ts';
import { ToolGroup, type PendingLink } from './ToolRow.tsx';

type T = ReturnType<typeof useT>;

export interface ConversationProps {
  id: string | null;
  listTitle: string | null;
  aiName?: string | undefined;
  product?: Project | undefined;
  draft: LiveDraft | undefined;
  notices: RunNotice[];
  liveChecklist: ChecklistItem[] | undefined;
  revision: number;
  disconnected: boolean;
  onReconnect: () => void;
  onClearNotices: (id: string, runId?: string) => void;
  onInterrupt: (id: string, on: boolean) => void;
  panes?: PanesToggle | undefined;
  waits?: Record<string, WaitReason> | undefined;
  buildLive?: BuildLive | undefined;
}

export interface BuildLive { toolOf: (build: ChatBuild) => ToolItem | undefined; checklistOf: (build: ChatBuild) => ChecklistItem[] | undefined; questions: (taskId: string) => number; pending: (taskId: string) => number }

interface Loaded { conversation: ConversationRow; messages: Message[]; pending: PendingMessage[]; builds: ChatBuild[] }
interface Choice { modelId: string | null; effort: string | null; permissionMode: PermissionMode }
const NO_CHOICE: Choice = { modelId: null, effort: null, permissionMode: 'auto' };

const MEMORY_KEY = { create: 'ui.notice.memoryCreate', update: 'ui.notice.memoryUpdate', forget: 'ui.notice.memoryForget' } as const;
const MEMORY_NOTE_KEY = { create: 'ui.notice.memoryNoteCreate', update: 'ui.notice.memoryNoteUpdate', forget: 'ui.notice.memoryNoteForget' } as const;
const short = (text: string, max = 80): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

export function noticeText(t: T, n: RunNotice): string {
  switch (n.kind) {
    case 'switch': return t('ui.notice.switched', n.to);
    case 'warning': return warningText({ code: n.code, message: n.message, ...(n.params ? { params: n.params as Record<string, string | number> } : {}) }, getExplainLanguage());
    case 'compaction': return t('ui.notice.compacted', n.summarized);
    case 'memory': return t(MEMORY_KEY[n.action], short(n.content));
    case 'memoryNote': return t(MEMORY_NOTE_KEY[n.action], notePath(n.name));
    case 'stopped': return t('ui.notice.stopped');
    case 'interrupted': return t('ui.notice.interrupted');
    case 'undo': return [n.undone > 0 && t('ui.notice.undid', n.undone), n.refused > 0 && t('ui.notice.undidRefused', n.refused), n.more > 0 && t('ui.notice.undidMore', n.more)].filter(Boolean).join(' · ');
    case 'error': return serverText(n.errorCode, n.errorParams, getExplainLanguage()) ?? n.errorMessage ?? n.errorKind;
  }
}

function MemoryUndo({ eventId }: { eventId: number }) {
  const t = useT();
  const undone = useMemoryUndone(eventId);
  const [failed, setFailed] = useState(false);
  if (undone) return <span> · {t('ui.notice.undone')}</span>;
  return <> <button type="button" className="bt-notice__action" onClick={() => void undoMemoryEvent(eventId).then(ok => setFailed(!ok))}>{failed ? t('ui.notice.undoFailed') : t('ui.notice.undo')}</button></>;
}

function MemoryNoteUndo({ projectId, name, eventId }: { projectId: string; name: string; eventId: number }) {
  const t = useT();
  const undone = useMemoryNoteUndone(projectId, eventId);
  const [failed, setFailed] = useState(false);
  if (undone) return <span> · {t('ui.notice.undone')}</span>;
  return <> <button type="button" className="bt-notice__action" onClick={() => void undoMemoryNoteEvent(projectId, name, eventId).then(ok => setFailed(!ok))}>{failed ? t('ui.notice.undoFailed') : t('ui.notice.undo')}</button></>;
}

function QuietNotice({ notices }: { notices: RunNotice[] }) {
  const t = useT();
  return (
    <div className="bt-notice bt-rise">
      <span className="bt-notice__rule" />
      <span className="ui-notice__text">
        {notices.map((n, i) => (
          <Fragment key={i}>{i > 0 && ' · '}{noticeText(t, n)}{n.kind === 'memory' && <MemoryUndo eventId={n.eventId} />}{n.kind === 'memoryNote' && <MemoryNoteUndo projectId={n.projectId} name={n.name} eventId={n.eventId} />}{n.kind === 'undo' && n.batch && <RedoAction projectId={n.projectId} batch={n.batch} />}</Fragment>
        ))}
      </span>
      <span className="bt-notice__rule" />
    </div>
  );
}

function GeneratedNote({ text, rising }: { text: string; rising: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-generated">
      <div className={`bt-notice${rising ? ' bt-rise' : ''}`}>
        <span className="bt-notice__rule" />
        <span className="ui-notice__text">
          {t('ui.notice.generated')} · <button type="button" className="bt-notice__action" aria-expanded={open} onClick={() => setOpen(shown => !shown)}>{open ? t('ui.notice.hideGenerated') : t('ui.notice.showGenerated')}</button>
        </span>
        <span className="bt-notice__rule" />
      </div>
      {open && <p className="bt-meta ui-generated__text">{text}</p>}
    </div>
  );
}

function PlanWritten({ onOpen, rising }: { onOpen: (() => void) | undefined; rising: boolean }) {
  const t = useT();
  return (
    <div className={`bt-notice${rising ? ' bt-rise' : ''}`}>
      <span className="bt-notice__rule" />
      <span className="ui-notice__text">
        {t('ui.plan.written')}
        {onOpen && <> · <button type="button" className="bt-notice__action" onClick={onOpen}>{t('ui.plan.openPane')}</button></>}
      </span>
      <span className="bt-notice__rule" />
    </div>
  );
}

const BUILD_TEXT = {
  queued: 'ui.build.queued', running: 'ui.build.running', approval: 'ui.build.approval', question: 'ui.build.question', waiting: 'ui.build.waiting',
  check: 'ui.build.check', done: 'ui.build.done', stopped: 'ui.build.stopped', failed: 'ui.build.failed',
} as const;

const NEVER_NEW = (): boolean => false;

function BuildRow({ build, openPending, alert, wait, live, ownToolRunning }: { build: ChatBuild; openPending: (() => void) | undefined; alert: boolean; wait: WaitReason | undefined; live: BuildLive | undefined; ownToolRunning: boolean }) {
  const t = useT();
  const stage = buildStage(build);
  const questions = live?.questions(build.id) ?? 0;
  const held = live?.pending(build.id) ?? 0;
  const go = (hash: string) => () => { location.hash = hash; };
  const openTask = { label: t('ui.notifications.open.task'), run: go(routeHash({ view: 'task', id: build.id })) };
  const product = build.project_id ? { productId: build.project_id } : {};
  const place = stage === 'approval' ? { label: t('ui.notifications.open.pending'), run: openPending ?? go(routeHash({ view: 'pending', ...product })) }
    : stage === 'question' || questions > 0 ? { label: t('ui.notifications.open.questions'), run: go(routeHash({ view: 'questions', ...product })) }
    : held > 0 ? { label: t('ui.notifications.open.pending'), run: openPending ?? go(routeHash({ view: 'pending', ...product })) } : null;
  const note = [stage === 'queued' && wait ? waitText(wait) : null, questions > 0 ? t('ui.build.questions', questions) : null, held > 0 ? t('ui.build.pending', held) : null].filter(Boolean).join(' · ');
  const tool = stage === 'running' ? live?.toolOf(build) : undefined;
  const shown = tool && ownToolRunning ? { ...tool, running: undefined } : tool;
  const toolRow = shown && build.conversation_id ? <><ToolGroup rows={[shown]} isNew={NEVER_NEW} /><div className="bt-msg bt-meta ui-build__session"><a className="bt-tool__link" href={routeHash({ view: 'chat', id: build.conversation_id })}>{t('ui.task.openSession')}</a></div></> : null;
  const summary = (stage === 'done' || stage === 'check' || stage === 'failed') && build.summary ? <div className="bt-msg ui-reply ui-build__summary"><Markdown text={build.summary} /></div> : null;
  const list = stage !== 'running' && build.checklist.items.length > 0 ? <Checklist items={build.checklist.items} live={false} /> : null;
  if (stage === 'failed') return <><Notice tone="fail" alert={alert} title={t('ui.build.failed')} text={[t('ui.build.failedText'), note].filter(Boolean).join(' · ')} {...(place ? { action: place, also: openTask } : { action: openTask })} />{summary}{list}</>;
  return <><Notice title={t(BUILD_TEXT[stage])} {...(note ? { text: note } : {})} {...(place ? { action: place, also: openTask } : { action: openTask })} />{toolRow}{summary}{list}</>;
}

interface FailAction { label: string; run: () => void }

function useThrottledText(text: string): string {
  const throttle = useRef<TextThrottle | null>(null);
  throttle.current ??= new TextThrottle(text);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const drawn = throttle.current.next(text, performance.now());
  useEffect(() => throttle.current!.arm(text, { setTimer: (fn, ms) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); }, now: () => performance.now(), redraw }), [text]);
  return drawn;
}

function Thinking({ since }: { since: number }) {
  const t = useT();
  const seconds = thinkingSeconds(since, useNow(1000));
  return seconds === null ? null : <span className="bt-meta ui-thinking">{t('ui.thinking', seconds)}</span>;
}

function LiveReply({ text, since }: { text: string; since: number | null }) {
  const drawn = useThrottledText(text);
  if (!drawn) return <div className="bt-msg ui-live"><span className="bt-caret" />{since !== null && <Thinking since={since} />}</div>;
  return <div className="bt-msg ui-live"><Markdown text={drawn} /></div>;
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = state === 'done' ? t('ui.copied') : state === 'failed' ? t('ui.copyFailed') : t('ui.copy');
  return (
    <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost ui-copy" aria-label={label} title={label}
      onClick={() => void copyText(text).then(ok => { setState(ok ? 'done' : 'failed'); clearTimeout(timer.current); timer.current = setTimeout(() => setState('idle'), 1600); })}>
      <Icon name={state === 'done' ? 'check' : 'copy'} />
    </button>
  );
}

function Bar({ conversation: row, readOnly, title, product, meter, panes, onRenamed, onSummary }: {
  conversation: ConversationRow | null; readOnly: boolean; title: string; product: Project | undefined; meter: { value: number; high: boolean } | null; panes: PanesToggle | undefined; onRenamed: (title: string) => void; onSummary: () => void;
}) {
  const t = useT();
  const conversation = readOnly ? null : row;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [renameError, setRenameError] = useState('');
  const finished = useRef(false);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setMenu(false); };
    addEventListener('pointerdown', onDown);
    return () => removeEventListener('pointerdown', onDown);
  }, [menu]);
  const closeMenu = (refocus = true) => { setMenu(false); if (refocus) menuButton.current?.focus(); };
  const save = async () => {
    if (finished.current) return;
    finished.current = true;
    const next = draft.trim().slice(0, 200);
    setEditing(false);
    if (!conversation || !next || next === conversation.title) return;
    try { await api.renameConversation(conversation.id, next); onRenamed(next); } catch (e) { setRenameError(e instanceof ApiError ? e.message : String(e)); }
  };
  const cancel = () => { finished.current = true; setEditing(false); };
  const startRename = () => { finished.current = false; setRenameError(''); setMenu(false); setDraft(conversation?.title ?? ''); setEditing(true); };
  return (
    <header className="bt-app__bar">
      {editing ? (
        <input className="bt-field ui-bar__field" autoFocus value={draft} aria-label={t('ui.session.renameField')} maxLength={200}
          onChange={e => setDraft(e.target.value)} onBlur={() => void save()}
          onKeyDown={e => { if (isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return; if (e.key === 'Enter') { e.preventDefault(); void save(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } }} />
      ) : conversation ? (
        <button type="button" className="bt-app__bar-title ui-bar__title" title={t('ui.session.rename')} onClick={startRename}>{title}</button>
      ) : <span className="bt-app__bar-title ui-bar__title">{title}</span>}
      {product && !editing && <a className="bt-meta ui-bar__product" href={routeHash({ view: 'product', id: product.id })}>{product.name}</a>}
      {renameError && <span className="bt-meta ui-danger ui-bar__error" role="alert">{t('ui.session.renameFailed', renameError)}</span>}
      {meter && (
        <span className={`bt-meter${meter.high ? ' bt-meter--high' : ''}`} role="meter" aria-label={t('ui.meter')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter.value}
          style={{ '--bt-meter': meter.value } as CSSProperties}>
          <svg className="bt-meter__ring" viewBox="0 0 20 20" aria-hidden="true"><circle className="bt-meter__track" cx="10" cy="10" r="7.5" /><circle className="bt-meter__value" cx="10" cy="10" r="7.5" pathLength="100" /></svg>
          {meter.value}%{meter.high && <> · {t('ui.meter.high')}</>}
        </span>
      )}
      {panes && <PanesButton {...panes} />}
      {conversation && (
        <div className="ui-bar__menu" ref={wrap}>
          <button ref={menuButton} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.session.menu')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
            <Icon name="more" />
          </button>
          {menu && (
            <SessionMenu conversation={conversation} label={t('ui.session.menu')} opener={menuButton} className="ui-sessionmenu" onClose={closeMenu}
              onRename={startRename} onArchived={() => closeMenu()} onDeleted={() => location.replace('#/')}
              lead={conversation.has_summary ? <li role="none"><button type="button" role="menuitem" className="bt-menu__item ui-menu__btn" onClick={() => { setMenu(false); onSummary(); }}>{t('ui.session.summary')}</button></li> : undefined} />
          )}
        </div>
      )}
    </header>
  );
}

function Summary({ id }: { id: string }) {
  const t = useT();
  const [state, setState] = useState<{ text: string | null } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    void api.summary(id).then(s => { if (live) setState({ text: s.summary }); }, () => { if (live) setState('failed'); });
    return () => { live = false; };
  }, [id]);
  if (state === null) return null;
  if (state === 'failed' || state.text === null) return <p className="bt-meta ui-summary">{t('ui.notice.summaryFailed')}</p>;
  return <div className="ui-summary"><Markdown text={state.text} /></div>;
}

function Suggestions({ busy, onPick }: { busy: boolean; onPick: (text: string) => void }) {
  const t = useT();
  const items = [t('ui.suggest.task'), t('ui.suggest.memory'), t('ui.suggest.files')];
  return (
    <div className="ui-suggest">
      {items.map(text => <Button key={text} variant="ghost" small disabled={busy} onClick={() => onPick(text)}><Icon name="chevR" />{text}</Button>)}
    </div>
  );
}

function failNotice(title: string, text: string | null, action: FailAction | null): ReactNode {
  return <Notice tone="fail" title={title} text={text ?? undefined} {...(action ? { action } : {})} />;
}

function revealPending(id: number): void {
  const until = performance.now() + 3000;
  const look = (): void => {
    const row = document.querySelector<HTMLElement>(`[data-pending="${id}"]`);
    if (row && row.getClientRects().length > 0) { row.scrollIntoView({ block: 'nearest' }); return; }
    if (performance.now() < until) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}

const messageNumber = (key: string): number | undefined => {
  const found = /^m-(\d+)$/u.exec(key);
  return found ? Number(found[1]) : undefined;
};

function messageRow(root: HTMLElement | null, target: number, last: number): HTMLElement | null {
  if (!root || target > last) return null;
  let row: HTMLElement | null = null;
  let at = 0;
  for (const el of root.querySelectorAll<HTMLElement>('[data-msg]')) {
    const n = Number(el.dataset['msg']);
    if (n <= target && n > at) { row = el; at = n; }
  }
  return row;
}

export function Conversation({ id, listTitle, aiName, product, draft, notices, liveChecklist, revision, disconnected, onReconnect, onClearNotices, onInterrupt, panes, waits, buildLive }: ConversationProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [gone, setGone] = useState(false);
  const [readList, setReadList] = useState<{ items: ChecklistItem[] } | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [modelsRead, setModelsRead] = useState(false);
  const [chatOrder, setChatOrder] = useState<string[]>([]);
  const startMode = firstMode(product);
  const openPending = panes?.onOpenPending;
  const pendingLink = useMemo((): PendingLink => ({
    route: { view: 'pending' },
    open: pendingId => {
      if (openPending) openPending(); else location.hash = routeHash({ view: 'pending' });
      revealPending(pendingId);
    },
  }), [openPending]);
  const [draftChoice, setDraftChoice] = useState<Choice>({ ...NO_CHOICE, permissionMode: startMode });
  const modeChosen = useRef(false);
  useEffect(() => {
    if (!modeChosen.current) setDraftChoice(current => ({ ...current, permissionMode: startMode }));
  }, [startMode]);
  const [usageTick, setUsageTick] = useState(0);
  const [failure, setFailure] = useState<(SendFailure & { retry: FailAction | null; title?: string }) | null>(null);
  const [sending, setSending] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useRef(new Map<string, number>());
  const primed = useRef(false);
  const stick = useRef(true);
  const created = useRef<string | null>(null);

  const loads = useRef(latestOnly());
  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    if (!id) { setLoaded(null); setGone(false); return; }
    try {
      const r = await api.messages(id);
      if (!loads.current.isCurrent(ticket)) return;
      setLoaded({ conversation: r.conversation, messages: r.messages, pending: r.pending ?? [], builds: r.builds ?? [] });
      setGone(false);
    } catch (error) {
      if (!loads.current.isCurrent(ticket)) return;
      if (error instanceof ApiError && error.status === 404) { setLoaded(null); setGone(true); }
    }
  }, [id]);

  useEffect(() => { setLoaded(null); setGone(false); setFailure(null); setSummaryOpen(false); setReadList(null); stick.current = true; }, [id]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    if (!id) return undefined;
    let live = true;
    void api.checklist(id).then(r => { if (live) setReadList({ items: r.items }); }).catch(() => undefined);
    return () => { live = false; };
  }, [id, revision]);
  useEffect(() => { void api.models().then(r => { setModels(r.models); setChatOrder(r.chatOrder); setModelsRead(true); }).catch(() => undefined); }, []);
  const usage = useContextUsage(loaded?.conversation?.runtime_id ? null : id, draft ? -1 : revision + usageTick * 1_000_000);
  const meter = contextMeter(usage?.ratio);

  const conversation = loaded?.conversation ?? null;
  const messages = loaded?.messages ?? [];
  const pending = loaded?.pending ?? [];
  const builds = (loaded?.builds ?? []).map(b => {
    const live = b.status === 'running' ? buildLive?.checklistOf(b) : undefined;
    return live ? { ...b, checklist: { ...b.checklist, items: live } } : b;
  });
  const items = threadItems({ messages, draft, notices, builds });
  const runningBuild = builds.find(b => b.status === 'running' && b.checklist.items.length > 0);
  const unfinished = useRef(new Set<string>());
  useEffect(() => { for (const b of builds) if (b.status !== 'failed') unfinished.current.add(b.id); });
  const checklist = liveChecklist ?? readList?.items ?? [];
  const lastIsUser = endsWithUserTurn(messages);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const [jump, setJump] = useState<number | null>(() => (id ? messageTarget(parseRoute(location.hash), id) : null));
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!id) return undefined;
    const onHash = () => {
      const route = parseRoute(location.hash);
      if (route.view !== 'chat' || route.id !== id) return;
      if (route.messageId === undefined) jumped.current = null;
      else if (location.hash !== jumped.current) setJump(route.messageId);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [id]);
  useLayoutEffect(() => {
    if (jump === null || loaded === null) return;
    jumped.current = location.hash;
    setJump(null);
    const row = messageRow(scroller.current, jump, messages.at(-1)?.id ?? 0);
    if (!row) return;
    stick.current = false;
    row.scrollIntoView({ block: 'center' });
  }, [jump, loaded]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => {
      el.parentElement?.style.setProperty('--ui-gutter', `${threadGutter(el)}px`);
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const fail = async (error: unknown, retry: FailAction | null, lost: PendingMessage | null = null) => {
    stick.current = true;
    const failed = sendFailureOf(error, t('ui.fail.send'), models);
    setFailure({ ...failed, ...(lost ? { message: [failed.message, t('ui.fail.replacedLost', queuedLine(lost))].filter(Boolean).join(' · ') } : {}), retry });
  };

  const choice: Choice = conversation
    ? { modelId: conversation.model_id ?? null, effort: conversation.effort ?? null, permissionMode: conversation.permission_mode ?? 'auto' }
    : id ? NO_CHOICE : draftChoice;

  const submit = async (kind: SubmitKind, text: string, attachments: UploadView[] = [], retry: FailAction | null = null): Promise<boolean> => {
    if (sending) return false;
    setSending(true); setFailure(null);
    stick.current = true;
    const target = id ?? (created.current ??= newConversationId());
    try {
      const out = await submitMessage({ kind, text, attachmentIds: attachments.map(a => a.id), conversationId: id, target, running: Boolean(draft), pending }, {
        rename: api.renameConversation, cancelPending: api.cancelPending,
        send: (to, body, files, interrupt) => api.send(to, body, files, sendChoiceOf(id, choice, undefined, product !== undefined), sendOptions(id, product?.id, interrupt)),
        isGone: error => error instanceof ApiError && error.status === 404,
        interrupt: onInterrupt,
      });
      switch (out.kind) {
        case 'ignored':
          if (out.why === 'rename_unsent') toast({ kind: 'info', icon: 'alert', title: t('ui.composer.renameUnsent') });
          return false;
        case 'renamed': await load(); return true;
        case 'sent':
          if (out.replaced && out.queued) toast({ kind: 'info', icon: 'refresh', title: t('ui.composer.replaced'), body: queuedLine(out.replaced) });
          if (out.effortReset) toast({ kind: 'info', icon: 'refresh', title: t('ui.composer.depthReset') });
          if (!id) location.hash = routeHash({ view: 'chat', id: target });
          else await load();
          return true;
        case 'failed':
          await fail(out.error, retry, out.replaced);
          if (id) await load();
          return false;
      }
    } finally { setSending(false); }
  };

  const pick = (text: string): void => { void submit('send', text, [], { label: t('ui.fail.retry'), run: () => pick(text) }); };

  const changeFailed = (error: unknown) => {
    stick.current = true;
    setFailure({ ...sendFailureOf(error, t('ui.fail.change'), models), retry: null, title: t('ui.fail.change') });
  };

  const choose = async (next: ModelChoice) => {
    if (!id) {
      if (next.permissionMode !== undefined) modeChosen.current = true;
      setDraftChoice(current => ({
        modelId: next.modelId !== undefined ? next.modelId : current.modelId,
        effort: next.effort !== undefined ? next.effort : next.modelId !== undefined ? null : current.effort,
        permissionMode: next.permissionMode ?? current.permissionMode,
      }));
      return;
    }
    setFailure(null);
    try {
      const result = next.permissionMode !== undefined ? await api.chooseMode(id, next.permissionMode) : await api.chooseModel(id, next);
      setLoaded(current => (current ? { ...current, conversation: { ...current.conversation, ...result.conversation } } : current));
      setUsageTick(n => n + 1);
      if ('effortReset' in result && result.effortReset) toast({ kind: 'info', icon: 'refresh', title: t('ui.composer.depthReset') });
    } catch (error) { changeFailed(error); }
  };

  const cancelPending = async (pendingId: string) => {
    if (!id) return;
    const forced = cancelClearsInterrupt(pending, pendingId);
    try {
      await api.cancelPending(id, pendingId);
      if (forced) onInterrupt(id, false);
    } catch (error) { if (!(error instanceof ApiError && error.status === 404)) changeFailed(error); }
    await load();
  };

  const runSlash = (command: UiSlash) => {
    switch (command.name) {
      case 'new':
        if (id) location.hash = newSessionHash(product?.id); else toast({ kind: 'info', icon: 'check', title: t('ui.composer.alreadyNew') });
        return;
      case 'plan': void choose({ permissionMode: 'plan' }); return;
      case 'task': case 'tasks': location.hash = '#/kanban'; return;
      case 'skills': location.hash = '#/skills'; return;
      case 'log': location.hash = '#/runs'; return;
      case 'memory': location.hash = routeHash(product ? { view: 'memory', productId: product.id } : { view: 'memory' }); return;
      case 'stop': if (draft) void api.stop(draft.runId).catch(changeFailed); return;
      case 'archive': if (id) void api.archiveConversation(id).then(() => load(), changeFailed); return;
      case 'summary': setSummaryOpen(true); stick.current = false; scroller.current?.scrollTo({ top: 0 }); return;
      case 'build': panes?.onOpenPlan?.(true); return;
      case 'propose':
        if (!product) return;
        if (product.scout_mode === 'off') { toast({ kind: 'info', icon: 'alert', title: t('ui.scout.proposeOff'), body: t('ui.scout.proposeOffWhere'), href: routeHash({ view: 'productSettings', id: product.id }) }); return; }
        void api.scoutRun(product.id).then(() => toast({ icon: 'refresh', title: t('ui.scout.started') }), error => reportOpError(error));
        return;
      case 'rename': return;
    }
  };

  const lastError = notices.filter((n): n is Extract<RunNotice, { kind: 'error' }> => n.kind === 'error').at(-1);
  const stoppedSince = lastError !== undefined && notices.slice(notices.lastIndexOf(lastError) + 1).some(n => n.kind === 'stopped');
  const newestError = lastError && !draft && !stoppedSince && messages.every(m => lastError.after === undefined || m.id <= lastError.after || m.role === 'user') ? lastError : undefined;

  const retry = async () => {
    if (!id) return;
    if (newestError) onClearNotices(id, newestError.runId);
    setFailure(null);
    try { await api.retry(id); } catch (error) { await fail(error, { label: t('ui.fail.retry'), run: () => void retry() }); }
  };

  const alternative = conversation?.runtime_id ? undefined : models.find(m => m.id !== conversation?.model_id && m.probe?.status === 'ok' && m.inChat && !m.runtime);
  const useAlternative = (then: () => void): FailAction | null => (alternative && id ? {
    label: t('ui.fail.useModel', alternative.model || alternative.label),
    run: () => void api.chooseModel(id, { modelId: alternative.id }).then(() => { void load(); then(); }, error => fail(error, null)),
  } : null);
  const openSettings = { label: t('ui.fail.openSettings'), run: () => { location.hash = '#/settings'; } };
  const canRetry = lastIsUser && !draft && !conversation?.parent_run_id && (conversation?.kind ?? 'chat') === 'chat' && !conversation?.runtime_id;

  function runFailure(n: Extract<RunNotice, { kind: 'error' }>): ReactNode {
    const text = noticeText(t, n);
    const live = n === newestError;
    const retryAction = live && canRetry ? { label: t('ui.fail.retry'), run: () => void retry() } : null;
    switch (n.errorKind) {
      case 'context_overflow': return failNotice(t('ui.fail.context'), text, live ? useAlternative(() => void retry()) ?? openSettings : null);
      case 'auth': return failNotice(t('ui.fail.unreachable'), text, live ? openSettings : null);
      case 'timeout': case 'rate_limit': case 'provider_error': return failNotice(t('ui.fail.unreachable'), text, retryAction);
      default: return failNotice(t('ui.fail.reply'), text, retryAction);
    }
  }

  function sendFailure(f: NonNullable<typeof failure>): ReactNode {
    if (f.noModels) return failNotice(t('ui.fail.noModel'), t('ui.fail.noModelText'), openSettings);
    if (f.context) return failNotice(t('ui.fail.context'), f.message, useAlternative(() => f.retry?.run()) ?? openSettings);
    return failNotice(f.title ?? t('ui.fail.send'), f.message, f.retry);
  }

  const rise = (key: string): boolean => primed.current && isRising(seen.current.get(key), performance.now());
  useEffect(() => {
    const at = primed.current ? performance.now() : Number.NEGATIVE_INFINITY;
    const mark = (key: string) => { if (!seen.current.has(key)) seen.current.set(key, at); };
    for (const item of items) { mark(item.key); if (item.kind === 'tools') for (const row of item.rows) mark(row.key); }
    if (loaded !== null || id === null) primed.current = true;
  });

  const renderedAt = Date.now();
  function render(item: ThreadItem): ReactNode {
    switch (item.kind) {
      case 'owner': {
        const stamp = messageStamp(item.at, renderedAt);
        return (
          <div key={item.key} data-msg={messageNumber(item.key)} className={`bt-msg bt-msg--owner ui-owner${rise(item.key) ? ' bt-rise' : ''}`}>
            {item.text}
            {item.attachments.length > 0 && <span className="bt-meta ui-owner__files">{t('ui.attached', item.attachments.join(', '))}</span>}
            {stamp && <time className="bt-meta ui-msg__meta" dateTime={new Date(item.at).toISOString()} title={stamp.title}>{stamp.text}</time>}
          </div>
        );
      }
      case 'generated': return <GeneratedNote key={item.key} text={item.text} rising={rise(item.key)} />;
      case 'reply': {
        const stamp = item.stamped ? messageStamp(item.at, renderedAt) : null;
        return (
          <div key={item.key} data-msg={messageNumber(item.key)} className={`bt-msg ui-reply${rise(item.key) ? ' bt-rise' : ''}`}>
            <Markdown text={item.text} />
            {(stamp || item.copyText !== null) && (
              <div className="ui-reply__foot">
                {stamp && <time className="bt-meta" dateTime={new Date(item.at).toISOString()} title={stamp.title}>{replyMeta(aiName, stamp)}</time>}
                {item.copyText !== null && <CopyButton text={item.copyText} />}
              </div>
            )}
          </div>
        );
      }
      case 'live': return <LiveReply key={item.key} text={item.text} since={item.since} />;
      case 'tools': return <ToolGroup key={item.key} rows={item.rows} isNew={rise} pending={pendingLink} terminal={panes?.onOpenTerminal} changes={panes?.onOpenChanges} />;
      case 'notice': {
        if (item.weight === 'quiet') return <QuietNotice key={item.key} notices={item.notices} />;
        const n = item.notices[0]!;
        if (item.weight === 'fail' && n.kind === 'error') return <Fragment key={item.key}>{runFailure(n)}</Fragment>;
        return <Notice key={item.key} tone="warn" icon="alert" title={noticeText(t, n)} />;
      }
      case 'plan': return <PlanWritten key={item.key} onOpen={panes?.onOpenPlan ? () => panes.onOpenPlan?.(false) : undefined} rising={rise(item.key)} />;
      case 'build': return <BuildRow key={item.key} build={item.build} openPending={openPending} alert={unfinished.current.has(item.build.id)} wait={waits?.[item.build.id]} live={buildLive} ownToolRunning={Boolean(draft && !draft.text && draft.activeTool)} />;
    }
  }

  const title = conversation?.title || listTitle || (id ? t('ui.session.untitled') : t('ui.session.new'));
  const running = Boolean(draft);
  const empty = !draft && (id === null || (loaded !== null && messages.length === 0));
  const helper = conversation?.parent_run_id ? conversation : null;
  const ask = openAsk(messages);

  return (
    <>
      <Bar conversation={conversation} readOnly={Boolean(conversation?.parent_run_id)} title={title} product={product} meter={gone ? null : meter} panes={panes} onRenamed={() => void load()} onSummary={() => setSummaryOpen(true)} />
      {disconnected && <div className="ui-offline"><Notice tone="warn" icon="alert" title={t('ui.notice.disconnected')} action={{ label: t('ui.notice.reconnect'), run: onReconnect }} /></div>}
      <div ref={scroller} className="bt-thread" onScroll={e => { stick.current = isNearBottom(e.currentTarget); }}>
        {conversation?.archived === 1 && (
          <Notice title={t('ui.notice.archived')} action={{ label: t('ui.notice.restore'), run: () => void api.unarchiveConversation(conversation.id).then(() => load()).catch(() => undefined) }} />
        )}
        {conversation?.has_summary && (
          <Notice title={t('ui.notice.summary')} action={{ label: summaryOpen ? t('ui.notice.hideSummary') : t('ui.notice.readSummary'), run: () => setSummaryOpen(open => !open) }} />
        )}
        {conversation?.runtime_id && <RuntimeNote runtimeId={conversation.runtime_id} />}
        {summaryOpen && id && <Summary id={id} />}
        {gone && <EmptyState title={t('ui.session.gone')} text={t('ui.session.goneText')} />}
        {empty && !gone && product && !product.has_plan && <EmptyState title={t('ui.product.empty.title')} text={t('ui.product.empty.text')} />}
        {empty && !gone && !product && (
          <EmptyState title={t('ui.empty.title')} text={t('ui.empty.text')} action={<Suggestions busy={sending} onPick={text => void pick(text)} />} />
        )}
        {items.map(render)}
        {!running && checklist.length > 0 && <Checklist items={checklist} live={false} />}
        {meter && meter.value >= 90 && <Notice tone="warn" icon="alert" title={t('ui.notice.contextHigh', meter.value)} />}
        {failure && sendFailure(failure)}
        {helper && (
          <Notice title={t('ui.notice.helperSession')} {...(helper.source_conversation_id ? { action: { label: t('ui.notice.openParent'), run: () => { location.hash = routeHash({ view: 'chat', id: helper.source_conversation_id! }); } } } : {})} />
        )}
      </div>
      {running && checklist.length > 0 && <Checklist items={checklist} live className="ui-pinned bt-rise" />}
      {!(running && checklist.length > 0) && runningBuild && <Checklist items={runningBuild.checklist.items} live className="ui-pinned bt-rise" />}
      {!running && !gone && !helper && ask && <AskCard key={ask.key} ask={ask} busy={sending} onAnswer={text => void submit('send', text)} />}
      {!gone && !helper && (
        <Composer
          draftKey={id ?? (product ? `${NEW_DRAFT}:${product.id}` : NEW_DRAFT)} hasConversation={id !== null} product={Boolean(product)} planless={startMode === 'plan'} running={running} sending={sending} pending={pending}
          models={modelsRead ? models : null} chatOrder={chatOrder} modelId={choice.modelId} effort={choice.effort} mode={choice.permissionMode} runtime={{ bound: conversation?.runtime_id ?? null, allowed: (id === null || messages.length === 0) && Boolean(product ?? conversation?.project_id) }}
          slash={{ hasConversation: conversation !== null, running, hasSummary: Boolean(conversation?.has_summary), archived: conversation?.archived === 1, product: Boolean(product && panes?.onOpenPlan), propose: Boolean(product) }}
          onSubmit={(kind, text, attachments) => submit(kind, text, attachments)}
          onStop={() => { if (draft) void api.stop(draft.runId).catch(changeFailed); }}
          onChoose={next => void choose(next)} onCancelPending={pendingId => void cancelPending(pendingId)} onSlash={runSlash}
          onAttachFailed={error => { stick.current = true; setFailure({ ...sendFailureOf(error, t('ui.fail.attach'), models), retry: null, title: t('ui.fail.attach') }); }}
        />
      )}
    </>
  );
}
