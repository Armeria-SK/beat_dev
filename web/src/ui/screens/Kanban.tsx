import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, type Acceptance, type ChecklistItem, type Conversation, type FinishedCursor, type Project, type RunRow, type Task, type WaitReason } from '../../api.ts';
import { waitText } from '../wait.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, formatElapsed, formatRelative, timezoneLabel, useT } from '../../i18n/index.ts';
import { buildNewTask, emptyDraft, PRIORITIES, type TaskDraft } from '../../task-form.ts';
import { plainLine } from '../../task-meta.ts';
import { evidenceLines, remainingItems } from '../acceptance.ts';
import { useMedia, useNow } from '../hooks.ts';
import {
  awaitsCheck, buildBoard, cardProject, COLUMN_TABS_MEDIA, firstSentences, KANBAN_PAGE, NARROW_COLUMNS, mergeFinished, pagesToReload, pendingRoute, pendingWait, proposalOf, questionsRoute, RUNS_WINDOW, sessionCards, stepPercent, tabStep,
  type Card, type Column, type ColumnId, type SessionCard, type Step, type TaskCard,
} from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { Button, countText, Notice, Pill } from '../parts.tsx';
import { inFilter, newTaskProduct, optionLabel, productName, settleFilter, withProduct } from '../product-meta.ts';
import { ALL_PRODUCTS, filterOptions, filterQuery, sidebarOrder, type ProductFilter } from '../products.ts';
import '../styles/product-filter.css';
import { routeHash } from '../routes.ts';
import { checkOp, reportOpError, runTaskOp } from '../task-ops.ts';

type T = ReturnType<typeof useT>;

export interface KanbanProps {
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  revision: number;
  projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>;
  questionsByTask: ReadonlyMap<string, number>;
  waits?: Record<string, WaitReason> | undefined;
  productId?: string | undefined;
  emptyProposed?: ReactNode;
}

interface Loaded { active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[]; lists: ReadonlyMap<string, Acceptance> }

const COLUMN_KEY = {
  proposed: 'ui.kanban.col.proposed', approved: 'ui.kanban.col.approved', progress: 'ui.kanban.col.progress', check: 'ui.kanban.col.check', done: 'ui.kanban.col.done', failed: 'ui.kanban.col.failed',
} as const satisfies Record<ColumnId, string>;
export const PRIORITY_KEY = { 1: 'ui.task.priority.1', 2: 'ui.task.priority.2', 3: 'ui.task.priority.3' } as const;
const RELOAD_DELAY_MS = 150;

export async function readFinished(count: number, project?: string): Promise<{ tasks: Task[]; next: FinishedCursor | null; total: number }> {
  let tasks: Task[] = [];
  let next: FinishedCursor | null = null;
  let total = 0;
  do {
    const page = await api.finishedTasks(next, Math.min(100, count - tasks.length), project);
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

function Head({ label, dot, right, product }: { label: string; dot: boolean; right?: ReactNode; product: string | null }) {
  return (
    <div className="bt-card__head">
      {dot ? <span className="bt-card__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{label}</span></span> : <span className="bt-label">{label}</span>}
      {product ? <span className="bt-card__kind">{right}<span className="bt-tag">{product}</span></span> : right}
    </div>
  );
}

function Meta({ items }: { items: Array<string | false | null> }) {
  const shown = items.filter((item): item is string => Boolean(item));
  if (shown.length === 0) return null;
  return <div className="bt-card__meta">{shown.map(item => <span key={item}>{item}</span>)}</div>;
}

function SessionCardView({ card, now, index, product }: { card: SessionCard; now: number; index: number; product: string | null }) {
  const t = useT();
  const running = card.outcome === 'running';
  const right = running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : card.outcome === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : card.outcome === 'stopped' ? <span className="bt-tag">{t('ui.kanban.stopped')}</span> : undefined;
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}`} style={{ '--bt-i': index } as CSSProperties}>
      <Head label={t('ui.kanban.session')} dot={false} right={right} product={running ? null : product} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'chat', id: card.conversationId })}>{card.title || t('ui.session.untitled')}</a></h3>
      {running && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      <Meta items={running
        ? [product, card.step && t('ui.kanban.step', card.step.step, card.step.total), card.startedAt !== null && formatElapsed(now - card.startedAt)]
        : [formatRelative(card.at, now)]} />
    </article>
  );
}

function CheckItems({ task, list }: { task: Task; list: Acceptance | null }) {
  const rows = remainingItems(task, list);
  if (rows.length === 0) return null;
  return (
    <ul className="ui-check__items">
      {rows.map(({ id, item }) => {
        const evidence = item ? evidenceLines(item.evidence ?? [], { short: true }) : [];
        return (
          <li key={id} className="ui-check__item" data-item={id}>
            <span className="bt-tag">{id}</span>
            <span className="ui-check__text">{item?.result ?? ''}{evidence.map(line => <span key={line.text} className="bt-meta ui-check__ev">{line.text}</span>)}</span>
          </li>
        );
      })}
    </ul>
  );
}

function TaskCardView({ card, now, index, first, busy, rejecting, product, pending, questions, list, wait, onApprove, onReject, onRejecting, onChecked }: {
  card: TaskCard; now: number; index: number; first: boolean; busy: boolean; rejecting: boolean; product: string | null; pending: number; questions: number; list: Acceptance | null; wait: WaitReason | undefined;
  onApprove: () => void; onReject: (reason: string) => void; onRejecting: (on: boolean) => void; onChecked: () => void;
}) {
  const t = useT();
  const { task, column } = card;
  const [reason, setReason] = useState('');
  const running = task.status === 'running';
  const proposal = proposalOf(task);
  const label = proposal && column === 'proposed' ? t(proposal.kind === 'bug' ? 'ui.kanban.proposal.bug' : 'ui.kanban.proposal.feature') : column === 'approved' ? t('ui.kanban.queued') : column === 'check' ? t('ui.kanban.checkIt') : t('ui.kanban.task');
  const right = column === 'proposed' ? <span className="bt-meta">{formatRelative(task.created_at, now)}</span>
    : running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : task.status === 'waiting' ? <Pill tone="waiting">{t('ui.kanban.waiting')}</Pill>
    : task.status === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : task.status === 'cancelled' ? <span className="bt-tag">{t(task.cancelled_from === 'inbox' ? 'ui.kanban.rejected' : 'ui.kanban.cancelled')}</span> : undefined;
  const onPending = pendingWait(task);
  const body = column === 'proposed' ? (proposal ? firstSentences(proposal.why) : plainLine(task.body, 200)) : onPending ? '' : task.status === 'waiting' ? plainLine(task.waiting_text, 200) : column === 'failed' ? plainLine(task.result_summary, 120) : '';
  const timed = task.run_at !== null && task.run_at > now;
  const meta: Array<string | false | null> = column === 'approved'
    ? [timed ? t('ui.kanban.starts', formatDateTimeSmart(task.run_at, now)) : first && t('ui.kanban.next'), task.status === 'ready' && wait !== undefined && waitText(wait, now), card.repeating && t('ui.kanban.repeating')]
    : column === 'progress' ? [running && product, card.step && t('ui.kanban.step', card.step.step, card.step.total), card.repeating && t('ui.kanban.repeating')]
    : column === 'proposed' && proposal ? [...new Set(proposal.area), t('ui.kanban.proposal.size', proposal.size), proposal.goal !== null && t('ui.kanban.proposal.goal', proposal.goal)]
    : column === 'proposed' ? [task.origin !== 'user' && t('ui.kanban.byBeat'), card.repeating && t('ui.kanban.repeating')]
    : [formatRelative(card.at, now), column === 'check' && task.items !== undefined && t('ui.check.met', task.items.met, task.items.owned), card.repeating && t('ui.kanban.repeating')];
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}${rejecting ? ' is-rejecting' : ''}`} style={{ '--bt-i': index } as CSSProperties}>
      <Head label={label} dot={card.waiting} right={right} product={running ? null : product} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a></h3>
      {body && <p className="bt-card__body">{body}</p>}
      {onPending && <p className="bt-card__body"><a className="bt-tool__link" href={routeHash(onPending.route)} data-pending-wait={task.id}>{t('ui.kanban.waitingPending', onPending.refs)}</a></p>}
      {column === 'progress' && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      {column === 'check' && <CheckItems task={task} list={list} />}
      <Meta items={meta} />
      {column === 'proposed' && proposal && proposal.goal === null && <div className="bt-card__meta"><span className="bt-tag" data-off-plan>{t('ui.kanban.proposal.offPlan')}</span></div>}
      {pending > 0 && !onPending && <a className="bt-tool__link bt-meta" href={routeHash(pendingRoute(task))}>{t('ui.task.pending', pending)}</a>}
      {questions > 0 && <a className="bt-tool__link bt-meta" href={routeHash(questionsRoute(task))} data-questions={questions}>{t('ui.task.questions', questions)}</a>}
      {column === 'check' && (
        <div className="bt-card__actions">
          <Button variant="primary" small disabled={busy || !list} onClick={onChecked}>{t('ui.check.markChecked')}</Button>
          <a className="bt-btn bt-btn--sm" href={routeHash({ view: 'task', id: task.id })}>{t('ui.kanban.open')}</a>
        </div>
      )}
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

export function ProductPick({ projects, value, onChange }: { projects: readonly Project[]; value: string | null; onChange: (id: string | null) => void }) {
  const t = useT();
  const shown = sidebarOrder(projects);
  if (shown.length === 0) return null;
  return (
    <select className="bt-field ui-sched__pick" value={value ?? ''} aria-label={t('ui.pf.product')} onChange={e => onChange(e.target.value || null)}>
      <option value="">{t('ui.section.noProduct')}</option>
      {shown.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
    </select>
  );
}

function NewTask({ projects, product: initial, onClose }: { projects: readonly Project[]; product: string | null; onClose: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft);
  const [product, setProduct] = useState(initial);
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
      const { task } = await api.createTask(withProduct(built.task, product));
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
        <ProductPick projects={projects} value={product} onChange={setProduct} />
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

export function Kanban({ conversations, drafts, checklists, revision, projects, pendingByTask, questionsByTask, waits, productId, emptyProposed }: KanbanProps) {
  const t = useT();
  const [picked, setPicked] = useState<ProductFilter>(ALL_PRODUCTS);
  const pane = productId !== undefined;
  const filter = productId ?? settleFilter(picked, projects);
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [moreBusy, setMoreBusy] = useState(false);
  const [tab, setTab] = useState<ColumnId>('proposed');
  const tabbed = useMedia(COLUMN_TABS_MEDIA);
  const order = (columns: Column[]): Column[] => (tabbed ? NARROW_COLUMNS.flatMap(id => columns.filter(c => c.id === id)) : columns);
  const loads = useRef(latestOnly());
  const wanted = useRef(KANBAN_PAGE);
  const first = useRef(true);
  const newButton = useRef<HTMLButtonElement>(null);
  const lastRejecting = useRef<string | null>(null);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    const project = filterQuery(filter);
    try {
      const [tasks, finished, runs] = await Promise.all([api.tasks(project), readFinished(wanted.current, project), api.runs(RUNS_WINDOW, project)]);
      const active = [...tasks.active, ...(tasks.awaiting ?? [])];
      const products = [...new Set([...active, ...finished.tasks].filter(awaitsCheck).flatMap(task => (task.project_id ? [task.project_id] : [])))];
      const lists = new Map((await Promise.all(products.map(id => api.acceptance(id).then(r => [id, r.acceptance] as const, () => null)))).filter(entry => entry !== null));
      if (!loads.current.isCurrent(ticket)) return;
      setData({ active, finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs, lists });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [filter]);

  const runKey = drafts.map(d => d.runId).join(',');
  const lastFilter = useRef(filter);
  useEffect(() => {
    const switched = lastFilter.current !== filter;
    lastFilter.current = filter;
    if (switched) wanted.current = KANBAN_PAGE;
    const timer = setTimeout(() => void load(), first.current || switched ? 0 : RELOAD_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [load, filter, revision, runKey]);

  useEffect(() => {
    if (rejecting === null && lastRejecting.current !== null) document.querySelector<HTMLElement>(`[data-reject="${CSS.escape(lastRejecting.current)}"]`)?.focus();
    lastRejecting.current = rejecting;
  }, [rejecting]);

  const sessions = useMemo(() => sessionCards({ conversations: inFilter(conversations, filter), drafts, runs: data?.runs ?? [], checklists }), [conversations, filter, drafts, data, checklists]);
  const board = useMemo(
    () => (data ? buildBoard({ active: inFilter(data.active, filter), finished: inFilter(data.finished, filter), hasMore: data.next !== null, finishedTotal: data.total, sessions, checklists }) : null),
    [data, filter, sessions, checklists],
  );
  const options = projects.some(p => p.archived_at === null) ? filterOptions(projects) : [];
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
    const product = pane ? null : productName(projects, cardProject(card));
    if (card.kind === 'session') return <SessionCardView key={card.key} card={card} now={now} index={index} product={product} />;
    const { task } = card;
    return (
      <TaskCardView key={card.key} card={card} now={now} index={index} first={firstTask} busy={busy.has(task.id)} rejecting={rejecting === task.id} product={product} pending={pendingByTask.get(task.id) ?? 0} questions={questionsByTask.get(task.id) ?? 0} wait={waits?.[task.id]}
        onApprove={() => void act(task.id, () => runTaskOp('approve', task))}
        onReject={reason => void act(task.id, async () => { const ok = await runTaskOp('reject', task, { reason }); if (ok) setRejecting(null); return ok; })}
        onRejecting={on => setRejecting(on ? task.id : null)}
        list={(task.project_id && data?.lists.get(task.project_id)) || null}
        onChecked={() => void act(task.id, async () => { const list = task.project_id ? data?.lists.get(task.project_id) : undefined; if (list) await checkOp(task, list.version); return true; })} />
    );
  };

  return (
    <div className={pane ? 'ui-kanban ui-kanban--pane' : 'bt-screen__inner bt-screen__inner--wide ui-kanban'} data-kanban={pane ? 'pane' : 'screen'}>
      {!pane && <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.kanban')}</h1>
        <div className="bt-screen__tools">
          {options.length > 0 && (
            <div className="bt-seg ui-pfilter" role="group" aria-label={t('ui.pf.filter')}>
              {options.map(option => (
                <button key={option.key} type="button" className="bt-seg__opt" aria-pressed={filter === option.key} onClick={() => setPicked(option.key)}>
                  {optionLabel(option, t('ui.runs.all'), t('ui.section.noProduct'))}
                </button>
              ))}
            </div>
          )}
          <Button ref={newButton} icon="plus" aria-expanded={creating} onClick={() => setCreating(open => !open)}>{t('ui.kanban.new')}</Button>
        </div>
      </header>}
      {creating && <NewTask projects={projects} product={newTaskProduct(filter)} onClose={closeNew} />}
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {!board && !failed && <p className="bt-meta ui-col__empty" role="status" data-loading>{t('ui.set.loading')}</p>}
      {board && pane && emptyProposed && board.columns.every(column => column.cards.length === 0) && <div className="ui-kanban__empty">{emptyProposed}</div>}
      {board && !(pane && emptyProposed && board.columns.every(column => column.cards.length === 0)) && (
        <>
          <div className="bt-tabs ui-coltabs" role="tablist" aria-label={t('ui.kanban.columns')}>
            {order(board.columns).map(column => (
              <button key={column.id} type="button" role="tab" className="bt-tab" id={`ui-coltab-${column.id}`} aria-controls={`ui-col-${column.id}`}
                aria-selected={tab === column.id} tabIndex={tab === column.id ? 0 : -1} onClick={() => setTab(column.id)}
                onKeyDown={e => {
                  const to = tabStep(order(board.columns).findIndex(c => c.id === tab), board.columns.length, e.key);
                  const target = to === null ? undefined : order(board.columns)[to];
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
            {order(board.columns).map(column => {
              const firstTask = column.cards.findIndex(card => card.kind === 'task' && !(card.task.run_at !== null && card.task.run_at > now) && waits?.[card.task.id]?.kind !== 'off');
              return (
                <section key={column.id} id={`ui-col-${column.id}`} className={`bt-col${tab === column.id ? '' : ' ui-col--off'}`} aria-label={columnName(t, column.id)} {...(tabbed ? { role: 'tabpanel' } : {})}>
                  <div className="bt-col__head">
                    <span className="bt-label">{columnName(t, column.id)}</span>
                    <span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`} aria-label={t('ui.kanban.count', column.cards.length)}><span className="bt-count__n">{countText(column.cards.length)}</span></span>
                  </div>
                  <div className="ui-col__cards">
                    {column.cards.map((card, index) => renderCard(card, index, index === firstTask))}
                    {column.id === 'proposed' && column.cards.length === 0 && (emptyProposed ?? <p className="bt-meta ui-col__empty">{t('ui.kanban.noProposals')}</p>)}
                    {(column.id === 'done' || column.id === 'failed') && board.more > 0 && (
                      <button type="button" className="bt-tool__link bt-meta ui-more" disabled={moreBusy} title={t('ui.kanban.moreHint')} onClick={() => void more()}>{t('ui.kanban.more', board.more)}</button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
