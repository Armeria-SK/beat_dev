import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Approval, type ChecklistItem, type Conversation, type FinishedCursor, type RunRow, type Task, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, formatElapsed, formatRelative, startOfDay, useT } from '../../i18n/index.ts';
import { plainLine } from '../../task-meta.ts';
import type { Waiting } from '../agent-state.ts';
import { useNow } from '../hooks.ts';
import { buildBoard, KANBAN_PAGE, RUNS_WINDOW, sessionCards, type Card, type ColumnId } from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { finishedSince, LAST_LOOK_KEY, miniBoard, readLastLook, runningRows, tiles, workerLine, type RunningRow, type Tile, type TileId } from '../overview.ts';
import { Button, countText, Icon, Notice, Pill } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { reportOpError, runTaskOp } from '../task-ops.ts';
import { readFinished } from './Kanban.tsx';

export interface OverviewProps {
  waiting: Waiting;
  approvals: Approval[];
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  worker: WorkerStatus | null;
  onWorker: (status: WorkerStatus) => void;
  revision: number;
}

interface Loaded { active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[] }

const RELOAD_DELAY_MS = 150;
const TILE_LABEL = { proposals: 'ui.overview.proposals', questions: 'ui.overview.questions', pending: 'ui.overview.pending' } as const satisfies Record<TileId, string>;
const TILE_SOME = { proposals: 'ui.overview.proposals.some', questions: 'ui.overview.questions.some', pending: 'ui.overview.pending.some' } as const satisfies Record<TileId, string>;
const TILE_NONE = { proposals: 'ui.overview.proposals.none', questions: 'ui.overview.questions.none', pending: 'ui.overview.pending.none' } as const satisfies Record<TileId, string>;
const COLUMN_KEY = {
  proposed: 'ui.kanban.col.proposed', approved: 'ui.kanban.col.approved', progress: 'ui.kanban.col.progress', done: 'ui.kanban.col.done', failed: 'ui.kanban.col.failed',
} as const satisfies Record<ColumnId, string>;

function readStored(): string | null {
  try { return localStorage.getItem(LAST_LOOK_KEY); } catch { return null; }
}

function StatTile({ tile, index }: { tile: Tile; index: number }) {
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
      <span className="bt-meta">{t(tile.n > 0 ? TILE_SOME[tile.id] : TILE_NONE[tile.id])}</span>
    </>
  );
  const style = { '--bt-i': index + 1 } as CSSProperties;
  return tile.href
    ? <a className={classes} style={style} href={tile.href} data-tile={tile.id}>{inner}</a>
    : <div className={classes} style={style} data-tile={tile.id}>{inner}</div>;
}

function MiniCard({ card, sessionLabel, untitled }: { card: Card; sessionLabel: string; untitled: string }) {
  if (card.kind === 'session') {
    return (
      <a className={`bt-mini${card.outcome === 'running' ? ' bt-sheen' : ''}`} href={routeHash({ view: 'chat', id: card.conversationId })}>
        <span className="bt-mini__name">{card.title || untitled}</span><span className="bt-tag">{sessionLabel}</span>
      </a>
    );
  }
  return (
    <a className={`bt-mini${card.task.status === 'running' ? ' bt-sheen' : ''}`} href={routeHash({ view: 'task', id: card.task.id })}>
      {card.waiting && <span className="bt-dot" aria-hidden="true" />}<span className="bt-mini__name">{card.task.title}</span>
    </a>
  );
}

export function Overview({ waiting, approvals, conversations, drafts, checklists, worker, onWorker, revision }: OverviewProps) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [look] = useState(() => readLastLook(readStored(), Date.now(), startOfDay));
  const loads = useRef(latestOnly());
  const first = useRef(true);

  useEffect(() => {
    const write = () => { try { localStorage.setItem(LAST_LOOK_KEY, String(Date.now())); } catch { return; } };
    addEventListener('pagehide', write);
    return () => { removeEventListener('pagehide', write); write(); };
  }, []);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [tasks, finished, runs] = await Promise.all([api.tasks(), readFinished(KANBAN_PAGE), api.runs(RUNS_WINDOW)]);
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

  const sessions = useMemo(() => sessionCards({ conversations, drafts, runs: data?.runs ?? [], checklists }), [conversations, drafts, data, checklists]);
  const mini = useMemo(
    () => (data ? miniBoard(buildBoard({ active: data.active, finished: data.finished, hasMore: data.next !== null, finishedTotal: data.total, sessions, checklists })) : null),
    [data, sessions, checklists],
  );
  const running = useMemo(() => runningRows({ worker: worker?.runningAll ?? [], drafts, conversations, checklists }), [worker, drafts, conversations, checklists]);
  const done = useMemo(() => (data ? finishedSince(data.finished, look.at) : null), [data, look.at]);
  const now = useNow(running.some(row => row.startedAt !== null) ? 1000 : 30_000);
  const stats = tiles(waiting, approvals);
  const line = workerLine(worker, now);

  const act = async (key: string, work: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    setBusy(current => new Set(current).add(key));
    try { await work(); } catch (error) { reportOpError(error); } finally {
      setBusy(current => { const next = new Set(current); next.delete(key); return next; });
    }
  };
  const setPaused = (paused: boolean) => void act('worker', async () => {
    onWorker(await api.setWorker({ paused }));
    toast({ icon: paused ? 'square' : 'check', title: t(paused ? 'ui.overview.toast.paused' : 'ui.overview.toast.resumed') });
  });
  const stop = (row: RunningRow) => void act(row.key, async () => {
    await api.stop(row.runId);
    toast({ icon: 'square', title: t('ui.task.toast.stopped'), ...(row.kind === 'task' ? { body: t('ui.task.toast.stoppedBody') } : {}) });
  });
  const retry = (task: Task) => void act(task.id, async () => { if (await runTaskOp('retry', task, { busyWithOther: (worker?.runningAll.length ?? 0) > 0 })) await load(); });

  const rowTitle = (row: RunningRow): string => (row.kind === 'review' ? t('ui.overview.review') : row.title || t('ui.session.untitled'));
  const rowMeta = (row: RunningRow): string => [
    t(row.kind === 'task' ? 'ui.overview.kind.task' : row.kind === 'review' ? 'ui.overview.kind.review' : 'ui.overview.kind.session'),
    row.step && t('ui.kanban.step', row.step.step, row.step.total),
    row.startedAt !== null && formatElapsed(now - row.startedAt),
  ].filter(Boolean).join(' · ');

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{look.known ? t('ui.overview.lastLook', formatDateTimeSmart(look.at, now)) : t('ui.overview.firstLook')}</span>
          <h1 className="bt-screen__title bt-screen__title--lg">{t('ui.nav.overview')}</h1>
        </div>
        <div className="bt-screen__tools">
          {worker && !worker.enabled && <span className="bt-meta" data-worker="off">{t('ui.overview.workerOff')} · <a className="bt-tool__link" href="#/settings">{t('ui.nav.settings')}</a></span>}
          {worker?.enabled && worker.paused && <span className="bt-meta">{t('ui.overview.workerPaused')}</span>}
          {line && <span className="bt-meta" data-worker-line>{t('ui.overview.workerRuns', line.runs, line.max)}{line.nextWakeAt !== null && ` · ${t('ui.overview.nextWake', formatDateTimeSmart(line.nextWakeAt, now))}`}</span>}
          {worker?.enabled && (
            <Button icon={worker.paused ? 'refresh' : 'pause'} disabled={busy.has('worker')} data-worker={worker.paused ? 'paused' : 'on'} onClick={() => setPaused(!worker.paused)}>
              {t(worker.paused ? 'ui.overview.resume' : 'ui.overview.pause')}
            </Button>
          )}
          <a className="bt-btn bt-btn--icon ui-narrow-only" href="#/settings" aria-label={t('ui.nav.settings')}><Icon name="sliders" /></a>
        </div>
      </header>

      <section className="bt-stats" aria-label={t('ui.overview.waiting')}>
        {stats.map((tile, index) => <StatTile key={tile.id} tile={tile} index={index} />)}
      </section>

      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}

      <div className="bt-cols">
        <section className="bt-section bt-rise" style={{ '--bt-i': 4 } as CSSProperties} aria-label={t('ui.overview.running')}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.overview.running')}</span></div>
          {running.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.overview.nothingRunning')}</p> : (
            <ul className="bt-list">
              {running.map((row, index) => (
                <li key={row.key} className={`bt-row${index === 0 ? ' bt-sheen' : ''}`}>
                  <Icon name={row.kind === 'session' ? 'msg' : row.kind === 'review' ? 'book' : 'check'} />
                  <div className="bt-row__main">
                    {row.href ? <a className="bt-row__title ui-card__link" href={row.href}>{rowTitle(row)}</a> : <span className="bt-row__title">{rowTitle(row)}</span>}
                    <span className="bt-row__sub bt-meta">{rowMeta(row)}</span>
                  </div>
                  <div className="bt-row__end">
                    <Pill tone="running">{t('ui.kanban.running')}</Pill>
                    <Button variant="ghost" small disabled={busy.has(row.key)} onClick={() => stop(row)}>{t('ui.task.stop')}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bt-section bt-rise" style={{ '--bt-i': 5 } as CSSProperties} aria-label={t('ui.overview.finished', formatDateTimeSmart(look.at, now))}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.overview.finished', formatDateTimeSmart(look.at, now))}</span></div>
          {!done || done.tasks.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.overview.nothingFinished')}</p> : (
            <ul className="bt-list">
              {done.tasks.map(task => (
                <li key={task.id} className="bt-row">
                  <Icon name={task.status === 'failed' ? 'alert' : 'check'} className={task.status === 'failed' ? 'bt-del' : undefined} />
                  <div className="bt-row__main">
                    <a className="bt-row__title ui-card__link" href={routeHash({ view: 'task', id: task.id })}>{task.title}</a>
                    <span className="bt-row__sub bt-meta">{[formatRelative(task.completed_at ?? task.updated_at, now), plainLine(task.result_summary, 80)].filter(Boolean).join(' · ')}</span>
                  </div>
                  {task.status === 'failed' && <div className="bt-row__end"><Button small disabled={busy.has(task.id)} onClick={() => retry(task)}>{t('ui.task.retry')}</Button></div>}
                </li>
              ))}
              {done.more > 0 && <li className="bt-row"><a className="bt-tool__link bt-meta" href="#/kanban">{t('ui.kanban.more', done.more)}</a></li>}
            </ul>
          )}
        </section>
      </div>

      {mini && (
        <section className="bt-section bt-rise" style={{ '--bt-i': 6 } as CSSProperties} aria-label={t('ui.nav.kanban')}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.nav.kanban')}</span><a className="bt-tool__link bt-meta" href="#/kanban">{t('ui.overview.openBoard')}</a></div>
          <div className="bt-board bt-board--compact">
            {mini.map(column => (
              <div key={column.id} className="bt-col" data-col={column.id}>
                <div className="bt-col__head">
                  <span className="bt-label">{t(COLUMN_KEY[column.id])}</span>
                  <span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`} aria-label={t('ui.kanban.count', column.count)}><span className="bt-count__n">{countText(column.count)}</span></span>
                </div>
                {column.cards.map(card => <MiniCard key={card.key} card={card} sessionLabel={t('ui.kanban.session')} untitled={t('ui.session.untitled')} />)}
                {column.more > 0 && <a className="bt-mini bt-mini--more" href="#/kanban">{t('ui.kanban.more', column.more)}</a>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
