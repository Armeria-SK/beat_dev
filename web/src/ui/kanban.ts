import type { ChecklistItem, Conversation, RunRow, Task } from '../api.ts';
import { checklistStep } from './agent-state.ts';
import type { Route } from './routes.ts';

export type ColumnId = 'proposed' | 'approved' | 'progress' | 'done' | 'failed';
export const COLUMNS: readonly ColumnId[] = ['proposed', 'approved', 'progress', 'done', 'failed'];
export const KANBAN_PAGE = 20;
export const RUNS_WINDOW = 500;

export const isTemplate = (task: Pick<Task, 'cron' | 'parent_id'>): boolean => task.cron !== null && task.parent_id === null;

export function columnOf(task: Pick<Task, 'status' | 'cron' | 'parent_id'>): ColumnId | null {
  if (isTemplate(task)) return null;
  switch (task.status) {
    case 'inbox': return 'proposed';
    case 'ready': return 'approved';
    case 'running': case 'waiting': return 'progress';
    case 'done': return 'done';
    case 'failed': case 'cancelled': return 'failed';
    default: return null;
  }
}

export const questionsRoute = (task: Pick<Task, 'project_id'>): Route => (task.project_id ? { view: 'questions', productId: task.project_id } : { view: 'questions' });

export const pendingRoute = (task: Pick<Task, 'project_id'>): Route => (task.project_id ? { view: 'pending', productId: task.project_id } : { view: 'pending' });

export const waitsOnPending = (task: Pick<Task, 'status' | 'waiting_kind'>): boolean => task.status === 'waiting' && task.waiting_kind === 'approval';

export function pendingWait(task: Pick<Task, 'status' | 'waiting_kind' | 'waiting_text' | 'project_id'>): { refs: string; route: Route } | null {
  if (!waitsOnPending(task)) return null;
  const refs = [...new Set(task.waiting_text?.match(/#\d+/gu) ?? [])].join(', ');
  return { refs, route: pendingRoute(task) };
}

export const finishedAt = (task: Pick<Task, 'completed_at' | 'updated_at'>): number => task.completed_at ?? task.updated_at;

export interface Step { step: number; total: number }

export interface TaskCard { kind: 'task'; key: string; column: ColumnId; task: Task; at: number; repeating: boolean; waiting: boolean; step: Step | null }
export type SessionOutcome = 'running' | 'ok' | 'failed' | 'stopped';
export interface SessionCard {
  kind: 'session'; key: string; column: 'progress' | 'done' | 'failed'; conversationId: string; title: string | null; at: number;
  startedAt: number | null; step: Step | null; outcome: SessionOutcome; projectId?: string;
}
export type Card = TaskCard | SessionCard;

export const cardProject = (card: Card): string | null => (card.kind === 'task' ? card.task.project_id ?? null : card.projectId ?? null);

export interface SessionInput {
  conversations: ReadonlyArray<Pick<Conversation, 'id' | 'title' | 'project_id'>>;
  drafts: ReadonlyArray<{ runId: string; conversationId: string; startedAt?: number | undefined }>;
  runs: ReadonlyArray<Pick<RunRow, 'id' | 'kind' | 'conversation_id' | 'started_at' | 'duration_ms' | 'ok' | 'error_kind'>>;
  checklists: ReadonlyMap<string, readonly ChecklistItem[]>;
}

export function sessionCards({ conversations, drafts, runs, checklists }: SessionInput): SessionCard[] {
  const cards: SessionCard[] = [];
  const live = new Map(drafts.map(d => [d.conversationId, d]));
  for (const c of conversations) {
    const draft = live.get(c.id);
    if (draft) {
      const startedAt = draft.startedAt ?? runs.find(r => r.id === draft.runId)?.started_at ?? null;
      cards.push({
        kind: 'session', key: `s:${c.id}:progress`, column: 'progress', conversationId: c.id, title: c.title, at: startedAt ?? 0, startedAt,
        step: checklistStep(checklists.get(c.id) ?? []), outcome: 'running', ...(c.project_id ? { projectId: c.project_id } : {}),
      });
      continue;
    }
    let last: SessionInput['runs'][number] | undefined;
    for (const r of runs) {
      if (r.kind !== 'chat' || r.conversation_id !== c.id || r.ok === null) continue;
      if (!last || r.started_at > last.started_at) last = r;
    }
    if (!last) continue;
    const outcome: SessionOutcome = last.ok === 1 ? 'ok' : last.error_kind === 'cancelled' ? 'stopped' : 'failed';
    const column = outcome === 'ok' ? 'done' : 'failed';
    cards.push({
      kind: 'session', key: `s:${c.id}:${column}`, column, conversationId: c.id, title: c.title, at: last.started_at + (last.duration_ms ?? 0),
      startedAt: last.started_at, step: null, outcome, ...(c.project_id ? { projectId: c.project_id } : {}),
    });
  }
  return cards;
}

export interface BoardInput {
  active: readonly Task[];
  finished: readonly Task[];
  hasMore: boolean;
  finishedTotal: number;
  sessions: readonly SessionCard[];
  checklists?: ReadonlyMap<string, readonly ChecklistItem[]>;
}

export interface Column { id: ColumnId; cards: Card[]; accent: boolean }
export interface Board { columns: Column[]; more: number }

function taskCard(task: Task, column: ColumnId, checklists: BoardInput['checklists']): TaskCard {
  const finished = column === 'done' || column === 'failed';
  const step = column === 'progress' && task.conversation_id ? checklistStep(checklists?.get(task.conversation_id) ?? []) : null;
  return {
    kind: 'task', key: `t:${task.id}:${column}`, column, task, at: finished ? finishedAt(task) : task.updated_at,
    repeating: task.parent_id !== null, waiting: task.status === 'waiting' || task.status === 'inbox', step,
  };
}

const newest = (a: Card, b: Card): number => b.at - a.at || (a.key < b.key ? 1 : -1);
const waitsFirst = (a: Card, b: Card): number => Number(b.kind === 'task' && b.waiting) - Number(a.kind === 'task' && a.waiting);

function queueOrder(a: Card, b: Card): number {
  if (a.kind !== 'task' || b.kind !== 'task') return newest(a, b);
  return a.task.priority - b.task.priority || (a.task.run_at ?? 0) - (b.task.run_at ?? 0) || a.task.created_at - b.task.created_at;
}

export function buildBoard({ active, finished, hasMore, finishedTotal, sessions, checklists }: BoardInput): Board {
  const tasks = new Map<string, Task>();
  for (const task of [...finished, ...active]) {
    const old = tasks.get(task.id);
    if (!old || task.updated_at >= old.updated_at) tasks.set(task.id, task);
  }
  const byColumn = new Map<ColumnId, Card[]>(COLUMNS.map(id => [id, []]));
  for (const task of tasks.values()) {
    const column = columnOf(task);
    if (column) byColumn.get(column)!.push(taskCard(task, column, checklists));
  }
  const oldest = finished.reduce((min, task) => Math.min(min, finishedAt(task)), Number.POSITIVE_INFINITY);
  const cutoff = hasMore && finished.length > 0 ? oldest : Number.NEGATIVE_INFINITY;
  let hidden = 0;
  for (const card of sessions) {
    if (card.column !== 'progress' && card.at < cutoff) { hidden += 1; continue; }
    byColumn.get(card.column)!.push(card);
  }
  const order: Record<ColumnId, (a: Card, b: Card) => number> = {
    proposed: newest, approved: queueOrder, progress: (a, b) => waitsFirst(a, b) || newest(a, b), done: newest, failed: newest,
  };
  const columns = COLUMNS.map(id => {
    const cards = byColumn.get(id)!.sort(order[id]);
    return { id, cards, accent: id === 'proposed' && cards.length > 0 };
  });
  return { columns, more: Math.max(0, finishedTotal - finished.length) + hidden };
}

export function mergeFinished(loaded: readonly Task[], page: readonly Task[]): Task[] {
  const seen = new Set(loaded.map(task => task.id));
  return [...loaded, ...page.filter(task => !seen.has(task.id))];
}

export const pagesToReload = (loaded: number): number => Math.max(KANBAN_PAGE, Math.ceil(loaded / KANBAN_PAGE) * KANBAN_PAGE);

export const COLUMN_TABS_MEDIA = '(max-width: 760px)';

export function tabStep(current: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight': return (Math.max(0, current) + 1) % count;
    case 'ArrowLeft': return (Math.max(0, current) - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

export const stepPercent = (step: Step | null): number => (step ? Math.round((Math.max(0, step.step - 1) / step.total) * 100) : 0);
