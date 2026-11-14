import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { api, type Question, type QuestionAnswer, type QuestionCounts } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatRelative, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { ROW_LEAVE_MS } from '../library.ts';
import { Button, EmptyState, Notice, Pill } from '../parts.tsx';
import {
  ANSWERED_PAGE, answeredToast, answerOf, assumedText, BUTTON_KEY, buttonOf, choiceOrder, earlierCursor, firstPick, fixPill, headKey, historyOf, isRetry, leaveChoice, mergeAnswered, openedId, openShown, OTHER, resultLine, retryChoice, sendOnce,
  type Picked,
} from '../questions.ts';
import { routeHash } from '../routes.ts';
import { reportOpError } from '../task-ops.ts';
import '../styles/questions.css';

type T = ReturnType<typeof useT>;

function headMeta(t: T, q: Question, now: number): string {
  return [q.task && t('ui.q.from', q.task), formatRelative(q.created_at, now)].filter(Boolean).join(' · ');
}

function Head({ q, now, all }: { q: Question; now: number; all: boolean }) {
  const t = useT();
  return (
    <div className="bt-card__head">
      <span className="bt-card__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t(headKey(q))}</span>{q.acceptance_item && <span className="bt-tag" data-item>{q.acceptance_item}</span>}</span>
      <span className="ui-q__headend"><span className="bt-meta">{headMeta(t, q, now)}</span>{all && q.product && <span className="bt-tag" data-product-tag>{q.product}</span>}</span>
    </div>
  );
}

interface CardProps {
  q: Question; index: number; now: number; all: boolean; expanded: boolean; busy: boolean; leaving: boolean;
  onOpen: (id: number) => void; onAnswer: (q: Question, answer: QuestionAnswer) => void;
}

function QuestionCard({ q, index, now, all, expanded, busy, leaving, onOpen, onAnswer }: CardProps) {
  const t = useT();
  const name = useId();
  const [pick, setPick] = useState<Picked>(() => firstPick(q));
  const [text, setText] = useState('');
  const locked = busy || leaving;
  const style = { '--bt-i': index } as CSSProperties;
  const classes = `bt-card bt-question ui-q__card${leaving ? ' is-leaving' : ' bt-rise'}`;
  if (!expanded) {
    const assumed = assumedText(q);
    return (
      <article className={`${classes} is-collapsed`} style={style} data-q={q.id}>
        <Head q={q} now={now} all={all} />
        <h3 className="bt-question__q"><button type="button" className="ui-q__toggle" aria-expanded="false" onClick={() => onOpen(q.id)}>{q.question}</button></h3>
        <div className="bt-card__meta"><span>{assumed !== null ? t('ui.q.assumed', assumed) : t('ui.q.noAssumption')}</span></div>
      </article>
    );
  }
  const line = resultLine(q, pick);
  const result = line.key === 'ui.q.result.fixItem' ? t(line.key, line.item) : t(line.key);
  const answer = answerOf(pick, text);
  const retry = isRetry(q);
  const retryAt = retryChoice(q);
  const leaveAt = leaveChoice(q);
  return (
    <article className={classes} style={style} data-q={q.id} aria-busy={busy || undefined}>
      <Head q={q} now={now} all={all} />
      <h3 className="bt-question__q">{q.question}</h3>
      {q.why && <p className="bt-question__why"><span className="bt-label">{t('ui.q.why')}</span><br />{q.why}</p>}
      {!retry && (
        <fieldset className="bt-choices" disabled={locked} aria-label={q.question}>
          {choiceOrder(q).map(i => (
            <label key={i} className="bt-choice">
              <input type="radio" name={name} value={i} checked={pick === i} onChange={() => setPick(i)} />
              <span>{q.options[i]}</span>
              {i === q.chosen && <span className="bt-label bt-choice__tag">{t('ui.q.assumedTag')}</span>}
            </label>
          ))}
          <label className="bt-choice">
            <input type="radio" name={name} value={OTHER} checked={pick === OTHER} onChange={() => setPick(OTHER)} />
            <span>{t('ui.q.other')}</span>
          </label>
          {pick === OTHER && (
            <textarea className="bt-field ui-q__other" aria-label={t('ui.q.otherField')} placeholder={t('ui.q.otherField')} autoFocus rows={2} maxLength={4000} value={text} onChange={e => setText(e.target.value)} />
          )}
        </fieldset>
      )}
      <div className="bt-card__actions ui-q__actions">
        {retry ? (
          <>
            {retryAt !== null && <Button variant="primary" small disabled={locked} onClick={() => onAnswer(q, { choice: retryAt })}>{t('ui.q.retry')}</Button>}
            {leaveAt !== null && <Button variant="ghost" small disabled={locked} onClick={() => onAnswer(q, { choice: leaveAt })}>{t('ui.q.leave')}</Button>}
          </>
        ) : (
          <Button variant="primary" small disabled={locked || answer === null} onClick={() => { if (answer) onAnswer(q, answer); }}>{t(BUTTON_KEY[buttonOf(q, pick)])}</Button>
        )}
        <span className="bt-meta ui-q__result" data-result={line.key}>{result}</span>
      </div>
    </article>
  );
}

function AnsweredRow({ q, now, all }: { q: Question; now: number; all: boolean }) {
  const t = useT();
  const pill = fixPill(q);
  const target = q.fix_task_id ?? q.task_id;
  const sub = [all && q.product, q.answer, t(q.answer_kind === 'changed' ? 'ui.q.changedSub' : 'ui.q.keptSub'), q.answered_at !== null && formatRelative(q.answered_at, now)].filter(Boolean).join(' · ');
  return (
    <li className="bt-row" data-answered={q.id}>
      <div className="bt-row__main">
        {target ? <a className="bt-row__title ui-q__title" href={routeHash({ view: 'task', id: target })}>{q.question}</a> : <span className="bt-row__title ui-q__title">{q.question}</span>}
        <span className="bt-row__sub bt-meta ui-q__sub">{sub}</span>
      </div>
      {pill && <div className="bt-row__end"><Pill tone={pill.tone}>{t(pill.key)}</Pill></div>}
    </li>
  );
}

export interface QuestionsListProps {
  projectId: string | null;
  counts: QuestionCounts | null;
  revision: string;
  fixRevision: string;
}

export function QuestionsList({ projectId, counts, revision, fixRevision }: QuestionsListProps) {
  const t = useT();
  const now = useNow(30_000);
  const all = projectId === null;
  const project = projectId ?? undefined;
  const [open, setOpen] = useState<Question[] | null>(null);
  const [answered, setAnswered] = useState<Question[] | null>(null);
  const [complete, setComplete] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [answeredFailed, setAnsweredFailed] = useState(false);
  const failed = openFailed || answeredFailed;
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'none'>('idle');
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const opens = useRef(latestOnly());
  const answers = useRef(latestOnly());
  const sent = useRef(new Set<number>());
  const scope = project ? { projectId: project } : {};

  const loadOpen = useCallback(async () => {
    const ticket = opens.current.begin();
    try {
      const page = await api.questions({ status: 'open', ...(project ? { projectId: project } : {}) });
      if (!opens.current.isCurrent(ticket)) return;
      setOpen(page.items);
      setOpenFailed(false);
    } catch {
      if (opens.current.isCurrent(ticket)) setOpenFailed(true);
    }
  }, [project]);
  const loadAnswered = useCallback(async () => {
    const ticket = answers.current.begin();
    try {
      const page = await api.questions({ status: 'answered', ...(project ? { projectId: project } : {}) });
      if (!answers.current.isCurrent(ticket)) return;
      setAnswered(old => mergeAnswered(old ?? [], page.items));
      setComplete(old => old || page.items.length < ANSWERED_PAGE);
      setAnsweredFailed(false);
    } catch {
      if (answers.current.isCurrent(ticket)) setAnsweredFailed(true);
    }
  }, [project]);
  useEffect(() => { void loadOpen(); }, [loadOpen, revision]);
  useEffect(() => { void loadAnswered(); }, [loadAnswered, revision, fixRevision]);

  const showEarlier = async () => {
    const cursor = answered ? earlierCursor(answered) : null;
    if (earlier === 'loading' || cursor === null) return;
    setEarlier('loading');
    try {
      const page = await api.questions({ status: 'answered', ...scope, before: cursor });
      setAnswered(old => mergeAnswered(old ?? [], page.items));
      if (page.items.length < ANSWERED_PAGE) setComplete(true);
      setEarlier(page.items.length === 0 ? 'none' : 'idle');
    } catch (error) { reportOpError(error); setEarlier('idle'); }
  };

  const mark = (set: typeof setBusy, id: number, on: boolean) => set(old => { const next = new Set(old); if (on) next.add(id); else next.delete(id); return next; });
  const submit = async (q: Question, answer: QuestionAnswer) => {
    if (!sendOnce(sent.current, q.id)) return;
    mark(setBusy, q.id, true);
    try {
      const result = await api.answerQuestion(q.id, answer);
      toast({ icon: 'check', title: t(answeredToast(result)), body: q.question });
    } catch (error) {
      reportOpError(error);
      sent.current.delete(q.id);
      mark(setBusy, q.id, false);
      void loadOpen();
      return;
    }
    mark(setBusy, q.id, false);
    mark(setLeaving, q.id, true);
    setTimeout(() => {
      mark(setLeaving, q.id, false);
      mark(setGone, q.id, true);
      void loadOpen();
      void loadAnswered();
    }, ROW_LEAVE_MS);
  };

  const rows = openShown(open ?? [], gone);
  const total = rows.filter(q => !leaving.has(q.id)).length;
  const expanded = openedId(rows.filter(q => !leaving.has(q.id)), picked);
  const history = historyOf(counts, answered ?? [], all, complete);
  const historyText = history ? t('ui.q.history', history.answered, history.changed) : null;

  return (
    <div className="ui-q" data-scope={all ? 'all' : projectId}>
      <div className="bt-pane__bar">
        <span className="bt-section__kind">{total > 0 && <span className="bt-dot" aria-hidden="true" />}<span className="bt-label">{t('ui.q.open', total)}</span></span>
        <span className="bt-meta ui-q__note">{t('ui.q.keptGoing')}</span>
      </div>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => { void loadOpen(); void loadAnswered(); } }} />}
      {open && rows.length === 0 ? (
        <EmptyState title={t('ui.q.empty')} text={<span className="bt-meta">{historyText ?? t('ui.q.emptyText')}</span>} />
      ) : (
        <div className="bt-pane__stack ui-q__stack">
          {rows.map((q, i) => (
            <QuestionCard key={q.id} q={q} index={i} now={now} all={all} expanded={q.id === expanded} busy={busy.has(q.id)} leaving={leaving.has(q.id)} onOpen={setPicked} onAnswer={(row, a) => void submit(row, a)} />
          ))}
        </div>
      )}
      <section className="bt-section ui-q__answered" aria-label={t('ui.q.answered')}>
        <div className="bt-section__head"><span className="bt-label">{t('ui.q.answered')}</span>{historyText && <span className="bt-meta">{historyText}</span>}</div>
        {answered && answered.length === 0 && <p className="bt-meta ui-q__none">{t('ui.q.noneAnswered')}</p>}
        {answered && answered.length > 0 && <ul className="bt-list">{answered.map(q => <AnsweredRow key={q.id} q={q} now={now} all={all} />)}</ul>}
        {answered && answered.length > 0 && !complete && (earlier === 'none'
          ? <p className="bt-meta ui-q__none">{t('ui.q.noEarlier')}</p>
          : <Button small variant="ghost" className="ui-q__earlier" disabled={earlier === 'loading'} onClick={() => void showEarlier()}>{t('ui.q.earlier')}</Button>)}
      </section>
    </div>
  );
}
