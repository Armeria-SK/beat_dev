import type { ChecklistItem, Conversation, PendingCounts, Project, QuestionCounts, Task, WorkerRun, WorkerStatus } from '../api.ts';
import { checklistStep } from './agent-state.ts';
import { finishedAt, isTemplate, KANBAN_PAGE, type Board, type Card, type ColumnId, type Step } from './kanban.ts';
import { overviewOrder } from './products.ts';
import { routeHash } from './routes.ts';

export type TileId = 'proposals' | 'questions' | 'pending';
export interface Tile { id: TileId; n: number; href: string | null }

export function tiles(counts: { proposals: number; questions: number }, pending: number): Tile[] {
  return [
    { id: 'proposals', n: counts.proposals, href: '#/kanban' },
    { id: 'questions', n: counts.questions, href: routeHash({ view: 'questions' }) },
    { id: 'pending', n: pending, href: routeHash({ view: 'pending' }) },
  ];
}

export const MINI_SHOWN = 2;
export interface MiniColumn { id: ColumnId; count: number; accent: boolean; cards: Card[]; more: number }

export function miniBoard(board: Board, shown = MINI_SHOWN): MiniColumn[] {
  return board.columns.map(column => {
    const older = column.id === 'done' || column.id === 'failed' ? board.more : 0;
    return { id: column.id, count: column.cards.length, accent: column.accent, cards: column.cards.slice(0, shown), more: Math.max(0, column.cards.length - shown) + older };
  });
}

export type RunningRow =
  | { kind: 'task'; key: string; runId: string; title: string; href: string; step: null; startedAt: null }
  | { kind: 'review'; key: string; runId: string; title: null; href: null; step: null; startedAt: null }
  | { kind: 'session'; key: string; runId: string; title: string | null; href: string; step: Step | null; startedAt: number | null };

export interface RunningInput {
  worker: ReadonlyArray<WorkerRun>;
  drafts: ReadonlyArray<{ runId: string; conversationId: string; startedAt?: number | undefined }>;
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'title' | 'project_id'>>;
  checklists: ReadonlyMap<string, readonly ChecklistItem[]>;
}

export function runningRows({ worker, drafts, conversations, checklists }: RunningInput): RunningRow[] {
  const rows: RunningRow[] = [];
  const seen = new Set<string>();
  for (const run of worker) {
    seen.add(run.runId);
    if (run.kind === 'task' && run.taskId) rows.push({ kind: 'task', key: `w:${run.runId}`, runId: run.runId, title: run.title, href: routeHash({ view: 'task', id: run.taskId }), step: null, startedAt: null });
    else rows.push({ kind: 'review', key: `w:${run.runId}`, runId: run.runId, title: null, href: null, step: null, startedAt: null });
  }
  const titles = new Map(conversations.map(c => [c.id, c.title]));
  for (const draft of drafts) {
    if (seen.has(draft.runId) || !titles.has(draft.conversationId)) continue;
    rows.push({
      kind: 'session', key: `d:${draft.runId}`, runId: draft.runId, title: titles.get(draft.conversationId) ?? null, href: routeHash({ view: 'chat', id: draft.conversationId }),
      step: checklistStep(checklists.get(draft.conversationId) ?? []), startedAt: draft.startedAt ?? null,
    });
  }
  return rows;
}

export interface WorkerLine { runs: number; max: number; nextWakeAt: number | null }

export function workerLine(worker: Pick<WorkerStatus, 'enabled' | 'paused' | 'runningAll' | 'nextWakeAt' | 'runsLastHour' | 'maxRunsPerHour'> | null, now: number): WorkerLine | null {
  if (!worker?.enabled) return null;
  const waits = !worker.paused && worker.runningAll.length === 0 && worker.nextWakeAt !== null;
  return { runs: worker.runsLastHour, max: worker.maxRunsPerHour, nextWakeAt: waits ? Math.max(worker.nextWakeAt!, now) : null };
}

export const FINISHED_SHOWN = 8;

export function finishedSince(finished: readonly Task[], since: number, shown = FINISHED_SHOWN): { tasks: Task[]; more: number } {
  const all = finished.filter(task => !isTemplate(task) && (task.status === 'done' || task.status === 'failed') && finishedAt(task) > since)
    .sort((a, b) => finishedAt(b) - finishedAt(a) || (a.id < b.id ? 1 : -1));
  return { tasks: all.slice(0, shown), more: Math.max(0, all.length - shown) };
}

export const LAST_LOOK_KEY = 'beat.lastLook';
export const productLookKey = (projectId: string): string => `${LAST_LOOK_KEY}.${projectId}`;

export function readLastLook(raw: string | null, now: number, dayStart: (ms: number) => number): { at: number; known: boolean } {
  const at = raw !== null && /^\d{1,16}$/u.test(raw) ? Number(raw) : Number.NaN;
  return Number.isFinite(at) && at > 0 && at <= now ? { at, known: true } : { at: dayStart(now), known: false };
}

export type Owners = ReadonlyMap<string, string | null>;

export const taskOwners = (tasks: ReadonlyArray<Pick<Task, 'id' | 'project_id'>>): Map<string, string | null> =>
  new Map(tasks.map(task => [task.id, task.project_id ?? null]));

export function productTiles(project: Pick<Project, 'id' | 'waiting'>): Tile[] {
  return [
    { id: 'proposals', n: project.waiting.proposals, href: '#/kanban' },
    { id: 'questions', n: project.waiting.questions, href: routeHash({ view: 'questions', productId: project.id }) },
    { id: 'pending', n: project.waiting.pending, href: routeHash({ view: 'pending', productId: project.id }) },
  ];
}

export function holders(projects: readonly Project[], id: TileId, none: number): Array<{ name: string | null; n: number }> {
  const named: Array<{ name: string | null; n: number }> = overviewOrder(projects).map(p => ({ name: p.name, n: p.waiting[id] })).filter(h => h.n > 0);
  return named.length > 0 && none > 0 ? [...named, { name: null, n: none }] : named;
}

const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((total, n) => total + n, 0);

export function unownedWaits(active: ReadonlyArray<Pick<Task, 'status' | 'project_id'>> | null, questions: QuestionCounts | null, pending: PendingCounts | null): Record<TileId, number> {
  return {
    proposals: active ? active.filter(task => task.status === 'inbox' && !task.project_id).length : 0,
    questions: questions ? Math.max(0, questions.open - sum(questions.byProject)) : 0,
    pending: pending ? Math.max(0, pending.waiting - sum(pending.byProject)) : 0,
  };
}

const ARCHIVED = Symbol('archived');
type Place = string | null | typeof ARCHIVED;

const placeOf = (owner: string | null | undefined, shown: ReadonlySet<string> | undefined): Place =>
  (!owner ? null : !shown || shown.has(owner) ? owner : ARCHIVED);

const fits = (place: Place, projectId: string | null): boolean => place === projectId || (projectId === null && place === ARCHIVED);

export function scopeRunning(input: RunningInput, projectId: string | null, tasks: Owners | null, shown?: ReadonlySet<string>): RunningInput {
  return {
    ...input,
    worker: input.worker.filter(run => {
      if (run.kind !== 'task' || !run.taskId) return projectId === null;
      return tasks !== null && fits(placeOf(tasks.get(run.taskId), shown), projectId);
    }),
    conversations: input.conversations.filter(c => fits(placeOf(c.project_id, shown), projectId)),
  };
}

export type PlacedRow = RunningRow & { archived?: boolean };
export interface ProductSection { running: PlacedRow[]; failed: Task[]; finished: number }

export function productSection(projectId: string | null, input: RunningInput, tasks: Owners | null, done: readonly Task[], shown?: ReadonlySet<string>): ProductSection {
  const mine = done.filter(task => placeOf(task.project_id, shown) === projectId);
  const scoped = scopeRunning(input, projectId, tasks, shown);
  const archived = new Set<string>();
  if (projectId === null) {
    for (const run of scoped.worker) if (run.taskId && tasks && placeOf(tasks.get(run.taskId), shown) === ARCHIVED) archived.add(run.runId);
    const gone = new Set(scoped.conversations.filter(c => placeOf(c.project_id, shown) === ARCHIVED).map(c => c.id));
    for (const draft of scoped.drafts) if (gone.has(draft.conversationId)) archived.add(draft.runId);
  }
  const running = runningRows(scoped).map((row): PlacedRow => (archived.has(row.runId) ? { ...row, archived: true } : row));
  return { running, failed: mine.filter(task => task.status === 'failed'), finished: mine.length };
}

export const ticksEverySecond = (rows: readonly RunningRow[]): boolean => rows.some(row => row.startedAt !== null);

export const hasSomething = (section: ProductSection): boolean => section.running.length > 0 || section.failed.length > 0 || section.finished > 0;

export const FINISHED_CAP = 200;
export type Paging = 'more' | 'done' | 'capped';

export const FINISHED_PAGE = 100;

export function finishedPaging(loaded: ReadonlyArray<Pick<Task, 'completed_at' | 'updated_at'>>, hasNext: boolean, since: number, min: number, { cap = FINISHED_CAP, grew = true }: { cap?: number; grew?: boolean } = {}): Paging {
  if (!hasNext) return 'done';
  const reached = loaded.length > 0 && loaded.reduce((low, task) => Math.min(low, finishedAt(task)), Number.POSITIVE_INFINITY) <= since;
  if (!grew) return reached ? 'done' : 'capped';
  if (reached && loaded.length >= min) return 'done';
  return loaded.length >= cap ? (reached ? 'done' : 'capped') : 'more';
}

export const LIST_AFTER = 4;
export const listsProducts = (count: number): boolean => count > LIST_AFTER;

export function boardFinished<T>(finished: readonly T[], hasNext: boolean, page = KANBAN_PAGE): { finished: T[]; hasMore: boolean } {
  return { finished: finished.slice(0, page), hasMore: hasNext || finished.length > page };
}
