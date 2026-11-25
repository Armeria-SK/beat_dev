import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, type Acceptance, type BranchCommits, type ChecklistItem, type Conversation, type DeviationRow, type FinishedCursor, type PreFix, type Project, type RunRow, type Task, type WaitReason } from '../../api.ts';
import { waitText } from '../wait.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, formatElapsed, formatRelative, timezoneLabel, useT } from '../../i18n/index.ts';
import { buildNewTask, emptyDraft, PRIORITIES, type TaskDraft } from '../../task-form.ts';
import { plainLine } from '../../task-meta.ts';
import { evidenceLines, remainingItems } from '../acceptance.ts';
import { useMedia, useNow } from '../hooks.ts';
import {
  awaitsCheck, awaitsMerge, branchLeft, buildBoard, cardProject, mergedBranch, COLUMN_TABS_MEDIA, firstSentences, KANBAN_PAGE, NARROW_COLUMNS, mergeFinished, pagesToReload, pendingRoute, pendingWait, prefixDiff, prefixOf, proposalOf, questionsRoute, RUNS_WINDOW, sessionCards, stepPercent, tabStep,
  type Card, type ChangesTarget, type Column, type ColumnId, type SessionCard, type Step, type TaskCard,
} from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { Button, countText, Notice, Pill } from '../parts.tsx';
import { inFilter, newTaskProduct, optionLabel, productName, settleFilter, withProduct } from '../product-meta.ts';
import { ALL_PRODUCTS, filterOptions, filterQuery, sidebarOrder, type ProductFilter } from '../products.ts';
import '../styles/product-filter.css';
import { routeHash } from '../routes.ts';
import { checkOp, liveProductId, reportOpError, runTaskOp } from '../task-ops.ts';

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
  onOpenChanges?: ((target: ChangesTarget) => void) | undefined;
}

interface Loaded {
  filter: ProductFilter;
  active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[]; lists: ReadonlyMap<string, Acceptance>;
  changed: ReadonlySet<string>; deviations: ReadonlyMap<string, readonly DeviationRow[]>;
}

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

function SessionCardView({ card, now, index, product, busy, onChecked, onOpenChanges }: { card: SessionCard; now: number; index: number; product: string | null; busy: boolean; onChecked: () => void; onOpenChanges?: (() => void) | undefined }) {
  const t = useT();
  const running = card.outcome === 'running';
  const check = card.column === 'check';
  const right = running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : card.outcome === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : card.outcome === 'stopped' ? <span className="bt-tag">{t('ui.kanban.stopped')}</span> : undefined;
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}`} style={{ '--bt-i': index } as CSSProperties} data-session={card.conversationId}>
      <Head label={t(check ? 'ui.kanban.sessionCheckIt' : 'ui.kanban.session')} dot={check} right={right} product={running ? null : product} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'chat', id: card.conversationId })}>{card.title || t('ui.session.untitled')}</a></h3>
      {running && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      {check && <p className="bt-meta ui-card__reasons" data-reasons>{t('ui.kanban.reason.sessionChanged')}</p>}
      <Meta items={running
        ? [product, card.step && t('ui.kanban.step', card.step.step, card.step.total), card.startedAt !== null && formatElapsed(now - card.startedAt)]
        : [formatRelative(card.at, now)]} />
      {check && (
        <div className="bt-card__actions">
          <Button variant="primary" small disabled={busy} onClick={onChecked}>{t('ui.check.markChecked')}</Button>
          {onOpenChanges && <Button small onClick={onOpenChanges}>{t('ui.kanban.openChanges')}</Button>}
        </div>
      )}
    </article>
  );
}

// beat 8-3: 取り込み待ちのブランチの 1 行（名前・+n −n・元のコミット）
function BranchLine({ worktree }: { worktree: NonNullable<Task['worktree']> }) {
  const t = useT();
  return (
    <div className="bt-card__meta ui-card__branch" data-branch={worktree.branch}>
      <span className="bt-tag">{worktree.branch}</span>
      {worktree.added !== null && <span className="bt-add">+{worktree.added}</span>}
      {worktree.removed !== null && <span className="bt-del">−{worktree.removed}</span>}
      <span>{t('ui.kanban.fromBase', worktree.base.slice(0, 7))}</span>
    </div>
  );
}

function PrefixDiff({ prefix }: { prefix: PreFix }) {
  const t = useT();
  return (
    <div className="bt-diff" aria-label={t('ui.kanban.prefix.diff')} data-prefix-diff>
      <span className="bt-diff__file"><span>{t('ui.kanban.prefix.files', prefix.files)}</span><span><span className="bt-add">+{prefix.added}</span> <span className="bt-del">−{prefix.removed}</span></span></span>
      {prefixDiff(prefix.diff).map((line, i) => (
        <span key={i} className={`bt-diff__line bt-diff__line--${line.kind}`} title={line.text}>{line.text}</span>
      ))}
    </div>
  );
}

function Deviations({ rows }: { rows: readonly DeviationRow[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <ul className="ui-check__items" data-deviations>
      {rows.map(row => (
        <li key={`${row.item ?? ''}|${row.what}`} className="ui-check__item">
          <span className="bt-tag">{t('ui.dev.chip')}</span>
          <span className="ui-check__text">{row.what}<span className="bt-meta">{t('ui.dev.why', row.why)}</span></span>
        </li>
      ))}
    </ul>
  );
}

// discard = ブランチと作業コピーを捨てる。merge = 取り込み済みにして、作業コピーに残るものを見せてから片づける
type PanelMode = 'discard' | 'merge';
type Discarding = { mode: PanelMode; state: 'loading' } | { mode: PanelMode; state: 'ready'; data: BranchCommits };
type DiscardResult = 'done' | 'stale' | 'failed';
type MergeResult = DiscardResult | 'dirty';

function CommitList({ commits, more, attr }: { commits: BranchCommits['commits']; more: number; attr?: string }) {
  const t = useT();
  if (commits.length === 0) return null;
  return (
    <ul className="ui-card__commits" {...(attr ? { [attr]: '' } : {})}>
      {commits.map(c => <li key={c.sha} className="bt-meta"><code>{c.sha.slice(0, 7)}</code> {c.subject}</li>)}
      {more > 0 && <li className="bt-meta">{t('ui.kanban.commitsMore', more)}</li>}
    </ul>
  );
}

const FILE_KIND = { changed: 'ui.kanban.file.changed', untracked: 'ui.kanban.file.untracked', ignored: 'ui.kanban.file.ignored' } as const;

// 捨てる前に、消えるものを全部見せる: ブランチだけにあるコミット（持ち主のものも）と、作業コピーにしか無いファイル（無視されるものも）
function DiscardPanel({ task, discarding, busy, onConfirm, onCancel }: { task: Task; discarding: Discarding; busy: boolean; onConfirm: (tip: string, files: string) => void; onCancel: () => void }) {
  const t = useT();
  const data = discarding.state === 'ready' ? discarding.data : null;
  return (
    <div className="bt-card__reason" data-discard={task.id} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      {!data ? <p className="bt-meta" role="status">{t('ui.set.loading')}</p> : (
        <>
          <p className="bt-meta">{discarding.mode === 'merge'
            ? t('ui.kanban.mergeAsk', data.path ?? '', data.filesTotal, data.headCommits.length + data.headMore)
            : t('ui.kanban.discardAsk', data.branch, data.commits.length + data.more + data.headCommits.length + data.headMore, data.filesTotal)}</p>
          {discarding.mode === 'discard' && <CommitList commits={data.commits} more={data.more} attr="data-discard-commits" />}
          {data.headCommits.length > 0 && <p className="bt-meta">{t('ui.kanban.headCommits')}</p>}
          <CommitList commits={data.headCommits} more={data.headMore} attr="data-discard-head" />
          {data.filesTotal > 0 && data.path && <p className="bt-meta ui-card__path" data-discard-path><code>{data.path}</code></p>}
          {data.filesTotal > 0 && (
            <ul className="ui-card__commits" data-discard-files>
              {data.files.map(file => <li key={file.path} className="bt-meta" data-kind={file.kind}><code>{file.path}</code> {t(FILE_KIND[file.kind])}</li>)}
              {data.filesTotal > data.files.length && <li className="bt-meta">{t('ui.kanban.commitsMore', data.filesTotal - data.files.length)}</li>}
            </ul>
          )}
        </>
      )}
      <div className="ui-card__reasonrow">
        <Button variant="danger" small disabled={busy || !data} onClick={() => { if (data) onConfirm(data.tip, data.print); }}>{t(discarding.mode === 'merge' ? 'ui.kanban.removeCopy' : 'ui.kanban.discardBranch')}</Button>
        <Button variant="ghost" small autoFocus onClick={onCancel}>{t('ui.cancel')}</Button>
      </div>
    </div>
  );
}

const NOTE_KEY = { not_on_branch: 'ui.kanban.branchNote.not_on_branch', in_progress: 'ui.kanban.branchNote.in_progress', missing: 'ui.kanban.branchNote.missing' } as const;

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

function TaskCardView({ card, now, index, first, busy, rejecting, product, pending, questions, list, wait, deviations, onApprove, onReject, onRejecting, onChecked, onMerged, onDiscard, onOpenChanges }: {
  card: TaskCard; now: number; index: number; first: boolean; busy: boolean; rejecting: boolean; product: string | null; pending: number; questions: number; list: Acceptance | null; wait: WaitReason | undefined;
  deviations: readonly DeviationRow[];
  onApprove: () => void; onReject: (reason: string) => void; onRejecting: (on: boolean) => void; onChecked: () => void;
  onMerged: (confirmed?: { tip: string; files: string }) => Promise<MergeResult>; onDiscard: (tip: string, files: string) => Promise<DiscardResult>; onOpenChanges?: (() => void) | undefined;
}) {
  const t = useT();
  const { task, column } = card;
  const [reason, setReason] = useState('');
  const [discarding, setDiscarding] = useState<Discarding | null>(null);
  const discardButton = useRef<HTMLButtonElement>(null);
  const running = task.status === 'running';
  const proposal = proposalOf(task);
  const prefix = prefixOf(task);
  const pendingFix = column === 'proposed' ? prefix : null;
  const merge = column === 'check' && awaitsMerge(task);
  // 作業コピーのブランチが残るカード: 取り込み待ち（Awaiting check）と、失敗・取り消しのカード（Failed）
  const branchy = merge || (column === 'failed' && branchLeft(task));
  const held = branchy ? task.worktree?.held ?? null : null;
  const checking = column === 'check' && awaitsCheck(task);
  const label = pendingFix ? t('ui.kanban.prefix.bug')
    : proposal && column === 'proposed' ? t(proposal.kind === 'bug' ? 'ui.kanban.proposal.bug' : 'ui.kanban.proposal.feature') : column === 'approved' ? t('ui.kanban.queued')
    : merge ? t(prefix ? 'ui.kanban.prefix.mergeIt' : 'ui.kanban.mergeIt') : column === 'check' ? t('ui.kanban.checkIt')
    : column === 'done' && mergedBranch(task) ? t(prefix ? 'ui.kanban.prefix.merged' : 'ui.kanban.merged') : t('ui.kanban.task');
  const reasons = [checking && t('ui.kanban.reason.check'), merge && t(held ? 'ui.kanban.reason.held' : 'ui.kanban.reason.merge')].filter((r): r is string => Boolean(r));
  const note = branchy && task.worktree?.note && task.worktree.note in NOTE_KEY ? t(NOTE_KEY[task.worktree.note as keyof typeof NOTE_KEY]) : null;
  const startDiscard = async (mode: PanelMode = 'discard') => {
    setDiscarding({ mode, state: 'loading' });
    try {
      const data = await api.branchCommits(task.id);
      setDiscarding(current => (current ? { mode: current.mode, state: 'ready', data } : current));
    } catch (failure) { setDiscarding(null); reportOpError(failure); }
  };
  // Mark merged: 残すファイルがあると分かっていれば（held）、またはサーバーが branch_dirty で断ったら、消えるものを見せる欄を開く
  const markMerged = () => { if (held) void startDiscard('merge'); else void onMerged().then(result => { if (result === 'dirty') void startDiscard('merge'); }); };
  const stopDiscard = () => { setDiscarding(null); requestAnimationFrame(() => discardButton.current?.focus()); };
  const right = pendingFix ? <Pill tone="ok">{t('ui.kanban.prefix.checks')}</Pill>
    : column === 'proposed' ? <span className="bt-meta">{formatRelative(task.created_at, now)}</span>
    : running ? <Pill tone="running">{t('ui.kanban.running')}</Pill>
    : task.status === 'waiting' ? <Pill tone="waiting">{t('ui.kanban.waiting')}</Pill>
    : task.status === 'failed' ? <Pill tone="danger">{t('ui.kanban.failed')}</Pill>
    : task.status === 'cancelled' ? <span className="bt-tag">{t(task.cancelled_from === 'inbox' ? 'ui.kanban.rejected' : 'ui.kanban.cancelled')}</span> : undefined;
  const onPending = pendingWait(task);
  const body = column === 'proposed' ? (proposal ? firstSentences(proposal.why, pendingFix ? 1 : 2) : plainLine(task.body, 200)) : onPending ? '' : task.status === 'waiting' ? plainLine(task.waiting_text, 200) : column === 'failed' ? plainLine(task.result_summary, 120) : '';
  const timed = task.run_at !== null && task.run_at > now;
  const meta: Array<string | false | null> = column === 'approved'
    ? [timed ? t('ui.kanban.starts', formatDateTimeSmart(task.run_at, now)) : first && t('ui.kanban.next'), task.status === 'ready' && wait !== undefined && waitText(wait, now), card.repeating && t('ui.kanban.repeating')]
    : column === 'progress' ? [running && product, card.step && t('ui.kanban.step', card.step.step, card.step.total), card.repeating && t('ui.kanban.repeating')]
    : pendingFix ? [pendingFix.branch, formatRelative(task.created_at, now)]
    : column === 'proposed' && proposal ? [...new Set(proposal.area), t('ui.kanban.proposal.size', proposal.size), proposal.goal !== null && t('ui.kanban.proposal.goal', proposal.goal)]
    : column === 'proposed' ? [task.origin !== 'user' && t('ui.kanban.byBeat'), card.repeating && t('ui.kanban.repeating')]
    : [formatRelative(card.at, now), column === 'check' && task.items !== undefined && t('ui.check.met', task.items.met, task.items.owned), card.repeating && t('ui.kanban.repeating')];
  return (
    <article className={`bt-card ${running ? 'bt-sheen' : 'bt-rise'}${rejecting || discarding ? ' is-rejecting' : ''}`} style={{ '--bt-i': index } as CSSProperties} data-task={task.id}>
      <Head label={label} dot={card.waiting} right={right} product={running ? null : product} />
      <h3 className="bt-card__title"><a className="ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a></h3>
      {body && <p className="bt-card__body">{body}</p>}
      {onPending && <p className="bt-card__body"><a className="bt-tool__link" href={routeHash(onPending.route)} data-pending-wait={task.id}>{t('ui.kanban.waitingPending', onPending.refs)}</a></p>}
      {pendingFix && <PrefixDiff prefix={pendingFix} />}
      {column === 'progress' && <StepBar step={card.step} label={t('ui.kanban.progress')} />}
      {column === 'check' && reasons.length > 0 && <p className="bt-meta ui-card__reasons" data-reasons>{reasons.join(' · ')}</p>}
      {branchy && task.worktree && <BranchLine worktree={task.worktree} />}
      {held && <p className="bt-meta ui-card__path" data-held-path><code>{held.path}</code></p>}
      {note && <p className="bt-meta ui-danger" data-branch-note>{note}</p>}
      {column === 'check' && <CheckItems task={task} list={list} />}
      {column === 'check' && <Deviations rows={deviations} />}
      <Meta items={meta} />
      {column === 'proposed' && proposal && proposal.goal === null && <div className="bt-card__meta"><span className="bt-tag" data-off-plan>{t('ui.kanban.proposal.offPlan')}</span></div>}
      {pending > 0 && !onPending && <a className="bt-tool__link bt-meta" href={routeHash(pendingRoute(task))}>{t('ui.task.pending', pending)}</a>}
      {questions > 0 && <a className="bt-tool__link bt-meta" href={routeHash(questionsRoute(task))} data-questions={questions}>{t('ui.task.questions', questions)}</a>}
      {column === 'check' && (
        <div className="bt-card__actions">
          {merge && <Button variant="primary" small disabled={busy} onClick={markMerged}>{t('ui.kanban.markMerged')}</Button>}
          {checking && <Button variant={merge ? undefined : 'primary'} small disabled={busy || !list} onClick={onChecked}>{t('ui.check.markChecked')}</Button>}
          {onOpenChanges && <Button small onClick={onOpenChanges}>{t('ui.kanban.openChanges')}</Button>}
          {merge ? <Button ref={discardButton} variant="ghost" small disabled={busy} data-discard-open={task.id} onClick={() => void startDiscard()}>{t('ui.kanban.discard')}</Button>
            : <a className="bt-btn bt-btn--sm" href={routeHash({ view: 'task', id: task.id })}>{t('ui.kanban.open')}</a>}
        </div>
      )}
      {column === 'failed' && branchy && (
        <div className="bt-card__actions">
          <Button small disabled={busy} onClick={markMerged}>{t('ui.kanban.markMerged')}</Button>
          {onOpenChanges && <Button small onClick={onOpenChanges}>{t('ui.kanban.openChanges')}</Button>}
          <Button ref={discardButton} variant="ghost" small disabled={busy} data-discard-open={task.id} onClick={() => void startDiscard()}>{t('ui.kanban.discard')}</Button>
        </div>
      )}
      {branchy && discarding && <DiscardPanel task={task} discarding={discarding} busy={busy} onCancel={stopDiscard}
        onConfirm={(tip, files) => void (discarding.mode === 'merge' ? onMerged({ tip, files }) : onDiscard(tip, files))
          .then(result => { if (result === 'done') setDiscarding(null); else if (result === 'stale') void startDiscard(discarding.mode); })} />}
      {column === 'proposed' && (
        <div className="bt-card__actions">
          <Button variant="primary" small disabled={busy} onClick={onApprove}>{t('ui.kanban.approve')}</Button>
          {pendingFix && onOpenChanges && <Button small onClick={onOpenChanges}>{t('ui.kanban.prefix.openDiff')}</Button>}
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
  const liveProduct = liveProductId(projects, product);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const built = buildNewTask(draft);
    if (!built.ok) { setError(t(built.error === 'title' ? 'ui.newtask.needTitle' : 'ui.newtask.needTime')); return; }
    setBusy(true);
    try {
      const { task } = await api.createTask(withProduct(built.task, liveProduct));
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
        <ProductPick projects={projects} value={liveProduct} onChange={setProduct} />
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

export function Kanban({ conversations, drafts, checklists, revision, projects, pendingByTask, questionsByTask, waits, productId, emptyProposed, onOpenChanges }: KanbanProps) {
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
  const uid = useId();
  const narrow = useMedia(COLUMN_TABS_MEDIA);
  const tabbed = pane || narrow;
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
      const [tasks, finished, runs, checks] = await Promise.all([
        api.tasks(project), readFinished(wanted.current, project), api.runs(RUNS_WINDOW, project), api.sessionChecks(project).then(r => r.sessions, () => []),
      ]);
      const active = [...tasks.active, ...(tasks.awaiting ?? [])];
      const productsOf = (keep: (task: Task) => boolean) => [...new Set([...active, ...finished.tasks].filter(keep).flatMap(task => (task.project_id ? [task.project_id] : [])))];
      const products = productsOf(awaitsCheck);
      const [lists, deviations] = await Promise.all([
        Promise.all(products.map(id => api.acceptance(id).then(r => [id, r.acceptance] as const, () => null))).then(entries => new Map(entries.filter(entry => entry !== null))),
        Promise.all(productsOf(task => awaitsCheck(task) || awaitsMerge(task)).map(id => api.deviationRows(id).then(r => [id, r.deviations.rows] as const, () => null))).then(entries => new Map(entries.filter(entry => entry !== null))),
      ]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ filter, active, finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs, lists, changed: new Set(checks.map(c => c.conversation_id)), deviations });
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

  const sessions = useMemo(() => sessionCards({ conversations: inFilter(conversations, filter), drafts, runs: data?.runs ?? [], checklists, changed: data?.changed }), [conversations, filter, drafts, data, checklists]);

  // beat 8-3: 製品の Kanban を開いたら、持ち主が取り込んだブランチを見回りを待たずに見つける（片づいたら task.changed で読み直す）
  useEffect(() => {
    if (productId) void api.checkBranches(productId).catch(() => undefined);
  }, [productId]);
  const board = useMemo(
    () => {
      if (!data) return null;
      const settled = data.filter === filter;
      return buildBoard({ active: inFilter(data.active, filter), finished: inFilter(data.finished, filter), hasMore: settled && data.next !== null, finishedTotal: settled ? data.total : 0, sessions, checklists });
    },
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
    const project = cardProject(card);
    if (card.kind === 'session') {
      return <SessionCardView key={card.key} card={card} now={now} index={index} product={product} busy={busy.has(card.key)}
        onChecked={() => void act(card.key, async () => { await api.sessionChecked(card.conversationId).catch(reportOpError); return true; })}
        onOpenChanges={onOpenChanges && project ? () => onOpenChanges({ productId: project, conversationId: card.conversationId }) : undefined} />;
    }
    const { task } = card;
    const prefix = task.status === 'inbox' ? prefixOf(task) : null;
    const worktree = branchLeft(task) || prefix ? task.worktree : null;
    const changes = onOpenChanges && project && (!prefix || worktree) ? () => onOpenChanges({ productId: project, ...(worktree ? { worktreeId: worktree.id, branch: worktree.branch } : {}) }) : undefined;
    return (
      <TaskCardView key={card.key} card={card} now={now} index={index} first={firstTask} busy={busy.has(task.id)} rejecting={rejecting === task.id} product={product} pending={pendingByTask.get(task.id) ?? 0} questions={questionsByTask.get(task.id) ?? 0} wait={waits?.[task.id]}
        onApprove={() => void act(task.id, () => runTaskOp('approve', task))}
        onReject={reason => void act(task.id, async () => { const ok = await runTaskOp('reject', task, { reason }); if (ok) setRejecting(null); return ok; })}
        onRejecting={on => setRejecting(on ? task.id : null)}
        list={(task.project_id && data?.lists.get(task.project_id)) || null}
        deviations={(task.project_id && data?.deviations.get(task.project_id)?.filter(row => row.by === 'task' && row.task === task.id)) || []}
        onMerged={async confirmed => {
          let result: MergeResult = 'failed';
          await act(task.id, async () => {
            try {
              const done = await api.markMerged(task.id, confirmed);
              result = 'done';
              toast({ kind: 'done', icon: 'check', title: t(done.outcome === 'kept' ? 'ui.kanban.toast.mergedKept' : done.outcome === 'copy_removed' ? 'ui.kanban.toast.copyRemoved' : 'ui.kanban.toast.merged'), body: task.title });
            } catch (failure) {
              const code = failure instanceof ApiError ? failure.body?.code : null;
              // 作業コピーにファイルが残る: 断りのトーストではなく、消えるものを見せる欄を開く
              if (code === 'http.branch_dirty' && !confirmed) { result = 'dirty'; return true; }
              if (code === 'http.branch_moved' || code === 'http.branch_changed') result = 'stale';
              reportOpError(failure);
            }
            return true;
          });
          return result;
        }}
        onDiscard={async (tip, files) => {
          let result: DiscardResult = 'failed';
          await act(task.id, async () => {
            try { await api.discardBranch(task.id, tip, files); result = 'done'; toast({ kind: 'done', icon: 'check', title: t('ui.kanban.toast.discarded'), body: task.title }); } catch (failure) {
              // 見せたあとでブランチかファイルが変わった: 欄を読み直して、もう一度見てもらう（自分ではやり直さない）
              if (failure instanceof ApiError && (failure.body?.code === 'http.branch_moved' || failure.body?.code === 'http.branch_changed')) result = 'stale';
              reportOpError(failure);
            }
            return true;
          });
          return result;
        }}
        onOpenChanges={changes}
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
              <button key={column.id} type="button" role="tab" className="bt-tab" id={`${uid}coltab-${column.id}`} aria-controls={`${uid}col-${column.id}`} data-coltab={column.id}
                aria-selected={tab === column.id} tabIndex={tab === column.id ? 0 : -1} onClick={() => setTab(column.id)}
                onKeyDown={e => {
                  const to = tabStep(order(board.columns).findIndex(c => c.id === tab), board.columns.length, e.key);
                  const target = to === null ? undefined : order(board.columns)[to];
                  if (!target) return;
                  e.preventDefault();
                  setTab(target.id);
                  document.getElementById(`${uid}coltab-${target.id}`)?.focus();
                }}>
                {columnName(t, column.id)}<span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`}><span className="bt-count__n">{countText(column.cards.length)}</span></span>
              </button>
            ))}
          </div>
          <div className="bt-board">
            {order(board.columns).map(column => {
              const firstTask = column.cards.findIndex(card => card.kind === 'task' && !(card.task.run_at !== null && card.task.run_at > now) && waits?.[card.task.id]?.kind !== 'off' && waits?.[card.task.id]?.kind !== 'owner');
              return (
                <section key={column.id} id={`${uid}col-${column.id}`} data-col={column.id} className={`bt-col${tab === column.id ? '' : ' ui-col--off'}`} aria-label={columnName(t, column.id)} {...(tabbed ? { role: 'tabpanel' } : {})}>
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
