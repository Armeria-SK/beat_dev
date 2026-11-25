import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { api, ApiError, type Project, type RepeatingTask, type ScheduleView, type Task } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatDateTimeSmart, formatRelative, formatZonedInput, getTimezone, startOfDay, timezoneLabel, useT } from '../../i18n/index.ts';
import { buildNewTask, draftError, draftSummary, emptyDraft, FREQS, PRIORITIES, type DraftError, type Freq, type TaskDraft } from '../../task-form.ts';
import { STATUS_KEY } from '../../task-meta.ts';
import { WEEKDAYS } from '../../weekdays.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { Button, countText, Notice, Pill } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import {
  confirmStale, draftFromTask, otherZone, RELOAD_DELAY_MS, reloadWait, repeatPatch, runNowKind, splitSchedule, timePatch, type DeleteBlock, type RepeatingRow, type TimedRow,
} from '../schedule.ts';
import { liveProductId, reportOpError, runTaskOp, undoAction } from '../task-ops.ts';
import { buildRows, dayHours, nowAt, scrollToNow, windowOf, type Bar, type Range, type Stream, type TimeWindow } from '../timeline.ts';
import { productName, withProduct } from '../product-meta.ts';
import { sidebarOrder } from '../products.ts';
import { PRIORITY_KEY, ProductPick } from './Kanban.tsx';

type T = ReturnType<typeof useT>;

export interface ScheduleProps { revision: number; projects: readonly Project[] }

interface Loaded { repeating: RepeatingTask[]; active: Task[]; schedule: ScheduleView; range: Range; window: TimeWindow }

const FREQ_KEY = {
  daily: 'ui.schedule.freq.daily', weekday: 'ui.schedule.freq.weekday', weekly: 'ui.schedule.freq.weekly', hourly: 'ui.schedule.freq.hourly', interval: 'ui.schedule.freq.interval',
} as const satisfies Record<Freq, string>;
const ERROR_KEY = {
  title: 'ui.newtask.needTitle', at: 'ui.newtask.needTime', time: 'ui.schedule.needClock', minute: 'ui.schedule.needMinute', interval: 'ui.schedule.needInterval',
} as const satisfies Record<DraftError, string>;
const BLOCK_KEY = { run_open: 'ui.schedule.block.runOpen', ran: 'ui.schedule.block.ran', linked: 'ui.schedule.block.linked' } as const satisfies Record<DeleteBlock, string>;
const STATE_KEY = { past: 'ui.schedule.slot.past', live: 'ui.schedule.slot.live', planned: 'ui.schedule.slot.planned' } as const;

const yearOf = (ms: number): string => formatDateTime(ms, 'full').slice(0, 4);
const whenText = (ms: number, now: number): string => (yearOf(ms) === yearOf(now) ? formatDateTimeSmart(ms, now) : formatDateTime(ms, 'full'));
const dayLabel = (ms: number, options: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat('en-GB', { timeZone: getTimezone(), ...options }).format(ms);

function summaryText(t: T, draft: TaskDraft): string | null {
  const summary = draftSummary(draft);
  if (!summary) return null;
  switch (summary.kind) {
    case 'daily': return t('ui.schedule.sum.daily', summary.time);
    case 'weekday': return t('ui.schedule.sum.weekday', summary.time);
    case 'weekly': return t('ui.schedule.sum.weekly', t(WEEKDAYS.find(d => d.value === summary.day)?.label ?? WEEKDAYS[0].label), summary.time);
    case 'hourly': return t('ui.schedule.sum.hourly', summary.minute);
    case 'interval': return t('ui.schedule.sum.interval', summary.every);
    case 'at': return t('ui.schedule.sum.at', formatDateTime(summary.ms, 'full'));
  }
}

function RuleFields({ draft, set, zone }: { draft: TaskDraft; set: (patch: Partial<TaskDraft>) => void; zone?: string | null | undefined }) {
  const t = useT();
  const timed = draft.freq === 'daily' || draft.freq === 'weekday' || draft.freq === 'weekly';
  return (
    <div className="ui-newtask__row">
      <select className="bt-field ui-sched__pick" value={draft.freq} aria-label={t('ui.schedule.repeat')} onChange={e => set({ freq: e.target.value as Freq })}>
        {FREQS.map(freq => <option key={freq} value={freq}>{t(FREQ_KEY[freq])}</option>)}
      </select>
      {draft.freq === 'weekly' && (
        <select className="bt-field ui-sched__pick" value={draft.day} aria-label={t('ui.schedule.day')} onChange={e => set({ day: e.target.value })}>
          {WEEKDAYS.map(day => <option key={day.value} value={day.value}>{t(day.label)}</option>)}
        </select>
      )}
      {timed && <input className="bt-field ui-newtask__at" type="time" value={draft.time} aria-label={t('ui.schedule.clock')} onChange={e => set({ time: e.target.value })} />}
      {draft.freq === 'hourly' && <input className="bt-field ui-sched__num" type="number" min={0} max={59} value={draft.minute} aria-label={t('ui.schedule.minute')} onChange={e => set({ minute: e.target.value })} />}
      {draft.freq === 'interval' && <input className="bt-field ui-sched__num" type="number" min={1} max={59} value={draft.interval} aria-label={t('ui.schedule.interval')} onChange={e => set({ interval: e.target.value })} />}
      <span className="bt-meta">{timezoneLabel()}</span>
      {zone && <span className="bt-meta">{t('ui.schedule.zoneWas', timezoneLabel(zone))}</span>}
    </div>
  );
}

function ScheduleForm({ task, projects = [], onClose, onSaved }: { task: RepeatingTask | null; projects?: readonly Project[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [start] = useState(() => (task ? draftFromTask(task) : { draft: { ...emptyDraft(), when: 'repeat' as const }, ruleKnown: true }));
  const [draft, setDraft] = useState<TaskDraft>(start.draft);
  const [product, setProduct] = useState<string | null>(null);
  const [ruleOpen, setRuleOpen] = useState(start.ruleKnown);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TaskDraft>) => { setDraft(d => ({ ...d, ...patch })); setError(''); };
  const label = task ? t('ui.schedule.editing', task.title) : t('ui.schedule.new');
  const repeat = draft.when === 'repeat';
  const liveProduct = liveProductId(projects, product);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = draftError(task && !ruleOpen ? { ...draft, when: 'now' } : draft);
    if (problem) { setError(t(ERROR_KEY[problem])); return; }
    setBusy(true);
    try {
      if (task) {
        const patch = repeatPatch(start.draft, draft, { known: start.ruleKnown, open: ruleOpen });
        if (Object.keys(patch).length > 0) {
          await api.editTask(task.id, patch);
          toast({ icon: 'check', title: t('ui.task.toast.saved'), body: draft.title.trim() });
        }
      } else {
        const built = buildNewTask(draft);
        if (!built.ok) { setError(t(ERROR_KEY[built.error])); setBusy(false); return; }
        const { task: created } = await api.createTask(withProduct(built.task, liveProduct));
        toast({ kind: 'done', icon: 'check', title: t(repeat ? 'ui.schedule.toast.created' : 'ui.task.toast.created'), body: created.title, href: routeHash({ view: 'task', id: created.id }) });
      }
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('ui.task.saveFailed'));
      setBusy(false);
    }
  };
  const summary = (!task || ruleOpen) ? summaryText(t, draft) : null;
  return (
    <form className="ui-newtask bt-rise" aria-label={label} onSubmit={e => void submit(e)}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <input className="bt-field" autoFocus value={draft.title} maxLength={200} aria-label={t('ui.task.title')} placeholder={t('ui.task.title')} onChange={e => set({ title: e.target.value })} />
      <textarea className="bt-field" rows={3} value={draft.body} maxLength={20_000} aria-label={t('ui.task.body')} placeholder={t('ui.newtask.body')} onChange={e => set({ body: e.target.value })} />
      <div className="ui-newtask__row">
        {!task && <ProductPick projects={projects} value={liveProduct} onChange={setProduct} />}
        <span className="bt-seg" role="group" aria-label={t('ui.task.priority')}>
          {PRIORITIES.map(p => <button key={p} type="button" className="bt-seg__opt" aria-pressed={draft.priority === p} onClick={() => set({ priority: p })}>{t(PRIORITY_KEY[p])}</button>)}
        </span>
        {!task && (
          <span className="bt-seg" role="group" aria-label={t('ui.newtask.when')}>
            <button type="button" className="bt-seg__opt" aria-pressed={repeat} onClick={() => set({ when: 'repeat' })}>{t('ui.schedule.repeat')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={!repeat} onClick={() => set({ when: 'at' })}>{t('ui.newtask.at')}</button>
          </span>
        )}
      </div>
      {repeat && ruleOpen && <RuleFields draft={draft} set={set} zone={task ? otherZone(task.timezone, getTimezone()) : null} />}
      {task && !ruleOpen && (
        <div className="ui-newtask__row">
          <span className="bt-meta">{t('ui.schedule.ruleNow', task.cron_text ?? task.cron ?? '')}</span>
          <Button small onClick={() => setRuleOpen(true)}>{t('ui.schedule.changeRule')}</Button>
        </div>
      )}
      {!repeat && (
        <div className="ui-newtask__row">
          <input className="bt-field ui-newtask__at" type="datetime-local" value={draft.at} aria-label={t('ui.newtask.time')} onChange={e => set({ at: e.target.value })} />
          <span className="bt-meta">{timezoneLabel()}</span>
        </div>
      )}
      {summary && <p className="bt-meta ui-newtask__error">{summary}</p>}
      {error && <p className="bt-meta ui-danger ui-newtask__error" role="alert">{error}</p>}
      <div className="ui-newtask__row">
        <Button type="submit" variant="primary" small disabled={busy}>{task ? t('ui.task.save') : t('ui.newtask.create')}</Button>
        <Button variant="ghost" small onClick={onClose}>{t('ui.cancel')}</Button>
      </div>
    </form>
  );
}

function TimeForm({ task, onClose, onSaved }: { task: Task; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [initial] = useState(() => (task.run_at === null ? '' : formatZonedInput(task.run_at)));
  const [at, setAt] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const patch = timePatch(initial, at);
    if (patch === 'invalid') { setError(t('ui.newtask.needTime')); return; }
    setBusy(true);
    try {
      if (patch) {
        await api.editTask(task.id, patch);
        toast({ icon: 'check', title: t('ui.task.toast.saved'), body: task.title });
      }
      onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('ui.task.saveFailed'));
      setBusy(false);
    }
  };
  return (
    <form className="ui-sched__time" aria-label={t('ui.schedule.editing', task.title)} onSubmit={e => void submit(e)}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
      <input className="bt-field ui-newtask__at" type="datetime-local" autoFocus value={at} aria-label={t('ui.newtask.time')} onChange={e => { setAt(e.target.value); setError(''); }} />
      <span className="bt-meta">{timezoneLabel()}</span>
      <Button type="submit" variant="primary" small disabled={busy}>{t('ui.task.save')}</Button>
      <Button variant="ghost" small onClick={onClose}>{t('ui.cancel')}</Button>
      {error && <span className="bt-meta ui-danger" role="alert">{error}</span>}
    </form>
  );
}

function DeleteConfirm({ note, busy, onDelete, onKeep }: { note: string; busy: boolean; onDelete: () => void; onKeep: (refocus: boolean) => void }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef(onKeep);
  keep.current = onKeep;
  useEffect(() => {
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) keep.current(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  return (
    <div ref={box} className="ui-sched__confirm" role="group" aria-label={t('ui.schedule.deleteWarn')}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onKeep(true); } }}>
      <span className="bt-meta ui-danger">{t('ui.schedule.deleteWarn')}</span>
      <span className="bt-meta ui-sched__note">{note}</span>
      <span className="ui-sched__buttons">
        <Button variant="danger" small disabled={busy} onClick={onDelete}>{t('ui.schedule.delete')}</Button>
        <Button variant="ghost" small autoFocus onClick={() => onKeep(true)}>{t('ui.schedule.keep')}</Button>
      </span>
    </div>
  );
}

interface RowActions {
  busy: boolean;
  confirming: boolean;
  editing: boolean;
  onConfirm: (on: boolean, refocus?: boolean) => void;
  onEdit: (on: boolean) => void;
  onDelete: () => void;
  run: (action: () => Promise<unknown>, done?: { title: string; icon?: 'check' | 'undo'; undo?: () => Promise<unknown> }) => void;
  reload: () => void;
}

function RepeatingItem({ row, now, actions, product }: { row: RepeatingRow; now: number; actions: RowActions; product: string | null }) {
  const t = useT();
  const { task, state, next, last, blocked, openRun } = row;
  const runNow = runNowKind(state);
  if (actions.editing) return <li className="bt-row ui-sched ui-sched--form"><ScheduleForm task={task} onClose={() => actions.onEdit(false)} onSaved={actions.reload} /></li>;
  const when = state === 'active' ? (next !== null ? t('ui.schedule.next', whenText(next, now), formatRelative(next, now)) : null) : t(state === 'paused' ? 'ui.schedule.pausedMeta' : 'ui.schedule.endedMeta');
  return (
    <li className="bt-row ui-sched" data-task={task.id}>
      <div className="bt-row__main">
        <a className="bt-row__title ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a>
        <span className="bt-row__sub bt-meta">{[product, task.cron_text ?? task.cron, when].filter(Boolean).join(' · ')}</span>
        <span className="bt-row__sub bt-meta">
          {last
            ? <>{t('ui.schedule.last')} <a className="bt-tool__link" href={routeHash({ view: 'task', id: last.id })}>{formatRelative(last.at, now)}</a> · {t(STATUS_KEY[last.status])}{last.summary ? ` · ${last.summary}` : ''}</>
            : t('ui.schedule.neverRan')}
        </span>
        {blocked && !actions.confirming && <span className="bt-row__sub bt-meta">{t(BLOCK_KEY[blocked])}</span>}
      </div>
      {actions.confirming ? (
        <DeleteConfirm note={t('ui.schedule.deleteNote.repeating')} busy={actions.busy} onDelete={actions.onDelete} onKeep={refocus => actions.onConfirm(false, refocus)} />
      ) : (
        <div className="bt-row__end ui-sched__buttons">
          {openRun?.status === 'running' && <Pill tone="running">{t('ui.kanban.running')}</Pill>}
          {openRun?.status === 'waiting' && <Pill tone="waiting">{t('ui.kanban.waiting')}</Pill>}
          {openRun && <Button variant="ghost" small disabled={actions.busy} onClick={() => actions.run(() => runTaskOp('cancel', { id: openRun.id, title: task.title }))}>{t('ui.schedule.cancelRun')}</Button>}
          {state === 'paused' && <span className="bt-tag">{t('ui.schedule.paused')}</span>}
          {state === 'ended' && <span className="bt-tag">{t('ui.schedule.ended')}</span>}
          {state === 'active' && <Button variant="ghost" small disabled={actions.busy} onClick={() => actions.run(() => api.cancelTask(task.id), { title: t('ui.schedule.toast.paused'), undo: () => api.taskAction(task.id, 'uncancel') })}>{t('ui.schedule.pause')}</Button>}
          {state === 'paused' && <Button small disabled={actions.busy} onClick={() => actions.run(() => api.taskAction(task.id, 'uncancel'), { title: t('ui.schedule.toast.resumed'), icon: 'undo' })}>{t('ui.schedule.resume')}</Button>}
          {runNow && <Button variant="ghost" small disabled={actions.busy} onClick={() => actions.run(() => api.taskAction(task.id, 'run-now'), { title: t(runNow === 'restart' ? 'ui.schedule.toast.restarted' : 'ui.task.toast.started') })}>{t(runNow === 'restart' ? 'ui.schedule.restart' : 'ui.task.runNow')}</Button>}
          <Button variant="ghost" small disabled={actions.busy} data-edit={task.id} onClick={() => actions.onEdit(true)}>{t('ui.schedule.edit')}</Button>
          <Button variant="ghost" small disabled={actions.busy || blocked !== null} title={blocked ? t(BLOCK_KEY[blocked]) : undefined} data-delete={task.id} onClick={() => actions.onConfirm(true)}>{t('ui.schedule.delete')}</Button>
        </div>
      )}
    </li>
  );
}

function TimedItem({ row, now, actions, product }: { row: TimedRow; now: number; actions: RowActions; product: string | null }) {
  const t = useT();
  const { task, at, blocked } = row;
  return (
    <li className="bt-row ui-sched" data-task={task.id}>
      <span className="bt-meta ui-sched__at">{whenText(at, now)}</span>
      <div className="bt-row__main">
        <a className="bt-row__title ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a>
        <span className="bt-row__sub bt-meta">{[product, at <= now ? t('ui.schedule.due') : formatRelative(at, now)].filter(Boolean).join(' · ')}</span>
        {blocked && !actions.confirming && <span className="bt-row__sub bt-meta">{t(BLOCK_KEY[blocked])}</span>}
      </div>
      {actions.editing ? (
        <TimeForm task={task} onClose={() => actions.onEdit(false)} onSaved={actions.reload} />
      ) : actions.confirming ? (
        <DeleteConfirm note={t('ui.schedule.deleteNote.timed')} busy={actions.busy} onDelete={actions.onDelete} onKeep={refocus => actions.onConfirm(false, refocus)} />
      ) : (
        <div className="bt-row__end ui-sched__buttons">
          <Button variant="ghost" small disabled={actions.busy} onClick={() => actions.run(() => api.taskAction(task.id, 'run-now'), { title: t('ui.task.toast.started') })}>{t('ui.task.runNow')}</Button>
          <Button variant="ghost" small disabled={actions.busy} data-edit={task.id} onClick={() => actions.onEdit(true)}>{t('ui.schedule.editTime')}</Button>
          <Button variant="ghost" small disabled={actions.busy} onClick={() => actions.run(() => runTaskOp('cancel', task))}>{t('ui.cancel')}</Button>
          <Button variant="ghost" small disabled={actions.busy || blocked !== null} title={blocked ? t(BLOCK_KEY[blocked]) : undefined} data-delete={task.id} onClick={() => actions.onConfirm(true)}>{t('ui.schedule.delete')}</Button>
        </div>
      )}
    </li>
  );
}

function barTitle(t: T, bar: Bar, range: Range): string {
  const state = t(STATE_KEY[bar.state]);
  if (bar.band) return t('ui.schedule.slot.band', bar.title, state);
  const at = formatDateTime(bar.start, range === 'day' ? 'time' : 'compact');
  return bar.count > 1 ? t('ui.schedule.slot.many', bar.count, at, state) : t('ui.schedule.slot.one', bar.title, at, state);
}

function Timeline({ range, window: win, now, schedule, streams, projects }: { range: Range; window: TimeWindow; now: number; schedule: ScheduleView; streams: Stream[]; projects: readonly Project[] }) {
  const t = useT();
  const scroller = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const slots = useMemo(() => schedule.slots.map(slot => (slot.state === 'live' ? { ...slot, length: Math.max(slot.length, now - slot.start) } : slot)), [schedule.slots, now]);
  const products = useMemo(() => sidebarOrder(projects).map(p => ({ id: p.id, title: t('ui.pf.tasksOf', p.name) })), [projects, t]);
  const rows = useMemo(() => buildRows({ slots, streams, tasksTitle: t('ui.schedule.stream.tasks'), range, window: win, now, products }), [slots, streams, t, range, win, now, products]);
  const at = nowAt(now, win);
  const labels = range === 'day' ? dayHours() : win.days.slice(0, 7).map(day => dayLabel(day, { weekday: 'short', day: 'numeric' }));

  const placed = useRef('');
  useEffect(() => {
    const key = `${range}:${win.from}`;
    if (placed.current === key || !scroller.current || !body.current) return;
    placed.current = key;
    const gutter = Number.parseFloat(getComputedStyle(body.current).getPropertyValue('--bt-gutter')) || 0;
    scroller.current.scrollLeft = scrollToNow(at, body.current.scrollWidth, gutter, scroller.current.clientWidth);
  }, [range, win.from, at]);

  return (
    <section ref={scroller} className="bt-timeline bt-rise ui-timeline" tabIndex={0} aria-label={t(range === 'day' ? 'ui.schedule.today' : 'ui.schedule.week')}>
      <div ref={body} className="bt-timeline__body" style={{ '--bt-now': at, '--bt-cols': labels.length } as CSSProperties}>
        <div className="bt-timeline__hours">{labels.map(label => <span key={label}>{label}</span>)}</div>
        {rows.map(row => (
          <div key={row.id} className="bt-timeline__row" data-stream={row.id || 'tasks'}>
            <span className="ui-timeline__name" title={row.title}>
              {row.title}
              {row.paused && <span className="bt-meta"> {t(row.ended ? 'ui.schedule.endedMeta' : 'ui.schedule.pausedMeta')}</span>}
              {row.rule && <span className="bt-meta"> {row.rule}</span>}
            </span>
            <div className="bt-timeline__track">
              {row.bars.map(bar => (
                <span key={`${bar.state}:${bar.start}`} role="img" aria-label={barTitle(t, bar, range)} title={barTitle(t, bar, range)} data-state={bar.state}
                  className={`bt-timeline__slot${bar.state === 'past' ? ' bt-timeline__slot--past' : bar.state === 'live' ? ' bt-timeline__slot--live' : ''}${bar.band ? ' ui-timeline__band' : ''}`}
                  style={{ '--bt-at': `${bar.at}%`, '--bt-len': `${bar.len}%` } as CSSProperties} />
              ))}
            </div>
          </div>
        ))}
        <div className="bt-timeline__now" role="img" aria-label={t('ui.schedule.now', formatDateTime(now, 'time'))}><span className="bt-dot" aria-hidden="true" /></div>
      </div>
    </section>
  );
}

export function Schedule({ revision, projects }: ScheduleProps) {
  const t = useT();
  const [range, setRange] = useState<Range>('day');
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const loads = useRef(latestOnly());
  const first = useRef(true);
  const lastLoad = useRef(0);
  const seen = useRef(revision);
  const newButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<string | null>(null);
  const now = useNow(60_000);
  const today = startOfDay(now);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    lastLoad.current = Date.now();
    const win = windowOf(range, Date.now(), startOfDay);
    try {
      const [tasks, schedule] = await Promise.all([api.tasks(), api.schedule(win.from, win.to)]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ repeating: tasks.repeating ?? [], active: tasks.active, schedule, range, window: win });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [range]);

  useEffect(() => {
    const pushed = seen.current !== revision;
    seen.current = revision;
    const timer = setTimeout(() => void load(), first.current ? 0 : pushed ? reloadWait(lastLoad.current, Date.now()) : RELOAD_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [load, revision, today]);

  useEffect(() => {
    const selector = refocus.current;
    if (!selector) return;
    refocus.current = null;
    document.querySelector<HTMLElement>(selector)?.focus();
  }, [editing, confirming]);

  const rows = useMemo(() => (data ? splitSchedule(data) : null), [data]);
  const stale = rows !== null && confirmStale(confirming, [...rows.repeating, ...rows.timed]);
  useEffect(() => { if (stale) setConfirming(null); }, [stale]);
  const streams = useMemo<Stream[]>(() => (rows && data ? rows.repeating.map(row => {
    const template = data.schedule.templates.find(item => item.taskId === row.task.id);
    return { id: row.task.id, title: row.task.title, paused: row.state !== 'active', ended: row.state === 'ended', rule: template?.cron_text ?? row.task.cron_text, truncated: template?.truncated ?? false };
  }) : []), [rows, data]);

  const withBusy = async (id: string, work: () => Promise<void>) => {
    if (busy.has(id)) return;
    setBusy(current => new Set(current).add(id));
    try { await work(); } finally {
      setBusy(current => { const next = new Set(current); next.delete(id); return next; });
    }
  };
  const actionsFor = (task: Task, deleted: string): RowActions => ({
    busy: busy.has(task.id),
    confirming: confirming === task.id,
    editing: editing === task.id,
    onConfirm: (on, back = true) => { if (!on && back) refocus.current = `[data-delete="${CSS.escape(task.id)}"]`; setEditing(null); setConfirming(on ? task.id : null); },
    onEdit: on => { if (!on) refocus.current = `[data-edit="${CSS.escape(task.id)}"]`; setConfirming(null); setEditing(on ? task.id : null); },
    onDelete: () => void withBusy(task.id, async () => {
      try {
        const { deleted: removed } = await api.deleteTask(task.id);
        toast({ icon: 'x', title: deleted, body: removed.keptRuns > 0 ? t('ui.schedule.toast.kept', task.title, removed.keptRuns) : task.title });
        setConfirming(null);
        await load();
        newButton.current?.focus();
        return;
      } catch (error) { reportOpError(error); setConfirming(null); }
      await load();
    }),
    run: (action, done) => void withBusy(task.id, async () => {
      try {
        await action();
        const undo = done?.undo;
        if (done) toast({ icon: done.icon ?? 'check', title: done.title, body: task.title, ...(undo ? { action: undoAction(() => undo().then(() => load())) } : {}) });
      } catch (error) { reportOpError(error); }
      await load();
    }),
    reload: () => void load(),
  });
  const closeNew = () => { setCreating(false); newButton.current?.focus(); };

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{dayLabel(now, { weekday: 'short', day: 'numeric', month: 'short' })} · {formatDateTime(now, 'time')}</span>
          <h1 className="bt-screen__title">{t('ui.nav.schedule')}</h1>
        </div>
        <div className="bt-screen__tools">
          <div className="bt-seg" role="group" aria-label={t('ui.schedule.range')}>
            <button type="button" className="bt-seg__opt" aria-pressed={range === 'day'} onClick={() => setRange('day')}>{t('ui.schedule.range.day')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={range === 'week'} onClick={() => setRange('week')}>{t('ui.schedule.range.week')}</button>
          </div>
          <Button ref={newButton} icon="plus" aria-expanded={creating} onClick={() => setCreating(open => !open)}>{t('ui.schedule.newShort')}</Button>
        </div>
      </header>
      {creating && <ScheduleForm task={null} projects={projects} onClose={closeNew} onSaved={() => void load()} />}
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {data && rows && (
        <>
          <Timeline range={data.range} window={data.window} now={now} schedule={data.schedule} streams={streams} projects={projects} />
          {data.schedule.ranTruncated && <p className="bt-meta ui-col__empty">{t('ui.schedule.ranTruncated')}</p>}
          <div className="bt-cols">
            <section className="bt-section bt-rise" style={{ '--bt-i': 2 } as CSSProperties} aria-label={t('ui.schedule.repeating')}>
              <div className="bt-section__head"><span className="bt-label">{t('ui.schedule.repeating')}</span><span className="bt-count bt-count--quiet"><span className="bt-count__n">{countText(rows.repeating.length)}</span></span></div>
              {rows.repeating.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.schedule.noRepeating')}</p> : (
                <ul className="bt-list">
                  {rows.repeating.map(row => <RepeatingItem key={row.task.id} row={row} now={now} product={productName(projects, row.task.project_id)} actions={actionsFor(row.task, t('ui.schedule.toast.deleted'))} />)}
                </ul>
              )}
            </section>
            <section className="bt-section bt-rise" style={{ '--bt-i': 3 } as CSSProperties} aria-label={t('ui.schedule.timed')}>
              <div className="bt-section__head"><span className="bt-label">{t('ui.schedule.timed')}</span><span className="bt-count bt-count--quiet"><span className="bt-count__n">{countText(rows.timed.length)}</span></span></div>
              {rows.timed.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.schedule.noTimed')}</p> : (
                <ul className="bt-list">
                  {rows.timed.map(row => <TimedItem key={row.task.id} row={row} now={now} product={productName(projects, row.task.project_id)} actions={actionsFor(row.task, t('ui.schedule.toast.deletedTask'))} />)}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
