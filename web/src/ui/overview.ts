import type { ChecklistItem, Conversation, Project, Task, WorkerRun, WorkerStatus } from '../api.ts';
import { checklistStep } from './agent-state.ts';
import { finishedAt, isTemplate, type Board, type Card, type ColumnId, type Step } from './kanban.ts';
import { overviewOrder } from './products.ts';
import { routeHash } from './routes.ts';

export type TileId = 'proposals' | 'questions' | 'pending';
export interface Tile { id: TileId; n: number; href: string | null }

export function tiles(counts: { proposals: number; answers: number }, approvals: ReadonlyArray<{ conversationId: string }>): Tile[] {
  const first = approvals[0];
  return [
    { id: 'proposals', n: counts.proposals, href: '#/kanban' },
    { id: 'questions', n: counts.answers, href: '#/kanban' },
    { id: 'pending', n: approvals.length, href: first ? routeHash({ view: 'chat', id: first.conversationId }) : null },
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

export function conversationOwners(conversations: ReadonlyArray<Pick<Conversation, 'id' | 'project_id'>>, tasks: ReadonlyArray<Pick<Task, 'conversation_id' | 'project_id'>>): Map<string, string | null> {
  const owners = new Map<string, string | null>();
  for (const task of tasks) if (task.conversation_id) owners.set(task.conversation_id, task.project_id ?? null);
  for (const c of conversations) owners.set(c.id, c.project_id ?? null);
  return owners;
}

export const taskOwners = (tasks: ReadonlyArray<Pick<Task, 'id' | 'project_id'>>): Map<string, string | null> =>
  new Map(tasks.map(task => [task.id, task.project_id ?? null]));

export function productTiles(project: Pick<Project, 'id' | 'waiting'>, approvals: ReadonlyArray<{ conversationId: string }>, owners: Owners, tasks: ReadonlyArray<Pick<Task, 'id' | 'status' | 'project_id'>>): Tile[] {
  const approval = approvals.find(a => owners.get(a.conversationId) === project.id);
  const question = tasks.find(task => task.status === 'waiting' && task.project_id === project.id);
  return [
    { id: 'proposals', n: project.waiting.proposals, href: '#/kanban' },
    { id: 'questions', n: project.waiting.questions, href: question ? routeHash({ view: 'task', id: question.id }) : '#/kanban' },
    { id: 'pending', n: project.waiting.pending, href: approval ? routeHash({ view: 'chat', id: approval.conversationId }) : null },
  ];
}

export function holders(projects: readonly Project[], id: TileId, total: number): Array<{ name: string | null; n: number }> {
  const named: Array<{ name: string | null; n: number }> = overviewOrder(projects).map(p => ({ name: p.name, n: p.waiting[id] })).filter(h => h.n > 0);
  const rest = total - named.reduce((sum, h) => sum + h.n, 0);
  return named.length > 0 && rest > 0 ? [...named, { name: null, n: rest }] : named;
}

export function scopeRunning(input: RunningInput, projectId: string | null, tasks: Owners): RunningInput {
  return {
    ...input,
    worker: input.worker.filter(run => (run.kind === 'task' && run.taskId ? tasks.get(run.taskId) ?? null : null) === projectId),
    conversations: input.conversations.filter(c => (c.project_id ?? null) === projectId),
  };
}

export interface ProductSection { running: RunningRow[]; failed: Task[]; finished: number }

export function productSection(projectId: string | null, input: RunningInput, tasks: Owners, done: readonly Task[]): ProductSection {
  const mine = done.filter(task => (task.project_id ?? null) === projectId);
  return { running: runningRows(scopeRunning(input, projectId, tasks)), failed: mine.filter(task => task.status === 'failed'), finished: mine.length };
}

export const LIST_AFTER = 4;
export const listsProducts = (count: number): boolean => count > LIST_AFTER;

export function cardProduct(card: Card, owners: Owners): string | null {
  return card.kind === 'task' ? card.task.project_id ?? null : owners.get(card.conversationId) ?? null;
}
