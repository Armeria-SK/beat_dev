import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, type ChecklistItem, type Conversation, type FinishedCursor, type RunRow, type Task } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, formatElapsed, formatRelative, timezoneLabel, useT } from '../../i18n/index.ts';
import { buildNewTask, emptyDraft, PRIORITIES, type TaskDraft } from '../../task-form.ts';
import { plainLine } from '../../task-meta.ts';
import { useMedia, useNow } from '../hooks.ts';
import {
  buildBoard, COLUMN_TABS_MEDIA, KANBAN_PAGE, mergeFinished, pagesToReload, RUNS_WINDOW, sessionCards, stepPercent, tabStep,
  type Card, type ColumnId, type SessionCard, type Step, type TaskCard,
} from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { Button, countText, Notice, Pill } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { reportOpError, runTaskOp } from '../task-ops.ts';

type T = ReturnType<typeof useT>;

export interface KanbanProps {
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  revision: number;
}

interface Loaded { active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[] }

const COLUMN_KEY = {
  proposed: 'ui.kanban.col.proposed', approved: 'ui.kanban.col.approved', progress: 'ui.kanban.col.progress', done: 'ui.kanban.col.done', failed: 'ui.kanban.col.failed',
} as const satisfies Record<ColumnId, string>;
export const PRIORITY_KEY = { 1: 'ui.task.priority.1', 2: 'ui.task.priority.2', 3: 'ui.task.priority.3' } as const;
const RELOAD_DELAY_MS = 150;

export async function readFinished(count: number): Promise<{ tasks: Task[]; next: FinishedCursor | null; total: number }> {
  let tasks: Task[] = [];
  let next: FinishedCursor | null = null;
  let total = 0;
  do {
    const page = await api.finishedTasks(next, Math.min(100, count - tasks.length));
    tasks = mergeFinished(tasks, page.tasks);
    next = page.next;
    total = page.total;
  } while (next && tasks.length < count);
  return { tasks, next, total };
}

function StepBar({ step, label }: { step: Step | null; label: string }) {
  if (!step) return null;
  return (
    <div className="bt-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={step.total} aria-valuenow={Math.max(0, step.step - 1)}>
      <span className="bt-progress__fill" style={{ '--bt-progress': `${stepPercent(step)}%` } as CSSProperties} />
    </div>
  );
}

function Head({ label, dot, right }: { label: string; dot: boolean; right?: ReactNode }) {
  return (
    <div className="bt-card__head">
      {dot ? <span className="bt-card__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{label}</span></span> : <span className="bt-label">{label}</span>}
      {right}
    </div>
  );
}

function Meta({ items }: { items: Array<string | false | null> }) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return <div className="bt-card__meta">{shown.map(item => <span key={item}>{item}</span>)}</div>;
}

function SessionCardView({ card, now, index }: { card: SessionCard; now: number; index: number }) {
  const t = useT();
  const running = card.outcome === 'running';
  const right = running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : card.outcome === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : card.outcome === 'stopped' ? <span className="bt-tag">{t('ui.kanban.stopped')}</span> : undefined;
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}`} style={{ '--bt-i': index } as CSSProperties}>
      <Head label={t('ui.kanban.session')} dot={false} right={right} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'chat', id: card.conversationId })}>{card.title || t('ui.session.untitled')}</a></h3>
      {running && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      <Meta items={running
        ? [card.step && t('ui.kanban.step', card.step.step, card.step.total), card.startedAt !== null && formatElapsed(now - card.startedAt)]
        : [formatRelative(card.at, now)]} />
    </article>
  );
}

function TaskCardView({ card, now, index, first, busy, rejecting, onApprove, onReject, onRejecting }: {
  card: TaskCard; now: number; index: number; first: boolean; busy: boolean; rejecting: boolean;
  onApprove: () => void; onReject: (reason: string) => void; onRejecting: (on: boolean) => void;
}) {
  const t = useT();
  const { task, column } = card;
  const [reason, setReason] = useState('');
  const running = task.status === 'running';
  const label = column === 'approved' ? t('ui.kanban.queued') : t('ui.kanban.task');
  const right = column === 'proposed' ? <span className="bt-meta">{formatRelative(task.created_at, now)}</span>
    : running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : task.status === 'waiting' ? <Pill tone="waiting">{t('ui.kanban.waiting')}</Pill>
    : task.status === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : task.status === 'cancelled' ? <span className="bt-tag">{t(task.cancelled_from === 'inbox' ? 'ui.kanban.rejected' : 'ui.kanban.cancelled')}</span> : undefined;
  const body = column === 'proposed' ? plainLine(task.body, 200) : task.status === 'waiting' ? plainLine(task.waiting_text, 200) : column === 'failed' ? plainLine(task.result_summary, 120) : '';
  const timed = task.run_at !== null && task.run_at > now;
  const meta: Array<string | false | null> = column === 'approved'
    ? [timed ? t('ui.kanban.starts', formatDateTimeSmart(task.run_at, now)) : first && t('ui.kanban.next'), card.repeating && t('ui.kanban.repeating')]
    : column === 'progress' ? [card.step && t('ui.kanban.step', card.step.step, card.step.total), card.repeating && t('ui.kanban.repeating')]
    : column === 'proposed' ? [task.origin !== 'user' && t('ui.kanban.byBeat'), card.repeating && t('ui.kanban.repeating')]
    : [formatRelative(card.at, now), card.repeating && t('ui.kanban.repeating')];
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}${rejecting ? ' is-rejecting' : ''}`} style={{ '--bt-i': index } as CSSProperties}>
      <Head label={label} dot={card.waiting} right={right} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a></h3>
      {body && <p className="bt-card__body">{body}</p>}
      {column === 'progress' && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      <Meta items={meta} />
      {column === 'proposed' && (
        <div className="bt-card__actions">
          <Button variant="primary" small disabled={busy} onClick={onApprove}>{t('ui.kanban.approve')}</Button>
          <Button variant="ghost" small disabled={busy} data-reject={task.id} onClick={() => { setReason(''); onRejecting(true); }}>{t('ui.kanban.reject')}</Button>
        </div>
      )}
      {column === 'proposed' && rejecting && (
        <form className="bt-card__reason" onSubmit={e => { e.preventDefault(); onReject(reason); }}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onRejecting(false); } }}>
          <input className="bt-field" autoFocus value={reason} maxLength={2000} aria-label={t('ui.kanban.reasonLabel')} placeholder={t('ui.kanban.reason')} onChange={e => setReason(e.target.value)} />
          <div className="ui-card__reasonrow">
            <Button type="submit" variant="danger" small disabled={busy}>{t('ui.kanban.reject')}</Button>
            <Button variant="ghost" small onClick={() => onRejecting(false)}>{t('ui.cancel')}</Button>
          </div>
        </form>
      )}
    </article>
  );
}

function NewTask({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TaskDraft>) => { setDraft(d => ({ ...d, ...patch })); setError(''); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const built = buildNewTask(draft);
    if (!built.ok) { setError(t(built.error === 'title' ? 'ui.newtask.needTitle' : 'ui.newtask.needTime')); return; }
    setBusy(true);
    try {
      const { task } = await api.createTask(built.task);
      toast({ kind: 'done', icon: 'check', title: t('ui.task.toast.created'), body: task.title, href: routeHash({ view: 'task', id: task.id }) });
      onClose();
    } catch (failure) { reportOpError(failure); setBusy(false); }
  };
  return (
    <form className="ui-newtask bt-rise" aria-label={t('ui.kanban.new')} onSubmit={e => void submit(e)}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <input className="bt-field" autoFocus value={draft.title} maxLength={200} aria-label={t('ui.task.title')} placeholder={t('ui.task.title')} onChange={e => set({ title: e.target.value })} />
      <textarea className="bt-field" rows={3} value={draft.body} maxLength={20_000} aria-label={t('ui.task.body')} placeholder={t('ui.newtask.body')} onChange={e => set({ body: e.target.value })} />
      <div className="ui-newtask__row">
        <span className="bt-seg" role="group" aria-label={t('ui.task.priority')}>
          {PRIORITIES.map(p => <button key={p} type="button" className="bt-seg__opt" aria-pressed={draft.priority === p} onClick={() => set({ priority: p })}>{t(PRIORITY_KEY[p])}</button>)}
        </span>
        <span className="bt-seg" role="group" aria-label={t('ui.newtask.when')}>
          <button type="button" className="bt-seg__opt" aria-pressed={draft.when === 'now'} onClick={() => set({ when: 'now' })}>{t('ui.newtask.now')}</button>
          <button type="button" className="bt-seg__opt" aria-pressed={draft.when === 'at'} onClick={() => set({ when: 'at' })}>{t('ui.newtask.at')}</button>
        </span>
        {draft.when === 'at' && <input className="bt-field ui-newtask__at" type="datetime-local" value={draft.at} aria-label={t('ui.newtask.time')} onChange={e => set({ at: e.target.value })} />}
        {draft.when === 'at' && <span className="bt-meta">{timezoneLabel()}</span>}
      </div>
      {error && <p className="bt-meta ui-danger ui-newtask__error" role="alert">{error}</p>}
      <div className="ui-newtask__row">
        <Button type="submit" variant="primary" small disabled={busy}>{t('ui.newtask.create')}</Button>
        <Button variant="ghost" small onClick={onClose}>{t('ui.cancel')}</Button>
      </div>
    </form>
  );
}

function columnName(t: T, id: ColumnId): string { return t(COLUMN_KEY[id]); }

export function Kanban({ conversations, drafts, checklists, revision }: KanbanProps) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [moreBusy, setMoreBusy] = useState(false);
  const [tab, setTab] = useState<ColumnId>('proposed');
  const tabbed = useMedia(COLUMN_TABS_MEDIA);
  const loads = useRef(latestOnly());
  const wanted = useRef(KANBAN_PAGE);
  const first = useRef(true);
  const newButton = useRef<HTMLButtonElement>(null);
  const lastRejecting = useRef<string | null>(null);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [tasks, finished, runs] = await Promise.all([api.tasks(), readFinished(wanted.current), api.runs(RUNS_WINDOW)]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ active: tasks.active, finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);

  const runKey = drafts.map(d => d.runId).join(',');
  useEffect(() => {
    const timer = setTimeout(() => void load(), first.current ? 0 : RELOAD_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [load, revision, runKey]);

  useEffect(() => {
    if (rejecting === null && lastRejecting.current !== null) document.querySelector<HTMLElement>(`[data-reject="${CSS.escape(lastRejecting.current)}"]`)?.focus();
    lastRejecting.current = rejecting;
  }, [rejecting]);

  const sessions = useMemo(() => sessionCards({ conversations, drafts, runs: data?.runs ?? [], checklists }), [conversations, drafts, data, checklists]);
  const board = useMemo(
    () => (data ? buildBoard({ active: data.active, finished: data.finished, hasMore: data.next !== null, finishedTotal: data.total, sessions, checklists }) : null),
    [data, sessions, checklists],
  );
  const ticking = sessions.some(card => card.outcome === 'running');
  const now = useNow(ticking ? 1000 : 30_000);

  const act = async (id: string, run: () => Promise<boolean>) => {
    if (busy.has(id)) return;
    setBusy(current => new Set(current).add(id));
    try { if (await run()) await load(); } finally {
      setBusy(current => { const next = new Set(current); next.delete(id); return next; });
    }
  };
  const more = async () => {
    if (moreBusy) return;
    setMoreBusy(true);
    wanted.current = pagesToReload((data?.finished.length ?? 0) + KANBAN_PAGE);
    try { await load(); } finally { setMoreBusy(false); }
  };
  const closeNew = () => { setCreating(false); newButton.current?.focus(); };

  const renderCard = (card: Card, index: number, firstTask: boolean) => {
    if (card.kind === 'session') return <SessionCardView key={card.key} card={card} now={now} index={index} />;
    const { task } = card;
    return (
      <TaskCardView key={card.key} card={card} now={now} index={index} first={firstTask} busy={busy.has(task.id)} rejecting={rejecting === task.id}
        onApprove={() => void act(task.id, () => runTaskOp('approve', task))}
        onReject={reason => void act(task.id, async () => { const ok = await runTaskOp('reject', task, { reason }); if (ok) setRejecting(null); return ok; })}
        onRejecting={on => setRejecting(on ? task.id : null)} />
    );
  };

  return (
    <div className="bt-screen__inner bt-screen__inner--wide">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.kanban')}</h1>
        <div className="bt-screen__tools">
          <Button ref={newButton} icon="plus" aria-expanded={creating} onClick={() => setCreating(open => !open)}>{t('ui.kanban.new')}</Button>
        </div>
      </header>
      {creating && <NewTask onClose={closeNew} />}
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {board && (
        <>
          <div className="bt-tabs ui-coltabs" role="tablist" aria-label={t('ui.kanban.columns')}>
            {board.columns.map(column => (
              <button key={column.id} type="button" role="tab" className="bt-tab" id={`ui-coltab-${column.id}`} aria-controls={`ui-col-${column.id}`}
                aria-selected={tab === column.id} tabIndex={tab === column.id ? 0 : -1} onClick={() => setTab(column.id)}
                onKeyDown={e => {
                  const to = tabStep(board.columns.findIndex(c => c.id === tab), board.columns.length, e.key);
                  const target = to === null ? undefined : board.columns[to];
                  if (!target) return;
                  e.preventDefault();
                  setTab(target.id);
                  document.getElementById(`ui-coltab-${target.id}`)?.focus();
                }}>
                {columnName(t, column.id)}<span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`}><span className="bt-count__n">{countText(column.cards.length)}</span></span>
              </button>
            ))}
          </div>
          <div className="bt-board">
            {board.columns.map(column => {
              const firstTask = column.cards.findIndex(card => card.kind === 'task' && !(card.task.run_at !== null && card.task.run_at > now));
              return (
                <section key={column.id} id={`ui-col-${column.id}`} className={`bt-col${tab === column.id ? '' : ' ui-col--off'}`} aria-label={columnName(t, column.id)} {...(tabbed ? { role: 'tabpanel' } : {})}>
                  <div className="bt-col__head">
                    <span className="bt-label">{columnName(t, column.id)}</span>
                    <span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`} aria-label={t('ui.kanban.count', column.cards.length)}><span className="bt-count__n">{countText(column.cards.length)}</span></span>
                  </div>
                  {column.cards.map((card, index) => renderCard(card, index, index === firstTask))}
                  {column.id === 'proposed' && column.cards.length === 0 && <p className="bt-meta ui-col__empty">{t('ui.kanban.noProposals')}</p>}
                  {(column.id === 'done' || column.id === 'failed') && board.more > 0 && (
                    <button type="button" className="bt-tool__link bt-meta ui-more" disabled={moreBusy} title={t('ui.kanban.moreHint')} onClick={() => void more()}>{t('ui.kanban.more', board.more)}</button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
