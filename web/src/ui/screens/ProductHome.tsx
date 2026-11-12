import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Approval, type ChecklistItem, type Conversation, type FinishedCursor, type Project, type RunRow, type Task, type WorkerStatus } from '../../api.ts';
import { formatDateTimeSmart, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { buildBoard, KANBAN_PAGE, RUNS_WINDOW, sessionCards } from '../kanban.ts';
import { latestOnly } from '../latest.ts';
import type { LiveDraft } from '../live-state.ts';
import { conversationOwners, finishedSince, miniBoard, productLookKey, productTiles, runningRows, scopeRunning, taskOwners } from '../overview.ts';
import { CountBadge, Icon, Notice } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { FinishedItem, MiniBoard, RELOAD_DELAY_MS, RunningItems, StatTile, useLastLook, useRunActions } from './Overview.tsx';

export interface ProductHomeProps {
  id: string;
  project: Project | undefined;
  approvals: Approval[];
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  worker: WorkerStatus | null;
  revision: number;
}

interface Loaded { active: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[] }

export function ProductHome({ id, project, approvals, conversations, drafts, checklists, worker, revision }: ProductHomeProps) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const look = useLastLook(productLookKey(id));
  const loads = useRef(latestOnly());
  const first = useRef(true);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [tasks, finished, runs] = await Promise.all([api.tasks(id), api.finishedTasks(null, KANBAN_PAGE, id), api.runs(RUNS_WINDOW, id)]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ active: tasks.active, finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [id]);
  const { busy, stop, retry } = useRunActions(worker, load);

  const runKey = drafts.map(d => d.runId).join(',');
  useEffect(() => {
    const timer = setTimeout(() => void load(), first.current ? 0 : RELOAD_DELAY_MS);
    first.current = false;
    return () => clearTimeout(timer);
  }, [load, revision, runKey]);

  const mine = useMemo(() => conversations.filter(c => c.project_id === id), [conversations, id]);
  const mini = useMemo(() => {
    if (!data) return null;
    const sessions = sessionCards({ conversations: mine, drafts, runs: data.runs, checklists });
    return miniBoard(buildBoard({ active: data.active, finished: data.finished, hasMore: data.next !== null, finishedTotal: data.total, sessions, checklists }));
  }, [data, mine, drafts, checklists]);
  const running = useMemo(
    () => runningRows(scopeRunning({ worker: worker?.runningAll ?? [], drafts, conversations, checklists }, id, taskOwners(data?.active ?? []))),
    [worker, drafts, conversations, checklists, id, data],
  );
  const done = useMemo(() => (data ? finishedSince(data.finished, look.at) : null), [data, look.at]);
  const stats = useMemo(
    () => (project ? productTiles(project, approvals, conversationOwners(conversations, data ? [...data.active, ...data.finished] : []), data?.active ?? []) : []),
    [project, approvals, conversations, data],
  );
  const now = useNow(running.some(row => row.startedAt !== null) ? 1000 : 30_000);
  const lookText = formatDateTimeSmart(look.at, now);

  if (!project) return <div className="bt-screen__inner ui-home" />;

  return (
    <div className="bt-screen__inner ui-home" data-product={id}>
      <header className="bt-screen__head bt-rise">
        <div className="ui-home__title">
          <span className="bt-meta ui-home__root">{project.name} · {project.root}</span>
          <h1 className="bt-screen__title bt-screen__title--lg">{t('ui.home.away')}</h1>
        </div>
        <div className="bt-screen__tools">
          <a className="bt-btn bt-btn--icon" href={routeHash({ view: 'productSettings', id })} aria-label={t('ui.product.settings')} title={t('ui.product.settings')}><Icon name="sliders" /></a>
        </div>
      </header>

      {project.folder_missing && <Notice tone="warn" icon="folder" title={t('ui.home.folderMissing.title')} text={t('ui.home.folderMissing.text')} />}

      <section className="bt-stats" aria-label={t('ui.overview.waiting')}>
        {stats.map((tile, index) => <StatTile key={tile.id} tile={tile} index={index} />)}
      </section>

      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}

      {mini && <MiniBoard columns={mini} label={t('ui.nav.kanban')} index={4} className="ui-home__board" />}

      <section className="bt-section bt-rise" style={{ '--bt-i': 5 } as CSSProperties} aria-label={t('ui.overview.running')} data-home="running">
        <div className="bt-section__head"><span className="bt-label">{t('ui.overview.running')}</span><CountBadge n={running.length} quiet /></div>
        {running.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.overview.nothingRunning')}</p> : (
          <ul className="bt-list"><RunningItems rows={running} now={now} busy={busy} onStop={stop} sheen /></ul>
        )}
      </section>

      <section className="bt-section bt-rise" style={{ '--bt-i': 6 } as CSSProperties} aria-label={t('ui.overview.finished', lookText)} data-home="finished">
        <div className="bt-section__head"><span className="bt-label">{t('ui.overview.finished', lookText)}</span>{done && done.tasks.length > 0 && <span className="bt-meta">{done.tasks.length + done.more}</span>}</div>
        {!done || done.tasks.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.overview.nothingFinished')}</p> : (
          <ul className="bt-list">
            {done.tasks.map(task => <FinishedItem key={task.id} task={task} now={now} busy={busy} onRetry={retry} />)}
            {done.more > 0 && <li className="bt-row"><a className="bt-tool__link bt-meta" href="#/kanban">{t('ui.kanban.more', done.more)}</a></li>}
          </ul>
        )}
      </section>
    </div>
  );
}
