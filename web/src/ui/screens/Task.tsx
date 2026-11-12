import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Approval, type Task, type TaskEvent, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import { eventKey, ORIGIN_KEY, sheetActions, STATUS_KEY } from '../../task-meta.ts';
import { PRIORITIES } from '../../task-form.ts';
import { latestOnly } from '../latest.ts';
import { Button, EmptyState, Icon, Notice, Pill, type PillTone } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { answerTaskOp, reportOpError, runTaskOp, taskButtons, type TaskOp } from '../task-ops.ts';
import { threadItems } from '../thread.ts';
import { ToolGroup } from '../ToolRow.tsx';
import { PRIORITY_KEY } from './Kanban.tsx';

export interface TaskScreenProps {
  id: string;
  revision: number;
  worker: WorkerStatus | null;
}

interface Detail { task: Task; events: TaskEvent[]; approvals: Approval[]; runs: Task[] }
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

const fieldValue = (task: Task, field: FieldName): string =>
  (field === 'title' ? task.title : field === 'body' ? task.body : field === 'next' ? task.next_action ?? '' : task.done_criteria ?? '');

const fieldPatch = (field: FieldName, value: string) =>
  (field === 'title' ? { title: value.trim() } : field === 'body' ? { body: value } : field === 'next' ? { nextAction: value.trim() || null } : { doneCriteria: value.trim() || null });

function Field({ task, field, onSaved }: { task: Task; field: FieldName; onSaved: () => void }) {
  const t = useT();
  const spec = FIELD[field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLButtonElement>(null);
  const value = fieldValue(task, field);
  const label = t(spec.label);
  const close = () => { setEditing(false); setError(''); requestAnimationFrame(() => editButton.current?.focus()); };
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
        <form className="ui-field__form" onSubmit={e => void save(e)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
          <span className="bt-label">{label}</span>
          {spec.multiline
            ? <textarea className="bt-field" autoFocus rows={4} value={draft} maxLength={spec.max} aria-label={label} onChange={e => setDraft(e.target.value)} />
            : <input className="bt-field" autoFocus value={draft} maxLength={spec.max} aria-label={label} onChange={e => setDraft(e.target.value)} />}
          {error && <span className="bt-meta ui-danger" role="alert">{error}</span>}
          <span className="ui-field__buttons">
            <Button type="submit" variant="primary" small disabled={busy || (spec.required && !draft.trim())}>{t('ui.task.save')}</Button>
            <Button variant="ghost" small onClick={close}>{t('ui.cancel')}</Button>
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
        <Button ref={editButton} variant="ghost" small icon="pencil" aria-label={t('ui.task.edit', label)} title={t('ui.task.edit', label)} onClick={() => { setDraft(value); setEditing(true); }} />
      </div>
    </li>
  );
}

function Answer({ task, onSent }: { task: Task; onSent: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
        <textarea className="bt-field" rows={3} value={text} maxLength={20_000} aria-label={t('ui.task.answer')} placeholder={t('ui.task.answer')} onChange={e => setText(e.target.value)} />
        <div className="ui-field__buttons"><Button type="submit" variant="primary" small disabled={busy || !text.trim()}>{t('ui.task.sendAnswer')}</Button></div>
      </form>
    </section>
  );
}

export function TaskScreen({ id, revision, worker }: TaskScreenProps) {
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

  const { task, events, approvals, runs } = data;
  const mine = worker?.runningAll.find(r => r.taskId === task.id);
  const busyWithOther = (worker?.runningAll.length ?? 0) > 0 && !mine;
  const buttons = taskButtons(task.status, sheetActions(task.status), mine !== undefined);
  const approvalRows = threadItems({ messages: [], approvals }).flatMap(item => (item.kind === 'tools' ? item.rows : []));

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
            <Pill {...(STATUS_TONE[task.status] ? { tone: STATUS_TONE[task.status]! } : {})}>{t(task.status === 'cancelled' && task.cancelled_from === 'inbox' ? 'ui.kanban.rejected' : STATUS_KEY[task.status])}</Pill>
            <span className="bt-meta">{t('ui.task.updated', formatRelative(task.updated_at))}{task.parent_id !== null && <> · {t('ui.kanban.repeating')}</>}</span>
          </div>
        </div>
        <div className="bt-screen__tools">
          {buttons.map(({ op, primary }) => (
            <Button key={op} {...(primary ? { variant: 'primary' as const } : op === 'cancel' || op === 'reject' ? { variant: 'ghost' as const } : {})} disabled={busy}
              onClick={() => { if (op === 'reject') { setReason(''); setRejecting(true); } else void run(op); }}>{label(op)}</Button>
          ))}
        </div>
      </header>

      {rejecting && (
        <form className="ui-task__reject bt-rise" onSubmit={e => { e.preventDefault(); void run('reject', { reason }); }}
          onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRejecting(false); } }}>
          <input className="bt-field" autoFocus value={reason} maxLength={2000} aria-label={t('ui.kanban.reasonLabel')} placeholder={t('ui.kanban.reason')} onChange={e => setReason(e.target.value)} />
          <Button type="submit" variant="danger" small disabled={busy}>{t('ui.kanban.reject')}</Button>
          <Button variant="ghost" small onClick={() => setRejecting(false)}>{t('ui.cancel')}</Button>
        </form>
      )}

      {task.status === 'waiting' && <Answer task={task} onSent={() => void load()} />}

      {approvalRows.length > 0 && (
        <section className="bt-section" aria-label={t('ui.task.approvals')}>
          <div className="bt-section__head"><span className="bt-section__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.task.approvals')}</span></span></div>
          <ToolGroup rows={approvalRows} isNew={() => false} />
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
            const known = eventKey(event.kind);
            const name = known ? t(known) : Object.hasOwn(NEW_EVENT, event.kind) ? t(NEW_EVENT[event.kind as keyof typeof NEW_EVENT]) : event.kind;
            return (
              <li key={event.id} className="bt-row ui-event">
                <div className="bt-row__main">
                  <span className="bt-row__title">{name}{event.actor === 'user' && <span className="bt-meta"> · {t('ui.task.byYou')}</span>}</span>
                  {event.content && <span className="ui-event__text">{event.content}</span>}
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
