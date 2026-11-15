import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type Task, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatElapsed, formatRelative, startOfDay, useT } from '../../i18n/index.ts';
import { plainLine } from '../../task-meta.ts';
import type { Card, ColumnId } from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { readLastLook, type MiniColumn, type PlacedRow, type RunningRow, type Tile, type TileId } from '../overview.ts';
import { Button, countText, Icon, Pill } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { reportOpError, runTaskOp } from '../task-ops.ts';

const RELOAD_DELAY_MS = 150;
const TILE_LABEL = { proposals: 'ui.overview.proposals', questions: 'ui.overview.questions', pending: 'ui.overview.pending' } as const satisfies Record<TileId, string>;
const TILE_SOME = { proposals: 'ui.overview.proposals.some', questions: 'ui.overview.questions.some', pending: 'ui.overview.pending.some' } as const satisfies Record<TileId, string>;
const TILE_NONE = { proposals: 'ui.overview.proposals.none', questions: 'ui.overview.questions.none', pending: 'ui.overview.pending.none' } as const satisfies Record<TileId, string>;
const COLUMN_KEY = {
  proposed: 'ui.kanban.col.proposed', approved: 'ui.kanban.col.approved', progress: 'ui.kanban.col.progress', check: 'ui.kanban.col.check', done: 'ui.kanban.col.done', failed: 'ui.kanban.col.failed',
} as const satisfies Record<ColumnId, string>;

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function useLastLook(key: string, keep = true): { at: number; known: boolean } {
  const [look] = useState(() => readLastLook(readStored(key), Date.now(), startOfDay));
  useEffect(() => {
    if (!keep) return undefined;
    const write = () => { try { localStorage.setItem(key, String(Date.now())); } catch { return; } };
    addEventListener('pagehide', write);
    return () => { removeEventListener('pagehide', write); write(); };
  }, [key, keep]);
  return look;
}

export function useHomeLoad<T>(read: () => Promise<T>, revision: number, drafts: readonly LiveDraft[]): { data: T | null; failed: boolean; load: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const loads = useRef(latestOnly());
  const first = useRef(true);
  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const next = await read();
      if (!loads.current.isCurrent(ticket)) return;
      setData(next);
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [read]);
  const runKey = drafts.map(d => d.runId).join(',');
  useEffect(() => {
    const timer = setTimeout(() => void load(), first.current ? 0 : RELOAD_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [load, revision, runKey]);
  return { data, failed, load };
}

export function useRunActions(worker: WorkerStatus | null, reload: () => Promise<void>) {
  const t = useT();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const act = async (key: string, work: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    setBusy(current => new Set(current).add(key));
    try { await work(); } catch (error) { reportOpError(error); } finally {
      setBusy(current => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  const stop = (row: RunningRow) => void act(row.key, async () => {
    await api.stop(row.runId);
    toast({ icon: 'square', title: t('ui.task.toast.stopped'), ...(row.kind === 'task' ? { body: t('ui.task.toast.stoppedBody') } : {}) });
  });
  const retry = (task: Task) => void act(task.id, async () => { if (await runTaskOp('retry', task, { busyWithOther: (worker?.runningAll.length ?? 0) > 0 })) await reload(); });
  return { busy, act, stop, retry };
}

export function StatTile({ tile, index, meta }: { tile: Tile; index: number; meta?: string | undefined }) {
  const t = useT();
  const shown = useRef(tile.n);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (shown.current === tile.n) return;
    shown.current = tile.n;
    setTick(n => n + 1);
  }, [tile.n]);
  const classes = `bt-stat${tile.n > 0 ? ' bt-stat--waiting' : ''}${tick > 0 ? ' is-ticking' : ''} bt-rise`;
  const inner = (
    <>
      <span className="bt-stat__head">{tile.n > 0 && <span className="bt-dot" aria-hidden="true" />}<span className="bt-label">{t(TILE_LABEL[tile.id])}</span></span>
      <span className="bt-stat__n"><span key={tick}>{tile.n}</span></span>
      <span className="bt-meta">{meta || t(tile.n > 0 ? TILE_SOME[tile.id] : TILE_NONE[tile.id])}</span>
    </>
  );
  const style = { '--bt-i': index + 1 } as CSSProperties;
  return tile.href
    ? <a className={classes} style={style} href={tile.href} data-tile={tile.id}>{inner}</a>
    : <div className={classes} style={style} data-tile={tile.id}>{inner}</div>;
}

function MiniCard({ card, sessionLabel, untitled, tag }: { card: Card; sessionLabel: string; untitled: string; tag: string | null }) {
  const product = tag && <span className="bt-tag" data-product-tag>{tag}</span>;
  if (card.kind === 'session') {
    return (
      <a className={`bt-mini${card.outcome === 'running' ? ' bt-sheen' : ''}`} href={routeHash({ view: 'chat', id: card.conversationId })}>
        <span className="bt-mini__name">{card.title || untitled}</span><span className="bt-tag">{sessionLabel}</span>{product}
      </a>
    );
  }
  return (
    <a className={`bt-mini${card.task.status === 'running' ? ' bt-sheen' : ''}`} href={routeHash({ view: 'task', id: card.task.id })}>
      {card.waiting && <span className="bt-dot" aria-hidden="true" />}<span className="bt-mini__name">{card.task.title}</span>{product}
    </a>
  );
}

export function MiniBoard({ columns, label, index, className, tagOf }: { columns: MiniColumn[]; label: string; index: number; className?: string; tagOf?: (card: Card) => string | null }) {
  const t = useT();
  return (
    <section className={`bt-section bt-rise${className ? ` ${className}` : ''}`} style={{ '--bt-i': index } as CSSProperties} aria-label={label}>
      <div className="bt-section__head"><span className="bt-label">{label}</span><a className="bt-tool__link bt-meta" href="#/kanban">{t('ui.overview.openBoard')}</a></div>
      <div className="bt-board bt-board--compact">
        {columns.map(column => (
          <div key={column.id} className="bt-col" data-col={column.id}>
            <div className="bt-col__head">
              <span className="bt-label">{t(COLUMN_KEY[column.id])}</span>
              <span className={`bt-count${column.accent && column.id === 'proposed' ? '' : ' bt-count--quiet'}`} aria-label={t('ui.kanban.count', column.count)}><span className="bt-count__n">{countText(column.count)}</span></span>
            </div>
            {column.cards.map(card => <MiniCard key={card.key} card={card} sessionLabel={t('ui.kanban.session')} untitled={t('ui.session.untitled')} tag={tagOf?.(card) ?? null} />)}
            {column.more > 0 && <a className="bt-mini bt-mini--more" href="#/kanban">{t('ui.kanban.more', column.more)}</a>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function RunningItems({ rows, now, busy, onStop, sheen }: { rows: PlacedRow[]; now: number; busy: ReadonlySet<string>; onStop: (row: RunningRow) => void; sheen: boolean }) {
  const t = useT();
  const title = (row: RunningRow): string => (row.kind === 'review' ? t('ui.overview.review') : row.title || t('ui.session.untitled'));
  const meta = (row: RunningRow): string => [
    t(row.kind === 'task' ? 'ui.overview.kind.task' : row.kind === 'review' ? 'ui.overview.kind.review' : 'ui.overview.kind.session'),
    row.step && t('ui.kanban.step', row.step.step, row.step.total),
    row.startedAt !== null && formatElapsed(now - row.startedAt),
  ].filter(Boolean).join(' · ');
  return rows.map((row, index) => (
    <li key={row.key} className={`bt-row${sheen && index === 0 ? ' bt-sheen' : ''}`}>
      <Icon name={row.kind === 'session' ? 'msg' : row.kind === 'review' ? 'book' : 'check'} />
      <div className="bt-row__main">
        {row.href ? <a className="bt-row__title ui-card__link" href={row.href}>{title(row)}</a> : <span className="bt-row__title">{title(row)}</span>}
        <span className="bt-row__sub bt-meta">{meta(row)}</span>
      </div>
      <div className="bt-row__end">
        {row.archived && <span className="bt-tag" data-archived>{t('ui.pf.someArchived')}</span>}
        <Pill tone="running">{t('ui.kanban.running')}</Pill>
        <Button variant="ghost" small disabled={busy.has(row.key)} onClick={() => onStop(row)}>{t('ui.task.stop')}</Button>
      </div>
    </li>
  ));
}

export function FinishedItem({ task, now, busy, onRetry }: { task: Task; now: number; busy: ReadonlySet<string>; onRetry: (task: Task) => void }) {
  const t = useT();
  return (
    <li className="bt-row">
      <Icon name={task.status === 'failed' ? 'alert' : 'check'} className={task.status === 'failed' ? 'bt-del' : undefined} />
      <div className="bt-row__main">
        <a className="bt-row__title ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a>
        <span className="bt-row__sub bt-meta">{[formatRelative(task.completed_at ?? task.updated_at, now), plainLine(task.result_summary, 80)].filter(Boolean).join(' · ')}</span>
      </div>
      {task.status === 'failed' && <div className="bt-row__end"><Button small disabled={busy.has(task.id)} onClick={() => onRetry(task)}>{t('ui.task.retry')}</Button></div>}
    </li>
  );
}

