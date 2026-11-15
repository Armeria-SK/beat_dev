import { useCallback, useMemo, type CSSProperties } from 'react';
import { api, type ChecklistItem, type Conversation, type FinishedCursor, type PendingCounts, type Project, type QuestionCounts, type RunRow, type Task, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, useT } from '../../i18n/index.ts';
import type { Waiting } from '../agent-state.ts';
import { useNow } from '../hooks.ts';
import { buildBoard, cardProject, KANBAN_PAGE, mergeFinished, RUNS_WINDOW, sessionCards, type Card } from '../kanban.ts';
import type { LiveDraft } from '../live-state.ts';
import {
  boardFinished, FINISHED_PAGE, finishedPaging, finishedSince, hasSomething, holders, LAST_LOOK_KEY, listsProducts, miniBoard, productSection, taskOwners, ticksEverySecond, tiles, unownedWaits, workerLine,
  type Paging, type ProductSection,
} from '../overview.ts';
import { Avatar, Button, CountBadge, EmptyState, Icon, Notice } from '../parts.tsx';
import { overviewOrder, productOf, waitingTotal } from '../products.ts';
import { routeHash } from '../routes.ts';
import { FinishedItem, MiniBoard, RunningItems, StatTile, useHomeLoad, useLastLook, useRunActions } from './home-parts.tsx';
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
  questionCounts: QuestionCounts | null;
  pendingCounts: PendingCounts | null;
}

interface Loaded { active: Task[]; awaiting: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[]; capped: boolean }

async function readFinishedSince(since: number): Promise<{ tasks: Task[]; next: FinishedCursor | null; total: number; capped: boolean }> {
  let tasks: Task[] = [];
  let next: FinishedCursor | null = null;
  let total = 0;
  let paging: Paging = 'more';
  while (paging === 'more') {
    const page = await api.finishedTasks(next, tasks.length === 0 ? KANBAN_PAGE : FINISHED_PAGE);
    const before = tasks.length;
    tasks = mergeFinished(tasks, page.tasks);
    next = page.next;
    total = page.total;
    paging = finishedPaging(tasks, next !== null, since, KANBAN_PAGE, { grew: tasks.length > before });
  }
  return { tasks, next, total, capped: paging === 'capped' };
}

interface Placed extends ProductSection { project: Project }

export function Overview({ waiting, conversations, drafts, checklists, worker, onWorker, revision, projects, projectsLoaded, questionCounts, pendingCounts }: OverviewProps) {
  const t = useT();
  const look = useLastLook(LAST_LOOK_KEY);
  const read = useCallback(async (): Promise<Loaded> => {
    const [tasks, finished, runs] = await Promise.all([api.tasks(), readFinishedSince(look.at), api.runs(RUNS_WINDOW)]);
    return { active: tasks.active, awaiting: tasks.awaiting ?? [], finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs, capped: finished.capped };
  }, [look.at]);
  const { data, failed, load } = useHomeLoad(read, revision, drafts);
  const { busy, act, stop, retry } = useRunActions(worker, load);

  const sessions = useMemo(() => sessionCards({ conversations, drafts, runs: data?.runs ?? [], checklists }), [conversations, drafts, data, checklists]);
  const mini = useMemo(() => {
    if (!data) return null;
    const page = boardFinished(data.finished, data.next !== null);
    return miniBoard(buildBoard({ active: [...data.active, ...data.awaiting], finished: page.finished, hasMore: page.hasMore, finishedTotal: data.total, sessions, checklists }));
  }, [data, sessions, checklists]);
  const placed = useMemo(() => {
    const input = { worker: worker?.runningAll ?? [], drafts, conversations, checklists };
    const tasks = data ? taskOwners(data.active) : null;
    const done = data ? finishedSince(data.finished, look.at, Number.POSITIVE_INFINITY).tasks : [];
    const order = overviewOrder(projects);
    const shown = projectsLoaded ? new Set(order.map(p => p.id)) : undefined;
    return {
      products: order.map((project): Placed => ({ project, ...productSection(project.id, input, tasks, done, shown) })),
      none: productSection(null, input, tasks, done, shown),
    };
  }, [worker, drafts, conversations, checklists, data, look.at, projects, projectsLoaded]);
  const asList = listsProducts(placed.products.length);
  const now = useNow(ticksEverySecond([...placed.none.running, ...(asList ? [] : placed.products.flatMap(p => p.running))]) ? 1000 : 30_000);
  const stats = tiles(waiting, waiting.pending);
  const unowned = unownedWaits(data?.active ?? null, questionCounts, pendingCounts);
  const line = workerLine(worker, now);
  const sheenAt = placed.products.find(p => p.running.length > 0)?.project.id ?? null;
  const lookText = formatDateTimeSmart(look.at, now);

  const setPaused = (paused: boolean) => void act('worker', async () => {
    onWorker(await api.setWorker({ paused }));
    toast({ icon: paused ? 'square' : 'check', title: t(paused ? 'ui.overview.toast.paused' : 'ui.overview.toast.resumed') });
  });
  const capped = data?.capped ?? false;
  const finishedText = (n: number): string | false => n > 0 && t(capped ? 'ui.home.finishedSinceMore' : 'ui.home.finishedSince', n, lookText);
  const counts = ({ project, finished }: Placed): string => [
    t('ui.home.counts', project.waiting.proposals, project.waiting.questions, project.waiting.pending),
    finishedText(finished),
  ].filter(Boolean).join(' · ');
  const tagOf = (card: Card): string | null => productOf(projects, cardProject(card))?.name ?? null;

  return (
    <div className="bt-screen__inner ui-home">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{[projectsLoaded && t('ui.home.products', placed.products.length), look.known ? t('ui.overview.lastLook', lookText) : t('ui.overview.firstLook')].filter(Boolean).join(' · ')}</span>
          <h1 className="bt-screen__title bt-screen__title--lg">{t('ui.nav.overview')}</h1>
        </div>
        <div className="bt-screen__tools">
          {worker && !worker.enabled && <span className="bt-meta" data-worker="off">{t('ui.overview.workerOff')} · <a className="bt-tool__link" href="#/settings">{t('ui.nav.settings')}</a></span>}
          {worker?.paused && <span className="bt-meta">{t('ui.overview.workerPaused')}</span>}
          {line && <span className="bt-meta" data-worker-line>{t('ui.overview.workerRuns', line.runs, line.max)}{line.nextWakeAt !== null && ` · ${t('ui.overview.nextWake', formatDateTimeSmart(line.nextWakeAt, now))}`}</span>}
          {worker && (
            <Button icon={worker.paused ? 'refresh' : 'pause'} disabled={busy.has('worker')} data-worker={worker.paused ? 'paused' : 'on'} onClick={() => setPaused(!worker.paused)}>
              {t(worker.paused ? 'ui.overview.resume' : 'ui.overview.pause')}
            </Button>
          )}
          <a className="bt-btn" href={routeHash({ view: 'newProduct' })}><Icon name="plus" />{t('ui.product.new')}</a>
          <a className="bt-btn bt-btn--icon ui-narrow-only" href="#/settings" aria-label={t('ui.nav.settings')}><Icon name="sliders" /></a>
        </div>
      </header>

      <section className="bt-stats" aria-label={t('ui.overview.waiting')}>
        {stats.map((tile, index) => <StatTile key={tile.id} tile={tile} index={index} meta={holders(projects, tile.id, unowned[tile.id]).map(h => `${h.name ?? t('ui.section.noProduct')} ${h.n}`).join(' · ')} />)}
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

      {asList ? (
        <section className="bt-section bt-rise ui-home__products" style={{ '--bt-i': 4 } as CSSProperties} aria-label={t('ui.home.products', placed.products.length)}>
          <ul className="bt-list">
            {placed.products.map(p => {
              const n = waitingTotal(p.project);
              return (
                <li key={p.project.id} className={`bt-row bt-row--link ui-home__more${sheenAt === p.project.id ? ' bt-sheen' : ''}`} data-product={p.project.id}>
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
