import type { ChecklistItem, Conversation, Task, TaskStatus } from '../api.ts';
import type { Draft, RunEvent } from '../events.ts';

export interface TaskMark { status: TaskStatus; updatedAt: number; live: boolean }

export interface LiveState {
  conversations: Conversation[];
  approvals: number;
  skillDrafts: number;
  unread: number;
  tasks: ReadonlyMap<string, TaskMark>;
  drafts: Draft[];
  streaming: ReadonlySet<string>;
  checklists: ReadonlyMap<string, ChecklistItem[]>;
}

export const EMPTY: LiveState = {
  conversations: [], approvals: 0, skillDrafts: 0, unread: 0, tasks: new Map(), drafts: [], streaming: new Set(), checklists: new Map(),
};

export type Refresh = 'conversations' | 'approvals' | 'tasks' | 'drafts' | 'unread' | 'worker';

export type Effect =
  | { kind: 'refresh'; what: Refresh }
  | { kind: 'checklist'; conversationId: string }
  | { kind: 'notifyApproval'; title: string }
  | { kind: 'notify'; title: string; body: string };

export type Action =
  | { type: 'event'; event: RunEvent; hidden: boolean }
  | { type: 'resync'; drafts: Draft[] }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'approvals'; count: number }
  | { type: 'skillDrafts'; count: number }
  | { type: 'unread'; count: number }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'checklist'; conversationId: string; items: ChecklistItem[] };

export const BROWSER_NOTIFY: ReadonlySet<string> = new Set(['task_waiting']);

const refresh = (...what: Refresh[]): Effect[] => what.map(w => ({ kind: 'refresh', what: w }));

export function mergeTasks(prev: ReadonlyMap<string, TaskMark>, snapshot: readonly Task[]): Map<string, TaskMark> {
  const next = new Map<string, TaskMark>(snapshot.map(t => [t.id, { status: t.status, updatedAt: t.updated_at, live: false }]));
  for (const [id, mark] of prev) {
    const fresh = next.get(id);
    if (fresh ? mark.updatedAt > fresh.updatedAt : mark.live) next.set(id, mark);
  }
  return next;
}

function without<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function onEvent(s: LiveState, e: RunEvent, hidden: boolean): { state: LiveState; effects: Effect[] } {
  switch (e.type) {
    case 'run.start': {
      const drafts = [...s.drafts.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '' }];
      const known = s.conversations.some(c => c.id === e.conversationId);
      return { state: { ...s, drafts }, effects: [...(known ? [] : refresh('conversations')), { kind: 'checklist', conversationId: e.conversationId }, ...refresh('worker')] };
    }
    case 'text.delta':
      return { state: s.streaming.has(e.conversationId) ? s : { ...s, streaming: new Set(s.streaming).add(e.conversationId) }, effects: [] };
    case 'run.end':
      return {
        state: { ...s, drafts: s.drafts.filter(d => d.runId !== e.runId), streaming: without(s.streaming, e.conversationId) },
        effects: refresh('conversations', 'worker', 'drafts', 'approvals'),
      };
    case 'approval.requested':
      return { state: s, effects: [...(hidden ? [{ kind: 'notifyApproval', title: e.approval.title } as const] : []), ...refresh('approvals')] };
    case 'approval.resolved':
      return { state: s, effects: refresh('approvals') };
    case 'checklist.updated':
      return { state: { ...s, checklists: new Map(s.checklists).set(e.conversationId, e.items) }, effects: [] };
    case 'conversation.changed':
      return { state: s, effects: e.change === 'deleted' ? refresh('conversations', 'unread') : refresh('conversations') };
    case 'task.changed': {
      const old = s.tasks.get(e.task.id);
      if (old && old.updatedAt > e.task.updated_at) return { state: s, effects: refresh('worker') };
      const tasks = new Map(s.tasks).set(e.task.id, { status: e.task.status, updatedAt: e.task.updated_at, live: true });
      return { state: { ...s, tasks }, effects: refresh('worker') };
    }
    case 'notification': {
      const notify: Effect[] = hidden && BROWSER_NOTIFY.has(e.notification.kind) ? [{ kind: 'notify', title: e.notification.title, body: e.notification.body ?? '' }] : [];
      return { state: { ...s, unread: s.unread + 1 }, effects: [...notify, ...refresh('drafts')] };
    }
    case 'notification.read':
      return { state: { ...s, unread: e.unread }, effects: [] };
    default:
      return { state: s, effects: [] };
  }
}

export function reduce(s: LiveState, a: Action): { state: LiveState; effects: Effect[] } {
  switch (a.type) {
    case 'event': return onEvent(s, a.event, a.hidden);
    case 'resync':
      return {
        state: { ...s, drafts: a.drafts, streaming: new Set(a.drafts.filter(d => d.text).map(d => d.conversationId)) },
        effects: [...a.drafts.map(d => ({ kind: 'checklist', conversationId: d.conversationId }) as const), ...refresh('conversations', 'approvals', 'tasks', 'drafts', 'unread', 'worker')],
      };
    case 'conversations': return { state: { ...s, conversations: a.conversations }, effects: [] };
    case 'approvals': return { state: { ...s, approvals: a.count }, effects: [] };
    case 'skillDrafts': return { state: { ...s, skillDrafts: a.count }, effects: [] };
    case 'unread': return { state: { ...s, unread: a.count }, effects: [] };
    case 'tasks': return { state: { ...s, tasks: mergeTasks(s.tasks, a.tasks) }, effects: [] };
    case 'checklist': return { state: { ...s, checklists: new Map(s.checklists).set(a.conversationId, a.items) }, effects: [] };
  }
}
