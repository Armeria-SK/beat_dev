import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Conversation, type PendingAction, type PendingCounts, type Project } from '../../api.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { ROW_LEAVE_MS } from '../library.ts';
import { Button, EmptyState, Icon, Notice } from '../parts.tsx';
import {
  acceptanceRows, actionView, byteSize, cleanReason, decidedMore, decidedShown, decidedText, earlierQuery, effectFiles, extraShown, fileFacts, fromTitle, kindLabel, kindTile, mergeDecided, outcomeOf, REASON_MAX, reasonLine, waitingShown,
  type AcceptanceRow, type ActionView, type FileFact, type KindTile, type Outcome,
} from '../pending.ts';
import { reportOpError } from '../task-ops.ts';
import '../styles/pending.css';

const PREVIEW_CHARS = 8000;
const literalMark = (row: PendingAction): boolean => [row.shown, row.parts?.body, row.parts?.cwd, row.parts?.extra, ...row.preview.map(f => f.text)].some(text => text?.includes('[BEAT-SECRET'));
const TILE_ICON = { send: 'send', delete: 'bin', unsure: 'alert' } as const satisfies Record<KindTile, string>;

type T = ReturnType<typeof useT>;

function outcomeText(t: T, outcome: Outcome): string {
  const time = formatDateTime(outcome.at, 'time');
  switch (outcome.kind) {
    case 'running': return t('ui.pending.running');
    case 'ran': return t('ui.pending.ran', time, outcome.exit);
    case 'failed': return t('ui.pending.failed', time, outcome.detail);
    case 'stale': return t('ui.pending.stale', time);
    case 'rejected': return t('ui.pending.rejected', time, outcome.reason);
    case 'cancelled': return t('ui.pending.cancelled', time);
  }
}

function fromText(t: T, row: PendingAction, withProduct: boolean, titles: ReadonlyMap<string, string | null>): string {
  const title = fromTitle(row, titles) ?? t('ui.session.untitled');
  const product = row.project_name && row.project_archived ? t('ui.pf.archived', row.project_name) : withProduct ? row.project_name : null;
  return product ? t('ui.pending.fromProduct', product, title) : t('ui.pending.from', title);
}

function sizeText(t: T, bytes: number): string {
  const size = byteSize(bytes);
  return t('ui.pending.bytes', size.value, size.unit);
}

function factText(t: T, fact: FileFact): string {
  switch (fact.kind) {
    case 'missing': return t('ui.pending.missing');
    case 'file': return t('ui.pending.fileNow', sizeText(t, fact.bytes), formatDateTime(fact.at));
    case 'dir': return t('ui.pending.dirNow', fact.more ? t('ui.pending.filesMore', fact.files) : t('ui.pending.files', fact.files), formatDateTime(fact.at));
  }
}

function ActionBody({ row, view }: { row: PendingAction; view: ActionView }) {
  const t = useT();
  const facts = fileFacts(row);
  const extra = extraShown(row.title, view.extra);
  return (
    <>
      {view.cwd && <p className="bt-meta ui-pending__cwd">{t('ui.pending.cwd')} <code>{view.cwd}</code></p>}
      {view.block && <pre className="ui-pending__body"><code>{view.block}</code></pre>}
      {extra && (
        <div className="ui-pending__file">
          <span className="bt-meta">{t('ui.pending.extra')}</span>
          <pre className="ui-pending__body ui-pending__extra"><code>{extra}</code></pre>
        </div>
      )}
      {row.preview.map(file => (
        <div key={file.path} className="ui-pending__file">
          <span className="bt-meta">{t('ui.pending.preview')} · <code>{file.path}</code></span>
          <pre className="ui-pending__body"><code>{file.text}</code></pre>
          {row.oldPreview && <p className="bt-meta ui-pending__old" role="note">{t('ui.pending.oldPreview')}</p>}
          {file.truncated && <p className="bt-meta" role="note">{file.chars !== undefined && file.chars > PREVIEW_CHARS ? t('ui.pending.previewCut', PREVIEW_CHARS, file.chars) : t('ui.pending.previewCutAny')}</p>}
        </div>
      ))}
      {facts.length > 0 && (
        <ul className="ui-pending__facts bt-meta" aria-label={t('ui.pending.sends')}>
          {facts.map(fact => <li key={fact.path}><code>{fact.path}</code> · {factText(t, fact)}</li>)}
        </ul>
      )}
    </>
  );
}

interface ItemProps {
  row: PendingAction; index: number; now: number; withProduct: boolean; titles: ReadonlyMap<string, string | null>; busy: boolean; leaving: boolean;
  onApprove: (row: PendingAction) => void; onReject: (row: PendingAction, reason: string) => void;
}

function PendingItem({ row, index, now, withProduct, titles, busy, leaving, onApprove, onReject }: ItemProps) {
  const t = useT();
  const id = useId();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const tile = kindTile(row.kind);
  const why = reasonLine(row);
  const locked = busy || leaving;
  const files = effectFiles(row);
  const view = actionView(row);
  return (
    <div className={`bt-pending${tile === 'delete' ? ' bt-pending--delete' : ''}${leaving ? ' is-leaving' : ' bt-rise'} ui-pending__item`} style={{ '--bt-i': index } as CSSProperties} data-pending={row.id} aria-busy={busy || undefined}>
      <span className="bt-pending__kind" aria-hidden="true"><Icon name={TILE_ICON[tile]} /></span>
      <p className="bt-pending__what">
        <span className="bt-label">{t(kindLabel(row.kind))}</span>{view.title && <> {view.title}</>}
        {files !== null && <> {files.more ? t('ui.pending.effectMore', files.files) : t('ui.pending.effect', files.files)}</>}
      </p>
      {!asking && (
        <div className="bt-pending__actions">
          <Button small disabled={locked} onClick={() => onApprove(row)}>{t('ui.pending.approve')}</Button>
          <Button small variant="ghost" disabled={locked} onClick={() => setAsking(true)}>{t('ui.pending.reject')}</Button>
        </div>
      )}
      {asking && (
        <form className="ui-pending__reject" onSubmit={e => { e.preventDefault(); if (!locked) onReject(row, cleanReason(reason)); }}
          onKeyDown={e => { if (e.key === 'Escape' && !locked) { e.preventDefault(); e.stopPropagation(); setAsking(false); } }}>
          <label className="bt-label" htmlFor={id}>{t('ui.pending.rejectReason')}</label>
          <input id={id} className="bt-field" autoFocus value={reason} maxLength={REASON_MAX} autoComplete="off" disabled={locked} onChange={e => setReason(e.target.value)} />
          <span className="bt-pending__actions">
            <Button small type="submit" disabled={locked}>{t('ui.pending.reject')}</Button>
            <Button small variant="ghost" disabled={locked} onClick={() => setAsking(false)}>{t('ui.pending.cancel')}</Button>
          </span>
        </form>
      )}
      <div className="ui-pending__detail">
        {view.inline && <code className="ui-pending__code ui-pending__command">{view.inline}</code>}
        <ActionBody row={row} view={view} />
        {(why || row.masked > 0 || literalMark(row)) && (
          <p className="bt-meta ui-pending__why">{[why && ('key' in why ? t(why.key) : why.text), row.masked > 0 && (row.held?.length ? t('ui.pending.heldKey', row.masked, row.held.join(', ')) : t('ui.pending.masked', row.masked)), row.masked === 0 && literalMark(row) && t('ui.pending.literalMark')].filter(Boolean).join(' · ')}</p>
        )}
        <div className="bt-pending__from bt-meta"><span>{fromText(t, row, withProduct, titles)}</span><span>{formatRelative(row.created_at, now)}</span></div>
      </div>
    </div>
  );
}

function AcceptanceItem({ row, index, withProduct, onOpenPlan }: { row: AcceptanceRow; index: number; withProduct: boolean; onOpenPlan: (projectId: string) => void }) {
  const t = useT();
  return (
    <div className="bt-pending bt-rise ui-pending__item" style={{ '--bt-i': index } as CSSProperties} data-acceptance={row.projectId}>
      <span className="bt-pending__kind" aria-hidden="true"><Icon name="check" /></span>
      <div className="ui-pending__text">
        <p className="bt-pending__what"><span className="bt-label">{t('ui.pending.acceptance')}</span></p>
        <div className="bt-pending__from bt-meta">{withProduct && <span>{row.name}</span>}<span>{t('ui.pending.acceptanceCount', row.n)}</span></div>
      </div>
      <div className="bt-pending__actions"><Button small variant="ghost" onClick={() => onOpenPlan(row.projectId)}>{t('ui.pending.openPlan')}</Button></div>
    </div>
  );
}

export interface PendingListProps {
  projectId: string | null;
  waiting: readonly PendingAction[];
  counts: PendingCounts | null;
  projects: readonly Project[];
  conversations: readonly Conversation[];
  revision: string;
  onOpenPlan: (projectId: string) => void;
}

export function PendingList({ projectId, waiting, counts, projects, conversations, revision, onOpenPlan }: PendingListProps) {
  const t = useT();
  const now = useNow(30_000);
  const all = projectId === null;
  const [decided, setDecided] = useState<PendingAction[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [earlier, setEarlier] = useState<'idle' | 'loading' | 'none'>('idle');
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const [held, setHeld] = useState<readonly PendingAction[]>([]);
  const [local, setLocal] = useState<readonly PendingAction[]>([]);
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const loads = useRef(latestOnly());
  const sent = useRef(new Set<number>());
  const project = projectId ?? undefined;

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const page = await api.pending({ status: 'decided', ...(project ? { project } : {}) });
      if (!loads.current.isCurrent(ticket)) return;
      setDecided(old => mergeDecided(old ?? [], page.items));
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [project]);
  useEffect(() => { void load(); }, [load, revision]);

  const showEarlier = async () => {
    if (earlier === 'loading' || !decided) return;
    const cursor = earlierQuery(decided);
    setEarlier('loading');
    try {
      const page = await api.pending({ status: 'decided', ...(project ? { project } : {}), ...cursor });
      setDecided(old => mergeDecided(old ?? [], page.items));
      setEarlier(page.items.length === 0 ? 'none' : 'idle');
    } catch (error) { reportOpError(error); setEarlier('idle'); }
  };

  const mark = (set: typeof setBusy, id: number, on: boolean) => set(old => { const next = new Set(old); if (on) next.add(id); else next.delete(id); return next; });
  const decide = async (row: PendingAction, run: () => Promise<{ item?: PendingAction }>, after: Partial<PendingAction>) => {
    if (sent.current.has(row.id)) return;
    sent.current.add(row.id);
    mark(setBusy, row.id, true);
    let item: PendingAction | undefined;
    try { item = (await run()).item; } catch (error) { reportOpError(error); sent.current.delete(row.id); mark(setBusy, row.id, false); void load(); return; }
    const shown = item ?? { ...row, ...after, decided_at: Date.now() };
    mark(setBusy, row.id, false);
    setHeld(old => [...old.filter(r => r.id !== row.id), row]);
    setTimeout(() => {
      setHeld(old => old.filter(r => r.id !== row.id));
      mark(setGone, row.id, true);
      setLocal(old => [...old.filter(r => r.id !== row.id), shown]);
      void load();
    }, ROW_LEAVE_MS);
  };
  const approve = (row: PendingAction) => void decide(row, () => api.approvePending(row.id), { status: 'running' });
  const reject = (row: PendingAction, reason: string) => void decide(row, () => api.rejectPending(row.id, reason), { status: 'rejected', reject_reason: reason || null });

  const rows = waitingShown(waiting, held, gone, projectId);
  const leaving = new Set(held.map(r => r.id));
  const changes = acceptanceRows(counts, projects, projectId);
  const total = rows.filter(r => !leaving.has(r.id)).length + changes.reduce((sum, r) => sum + r.n, 0);
  const titles = useMemo(() => new Map(conversations.map(c => [c.id, c.title])), [conversations]);
  const today = decidedShown(decided ?? [], waiting, local, projectId);

  return (
    <div className="ui-pending" data-scope={all ? 'all' : projectId}>
      <div className="bt-pane__bar">
        <span className="bt-section__kind">{total > 0 && <span className="bt-dot" aria-hidden="true" />}<span className="bt-label">{t('ui.pending.waiting', total)}</span></span>
        <span className="bt-meta ui-pending__note">{t('ui.pending.notRun')}</span>
      </div>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {rows.length === 0 && changes.length === 0 ? (
        <EmptyState title={t('ui.pending.empty')} text={counts ? <span className="bt-meta">{t('ui.pending.passed', counts.judgedToday.allowed)}</span> : undefined} />
      ) : (
        <div className="bt-pane__stack ui-pending__stack">
          {changes.map((row, i) => <AcceptanceItem key={`a:${row.projectId}`} row={row} index={i} withProduct={all} onOpenPlan={onOpenPlan} />)}
          {rows.map((row, i) => (
            <PendingItem key={row.id} row={row} index={changes.length + i} now={now} withProduct={all} titles={titles} busy={busy.has(row.id)} leaving={leaving.has(row.id)} onApprove={approve} onReject={reject} />
          ))}
        </div>
      )}
      <section className="bt-section ui-pending__decided" aria-label={t('ui.pending.decided')}>
        <div className="bt-section__head"><span className="bt-label">{t('ui.pending.decided')}</span><span className="bt-meta">{t('ui.pending.today')}</span></div>
        {decided && today.length === 0 && <p className="bt-meta ui-pending__none">{t('ui.pending.noneDecided')}</p>}
        {today.length > 0 && (
          <ul className="bt-list">
            {today.map(row => {
              const outcome = outcomeOf(row);
              const line = decidedText(actionView(row));
              const more = decidedMore(row);
              if (!outcome) return null;
              const ok = outcome.kind === 'ran' && (outcome.exit === null || outcome.exit === 0);
              return (
                <li key={row.id} className="bt-row" data-decided={row.status}>
                  <Icon name={outcome.kind === 'running' ? 'clock' : ok ? 'check' : outcome.kind === 'failed' || outcome.kind === 'ran' ? 'alert' : 'x'} className={outcome.kind === 'ran' && ok ? 'bt-add' : undefined} />
                  <div className="bt-row__main">
                    <span className="bt-row__title ui-pending__shown">{line.erased && <span className="ui-pending__title bt-meta">{t('ui.pending.erased')}</span>}{line.title && <span className="ui-pending__title">{line.title}</span>}{line.code && <code className="ui-pending__code">{line.code}</code>}</span>
                    <span className="bt-row__sub bt-meta">{[all && row.project_name, line.cwd && `${t('ui.pending.cwd')} ${line.cwd}`, outcomeText(t, outcome)].filter(Boolean).join(' · ')}</span>
                    {more && (
                      <details className="ui-pending__more">
                        <summary className="bt-meta">{t('ui.pending.more')}</summary>
                        {more.reason && <p className="bt-meta ui-pending__why">{t('ui.pending.reasonGiven')}: {more.reason}</p>}
                        {more.output && (
                          <div className="ui-pending__file">
                            <span className="bt-meta">{t('ui.pending.output')}</span>
                            <pre className="ui-pending__body"><code>{more.output}</code></pre>
                          </div>
                        )}
                      </details>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {decided && (earlier === 'none'
          ? <p className="bt-meta ui-pending__none">{t('ui.pending.noEarlier')}</p>
          : <Button small variant="ghost" className="ui-pending__earlier" disabled={earlier === 'loading'} onClick={() => void showEarlier()}>{t('ui.pending.earlier')}</Button>)}
      </section>
    </div>
  );
}
