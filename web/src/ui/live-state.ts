import type { Approval, ChecklistItem, Conversation, Task, TaskStatus } from '../api.ts';
import { mergeNotice } from '../chat-logic.ts';
import type { Draft, RunEvent } from '../events.ts';

export interface TaskMark { status: TaskStatus; updatedAt: number; live: boolean }

export interface LiveDraft extends Draft { toolStartedAt?: number | undefined }

export type RunNotice = { runId: string; key?: string | undefined } & (
  | { kind: 'switch'; from: string; to: string; reason: string }
  | { kind: 'warning'; code: string; message: string; params?: Record<string, unknown> | undefined }
  | { kind: 'compaction'; summarized: number }
  | { kind: 'auto'; tool: string; reason: string }
  | { kind: 'denied'; tool: string; detail: string }
  | { kind: 'memory'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { kind: 'stopped' }
  | { kind: 'error'; errorKind: string; errorCode?: string | undefined; errorParams?: Record<string, string | number> | undefined; errorMessage?: string | undefined; hint?: string | undefined; measured?: number | undefined; required?: number | undefined }
);

export interface LiveState {
  conversations: Conversation[];
  approvals: Approval[];
  skillDrafts: number;
  unread: number;
  tasks: ReadonlyMap<string, TaskMark>;
  drafts: LiveDraft[];
  streaming: ReadonlySet<string>;
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  notices: ReadonlyMap<string, RunNotice[]>;
  revisions: ReadonlyMap<string, number>;
  epoch: number;
  runStarts: ReadonlyMap<string, number>;
}

export const EMPTY: LiveState = {
  conversations: [], approvals: [], skillDrafts: 0, unread: 0, tasks: new Map(), drafts: [], streaming: new Set(), checklists: new Map(),
  notices: new Map(), revisions: new Map(), epoch: 0, runStarts: new Map(),
};

export type Refresh = 'conversations' | 'approvals' | 'tasks' | 'drafts' | 'unread' | 'worker';

export type Effect =
  | { kind: 'refresh'; what: Refresh }
  | { kind: 'checklist'; conversationId: string }
  | { kind: 'notifyApproval'; title: string }
  | { kind: 'notify'; title: string; body: string }
  | { kind: 'gone'; conversationId: string };

export type Action =
  | { type: 'event'; event: RunEvent; hidden: boolean; now?: number }
  | { type: 'resync'; drafts: Draft[] }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'approvals'; approvals: Approval[] }
  | { type: 'skillDrafts'; count: number }
  | { type: 'unread'; count: number }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'checklist'; conversationId: string; items: ChecklistItem[] }
  | { type: 'clearNotices'; conversationId: string };

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

const draftsWith = (s: LiveState, runId: string, change: (d: LiveDraft) => LiveDraft): LiveDraft[] =>
  s.drafts.map(d => (d.runId === runId ? change(d) : d));

function addNotice(s: LiveState, conversationId: string, notice: RunNotice): LiveState {
  return { ...s, notices: new Map(s.notices).set(conversationId, mergeNotice(s.notices.get(conversationId) ?? [], notice)) };
}

function bump(s: LiveState, conversationId: string): LiveState {
  return { ...s, revisions: new Map(s.revisions).set(conversationId, (s.revisions.get(conversationId) ?? 0) + 1) };
}

function onEvent(s: LiveState, e: RunEvent, hidden: boolean, now: number): { state: LiveState; effects: Effect[] } {
  switch (e.type) {
    case 'run.start': {
      const drafts = [...s.drafts.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '' }];
      const known = s.conversations.some(c => c.id === e.conversationId);
      const notices = new Map(s.notices);
      notices.delete(e.conversationId);
      return {
        state: { ...s, drafts, notices, runStarts: new Map(s.runStarts).set(e.runId, now) },
        effects: [...(known ? [] : refresh('conversations')), { kind: 'checklist', conversationId: e.conversationId }, ...refresh('worker')],
      };
    }
    case 'model.switch': {
      const state = { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, modelId: e.to, text: '' })) };
      return { state: addNotice(state, e.conversationId, { runId: e.runId, kind: 'switch', from: e.from, to: e.to, reason: e.reason }), effects: [] };
    }
    case 'text.delta': {
      const drafts = draftsWith(s, e.runId, d => ({ ...d, text: d.text + e.text }));
      return { state: { ...s, drafts, streaming: s.streaming.has(e.conversationId) ? s.streaming : new Set(s.streaming).add(e.conversationId) }, effects: [] };
    }
    case 'warning':
      if (e.code === 'compacted') return { state: s, effects: [] };
      return {
        state: addNotice(s, e.conversationId, { runId: e.runId, kind: 'warning', code: e.code, message: e.message, params: e.params, ...(e.code === 'context_trimmed' ? { key: 'context_trimmed' } : {}) }),
        effects: [],
      };
    case 'compaction':
      return { state: addNotice(s, e.conversationId, { runId: e.runId, kind: 'compaction', key: 'compaction', summarized: e.summarized }), effects: [] };
    case 'message.saved': {
      const state = bump(s, e.conversationId);
      return {
        state: e.role === 'assistant' ? { ...state, drafts: draftsWith(state, e.runId, d => ({ ...d, text: '' })) } : state,
        effects: e.role === 'user' ? refresh('conversations') : [],
      };
    }
    case 'tool.call':
      return { state: { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, activeTool: e.name, activeInput: e.input, toolStartedAt: now })) }, effects: [] };
    case 'tool.auto': {
      const state = { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, autoChecking: e.state === 'checking' })) };
      return { state: e.state === 'allowed' ? addNotice(state, e.conversationId, { runId: e.runId, kind: 'auto', tool: e.name, reason: e.reason ?? '' }) : state, effects: [] };
    }
    case 'agent.state':
      return {
        state: { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, agent: e.state === 'running' ? { conversationId: e.childConversationId, toolCalls: e.toolCalls } : undefined })) },
        effects: [],
      };
    case 'tool.result': {
      const state = { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, activeTool: undefined, activeInput: undefined, autoChecking: undefined, agent: undefined, toolStartedAt: undefined })) };
      return {
        state: e.decision === 'deny' ? addNotice(state, e.conversationId, { runId: e.runId, kind: 'denied', tool: e.name, detail: e.preview.split('\n').slice(1, 3).join(' ') }) : state,
        effects: [],
      };
    }
    case 'run.end': {
      const runStarts = new Map(s.runStarts);
      runStarts.delete(e.runId);
      let state: LiveState = bump({ ...s, drafts: s.drafts.filter(d => d.runId !== e.runId), streaming: without(s.streaming, e.conversationId), runStarts }, e.conversationId);
      if (!e.ok && e.errorKind === 'cancelled') state = addNotice(state, e.conversationId, { runId: e.runId, kind: 'stopped' });
      else if (!e.ok) {
        state = addNotice(state, e.conversationId, {
          runId: e.runId, kind: 'error', errorKind: e.errorKind ?? 'internal', errorCode: e.errorCode, errorParams: e.errorParams, errorMessage: e.errorMessage,
          hint: e.detail?.hint, measured: e.detail?.measured, required: e.detail?.required,
        });
      }
      return { state, effects: refresh('conversations', 'worker', 'drafts', 'approvals') };
    }
    case 'approval.requested': {
      const approval: Approval = { ...e.approval, runId: e.runId, conversationId: e.conversationId };
      return {
        state: { ...s, approvals: [...s.approvals.filter(a => a.id !== approval.id), approval] },
        effects: [...(hidden ? [{ kind: 'notifyApproval', title: e.approval.title } as const] : []), ...refresh('approvals')],
      };
    }
    case 'approval.resolved':
      return { state: { ...s, approvals: s.approvals.filter(a => a.id !== e.approvalId) }, effects: refresh('approvals') };
    case 'memory.changed':
      return { state: addNotice(s, e.conversationId, { runId: e.runId, kind: 'memory', action: e.action, content: e.content, eventId: e.eventId }), effects: [] };
    case 'checklist.updated':
      return { state: { ...s, checklists: new Map(s.checklists).set(e.conversationId, e.items) }, effects: [] };
    case 'pending.changed':
      return { state: bump(s, e.conversationId), effects: [] };
    case 'conversation.changed':
      return {
        state: bump(s, e.conversationId),
        effects: e.change === 'deleted' ? [...refresh('conversations', 'unread'), { kind: 'gone', conversationId: e.conversationId }] : refresh('conversations'),
      };
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
    case 'event': return onEvent(s, a.event, a.hidden, a.now ?? 0);
    case 'resync':
      return {
        state: { ...s, drafts: a.drafts, streaming: new Set(a.drafts.filter(d => d.text).map(d => d.conversationId)), checklists: new Map(), epoch: s.epoch + 1 },
        effects: [...a.drafts.map(d => ({ kind: 'checklist', conversationId: d.conversationId }) as const), ...refresh('conversations', 'approvals', 'tasks', 'drafts', 'unread', 'worker')],
      };
    case 'conversations': return { state: { ...s, conversations: a.conversations }, effects: [] };
    case 'approvals': return { state: { ...s, approvals: a.approvals }, effects: [] };
    case 'skillDrafts': return { state: { ...s, skillDrafts: a.count }, effects: [] };
    case 'unread': return { state: { ...s, unread: a.count }, effects: [] };
    case 'tasks': return { state: { ...s, tasks: mergeTasks(s.tasks, a.tasks) }, effects: [] };
    case 'checklist': return { state: { ...s, checklists: new Map(s.checklists).set(a.conversationId, a.items) }, effects: [] };
    case 'clearNotices': {
      if (!s.notices.has(a.conversationId)) return { state: s, effects: [] };
      const notices = new Map(s.notices);
      notices.delete(a.conversationId);
      return { state: { ...s, notices }, effects: [] };
    }
  }
}
