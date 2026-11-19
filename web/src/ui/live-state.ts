import type { ChecklistItem, Conversation, NotificationItem, PendingAction, PendingCounts, Project, QuestionCounts, Task, TaskStatus, ToolGate } from '../api.ts';
import { mergeNotice } from '../chat-logic.ts';
import type { Draft, RunEvent } from '../events.ts';
import { EDIT_TOOLS } from './changes.ts';

export interface TaskMark { status: TaskStatus; updatedAt: number; live: boolean; waitingKind?: Task['waiting_kind']; checkState?: Task['check_state']; merge?: boolean; projectId?: string | null; conversationId?: string | null; buildChat?: { chat: string; conversation: string | null } }

export interface SettledTool { callId: string; name: string; input: string; gate?: ToolGate | undefined }
export interface LiveDraft extends Draft { startedAt?: number | undefined; toolStartedAt?: number | undefined; toolCallId?: string | undefined; settled?: SettledTool[] | undefined; settledCount?: number | undefined; waitingSince?: number | undefined }

const SETTLED_MAX = 20;
const settle = (d: LiveDraft, callId: string, gate: ToolGate | undefined): SettledTool[] | undefined =>
  (d.activeTool && d.toolCallId === callId ? [...(d.settled ?? []), { callId, name: d.activeTool, input: d.activeInput ?? '', ...(gate ? { gate } : {}) }].slice(-SETTLED_MAX) : d.settled);

export type RunNotice = { runId: string; key?: string | undefined; after?: number | undefined } & (
  | { kind: 'switch'; from: string; to: string; reason: string }
  | { kind: 'warning'; code: string; message: string; params?: Record<string, unknown> | undefined }
  | { kind: 'compaction'; summarized: number }
  | { kind: 'memory'; action: 'create' | 'update' | 'forget'; content: string; eventId: number }
  | { kind: 'stopped' }
  | { kind: 'interrupted' }
  | { kind: 'undo'; projectId: string; batch: string | null; undone: number; refused: number; more: number }
  | { kind: 'error'; errorKind: string; errorCode?: string | undefined; errorParams?: Record<string, string | number> | undefined; errorMessage?: string | undefined; hint?: string | undefined; measured?: number | undefined; required?: number | undefined }
);

export interface LiveState {
  conversations: Conversation[];
  conversationsMore: Readonly<Record<string, number>>;
  conversationsSettled: boolean;
  projects: Project[];
  projectsLoaded: boolean;
  skillDrafts: number;
  unread: number;
  tasks: ReadonlyMap<string, TaskMark>;
  drafts: LiveDraft[];
  streaming: ReadonlySet<string>;
  checklists: ReadonlyMap<string, ChecklistItem[]>;
  notices: ReadonlyMap<string, RunNotice[]>;
  lastMessage: ReadonlyMap<string, number>;
  cutAt: ReadonlyMap<string, number>;
  revisions: ReadonlyMap<string, number>;
  edits: ReadonlyMap<string, number>;
  interrupting: ReadonlySet<string>;
  taskRevision: number;
  planRevisions: ReadonlyMap<string, number>;
  libraryRevision: number;
  pendingCounts: PendingCounts | null;
  pendingWaiting: PendingAction[];
  pendingRevision: number;
  questionCounts: QuestionCounts | null;
  questionRevision: number;
  backgroundRevision: number;
  epoch: number;
}

export const EMPTY: LiveState = {
  conversations: [], conversationsMore: {}, conversationsSettled: false, projects: [], projectsLoaded: false, skillDrafts: 0, unread: 0, tasks: new Map(), drafts: [], streaming: new Set(), checklists: new Map(),
  notices: new Map(), lastMessage: new Map(), cutAt: new Map(), revisions: new Map(), edits: new Map(), interrupting: new Set(), taskRevision: 0, planRevisions: new Map(), libraryRevision: 0, pendingCounts: null, pendingWaiting: [], pendingRevision: 0, questionCounts: null, questionRevision: 0, backgroundRevision: 0, epoch: 0,
};

const library = (s: LiveState): LiveState => ({ ...s, libraryRevision: s.libraryRevision + 1 });

const planBump = (s: LiveState, projectId: string): LiveState => ({ ...s, planRevisions: new Map(s.planRevisions).set(projectId, (s.planRevisions.get(projectId) ?? 0) + 1) });

export type Refresh = 'conversations' | 'tasks' | 'drafts' | 'unread' | 'worker' | 'projects' | 'projectCounts' | 'pending' | 'questions';

export type Effect =
  | { kind: 'refresh'; what: Refresh }
  | { kind: 'checklist'; conversationId: string }
  | { kind: 'notify'; title: string; body: string }
  | { kind: 'toast'; notification: NotificationItem }
  | { kind: 'gone'; conversationId: string };

export type Action =
  | { type: 'event'; event: RunEvent; hidden: boolean; now?: number }
  | { type: 'resync'; drafts: Draft[] }
  | { type: 'conversations'; conversations: Conversation[]; more?: Record<string, number> | undefined }
  | { type: 'conversationsFailed' }
  | { type: 'projects'; projects: Project[] }
  | { type: 'project'; project: Project }
  | { type: 'pending'; counts: PendingCounts; waiting: PendingAction[] }
  | { type: 'questions'; counts: QuestionCounts }
  | { type: 'skillDrafts'; count: number }
  | { type: 'unread'; count: number }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'checklist'; conversationId: string; items: ChecklistItem[] }
  | { type: 'clearNotices'; conversationId: string; runId?: string | undefined }
  | { type: 'notice'; conversationId: string; notice: RunNotice }
  | { type: 'interrupt'; conversationId: string; on: boolean };

export const BROWSER_NOTIFY: ReadonlySet<string> = new Set(['task_waiting']);

const refresh = (...what: Refresh[]): Effect[] => what.map(w => ({ kind: 'refresh', what: w }));
const counts = (s: LiveState): Effect[] => (s.projects.length ? refresh('projectCounts') : []);

const buildChat = (t: Task): Pick<TaskMark, 'buildChat'> =>
  (t.created_in_conversation && t.acceptance_items && !t.spawned_by ? { buildChat: { chat: t.created_in_conversation, conversation: t.conversation_id } } : {});

export function mergeTasks(prev: ReadonlyMap<string, TaskMark>, snapshot: readonly Task[]): Map<string, TaskMark> {
  const next = new Map<string, TaskMark>(snapshot.map(t => [t.id, { status: t.status, updatedAt: t.updated_at, live: false, ...(t.waiting_kind ? { waitingKind: t.waiting_kind } : {}), projectId: t.project_id ?? null, ...(t.conversation_id ? { conversationId: t.conversation_id } : {}), ...(t.check_state ? { checkState: t.check_state } : {}), ...(t.worktree?.state === 'branch' ? { merge: true } : {}), ...buildChat(t) }]));
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

function addNotice(s: LiveState, conversationId: string, notice: RunNotice, place = true): LiveState {
  const last = s.lastMessage.get(conversationId);
  const placed = place && notice.after === undefined && last !== undefined ? { ...notice, after: last } : notice;
  return { ...s, notices: new Map(s.notices).set(conversationId, mergeNotice(s.notices.get(conversationId) ?? [], placed)) };
}

function placeLoose(s: LiveState, conversationId: string, messageId: number): LiveState {
  const list = s.notices.get(conversationId);
  if (!list?.some(n => n.after === undefined)) return s;
  return { ...s, notices: new Map(s.notices).set(conversationId, list.map(n => (n.after === undefined ? { ...n, after: messageId - 0.5 } : n))) };
}

function dropNotices(s: LiveState, conversationId: string, drop: (n: RunNotice) => boolean): LiveState {
  const list = s.notices.get(conversationId);
  if (!list?.some(drop)) return s;
  const kept = list.filter(n => !drop(n));
  const notices = new Map(s.notices);
  if (kept.length) notices.set(conversationId, kept); else notices.delete(conversationId);
  return { ...s, notices };
}

const HIDDEN_WARNINGS: ReadonlySet<string> = new Set(['compacted', 'output_continued']);
const PASSING_WARNINGS: ReadonlySet<string> = new Set(['retrying']);

function bump(s: LiveState, conversationId: string): LiveState {
  return { ...s, revisions: new Map(s.revisions).set(conversationId, (s.revisions.get(conversationId) ?? 0) + 1) };
}

function onEvent(s: LiveState, e: RunEvent, hidden: boolean, now: number): { state: LiveState; effects: Effect[] } {
  switch (e.type) {
    case 'run.start': {
      const drafts = [...s.drafts.filter(d => d.runId !== e.runId), { runId: e.runId, conversationId: e.conversationId, modelId: e.modelId, text: '', startedAt: now, waitingSince: now }];
      const known = s.conversations.some(c => c.id === e.conversationId);
      const cut = s.cutAt.get(e.conversationId);
      const cutAt = new Map(s.cutAt);
      cutAt.delete(e.conversationId);
      const marked = s.interrupting.has(e.conversationId) ? addNotice(s, e.conversationId, { runId: e.runId, kind: 'interrupted', ...(cut !== undefined ? { after: cut } : {}) }, false) : s;
      return {
        state: library({ ...marked, cutAt, drafts, interrupting: without(s.interrupting, e.conversationId) }),
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
      if (HIDDEN_WARNINGS.has(e.code)) return { state: s, effects: [] };
      return {
        state: addNotice(e.code === 'queued_not_started' ? { ...s, interrupting: without(s.interrupting, e.conversationId) } : s, e.conversationId, { runId: e.runId, kind: 'warning', code: e.code, message: e.message, params: e.params, ...(e.code === 'context_trimmed' || PASSING_WARNINGS.has(e.code) ? { key: e.code } : {}) }),
        effects: [],
      };
    case 'compaction':
      return { state: addNotice(s, e.conversationId, { runId: e.runId, kind: 'compaction', key: 'compaction', summarized: e.summarized }), effects: [] };
    case 'message.saved': {
      const cut = s.interrupting.has(e.conversationId) && !s.cutAt.has(e.conversationId) ? { cutAt: new Map(s.cutAt).set(e.conversationId, e.messageId - 0.5) } : {};
      const state = { ...placeLoose(bump(s, e.conversationId), e.conversationId, e.messageId), ...cut, lastMessage: new Map(s.lastMessage).set(e.conversationId, Math.max(e.messageId, s.lastMessage.get(e.conversationId) ?? 0)) };
      return {
        state: e.role === 'assistant' ? { ...state, drafts: draftsWith(state, e.runId, d => ({ ...d, text: '', waitingSince: now })) } : state,
        effects: e.role === 'user' ? refresh('conversations') : [],
      };
    }
    case 'tool.call':
      return { state: { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, activeTool: e.name, activeInput: e.input, toolStartedAt: now, toolCallId: e.callId })) }, effects: [] };
    case 'tool.auto': {
      return { state: { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, autoChecking: e.state === 'checking' })) }, effects: [] };
    }
    case 'agent.state':
      return {
        state: { ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, agent: e.state === 'running' ? { conversationId: e.childConversationId, toolCalls: e.toolCalls } : undefined })) },
        effects: [],
      };
    case 'tool.result': {
      const state = library({ ...s, drafts: draftsWith(s, e.runId, d => ({ ...d, activeTool: undefined, activeInput: undefined, autoChecking: undefined, agent: undefined, toolStartedAt: undefined, toolCallId: undefined, settled: settle(d, e.callId, e.gate), settledCount: (d.settledCount ?? 0) + (d.activeTool && d.toolCallId === e.callId ? 1 : 0), waitingSince: now })) });
      const edited = e.ok && e.decision !== 'deny' && EDIT_TOOLS.has(e.name) ? { ...state, edits: new Map(state.edits).set(e.conversationId, (state.edits.get(e.conversationId) ?? 0) + 1) } : state;
      return { state: edited, effects: [] };
    }
    case 'run.end': {
      let state: LiveState = dropNotices(bump(library({ ...s, drafts: s.drafts.filter(d => d.runId !== e.runId), streaming: without(s.streaming, e.conversationId) }), e.conversationId), e.conversationId, n => n.runId === e.runId && n.kind === 'warning' && PASSING_WARNINGS.has(n.code));
      if (!e.ok && e.errorKind === 'cancelled' && s.interrupting.has(e.conversationId)) {
        const last = s.lastMessage.get(e.conversationId);
        if (last !== undefined) state = { ...state, cutAt: new Map(state.cutAt).set(e.conversationId, last) };
        return { state, effects: refresh('conversations', 'worker', 'drafts') };
      }
      if (!e.ok && e.errorKind === 'cancelled') state = addNotice(state, e.conversationId, { runId: e.runId, kind: 'stopped' });
      else if (!e.ok) {
        state = addNotice(state, e.conversationId, {
          runId: e.runId, kind: 'error', errorKind: e.errorKind ?? 'internal', errorCode: e.errorCode, errorParams: e.errorParams, errorMessage: e.errorMessage,
          hint: e.detail?.hint, measured: e.detail?.measured, required: e.detail?.required,
        });
      }
      return { state, effects: refresh('conversations', 'worker', 'drafts') };
    }
    case 'memory.changed':
      return { state: addNotice(library(s), e.conversationId, { runId: e.runId, kind: 'memory', action: e.action, content: e.content, eventId: e.eventId }), effects: [] };
    case 'checklist.updated': {
      const state = { ...s, checklists: new Map(s.checklists).set(e.conversationId, e.items) };
      const chat = [...s.tasks.values()].find(mark => mark.buildChat?.conversation === e.conversationId)?.buildChat?.chat;
      return { state: chat ? bump(state, chat) : state, effects: [] };
    }
    case 'pendingAction.changed':
      return { state: { ...s, pendingRevision: s.pendingRevision + 1 }, effects: [...refresh('pending'), ...counts(s)] };
    case 'question.changed':
      return { state: { ...s, questionRevision: s.questionRevision + 1 }, effects: [...refresh('questions'), ...counts(s)] };
    case 'background.changed':
      return { state: { ...s, backgroundRevision: s.backgroundRevision + 1 }, effects: [] };
    case 'pending.changed':
      return { state: bump(s, e.conversationId), effects: [] };
    case 'conversation.changed':
      return {
        state: bump(library(s), e.conversationId),
        effects: e.change === 'deleted' ? [...refresh('conversations', 'unread'), { kind: 'gone', conversationId: e.conversationId }] : refresh('conversations'),
      };
    case 'project.changed':
      return { state: s, effects: refresh('projects', ...(e.change === 'archived' || e.change === 'restored' ? ['conversations', 'pending'] as const : [])) };
    case 'plan.changed':
      return { state: planBump(s, e.projectId), effects: refresh('projects') };
    case 'acceptance.changed':
      return { state: { ...planBump(s, e.projectId), taskRevision: s.taskRevision + 1 }, effects: refresh('pending', 'tasks') };
    case 'task.changed': {
      const old = s.tasks.get(e.task.id);
      if (old && old.updatedAt > e.task.updated_at) return { state: s, effects: refresh('worker') };
      const tasks = new Map(s.tasks).set(e.task.id, { status: e.task.status, updatedAt: e.task.updated_at, live: true, ...(e.task.waiting_kind ? { waitingKind: e.task.waiting_kind } : {}), projectId: e.task.project_id ?? null, ...(e.task.conversation_id ? { conversationId: e.task.conversation_id } : {}), ...(e.task.check_state ? { checkState: e.task.check_state } : {}), ...(e.task.worktree?.state === 'branch' ? { merge: true } : {}), ...buildChat(e.task) });
      const mark = tasks.get(e.task.id)!;
      const moved = !old || old.status !== mark.status || old.waitingKind !== mark.waitingKind || old.checkState !== mark.checkState || old.merge !== mark.merge || old.buildChat?.conversation !== mark.buildChat?.conversation;
      const chat = moved ? mark.buildChat?.chat : undefined;
      const next = { ...(chat ? bump(s, chat) : s), tasks, taskRevision: s.taskRevision + 1 };
      const build = e.task.project_id && e.task.acceptance_items && old?.status !== e.task.status ? e.task.project_id : null;
      return { state: build ? planBump(next, build) : next, effects: [...refresh('worker'), ...counts(s)] };
    }
    case 'scout.changed':
      return { state: { ...s, taskRevision: s.taskRevision + 1 }, effects: [] };
    case 'task.deleted': {
      const tasks = new Map(s.tasks);
      tasks.delete(e.id);
      return { state: { ...s, tasks, taskRevision: s.taskRevision + 1 }, effects: [...refresh('tasks', 'worker'), ...counts(s)] };
    }
    case 'notification': {
      const notify: Effect[] = hidden && BROWSER_NOTIFY.has(e.notification.kind) ? [{ kind: 'notify', title: e.notification.title, body: e.notification.body ?? '' }] : [];
      return { state: library({ ...s, unread: s.unread + 1 }), effects: [...notify, { kind: 'toast', notification: e.notification }, ...refresh('drafts')] };
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
        effects: [...a.drafts.map(d => ({ kind: 'checklist', conversationId: d.conversationId }) as const), ...refresh('conversations', 'tasks', 'drafts', 'unread', 'worker', 'projects', 'pending', 'questions')],
      };
    case 'conversations': return { state: { ...s, conversations: a.conversations, conversationsMore: a.more ?? {}, conversationsSettled: true }, effects: [] };
    case 'conversationsFailed': return { state: s.conversationsSettled ? s : { ...s, conversationsSettled: true }, effects: [] };
    case 'projects': return { state: { ...s, projects: a.projects, projectsLoaded: true }, effects: [] };
    case 'project': {
      const rest = s.projects.filter(p => p.id !== a.project.id);
      const projects = a.project.archived_at !== null ? rest : rest.length < s.projects.length ? s.projects.map(p => (p.id === a.project.id ? a.project : p)) : [...rest, a.project];
      return { state: { ...s, projects }, effects: [] };
    }
    case 'pending': return { state: { ...s, pendingCounts: a.counts, pendingWaiting: a.waiting }, effects: [] };
    case 'questions': return { state: { ...s, questionCounts: a.counts }, effects: [] };
    case 'skillDrafts': return { state: { ...s, skillDrafts: a.count }, effects: [] };
    case 'unread': return { state: { ...s, unread: a.count }, effects: [] };
    case 'tasks': return { state: { ...s, tasks: mergeTasks(s.tasks, a.tasks) }, effects: [] };
    case 'checklist': return { state: { ...s, checklists: new Map(s.checklists).set(a.conversationId, a.items) }, effects: [] };
    case 'interrupt': {
      if (a.on) {
        const cutAt = new Map(s.cutAt);
        cutAt.delete(a.conversationId);
        return { state: { ...s, cutAt, interrupting: new Set(s.interrupting).add(a.conversationId) }, effects: [] };
      }
      const list = s.notices.get(a.conversationId) ?? [];
      const latest = s.interrupting.has(a.conversationId) ? -1 : list.findLastIndex(n => n.kind === 'interrupted');
      const kept = list.filter((_, i) => i !== latest);
      const notices = new Map(s.notices);
      if (kept.length) notices.set(a.conversationId, kept); else notices.delete(a.conversationId);
      return { state: { ...s, notices, interrupting: without(s.interrupting, a.conversationId) }, effects: [] };
    }
    case 'notice': return { state: addNotice(s, a.conversationId, a.notice), effects: [] };
    case 'clearNotices': return { state: dropNotices(s, a.conversationId, n => a.runId === undefined || n.runId === a.runId), effects: [] };
  }
}
