import { Fragment, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PermissionMode } from '../../../src/shared/permission-mode.ts';
import { api, ApiError, type Approval, type ChecklistItem, type Conversation as ConversationRow, type Message, type ModelChoice, type ModelView, type PendingMessage, type Project, type UploadView } from '../api.ts';
import { isNearBottom, newConversationId, sendChoiceOf, sendFailureOf, TextThrottle, type SendFailure } from '../chat-logic.ts';
import { copyText } from '../clipboard.ts';
import { toast } from '../feedback.ts';
import { Composer } from './Composer.tsx';
import { cancelClearsInterrupt, NEW_DRAFT, queuedLine, showProceed, submitMessage, type SubmitKind, type UiSlash } from './composer-state.ts';
import { getLanguage, useT } from '../i18n/index.ts';
import { Markdown } from '../Markdown.tsx';
import { undoMemoryEvent, useMemoryUndone } from '../memory-undo.ts';
import { serverText, warningText } from '../server-text.ts';
import { useContextUsage } from '../use-context-usage.ts';
import { Checklist } from './Checklist.tsx';
import { useNow } from './hooks.ts';
import { latestOnly } from './latest.ts';
import { menuStep } from './menu.ts';
import { sendOptions } from './product-nav.ts';
import type { LiveDraft, RunNotice } from './live-state.ts';
import { Button, EmptyState, Icon, Notice } from './parts.tsx';
import { routeHash } from './routes.ts';
import { contextMeter, isRising, messageStamp, replyMeta, thinkingSeconds, threadItems, type ThreadItem } from './thread.ts';
import { ToolGroup } from './ToolRow.tsx';

type T = ReturnType<typeof useT>;

export interface ConversationProps {
  id: string | null;
  listTitle: string | null;
  aiName?: string | undefined;
  product?: Project | undefined;
  draft: LiveDraft | undefined;
  approvals: Approval[];
  notices: RunNotice[];
  liveChecklist: ChecklistItem[] | undefined;
  revision: number;
  disconnected: boolean;
  onReconnect: () => void;
  onClearNotices: (id: string) => void;
  onInterrupt: (id: string, on: boolean) => void;
}

interface Loaded { conversation: ConversationRow; messages: Message[]; pending: PendingMessage[] }
interface Choice { modelId: string | null; effort: string | null; permissionMode: PermissionMode }
const NO_CHOICE: Choice = { modelId: null, effort: null, permissionMode: 'normal' };

const MEMORY_KEY = { create: 'ui.notice.memoryCreate', update: 'ui.notice.memoryUpdate', forget: 'ui.notice.memoryForget' } as const;
const short = (text: string, max = 80): string => {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

function noticeText(t: T, n: RunNotice): string {
  switch (n.kind) {
    case 'switch': return t('ui.notice.switched', n.to);
    case 'warning': return warningText({ code: n.code, message: n.message, ...(n.params ? { params: n.params as Record<string, string | number> } : {}) }, getLanguage());
    case 'compaction': return t('ui.notice.compacted', n.summarized);
    case 'auto': return t('ui.notice.auto', n.tool);
    case 'denied': return n.detail ? `${t('ui.notice.denied', n.tool)} · ${n.detail}` : t('ui.notice.denied', n.tool);
    case 'memory': return t(MEMORY_KEY[n.action], short(n.content));
    case 'stopped': return t('ui.notice.stopped');
    case 'interrupted': return t('ui.notice.interrupted');
    case 'error': return serverText(n.errorCode, n.errorParams, getLanguage()) ?? n.errorMessage ?? n.errorKind;
  }
}

function MemoryUndo({ eventId }: { eventId: number }) {
  const t = useT();
  const undone = useMemoryUndone(eventId);
  const [failed, setFailed] = useState(false);
  if (undone) return <span> · {t('ui.notice.undone')}</span>;
  return <> <button type="button" className="bt-notice__action" onClick={() => void undoMemoryEvent(eventId).then(ok => setFailed(!ok))}>{failed ? t('ui.notice.undoFailed') : t('ui.notice.undo')}</button></>;
}

function QuietNotice({ notices }: { notices: RunNotice[] }) {
  const t = useT();
  return (
    <div className="bt-notice bt-rise">
      <span className="bt-notice__rule" />
      <span className="ui-notice__text">
        {notices.map((n, i) => (
          <Fragment key={i}>{i > 0 && ' · '}{noticeText(t, n)}{n.kind === 'memory' && <MemoryUndo eventId={n.eventId} />}</Fragment>
        ))}
      </span>
      <span className="bt-notice__rule" />
    </div>
  );
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

function SessionMenu({ conversation, onRename, onSummary, onClose }: { conversation: ConversationRow; onRename: () => void; onSummary: () => void; onClose: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => { if (confirming) confirm.current?.focus(); }, [confirming]);
  const act = async (run: () => Promise<unknown>, after: () => void) => {
    setBusy(true); setError('');
    try { await run(); after(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setBusy(false); }
  };
  return (
    <ul className="bt-menu ui-sessionmenu" role="menu" aria-label={t('ui.session.menu')}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
        const next = menuStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.key);
        if (next !== null) { e.preventDefault(); items[next]?.focus(); }
      }}>
      <li role="none"><button ref={first} type="button" role="menuitem" className="bt-menu__item ui-menu__btn" onClick={onRename}>{t('ui.session.rename')}</button></li>
      {conversation.has_summary && <li role="none"><button type="button" role="menuitem" className="bt-menu__item ui-menu__btn" onClick={onSummary}>{t('ui.session.summary')}</button></li>}
      {conversation.archived !== 1 && (
        <li role="none"><button type="button" role="menuitem" className="bt-menu__item ui-menu__btn" disabled={busy}
          onClick={() => void act(() => api.archiveConversation(conversation.id), onClose)}>{t('ui.session.archive')}</button></li>
      )}
      {confirming ? (
        <li role="none" className="ui-menu__confirm">
          <span className="bt-meta">{t('ui.session.deleteWhat')}</span>
          <span className="ui-menu__confirmrow">
            <Button ref={confirm} role="menuitem" variant="danger" small disabled={busy} onClick={() => void act(() => api.deleteConversation(conversation.id), () => location.replace('#/'))}>{t('ui.session.deleteConfirm')}</Button>
            <Button role="menuitem" variant="ghost" small onClick={() => setConfirming(false)}>{t('ui.session.keep')}</Button>
          </span>
        </li>
      ) : (
        <li role="none"><button type="button" role="menuitem" className="bt-menu__item ui-menu__btn ui-danger" onClick={() => setConfirming(true)}>{t('ui.session.delete')}</button></li>
      )}
      {error && <li role="alert" className="bt-meta ui-danger ui-menu__error">{error}</li>}
    </ul>
  );
}

function Bar({ conversation: row, readOnly, title, product, meter, onRenamed, onSummary }: {
  conversation: ConversationRow | null; readOnly: boolean; title: string; product: Project | undefined; meter: { value: number; high: boolean } | null; onRenamed: (title: string) => void; onSummary: () => void;
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
  const closeMenu = () => { setMenu(false); menuButton.current?.focus(); };
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
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } else if (e.key === 'Escape') { e.preventDefault(); cancel(); } }} />
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
      {conversation && (
        <div className="ui-bar__menu" ref={wrap}>
          <button ref={menuButton} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.session.menu')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
            <Icon name="more" />
          </button>
          {menu && <SessionMenu conversation={conversation} onRename={startRename} onSummary={() => { setMenu(false); onSummary(); }} onClose={closeMenu} />}
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

export function Conversation({ id, listTitle, aiName, product, draft, approvals, notices, liveChecklist, revision, disconnected, onReconnect, onClearNotices, onInterrupt }: ConversationProps) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [gone, setGone] = useState(false);
  const [readList, setReadList] = useState<{ items: ChecklistItem[]; tainted: boolean } | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [modelsRead, setModelsRead] = useState(false);
  const [chatOrder, setChatOrder] = useState<string[]>([]);
  const [draftChoice, setDraftChoice] = useState<Choice>(NO_CHOICE);
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
      setLoaded({ conversation: r.conversation, messages: r.messages, pending: r.pending ?? [] });
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
    void api.checklist(id).then(r => { if (live) setReadList({ items: r.items, tainted: r.tainted }); }).catch(() => undefined);
    return () => { live = false; };
  }, [id, revision]);
  useEffect(() => { void api.models().then(r => { setModels(r.models); setChatOrder(r.routing.chat); setModelsRead(true); }).catch(() => undefined); }, []);
  const usage = useContextUsage(id, draft ? -1 : revision + usageTick * 1_000_000);
  const meter = contextMeter(usage?.ratio);

  const conversation = loaded?.conversation ?? null;
  const messages = loaded?.messages ?? [];
  const pending = loaded?.pending ?? [];
  const items = threadItems({ messages, draft, approvals, notices });
  const checklist = liveChecklist ?? readList?.items ?? [];
  const lastIsUser = messages.at(-1)?.role === 'user';

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const fail = async (error: unknown, retry: FailAction | null, lost: PendingMessage | null = null) => {
    stick.current = true;
    const failed = sendFailureOf(error, t('ui.fail.send'), models);
    setFailure({ ...failed, ...(lost ? { message: [failed.message, t('ui.fail.replacedLost', queuedLine(lost))].filter(Boolean).join(' · ') } : {}), retry });
  };

  const choice: Choice = conversation
    ? { modelId: conversation.model_id ?? null, effort: conversation.effort ?? null, permissionMode: conversation.permission_mode ?? 'normal' }
    : draftChoice;

  const submit = async (kind: SubmitKind, text: string, attachments: UploadView[] = [], retry: FailAction | null = null): Promise<boolean> => {
    if (sending) return false;
    setSending(true); setFailure(null);
    stick.current = true;
    const target = id ?? (created.current ??= newConversationId());
    try {
      const out = await submitMessage({ kind, text, attachmentIds: attachments.map(a => a.id), conversationId: id, target, running: Boolean(draft), pending }, {
        rename: api.renameConversation, cancelPending: api.cancelPending,
        send: (to, body, files, interrupt) => api.send(to, body, files, sendChoiceOf(id, choice), sendOptions(id, product?.id, interrupt)),
        isGone: error => error instanceof ApiError && error.status === 404,
        clearNotices: onClearNotices, interrupt: onInterrupt,
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

  const proceed = async () => {
    if (!id || sending) return;
    setSending(true); setFailure(null);
    stick.current = true;
    try {
      await api.send(id, t('ui.plan.proceedRequest'), [], { permissionMode: 'normal' });
      await load();
    } catch (error) { await fail(error, null); await load(); } finally { setSending(false); }
  };

  const changeFailed = (error: unknown) => {
    stick.current = true;
    setFailure({ ...sendFailureOf(error, t('ui.fail.change'), models), retry: null, title: t('ui.fail.change') });
  };

  const choose = async (next: ModelChoice) => {
    if (!id) {
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
        if (id) location.hash = '#/'; else toast({ kind: 'info', icon: 'check', title: t('ui.composer.alreadyNew') });
        return;
      case 'plan': void choose({ permissionMode: 'plan' }); return;
      case 'task': case 'tasks': location.hash = '#/kanban'; return;
      case 'skills': location.hash = '#/skills'; return;
      case 'log': location.hash = '#/runs'; return;
      case 'memory': location.hash = '#/memory'; return;
      case 'stop': if (draft) void api.stop(draft.runId).catch(changeFailed); return;
      case 'archive': if (id) void api.archiveConversation(id).then(() => load(), changeFailed); return;
      case 'summary': setSummaryOpen(true); stick.current = false; scroller.current?.scrollTo({ top: 0 }); return;
      case 'rename': return;
    }
  };

  const retry = async () => {
    if (!id) return;
    onClearNotices(id);
    setFailure(null);
    try { await api.retry(id); } catch (error) { await fail(error, { label: t('ui.fail.retry'), run: () => void retry() }); }
  };

  const alternative = models.find(m => m.id !== conversation?.model_id && m.probe?.status === 'ok' && m.inChat);
  const useAlternative = (then: () => void): FailAction | null => (alternative && id ? {
    label: t('ui.fail.useModel', alternative.model || alternative.label),
    run: () => void api.chooseModel(id, { modelId: alternative.id }).then(() => { void load(); then(); }, error => fail(error, null)),
  } : null);
  const openSettings = { label: t('ui.fail.openSettings'), run: () => { location.hash = '#/settings'; } };
  const canRetry = lastIsUser && !draft && !conversation?.parent_run_id;

  function runFailure(n: Extract<RunNotice, { kind: 'error' }>): ReactNode {
    const text = noticeText(t, n);
    const retryAction = canRetry ? { label: t('ui.fail.retry'), run: () => void retry() } : null;
    switch (n.errorKind) {
      case 'context_overflow': return failNotice(t('ui.fail.context'), text, useAlternative(() => void retry()) ?? openSettings);
      case 'auth': return failNotice(t('ui.fail.unreachable'), text, openSettings);
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
          <div key={item.key} className={`bt-msg bt-msg--owner ui-owner${rise(item.key) ? ' bt-rise' : ''}`}>
            {item.text}
            {item.attachments.length > 0 && <span className="bt-meta ui-owner__files">{t('ui.attached', item.attachments.join(', '))}</span>}
            {stamp && <time className="bt-meta ui-msg__meta" dateTime={new Date(item.at).toISOString()} title={stamp.title}>{stamp.text}</time>}
          </div>
        );
      }
      case 'reply': {
        const stamp = item.stamped ? messageStamp(item.at, renderedAt) : null;
        return (
          <div key={item.key} className={`bt-msg ui-reply${rise(item.key) ? ' bt-rise' : ''}`}>
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
      case 'tools': return <ToolGroup key={item.key} rows={item.rows} isNew={rise} />;
      case 'notice': {
        if (item.weight === 'quiet') return <QuietNotice key={item.key} notices={item.notices} />;
        const n = item.notices[0]!;
        if (item.weight === 'fail' && n.kind === 'error') return <Fragment key={item.key}>{runFailure(n)}</Fragment>;
        return <Notice key={item.key} tone="warn" icon="alert" title={noticeText(t, n)} />;
      }
    }
  }

  const title = conversation?.title || listTitle || (id ? t('ui.session.untitled') : t('ui.session.new'));
  const running = Boolean(draft);
  const empty = !draft && (id === null || (loaded !== null && messages.length === 0));
  const helper = conversation?.parent_run_id ? conversation : null;

  return (
    <>
      <Bar conversation={conversation} readOnly={Boolean(conversation?.parent_run_id)} title={title} product={product} meter={gone ? null : meter} onRenamed={() => void load()} onSummary={() => setSummaryOpen(true)} />
      {disconnected && <div className="ui-offline"><Notice tone="warn" icon="alert" title={t('ui.notice.disconnected')} action={{ label: t('ui.notice.reconnect'), run: onReconnect }} /></div>}
      <div ref={scroller} className="bt-thread" onScroll={e => { stick.current = isNearBottom(e.currentTarget); }}>
        {conversation?.archived === 1 && (
          <Notice title={t('ui.notice.archived')} action={{ label: t('ui.notice.restore'), run: () => void api.unarchiveConversation(conversation.id).then(() => load()).catch(() => undefined) }} />
        )}
        {conversation?.has_summary && (
          <Notice title={t('ui.notice.summary')} action={{ label: summaryOpen ? t('ui.notice.hideSummary') : t('ui.notice.readSummary'), run: () => setSummaryOpen(open => !open) }} />
        )}
        {summaryOpen && id && <Summary id={id} />}
        {gone && <EmptyState title={t('ui.session.gone')} text={t('ui.session.goneText')} />}
        {empty && !gone && product && <EmptyState title={t('ui.product.empty.title')} text={t('ui.product.empty.text')} />}
        {empty && !gone && !product && (
          <EmptyState title={t('ui.empty.title')} text={t('ui.empty.text')} action={<Suggestions busy={sending} onPick={text => void pick(text)} />} />
        )}
        {items.map(render)}
        {!running && checklist.length > 0 && <Checklist items={checklist} tainted={readList?.tainted ?? false} live={false} />}
        {meter && meter.value >= 90 && <Notice tone="warn" icon="alert" title={t('ui.notice.contextHigh', meter.value)} />}
        {failure && sendFailure(failure)}
        {helper && (
          <Notice title={t('ui.notice.helperSession')} {...(helper.source_conversation_id ? { action: { label: t('ui.notice.openParent'), run: () => { location.hash = routeHash({ view: 'chat', id: helper.source_conversation_id! }); } } } : {})} />
        )}
      </div>
      {running && checklist.length > 0 && <Checklist items={checklist} tainted={readList?.tainted ?? false} live className="ui-pinned bt-rise" />}
      {!gone && !helper && showProceed({ mode: choice.permissionMode, hasConversation: id !== null, running, sending, approvals: approvals.length, last: messages.at(-1) }) && (
        <div className="ui-pinned ui-proceed" role="group" aria-label={t('ui.plan.proceed')}>
          <Button variant="primary" onClick={() => void proceed()}>{t('ui.plan.proceed')}</Button>
          <span className="bt-meta">{t('ui.plan.proceedHint')}</span>
        </div>
      )}
      {!gone && !helper && (
        <Composer
          draftKey={id ?? (product ? `${NEW_DRAFT}:${product.id}` : NEW_DRAFT)} hasConversation={id !== null} product={Boolean(product)} running={running} sending={sending} pending={pending}
          models={modelsRead ? models : null} chatOrder={chatOrder} modelId={choice.modelId} effort={choice.effort} mode={choice.permissionMode}
          slash={{ hasConversation: conversation !== null, running, hasSummary: Boolean(conversation?.has_summary), archived: conversation?.archived === 1 }}
          onSubmit={(kind, text, attachments) => submit(kind, text, attachments)}
          onStop={() => { if (draft) void api.stop(draft.runId).catch(changeFailed); }}
          onChoose={next => void choose(next)} onCancelPending={pendingId => void cancelPending(pendingId)} onSlash={runSlash}
          onAttachFailed={error => { stick.current = true; setFailure({ ...sendFailureOf(error, t('ui.fail.attach'), models), retry: null, title: t('ui.fail.attach') }); }}
        />
      )}
    </>
  );
}
