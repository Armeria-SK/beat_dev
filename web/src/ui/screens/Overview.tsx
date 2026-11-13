import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type ChecklistItem, type Conversation, type FinishedCursor, type Project, type RunRow, type Task, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, formatElapsed, formatRelative, startOfDay, useT } from '../../i18n/index.ts';
import { plainLine } from '../../task-meta.ts';
import type { Waiting } from '../agent-state.ts';
import { useNow } from '../hooks.ts';
import { buildBoard, KANBAN_PAGE, mergeFinished, RUNS_WINDOW, sessionCards, type Card, type ColumnId } from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import {
  cardProduct, conversationOwners, finishedPaging, finishedSince, hasSomething, holders, LAST_LOOK_KEY, listsProducts, miniBoard, productSection, readLastLook, taskOwners, tiles, workerLine,
  type MiniColumn, type Paging, type ProductSection, type RunningRow, type Tile, type TileId,
} from '../overview.ts';
import { Avatar, Button, CountBadge, countText, EmptyState, Icon, Notice, Pill } from '../parts.tsx';
import { overviewOrder, productOf, waitingTotal } from '../products.ts';
import { routeHash } from '../routes.ts';
import { reportOpError, runTaskOp } from '../task-ops.ts';
import '../styles/product-home.css';

export interface OverviewProps {
  waiting: Waiting;
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  worker: WorkerStatus | null;
  onWorker: (status: WorkerStatus) => void;
  revision: number;
  projects: Project[];
  projectsLoaded: boolean;
}

interface Loaded { active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[]; capped: boolean }

const FINISHED_PAGE = 50;

async function readFinishedSince(since: number): Promise<{ tasks: Task[]; next: FinishedCursor | null; total: number; capped: boolean }> {
  let tasks: Task[] = [];
  let next: FinishedCursor | null = null;
  let total = 0;
  let paging: Paging = 'more';
  while (paging === 'more') {
    const page = await api.finishedTasks(next, tasks.length === 0 ? KANBAN_PAGE : FINISHED_PAGE);
    tasks = mergeFinished(tasks, page.tasks);
    next = page.next;
    total = page.total;
    paging = page.tasks.length === 0 ? 'done' : finishedPaging(tasks, next !== null, since, KANBAN_PAGE);
  }
  return { tasks, next, total, capped: paging === 'capped' };
}

export const RELOAD_DELAY_MS = 150;
const TILE_LABEL = { proposals: 'ui.overview.proposals', questions: 'ui.overview.questions', pending: 'ui.overview.pending' } as const satisfies Record<TileId, string>;
const TILE_SOME = { proposals: 'ui.overview.proposals.some', questions: 'ui.overview.questions.some', pending: 'ui.overview.pending.some' } as const satisfies Record<TileId, string>;
const TILE_NONE = { proposals: 'ui.overview.proposals.none', questions: 'ui.overview.questions.none', pending: 'ui.overview.pending.none' } as const satisfies Record<TileId, string>;
const COLUMN_KEY = {
  proposed: 'ui.kanban.col.proposed', approved: 'ui.kanban.col.approved', progress: 'ui.kanban.col.progress', done: 'ui.kanban.col.done', failed: 'ui.kanban.col.failed',
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
              <span className={`bt-count${column.accent ? '' : ' bt-count--quiet'}`} aria-label={t('ui.kanban.count', column.count)}><span className="bt-count__n">{countText(column.count)}</span></span>
            </div>
            {column.cards.map(card => <MiniCard key={card.key} card={card} sessionLabel={t('ui.kanban.session')} untitled={t('ui.session.untitled')} tag={tagOf?.(card) ?? null} />)}
            {column.more > 0 && <a className="bt-mini bt-mini--more" href="#/kanban">{t('ui.kanban.more', column.more)}</a>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function RunningItems({ rows, now, busy, onStop, sheen }: { rows: RunningRow[]; now: number; busy: ReadonlySet<string>; onStop: (row: RunningRow) => void; sheen: boolean }) {
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

interface Placed extends ProductSection { project: Project }

export function Overview({ waiting, conversations, drafts, checklists, worker, onWorker, revision, projects, projectsLoaded }: OverviewProps) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const look = useLastLook(LAST_LOOK_KEY);
  const loads = useRef(latestOnly());
  const first = useRef(true);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [tasks, finished, runs] = await Promise.all([api.tasks(), readFinishedSince(look.at), api.runs(RUNS_WINDOW)]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ active: tasks.active, finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs, capped: finished.capped });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [look.at]);
  const { busy, act, stop, retry } = useRunActions(worker, load);

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
  const owners = useMemo(() => conversationOwners(conversations, data ? [...data.active, ...data.finished] : []), [conversations, data]);
  const placed = useMemo(() => {
    const input = { worker: worker?.runningAll ?? [], drafts, conversations, checklists };
    const tasks = taskOwners(data?.active ?? []);
    const done = data ? finishedSince(data.finished, look.at, Number.POSITIVE_INFINITY).tasks : [];
    return {
      products: overviewOrder(projects).map((project): Placed => ({ project, ...productSection(project.id, input, tasks, done) })),
      none: productSection(null, input, tasks, done),
    };
  }, [worker, drafts, conversations, checklists, data, look.at, projects]);
  const anyRunning = placed.none.running.length > 0 || placed.products.some(p => p.running.length > 0);
  const now = useNow(anyRunning ? 1000 : 30_000);
  const stats = tiles(waiting, waiting.pending);
  const line = workerLine(worker, now);
  const sheenAt = placed.products.find(p => p.running.length > 0)?.project.id ?? null;
  const lookText = formatDateTimeSmart(look.at, now);

  const setPaused = (paused: boolean) => void act('worker', async () => {
    onWorker(await api.setWorker({ paused }));
    toast({ icon: paused ? 'square' : 'check', title: t(paused ? 'ui.overview.toast.paused' : 'ui.overview.toast.resumed') });
  });
  const capped = data?.capped ?? false;
  const finishedText = (n: number): string | false => (capped ? t('ui.home.finishedSinceMore', n, lookText) : n > 0 && t('ui.home.finishedSince', n, lookText));
  const counts = ({ project, finished }: Placed): string => [
    t('ui.home.counts', project.waiting.proposals, project.waiting.questions, project.waiting.pending),
    finishedText(finished),
  ].filter(Boolean).join(' · ');
  const tagOf = (card: Card): string | null => productOf(projects, cardProduct(card, owners))?.name ?? null;

  return (
    <div className="bt-screen__inner ui-home">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{[projectsLoaded && t('ui.home.products', placed.products.length), look.known ? t('ui.overview.lastLook', lookText) : t('ui.overview.firstLook')].filter(Boolean).join(' · ')}</span>
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
          <a className="bt-btn" href={routeHash({ view: 'newProduct' })}><Icon name="plus" />{t('ui.product.new')}</a>
          <a className="bt-btn bt-btn--icon ui-narrow-only" href="#/settings" aria-label={t('ui.nav.settings')}><Icon name="sliders" /></a>
        </div>
      </header>

      <section className="bt-stats" aria-label={t('ui.overview.waiting')}>
        {stats.map((tile, index) => <StatTile key={tile.id} tile={tile} index={index} meta={holders(projects, tile.id, tile.n).map(h => `${h.name ?? t('ui.section.noProduct')} ${h.n}`).join(' · ')} />)}
      </section>

      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}

      {projectsLoaded && placed.products.length === 0 && (
        <EmptyState
          lead={<Avatar state="idle" size="lg" />}
          title={t('ui.home.empty.title')}
          text={t('ui.home.empty.text')}
          action={<a className="bt-btn bt-btn--primary" href={routeHash({ view: 'newProduct' })}>{t('ui.product.new')}</a>}
        />
      )}

      {listsProducts(placed.products.length) ? (
        <section className="bt-section bt-rise ui-home__products" style={{ '--bt-i': 4 } as CSSProperties} aria-label={t('ui.home.products', placed.products.length)}>
          <ul className="bt-list">
            {placed.products.map(p => {
              const n = waitingTotal(p.project);
              return (
                <li key={p.project.id} className="bt-row bt-row--link ui-home__more" data-product={p.project.id}>
                  {n > 0 && <span className="bt-dot" aria-hidden="true" />}
                  <div className="bt-row__main">
                    <a className="bt-row__title ui-card__link" href={routeHash({ view: 'product', id: p.project.id })}>{p.project.name}</a>
                    <span className="bt-row__sub bt-meta">{[counts(p), p.project.folder_missing && t('ui.home.folderMissing')].filter(Boolean).join(' · ')}</span>
                  </div>
                  <CountBadge n={n} label={t('ui.count.waiting', n)} />
                </li>
              );
            })}
          </ul>
        </section>
      ) : placed.products.map((p, index) => {
        const n = waitingTotal(p.project);
        return (
          <section key={p.project.id} className="bt-section bt-rise ui-home__products" style={{ '--bt-i': index + 4 } as CSSProperties} aria-label={p.project.name} data-product={p.project.id}>
            <div className="bt-section__head">
              <span className="bt-section__kind ui-home__kind">
                {n > 0 && <span className="bt-dot" aria-hidden="true" />}
                <a className="bt-tool__link ui-home__name" href={routeHash({ view: 'product', id: p.project.id })}>{p.project.name}</a>
                <span className="bt-meta ui-home__root">{p.project.root}</span>
                {p.project.folder_missing && <span className="bt-meta bt-del">{t('ui.home.folderMissing')}</span>}
              </span>
              {n > 0 ? <CountBadge n={n} label={t('ui.count.waiting', n)} /> : <span className="bt-meta">{t('ui.home.nothingWaiting')}</span>}
            </div>
            <ul className="bt-list">
              <RunningItems rows={p.running} now={now} busy={busy} onStop={stop} sheen={sheenAt === p.project.id} />
              {p.failed.map(task => <FinishedItem key={task.id} task={task} now={now} busy={busy} onRetry={retry} />)}
              <li className="bt-row bt-row--link ui-home__more">
                <div className="bt-row__main"><a className="bt-row__sub bt-meta ui-home__line" href={routeHash({ view: 'product', id: p.project.id })}>{counts(p)}</a></div>
                <Icon name="chevR" />
              </li>
              {capped && <li className="bt-row"><a className="bt-tool__link bt-meta" href="#/kanban">{t('ui.home.moreOnBoard')}</a></li>}
            </ul>
          </section>
        );
      })}

      {hasSomething(placed.none) && (
        <section className="bt-section bt-rise ui-home__products" style={{ '--bt-i': 5 } as CSSProperties} aria-label={t('ui.section.noProduct')} data-product="none">
          <div className="bt-section__head"><span className="bt-label">{t('ui.section.noProduct')}</span></div>
          <ul className="bt-list">
            <RunningItems rows={placed.none.running} now={now} busy={busy} onStop={stop} sheen={sheenAt === null} />
            {placed.none.failed.map(task => <FinishedItem key={task.id} task={task} now={now} busy={busy} onRetry={retry} />)}
            {placed.none.finished > 0 && (
              <li className="bt-row bt-row--link ui-home__more">
                <div className="bt-row__main"><a className="bt-row__sub bt-meta ui-home__line" href="#/kanban">{finishedText(placed.none.finished)}</a></div>
                <Icon name="chevR" />
              </li>
            )}
          </ul>
        </section>
      )}

      {mini && <MiniBoard columns={mini} label={t(projects.length > 0 ? 'ui.home.boardAll' : 'ui.nav.kanban')} index={6} tagOf={tagOf} />}
    </div>
  );
}
