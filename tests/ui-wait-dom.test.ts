import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, ChatBuild, Project, Task, WaitReason, WorkerStatus } from '../web/src/api.ts';
import { formatDateTimeSmart } from '../web/src/i18n/index.ts';

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void; waits?: Record<string, WaitReason>;
}
interface PlanProps { productId: string; conversationId?: string; revision: string; taskRevision?: string; isGit: boolean; waits?: Record<string, WaitReason> }
interface TaskProps { id: string; revision: string; worker: WorkerStatus | null; projects: readonly Project[]; pending: number }
interface KanbanProps {
  conversations: never[]; drafts: never[]; checklists: Map<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: Map<string, number>; questionsByTask: Map<string, number>; waits?: Record<string, WaitReason>;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);
const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);
const { TaskScreen } = await loadTsx<{ TaskScreen: ComponentType<TaskProps> }>('../web/src/ui/screens/Task.tsx', import.meta.url);
const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };

function serve(routes: (path: string, method: string) => unknown): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const out = routes(String(path), init?.method ?? 'GET');
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  window.location.hash = '';
});

const task = (status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id: 'b1', title: 'Build: Parser', body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 1, updated_at: 1, completed_at: null, project_id: PRODUCT, ...extra,
});

const AT = Date.now() + 25 * 60_000;
const REASONS: Array<[WaitReason, string]> = [
  [{ kind: 'off' }, 'Work on its own is off'],
  [{ kind: 'paused' }, 'paused'],
  [{ kind: 'chat' }, 'waiting for the chat reply to finish'],
  [{ kind: 'budget', at: AT }, `hourly limit reached · can start at ${formatDateTimeSmart(AT)}`],
  [{ kind: 'product' }, 'another task of this product is running'],
  [{ kind: 'slots' }, 'waiting for running work to finish'],
];

test('ui/Conversation（DOM）: a queued Build says why it is not running ("Build queued · paused" and the other reasons); without a reason it stays "Build queued"', async () => {
  const build: ChatBuild = { id: 'b1', status: 'ready', waiting_kind: null, check_state: null, project_id: PRODUCT, created_at: 30, updated_at: 30, checklist: { items: [], tainted: false }, conversation_id: null, summary: null, summary_tainted: false };
  serve(path => {
    if (path === `/api/conversations/${CHAT}/messages`) {
      return { conversation: { id: CHAT, title: 'Parser', created_at: 0, last_message_at: 0, permission_mode: 'plan' }, messages: [{ id: 1, role: 'user', text: 'plan it', runId: 'r1', createdAt: 10 }], pending: [], builds: [build], activeRun: null };
    }
    if (path === `/api/conversations/${CHAT}/checklist`) return { items: [], tainted: false, updatedAt: null };
    if (path === '/api/models') return { models: [], routing: { chat: [] } };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const props = (waits?: Record<string, WaitReason>): ConversationProps => ({
    id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {}, ...(waits ? { waits } : {}),
  });
  const { container, root } = await render(createElement(Conversation, props()));
  await settle(); await settle();
  const row = () => [...container.querySelectorAll('.bt-thread > .bt-notice')].find(n => /^Build /u.test(n.textContent ?? ''));
  assert.match(row()!.textContent!, /^Build queuedOpen task$/u);
  for (const [reason, text] of REASONS) {
    await update(() => root.render(createElement(Conversation, props({ b1: reason }))));
    assert.equal(row()!.querySelector('.ui-notice__text')?.textContent, `Build queued · ${text}`, reason.kind);
  }
});

const acceptance: Acceptance = {
  version: 1, language: 'en', items: [], not_doing: [], draft: false, hash: 'ah',
  frozen: { version: 1, hash: 'ah', plan_hash: 'p1', created_at: 1, source: 'build', build_task_id: 'b1' }, open_build_task_id: 'b1',
};

test('ui/PlanPane（DOM）: the pill stays "Queued" and the reason is a meta line under the bar; Running shows no reason', async () => {
  let status: Task['status'] = 'ready';
  serve(path => {
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/plan`) return { plan: { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false } };
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/acceptance`) return { acceptance, coverage: { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0, by_hand: 0, unreferenced: [], unreferenced_total: 0 } };
    if (path === '/api/tasks/b1') return { task: task(status), events: [], runs: [] };
    if (path === `/api/projects/${PRODUCT}/deviations`) return { deviations: { rows: [], unreadable: 0, unusable: false }, flags: { checked: false, reason: 'no_git' } };
    return undefined;
  });
  const props = { productId: PRODUCT, conversationId: CHAT, revision: '0', isGit: true };
  const { root } = await render(createElement(PlanPane, { ...props, taskRevision: '0' }));
  await settle(); await settle();
  const pill = () => document.body.querySelector('[role="status"] .bt-pill');
  const why = () => document.body.querySelector('.ui-plan__live [data-wait]')?.textContent ?? null;
  assert.equal(pill()?.textContent, 'Queued');
  assert.equal(why(), null);
  for (const [reason, text] of REASONS) {
    await update(() => root.render(createElement(PlanPane, { ...props, taskRevision: '0', waits: { b1: reason } })));
    assert.equal(pill()?.textContent, 'Queued', reason.kind);
    assert.equal(why(), text, reason.kind);
  }
  status = 'running';
  await update(() => root.render(createElement(PlanPane, { ...props, taskRevision: '1', waits: { b1: { kind: 'paused' } } })));
  await settle();
  assert.equal(pill()?.textContent, 'Running');
  assert.equal(why(), null, 'a running task shows no waiting reason');
});

const worker = (waits: Record<string, WaitReason>): WorkerStatus => ({
  enabled: false, autonomy: false, paused: true, quiet: false, running: null, runningAll: [], maxParallel: 1, nextWakeAt: null, runsLastHour: 0, maxRunsPerHour: 6, waiting: waits,
});
const project = { id: PRODUCT, name: 'Parser' } as Project;

test('ui/Task（DOM）: a queued task keeps the "Queued" pill and shows the reason as a meta line ("paused")', async () => {
  serve(path => (path === '/api/tasks/b1' ? { task: task('ready'), events: [], runs: [] } : undefined));
  const { container, root } = await render(createElement(TaskScreen, { id: 'b1', revision: '0', worker: worker({}), projects: [project], pending: 0 }));
  await settle();
  const pill = () => container.querySelector('.ui-task__state .bt-pill')?.textContent;
  const why = () => container.querySelector('.ui-task__state [data-wait]')?.textContent ?? null;
  assert.equal(pill(), 'Queued');
  assert.equal(why(), null);
  await update(() => root.render(createElement(TaskScreen, { id: 'b1', revision: '0', worker: worker({ b1: { kind: 'paused' } }), projects: [project], pending: 0 })));
  assert.equal(pill(), 'Queued');
  assert.equal(why(), 'paused');
});

test('ui/Kanban（DOM）: an Approved card says why it is waiting ("another task of this product is running")', async () => {
  serve(path => {
    if (path === '/api/tasks') return { active: [task('ready', { title: 'Tidy the parser' })], finished: [] };
    if (path === '/api/tasks/finished?limit=20') return { tasks: [], next: null, total: 0 };
    if (path === '/api/runs?limit=500') return { runs: [], total: 0, judged: {} };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const props: KanbanProps = { conversations: [], drafts: [], checklists: new Map<string, never[]>(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map() };
  const { container, root } = await render(createElement(Kanban, props));
  await settle();
  const card = () => [...container.querySelectorAll('.bt-card')].find(c => c.textContent?.includes('Tidy the parser'));
  assert.ok(card(), 'the card is drawn');
  assert.ok(!card()!.textContent!.includes('another task of this product is running'));
  await update(() => root.render(createElement(Kanban, { ...props, waits: { b1: { kind: 'product' } } })));
  assert.ok(card()!.textContent!.includes('another task of this product is running'), card()!.textContent!);
});

test('ui/Kanban（DOM）: while Work on its own is Off, a beat task says so and "next in queue" goes to the owner task that will run', async () => {
  serve(path => {
    if (path === '/api/tasks') return { active: [task('ready', { id: 's1', title: 'Tidy the notes', origin: 'self', priority: 1 }), task('ready', { title: 'Build: Parser' })], finished: [] };
    if (path === '/api/tasks/finished?limit=20') return { tasks: [], next: null, total: 0 };
    if (path === '/api/runs?limit=500') return { runs: [], total: 0, judged: {} };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const props: KanbanProps = { conversations: [], drafts: [], checklists: new Map<string, never[]>(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map(), waits: { s1: { kind: 'off' } } };
  const { container } = await render(createElement(Kanban, props));
  await settle();
  const card = (title: string) => [...container.querySelectorAll('.bt-card')].find(c => c.textContent?.includes(title))!.textContent!;
  assert.ok(card('Tidy the notes').includes('Work on its own is off'), card('Tidy the notes'));
  assert.ok(!card('Tidy the notes').includes('next in queue'), card('Tidy the notes'));
  assert.ok(card('Build: Parser').includes('next in queue'), card('Build: Parser'));
});
