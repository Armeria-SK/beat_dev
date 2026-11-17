import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { api, type ChecklistItem, type Conversation, type FinishedCursor, type Project, type RunRow, type ScoutMode, type ScoutState, type Task, type WorkerStatus } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTimeSmart, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { buildBoard, KANBAN_PAGE, RUNS_WINDOW, sessionCards } from '../kanban.ts';
import type { LiveDraft } from '../live-state.ts';
import { finishedSince, miniBoard, productLookKey, productTiles, runningRows, scopeRunning, taskOwners, ticksEverySecond } from '../overview.ts';
import { Button, CountBadge, Icon, Notice, Pill } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { canThinkNow, SCOUT_MODE_CHOICES, useScout } from '../scout.ts';
import { reportOpError } from '../task-ops.ts';
import { GrowthSection } from './GrowthSection.tsx';
import { CommandItems, FinishedItem, MiniBoard, RunningItems, StatTile, useHomeLoad, useLastLook, useProductCommands, useRunActions } from './home-parts.tsx';

export interface ProductHomeProps {
  id: string;
  project: Project | undefined;
  conversations: Conversation[];
  drafts: LiveDraft[];
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  worker: WorkerStatus | null;
  revision: number;
  backgroundRevision?: number;
  onProject?: ((project: Project) => void) | undefined;
}

interface Loaded { active: Task[]; awaiting: Task[]; finished: Task[]; next: FinishedCursor | null; total: number; runs: RunRow[] }

const MODE_KEY = { off: 'ui.scout.mode.off', research: 'ui.scout.mode.research', fix: 'ui.scout.mode.fix' } as const satisfies Record<ScoutMode, string>;

function ModeSwitch({ project, onProject }: { project: Project; onProject?: ((project: Project) => void) | undefined }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const pick = async (mode: ScoutMode) => {
    if (busy || mode === project.scout_mode) return;
    setBusy(true);
    try { onProject?.((await api.patchProject(project.id, { scoutMode: mode })).project); } catch (error) { reportOpError(error); } finally { setBusy(false); }
  };
  return (
    <div className="bt-seg ui-home__mode" role="group" aria-label={t('ui.scout.mode')}>
      {SCOUT_MODE_CHOICES.map(choice => (
        <button key={choice.mode} type="button" className="bt-seg__opt" data-mode={choice.mode} aria-pressed={project.scout_mode === choice.mode} disabled={busy || !choice.enabled}
          title={choice.enabled ? undefined : t('ui.scout.mode.later')} onClick={() => void pick(choice.mode)}>
          {t(MODE_KEY[choice.mode])}{!choice.enabled && <span className="bt-meta ui-home__later"> · {t('ui.scout.mode.later')}</span>}
        </button>
      ))}
    </div>
  );
}

function ScoutRow({ state }: { state: ScoutState }) {
  const t = useT();
  return (
    <li className="bt-row" data-scout-row>
      <Icon name="search" />
      <div className="bt-row__main">
        <span className="bt-row__title">{t('ui.scout.row')}</span>
        <span className="bt-row__sub bt-meta">{[t('ui.scout.rowMeta', state.examined), state.area && t('ui.scout.reading', state.area)].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="bt-row__end"><Pill tone="running">{t('ui.scout.thinking')}</Pill></div>
    </li>
  );
}

export function ProductHome({ id, project, conversations, drafts, checklists, worker, revision, backgroundRevision = 0, onProject }: ProductHomeProps) {
  const t = useT();
  const scout = useScout(id, revision);
  const [thinking, setThinking] = useState(false);
  const scoutState = scout.load.kind === 'ready' ? scout.load.state : null;
  const scoutRow = scoutState?.state === 'thinking' ? scoutState : null;
  const thinkNow = async () => {
    if (thinking) return;
    setThinking(true);
    try { await scout.thinkNow(); toast({ icon: 'refresh', title: t('ui.scout.started') }); } catch (error) { reportOpError(error); } finally { setThinking(false); }
  };
  const look = useLastLook(productLookKey(id), project !== undefined);
  const read = useCallback(async (): Promise<Loaded> => {
    const [tasks, finished, runs] = await Promise.all([api.tasks(id), api.finishedTasks(null, KANBAN_PAGE, id), api.runs(RUNS_WINDOW, id)]);
    return { active: tasks.active, awaiting: tasks.awaiting ?? [], finished: finished.tasks, next: finished.next, total: finished.total, runs: runs.runs };
  }, [id]);
  const { data, failed, load } = useHomeLoad(read, revision, drafts);
  const { busy, stop, retry } = useRunActions(worker, load);
  const commands = useProductCommands(id, backgroundRevision);

  const mine = useMemo(() => conversations.filter(c => c.project_id === id), [conversations, id]);
  const mini = useMemo(() => {
    if (!data) return null;
    const sessions = sessionCards({ conversations: mine, drafts, runs: data.runs, checklists });
    return miniBoard(buildBoard({ active: [...data.active, ...data.awaiting], finished: data.finished, hasMore: data.next !== null, finishedTotal: data.total, sessions, checklists }));
  }, [data, mine, drafts, checklists]);
  const running = useMemo(
    () => runningRows(scopeRunning({ worker: worker?.runningAll ?? [], drafts, conversations, checklists }, id, data ? taskOwners(data.active) : null)),
    [worker, drafts, conversations, checklists, id, data],
  );
  const done = useMemo(() => (data ? finishedSince(data.finished, look.at) : null), [data, look.at]);
  const stats = useMemo(
    () => (project ? productTiles(project) : []),
    [project],
  );
  const now = useNow(ticksEverySecond(running) || commands.commands.length > 0 ? 1000 : 30_000);
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
          <ModeSwitch project={project} onProject={onProject} />
          {scoutState && canThinkNow(scoutState, project.scout_mode) && <Button disabled={thinking} onClick={() => void thinkNow()}>{t('ui.scout.thinkNow')}</Button>}
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
        <div className="bt-section__head"><span className="bt-label">{t('ui.overview.running')}</span><CountBadge n={running.length + commands.commands.length + (scoutRow ? 1 : 0)} quiet /></div>
        {running.length + commands.commands.length + (scoutRow ? 1 : 0) === 0 ? <p className="bt-meta ui-col__empty">{t('ui.overview.nothingRunning')}</p> : (
          <ul className="bt-list"><RunningItems rows={running} now={now} busy={busy} onStop={stop} sheen /><CommandItems commands={commands.commands} now={now} busy={commands.busy} onStop={commands.stop} />{scoutRow && <ScoutRow state={scoutRow} />}</ul>
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

      <GrowthSection key={id} id={id} createdAt={project.created_at} revision={revision} index={7} />
    </div>
  );
}
