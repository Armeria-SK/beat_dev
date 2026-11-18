import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Acceptance, type AcceptanceItem, type Project, type Task, type TaskEvent, type WorkerStatus } from '../../api.ts';
import { waitText } from '../wait.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import { eventKey, ORIGIN_KEY, sheetActions, STATUS_KEY } from '../../task-meta.ts';
import { PRIORITIES } from '../../task-form.ts';
import { DiscardConfirm, useDiscardAsk, useUnsaved } from '../Discard.tsx';
import { latestOnly } from '../latest.ts';
import { Button, EmptyState, Icon, Notice, Pill, type PillTone } from '../parts.tsx';
import { productOf } from '../products.ts';
import { routeHash } from '../routes.ts';
import { checkLabel, evidenceLines, remainingItems, stateLabel, stateTone } from '../acceptance.ts';
import { answerTaskOp, checkOp, editOverwrites, reportOpError, runTaskOp, taskButtons, type CheckChoice, type TaskOp } from '../task-ops.ts';
import { SCREEN_EDITS } from '../unsaved.ts';
import { awaitsCheck, pendingWait } from '../kanban.ts';
import { ownerRuns } from '../overview.ts';
import { PRIORITY_KEY } from './Kanban.tsx';

export interface TaskScreenProps {
  id: string;
  revision: string;
  worker: WorkerStatus | null;
  projects: readonly Project[];
  pending: number;
}

interface Detail { task: Task; events: TaskEvent[]; runs: Task[] }
type FieldName = 'title' | 'body' | 'next' | 'done';

const STATUS_TONE: Partial<Record<Task['status'], PillTone>> = { running: 'running', waiting: 'waiting', inbox: 'waiting', done: 'ok', failed: 'danger' };
const FIELD = {
  title: { label: 'ui.task.title', max: 200, multiline: false, required: true },
  body: { label: 'ui.task.body', max: 20_000, multiline: true, required: false },
  next: { label: 'ui.task.next', max: 2000, multiline: true, required: false },
  done: { label: 'ui.task.doneWhen', max: 500, multiline: true, required: false },
} as const;
const FIELDS: readonly FieldName[] = ['title', 'body', 'next', 'done'];
const OP_LABEL = {
  approve: 'ui.kanban.approve', reject: 'ui.kanban.reject', runNow: 'ui.task.runNow', retry: 'ui.task.retry', done: 'ui.task.markDone',
  cancel: 'ui.task.cancel', restore: 'ui.task.restore', stop: 'ui.task.stop',
} as const satisfies Record<TaskOp, string>;
const NEW_EVENT = { reason: 'ui.task.event.reason', unapproved: 'ui.task.event.unapproved' } as const;

function eventText(t: ReturnType<typeof useT>, event: TaskEvent): string | null {
  if ((event.kind !== 'owner_check' && event.kind !== 'owner_fix') || !event.content) return event.content;
  try {
    const value = JSON.parse(event.content) as { item?: unknown; result?: unknown; note?: unknown };
    const item = typeof value.item === 'string' ? value.item : '';
    if (event.kind === 'owner_fix') return item || event.content;
    const head = t(value.result === 'checked' ? 'ui.check.event.checked' : 'ui.check.event.insufficient', item);
    return typeof value.note === 'string' && value.note ? `${head} · ${value.note}` : head;
  } catch { return event.content; }
}

const GATE_AFTER = new Set(['gate_list_changed', 'gate_passed', 'gate_refused', 'gate_closed', 'item_check_failed']);
const listChanged = (events: readonly TaskEvent[]): boolean => events.find(e => GATE_AFTER.has(e.kind))?.kind === 'gate_list_changed';

const fieldValue = (task: Task, field: FieldName): string =>
  (field === 'title' ? task.title : field === 'body' ? task.body : field === 'next' ? task.next_action ?? '' : task.done_criteria ?? '');

const fieldPatch = (field: FieldName, value: string) =>
  (field === 'title' ? { title: value.trim() } : field === 'body' ? { body: value } : field === 'next' ? { nextAction: value.trim() || null } : { doneCriteria: value.trim() || null });

function Field({ task, field, onSaved }: { task: Task; field: FieldName; onSaved: () => void }) {
  const t = useT();
  const spec = FIELD[field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [opened, setOpened] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const value = fieldValue(task, field);
  const label = t(spec.label);
  const close = () => { setEditing(false); setError(''); requestAnimationFrame(() => editButton.current?.focus()); };
  const changed = editing && draft !== opened;
  useUnsaved(`${SCREEN_EDITS}task:${task.id}:${field}`, changed);
  const ask = useDiscardAsk(() => changed);
  const cancel = () => ask.attempt(close);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || (spec.required && !draft.trim())) return;
    setBusy(true); setError('');
    try {
      await api.editTask(task.id, fieldPatch(field, draft));
      onSaved();
      close();
    } catch (failure) { setError(failure instanceof ApiError ? failure.message : t('ui.task.saveFailed')); } finally { setBusy(false); }
  };
  if (editing) {
    return (
      <li className="bt-row ui-field">
        <form className="ui-field__form" onSubmit={e => void save(e)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }}>
          <span className="bt-label">{label}</span>
          <DiscardConfirm ask={ask} />
          {spec.multiline
            ? <textarea className="bt-field" autoFocus rows={4} value={draft} maxLength={spec.max} aria-label={label} onChange={e => setDraft(e.target.value)} />
            : <input className="bt-field" autoFocus value={draft} maxLength={spec.max} aria-label={label} onChange={e => setDraft(e.target.value)} />}
          {editOverwrites(opened, value, draft) && <span className="bt-meta ui-danger" role="status">{t('ui.task.changedUnder')}</span>}
          {error && <span className="bt-meta ui-danger" role="alert">{error}</span>}
          <span className="ui-field__buttons">
            <Button type="submit" variant="primary" small disabled={busy || (spec.required && !draft.trim())}>{t('ui.task.save')}</Button>
            <Button variant="ghost" small onClick={cancel}>{t('ui.cancel')}</Button>
          </span>
        </form>
      </li>
    );
  }
  return (
    <li className="bt-row ui-field">
      <div className="bt-row__main">
        <span className="bt-label">{label}</span>
        <span className={`ui-field__value${value ? '' : ' ui-field__value--unset'}`}>{value || t('ui.task.notSet')}</span>
      </div>
      <div className="bt-row__end">
        <Button ref={editButton} variant="ghost" small icon="pencil" aria-label={t('ui.task.edit', label)} title={t('ui.task.edit', label)} onClick={() => { setDraft(value); setOpened(value); setEditing(true); }} />
      </div>
    </li>
  );
}

function Answer({ task, onSent }: { task: Task; onSent: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useUnsaved(`${SCREEN_EDITS}task:${task.id}:answer`, text.trim() !== '');
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    try { if (await answerTaskOp(task, text.trim())) { setText(''); onSent(); } } finally { setBusy(false); }
  };
  return (
    <section className="bt-section" aria-label={t('ui.task.question')}>
      <div className="bt-section__head"><span className="bt-section__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.task.question')}</span></span></div>
      <form className="ui-answer" onSubmit={e => void send(e)}>
        <p className="ui-answer__q">{task.waiting_text || t('ui.task.noQuestion')}</p>
        <textarea className="bt-field" rows={3} value={text} maxLength={4000} aria-label={t('ui.task.answer')} placeholder={t('ui.task.answer')} onChange={e => setText(e.target.value)} />
        <div className="ui-field__buttons"><Button type="submit" variant="primary" small disabled={busy || !text.trim()}>{t('ui.task.sendAnswer')}</Button></div>
      </form>
    </section>
  );
}

function CheckRow({ id, item, busy, onCheck }: { id: string; item: AcceptanceItem | null; busy: boolean; onCheck: (choice: CheckChoice) => Promise<boolean> }) {
  const t = useT();
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState('');
  useUnsaved(`${SCREEN_EDITS}check:${id}`, note.trim() !== '');
  const evidence = item ? evidenceLines(item.evidence ?? [], { short: true }) : [];
  const tone = item ? stateTone(item.state) : undefined;
  const send = (e: FormEvent) => { e.preventDefault(); void onCheck({ item: id, result: 'insufficient', note }).then(ok => { if (ok) { setNoting(false); setNote(''); } }); };
  return (
    <li className="bt-row ui-acc__row" data-item={id}>
      <span className="bt-tag ui-acc__id">{id}</span>
      <div className="bt-row__main">
        <span className="ui-acc__text">{item?.result ?? ''}</span>
        {item && <span className="ui-acc__tags"><span className="bt-chip">{t(checkLabel(item.check))}</span></span>}
        <span className="ui-check__text">
          {evidence.length === 0 && <span className="bt-meta">{t('ui.check.noEvidence')}</span>}
          {evidence.map((line, i) => (
            <span key={i} className="ui-check__ev">
              <span className="bt-meta">{line.text}</span>
              {line.output && <pre className="ui-check__out">{line.output}</pre>}
            </span>
          ))}
        </span>
        {noting ? (
          <form className="ui-check__note" onSubmit={send} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNoting(false); } }}>
            <input className="bt-field" autoFocus value={note} maxLength={1000} aria-label={t('ui.check.note')} placeholder={t('ui.check.note')} onChange={e => setNote(e.target.value)} />
            <span className="ui-field__buttons">
              <Button type="submit" variant="primary" small disabled={busy || !item}>{t('ui.check.send')}</Button>
              <Button variant="ghost" small onClick={() => setNoting(false)}>{t('ui.cancel')}</Button>
            </span>
          </form>
        ) : (
          <span className="ui-field__buttons">
            <Button small disabled={busy || !item} onClick={() => void onCheck({ item: id, result: 'checked' })}>{t('ui.check.checked')}</Button>
            <Button variant="ghost" small disabled={busy || !item} onClick={() => setNoting(true)}>{t('ui.check.notEnough')}</Button>
          </span>
        )}
      </div>
      {item && <span className="bt-row__end"><Pill {...(tone ? { tone } : {})}>{t(stateLabel(item.state))}</Pill></span>}
    </li>
  );
}

function CheckSection({ task, onDone }: { task: Task; onDone: () => Promise<void> }) {
  const t = useT();
  const [list, setList] = useState<Acceptance | null>(null);
  const [busy, setBusy] = useState(false);
  const [reads, setReads] = useState(0);
  const projectId = task.project_id ?? null;
  useEffect(() => {
    if (!projectId) return undefined;
    let live = true;
    void api.acceptance(projectId).then(r => { if (live) setList(r.acceptance); }, () => { if (live) setList(null); });
    return () => { live = false; };
  }, [projectId, task.updated_at, reads]);
  const run = async (choice?: CheckChoice): Promise<boolean> => {
    if (busy || !list) return false;
    setBusy(true);
    try {
      const ok = await checkOp(task, list.version, choice);
      if (!ok) setReads(n => n + 1);
      await onDone();
      return ok;
    } finally { setBusy(false); }
  };
  const items = task.items;
  return (
    <section className="bt-section ui-check" aria-label={t('ui.kanban.col.check')}>
      <div className="bt-section__head">
        <span className="bt-section__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.kanban.col.check')}</span></span>
        {items && <span className="bt-meta">{t('ui.check.met', items.met, items.owned)}</span>}
        <Button variant="primary" small disabled={busy || !list} onClick={() => void run()}>{t('ui.check.markChecked')}</Button>
      </div>
      <p className="bt-meta">{t('ui.check.text')}</p>
      <ul className="bt-list">
        {remainingItems(task, list).map(({ id, item }) => <CheckRow key={id} id={id} item={item} busy={busy || !list} onCheck={choice => run(choice)} />)}
      </ul>
    </section>
  );
}

export function TaskScreen({ id, revision, worker, projects, pending }: TaskScreenProps) {
  const t = useT();
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const loads = useRef(latestOnly());

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const detail = await api.task(id);
      if (!loads.current.isCurrent(ticket)) return;
      setData(detail); setMissing(false); setFailed(false);
    } catch (error) {
      if (!loads.current.isCurrent(ticket)) return;
      if (error instanceof ApiError && error.status === 404) { setData(null); setMissing(true); } else setFailed(true);
    }
  }, [id]);

  useEffect(() => { setData(null); setMissing(false); setRejecting(false); }, [id]);
  useEffect(() => { void load(); }, [load, revision]);

  const back = <a className="bt-meta ui-task__back" href="#/kanban"><Icon name="arrowL" />{t('ui.nav.kanban')}</a>;

  if (missing) {
    return (
      <div className="bt-screen__inner">
        {back}
        <EmptyState title={t('ui.task.deleted')} text={t('ui.task.deletedText')} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="bt-screen__inner">
        {back}
        {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      </div>
    );
  }

  const { task, events, runs } = data;
  const product = productOf(projects, task.project_id);
  const mine = worker?.runningAll.find(r => r.taskId === task.id);
  const busyWithOther = ownerRuns(worker?.runningAll ?? []).length > 0 && !mine;
  const onPending = pendingWait(task);
  const buttons = taskButtons(task.status, sheetActions(task.status), mine !== undefined);

  const run = async (op: TaskOp, options: { reason?: string } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await runTaskOp(op, task, { ...options, runId: mine?.runId, busyWithOther })) { setRejecting(false); await load(); }
    } finally { setBusy(false); }
  };
  const setPriority = async (priority: number) => {
    if (priority === task.priority) return;
    try {
      await api.editTask(task.id, { priority });
      toast({ icon: 'check', title: t('ui.task.toast.saved'), body: t(PRIORITY_KEY[priority as 1 | 2 | 3]) });
      await load();
    } catch (error) { reportOpError(error); }
  };
  const label = (op: TaskOp): string => (op === 'retry' && task.status !== 'failed' ? t('ui.task.runAgain') : t(OP_LABEL[op]));
  const facts: Array<[string, string]> = [
    [t('ui.task.from'), t(ORIGIN_KEY[task.origin])],
    [t('ui.task.created'), formatDateTime(task.created_at, 'full')],
    ...(task.run_at !== null ? [[t('ui.task.startsAt'), formatDateTime(task.run_at, 'full')] as [string, string]] : []),
    ...(task.cron_text ? [[t('ui.task.repeats'), task.cron_text] as [string, string]] : []),
    [t('ui.task.attempts'), t('ui.task.attemptsValue', task.attempts, task.max_attempts)],
  ];

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <div className="ui-task__heading">
          {back}
          <h1 className="bt-screen__title">{task.title}</h1>
          <div className="ui-task__state">
            {product && <a className="bt-tool__link bt-meta" href={routeHash({ view: 'product', id: product.id })}>{product.name}</a>}
            {awaitsCheck(task) ? <Pill tone="waiting">{t('ui.kanban.col.check')}</Pill> : <Pill {...(STATUS_TONE[task.status] ? { tone: STATUS_TONE[task.status]! } : {})}>{onPending ? t('ui.kanban.waiting') : t(task.status === 'cancelled' && task.cancelled_from === 'inbox' ? 'ui.kanban.rejected' : STATUS_KEY[task.status])}</Pill>}
            <span className="bt-meta">{t('ui.task.updated', formatRelative(task.updated_at))}{task.parent_id !== null && <> · {t('ui.kanban.repeating')}</>}</span>
            {task.status === 'ready' && worker?.waiting?.[task.id] && <span className="bt-meta" data-wait>{waitText(worker.waiting[task.id]!)}</span>}
          </div>
        </div>
        <div className="bt-screen__tools">
          {buttons.map(({ op, primary }) => (
            <Button key={op} {...(primary ? { variant: 'primary' as const } : op === 'cancel' || op === 'reject' ? { variant: 'ghost' as const } : {})} disabled={busy}
              onClick={() => { if (op === 'reject') { setReason(''); setRejecting(true); } else void run(op); }}>{label(op)}</Button>
          ))}
        </div>
      </header>

      {failed && <Notice tone="warn" icon="alert" title={t('ui.task.reloadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}

      {rejecting && (
        <form className="ui-task__reject bt-rise" onSubmit={e => { e.preventDefault(); void run('reject', { reason }); }}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRejecting(false); } }}>
          <input className="bt-field" autoFocus value={reason} maxLength={2000} aria-label={t('ui.kanban.reasonLabel')} placeholder={t('ui.kanban.reason')} onChange={e => setReason(e.target.value)} />
          <Button type="submit" variant="danger" small disabled={busy}>{t('ui.kanban.reject')}</Button>
          <Button variant="ghost" small onClick={() => setRejecting(false)}>{t('ui.cancel')}</Button>
        </form>
      )}

      {listChanged(events) && <Notice tone="warn" icon="alert" title={t('ui.check.listChanged')} text={t('ui.check.listChangedText')} />}

      {awaitsCheck(task) && <CheckSection task={task} onDone={load} />}

      {task.status === 'waiting' && !onPending && <Answer task={task} onSent={() => void load()} />}

      {(pending > 0 || onPending) && (
        <section className="bt-section" aria-label={onPending ? t('ui.kanban.waitingPending', onPending.refs) : t('ui.task.pending', pending)}>
          <div className="bt-section__head">
            <span className="bt-section__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{onPending ? t('ui.kanban.waitingPending', onPending.refs) : t('ui.task.pending', pending)}</span></span>
            <a className="bt-tool__link" href={routeHash(product ? { view: 'pending', productId: product.id } : { view: 'pending' })}>{t('ui.task.openPending')}</a>
          </div>
        </section>
      )}

      <section className="bt-section" aria-label={t('ui.task.details')}>
        <div className="bt-section__head"><span className="bt-label">{t('ui.task.details')}</span></div>
        <ul className="bt-list">
          {FIELDS.map(field => <Field key={field} task={task} field={field} onSaved={() => void load()} />)}
          <li className="bt-row ui-field">
            <div className="bt-row__main"><span className="bt-label">{t('ui.task.priority')}</span></div>
            <div className="bt-row__end">
              <span className="bt-seg" role="group" aria-label={t('ui.task.priority')}>
                {PRIORITIES.map(p => <button key={p} type="button" className="bt-seg__opt" aria-pressed={task.priority === p} onClick={() => void setPriority(p)}>{t(PRIORITY_KEY[p])}</button>)}
              </span>
            </div>
          </li>
        </ul>
      </section>

      {task.result_summary && (
        <section className="bt-section" aria-label={t('ui.task.result')}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.task.result')}</span></div>
          <div className="ui-task__result"><Markdown text={task.result_summary} /></div>
        </section>
      )}

      <section className="bt-section" aria-label={t('ui.task.facts')}>
        <div className="bt-section__head"><span className="bt-label">{t('ui.task.facts')}</span></div>
        <ul className="bt-list">
          {facts.map(([key, value]) => (
            <li key={key} className="bt-row"><div className="bt-row__main"><span className="bt-meta">{key}</span></div><div className="bt-row__end">{value}</div></li>
          ))}
          {task.conversation_id && (
            <li className="bt-row"><div className="bt-row__main"><span className="bt-meta">{t('ui.task.session')}</span></div>
              <div className="bt-row__end"><a className="bt-tool__link" href={routeHash({ view: 'chat', id: task.conversation_id })}>{t('ui.task.openSession')}</a></div></li>
          )}
          {task.parent_id && (
            <li className="bt-row"><div className="bt-row__main"><span className="bt-meta">{t('ui.task.schedule')}</span></div>
              <div className="bt-row__end"><a className="bt-tool__link" href={routeHash({ view: 'task', id: task.parent_id })}>{t('ui.task.openSchedule')}</a></div></li>
          )}
        </ul>
      </section>

      {runs.length > 0 && (
        <section className="bt-section" aria-label={t('ui.task.runs')}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.task.runs')}</span></div>
          <ul className="bt-list">
            {runs.map(child => (
              <li key={child.id} className="bt-row">
                <div className="bt-row__main"><a className="bt-row__title ui-card__link" href={routeHash({ view: 'task', id: child.id })}>{formatDateTime(child.created_at, 'full')}</a></div>
                <div className="bt-row__end"><Pill {...(STATUS_TONE[child.status] ? { tone: STATUS_TONE[child.status]! } : {})}>{t(STATUS_KEY[child.status])}</Pill></div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="bt-section" aria-label={t('ui.task.activity')}>
        <div className="bt-section__head"><span className="bt-label">{t('ui.task.activity')}</span><span className="bt-meta">{t('ui.task.activityCount', events.length)}</span></div>
        <ul className="bt-list">
          {events.map(event => {
            const known = eventKey(event.kind, event.content);
            const content = eventText(t, event);
            const name = known ? t(known) : Object.hasOwn(NEW_EVENT, event.kind) ? t(NEW_EVENT[event.kind as keyof typeof NEW_EVENT]) : event.kind;
            return (
              <li key={event.id} className="bt-row ui-event">
                <div className="bt-row__main">
                  <span className="bt-row__title">{name}{event.actor === 'user' && <span className="bt-meta"> · {t('ui.task.byYou')}</span>}</span>
                  {content && <span className="ui-event__text">{content}</span>}
                </div>
                <div className="bt-row__end"><span className="bt-meta" title={formatDateTime(event.created_at, 'precise')}>{formatRelative(event.created_at)}</span></div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
