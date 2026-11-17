import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project, Proposal, ScoutState, Task } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

interface PaneProps { productId: string; conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: Project[]; pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number> }
interface HomeProps { id: string; project: Project | undefined; conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; worker: null; revision: number; onProject?: (p: Project) => void }

const { KanbanPane } = await loadTsx<{ KanbanPane: ComponentType<PaneProps> }>('../web/src/ui/panes/KanbanPane.tsx', import.meta.url);
const { ProductHome } = await loadTsx<{ ProductHome: ComponentType<HomeProps> }>('../web/src/ui/screens/ProductHome.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const g = globalThis as { matchMedia?: unknown };
const realMatch = g.matchMedia;
let narrow = false;
g.matchMedia = () => ({ matches: narrow, addEventListener: () => {}, removeEventListener: () => {} });
const realFetch = globalThis.fetch;
const calls: Array<{ path: string; method: string; body: unknown }> = [];

const project = (over: Partial<Project> = {}): Project => ({
  id: PRODUCT, name: 'Shop', root: '/w/shop', check_command: null, scout_mode: 'research', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});
const task = (id: string, status: Task['status'], over: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'self', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: Date.now() - 60_000, updated_at: Date.now() - 60_000, completed_at: null,
  project_id: PRODUCT, proposal: null, ...over,
});
const PROPOSAL: Proposal = {
  kind: 'feature', why: 'Uploads restart from zero after a dropped connection. Resuming saves minutes per file. A third sentence is not shown.',
  area: ['src/upload/'], size: 'M', goal: null, evidence: null, ledger: 'L-0007',
};

function serve(tasks: { active: Task[]; finished?: Task[] }, scout: ScoutState | null, extra?: (path: string, method: string) => unknown): void {
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    calls.push({ path: url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const more = extra?.(url, method);
    if (more !== undefined) return reply(200, more);
    if (url.startsWith('/api/tasks/finished')) return reply(200, { tasks: tasks.finished ?? [], next: null, total: (tasks.finished ?? []).length });
    if (url.startsWith('/api/tasks')) return reply(200, { active: tasks.active, finished: [], awaiting: [] });
    if (url.startsWith('/api/runs')) return reply(200, { runs: [], total: 0, judged: {} });
    if (url === `/api/projects/${PRODUCT}/scout`) return scout ? reply(200, scout) : reply(404, { error: 'not_found' });
    if (url === `/api/projects/${PRODUCT}/scout/run`) return reply(202, {});
    if (url.startsWith('/api/background')) return reply(200, { items: [] });
    return reply(404, { error: 'not_found' });
  }) as typeof fetch;
}

const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const pane = (projects = [project()]) => render(createElement(KanbanPane, {
  productId: PRODUCT, conversations: [], drafts: [], checklists: new Map(), revision: 0, projects, pendingByTask: new Map(), questionsByTask: new Map(),
}));
const column = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`#ui-col-${id}`)!;

afterEach(async () => {
  await cleanup();
  narrow = false;
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('ui/KanbanPane（DOM）: a proposal card reads "Proposal · feature", two sentences of why, the area, the size and "Outside the plan"; a plain proposal keeps the old card. With no state endpoint (404) there is no state line and no Think now', async () => {
  serve({ active: [task('Resume interrupted uploads', 'inbox', { proposal: PROPOSAL }), task('Plain idea', 'inbox', { body: 'Old style proposal.' }), task('Bug fix', 'inbox', { proposal: { ...PROPOSAL, kind: 'bug', size: 'S', goal: 'Fast uploads' } })] }, null);
  const { container } = await pane();
  await settle();
  assert.equal(container.querySelector('[data-kanban]')?.getAttribute('data-kanban'), 'pane');
  assert.equal(container.querySelector('.bt-screen__head'), null, 'no screen header or product filter inside the pane');
  const cards = [...column(container, 'proposed').querySelectorAll('article.bt-card')];
  const byTitle = (title: string) => cards.find(card => card.querySelector('.bt-card__title')?.textContent === title)!;
  const feature = byTitle('Resume interrupted uploads');
  assert.equal(feature.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.proposal.feature']);
  assert.equal(feature.querySelector('.bt-card__body')?.textContent, 'Uploads restart from zero after a dropped connection. Resuming saves minutes per file.');
  assert.deepEqual([...feature.querySelectorAll('.bt-card__meta span')].map(s => s.textContent), ['src/upload/', 'size M', en['ui.kanban.proposal.offPlan']]);
  assert.ok(feature.querySelector('[data-off-plan]'));
  assert.ok(byText(feature, 'button', 'Approve') && byText(feature, 'button', 'Reject'), 'Approve / Reject stay the same');
  const bug = byTitle('Bug fix');
  assert.equal(bug.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.proposal.bug']);
  assert.equal(bug.querySelector('[data-off-plan]'), null, 'inside the plan: no tag');
  assert.ok(bug.textContent?.includes('for: Fast uploads'));
  const plain = byTitle('Plain idea');
  assert.equal(plain.querySelector('.bt-card__head .bt-label')?.textContent, en['ui.kanban.task']);
  assert.equal(plain.querySelector('.bt-card__body')?.textContent, 'Old style proposal.');
  assert.equal(container.querySelector('.product, [data-product-tag]'), null);
  assert.equal(container.querySelector('[data-scout]'), null, '404: no state line');
  assert.equal(byText(container, 'button', en['ui.scout.thinkNow']), undefined, '404: no Think now');
  assert.ok(calls.some(c => c.path === `/api/tasks?project=${PRODUCT}`), 'the pane reads only this product');
});

test('ui/KanbanPane（DOM）: Proposed empty and no state endpoint (404, or a reply of the wrong shape) keeps "nothing to propose yet"', async () => {
  serve({ active: [task('Queued', 'ready', { origin: 'user' })] }, null);
  const { container } = await pane();
  await settle();
  assert.equal(column(container, 'proposed').querySelector('.ui-col__empty')?.textContent, en['ui.kanban.noProposals']);
  await cleanup();

  serve({ active: [task('Queued', 'ready', { origin: 'user' })] }, {} as ScoutState);
  const odd = await pane();
  await settle();
  assert.equal(odd.container.querySelector('[data-scout]'), null, 'a reply of the wrong shape is treated like no endpoint');
  assert.equal(column(odd.container, 'proposed').querySelector('.ui-col__empty')?.textContent, en['ui.kanban.noProposals']);
});

test('ui/KanbanPane（DOM）: Proposed empty while thinking shows Thinking, the examined count and the area, without Think now', async () => {
  serve({ active: [task('Queued', 'ready', { origin: 'user' })] }, { state: 'thinking', examined: 12, area: 'src/sync/', lastChangeAt: null, note: null });
  const { container } = await pane();
  await settle();
  const empty = column(container, 'proposed').querySelector('[data-scout="thinking"]')!;
  assert.ok(empty, 'the state sits in the Proposed column');
  assert.equal(empty.querySelector('.bt-pill')?.textContent, 'Thinking');
  assert.equal(empty.querySelector('.ui-scout__meta')?.textContent, 'examined 12 areas, nothing to propose yet · now reading src/sync/');
  assert.equal(byText(container, 'button', en['ui.scout.thinkNow']), undefined);
});

test('ui/KanbanPane（DOM）: an empty board while asleep shows the whole-pane empty state with Think now, which posts to the run endpoint; mode Off hides Think now', async () => {
  serve({ active: [] }, { state: 'asleep', examined: 3, area: null, lastChangeAt: Date.now() - 3 * 3_600_000, note: 'The ledger has 2 broken lines' });
  const { container } = await pane();
  await settle();
  assert.equal(container.querySelector('.bt-board'), null, 'every column empty: the empty state replaces the board');
  const empty = container.querySelector('.ui-kanban__empty [data-scout="asleep"]')!;
  assert.equal(empty.querySelector('.bt-empty__title')?.textContent, en['ui.scout.nothingNew']);
  assert.equal(empty.querySelector('.ui-scout__meta')?.textContent, 'last change 3 hours ago · wakes on the next edit');
  assert.equal(empty.querySelector('[data-scout-note]')?.textContent, 'The ledger has 2 broken lines');
  await click(byText(container, 'button', en['ui.scout.thinkNow']));
  await settle();
  assert.ok(calls.some(c => c.path === `/api/projects/${PRODUCT}/scout/run` && c.method === 'POST'));
  await cleanup();

  serve({ active: [] }, { state: 'asleep', examined: 3, area: null, lastChangeAt: null, note: null });
  const off = await pane([project({ scout_mode: 'off' })]);
  await settle();
  assert.ok(off.container.querySelector('[data-scout="asleep"]'));
  assert.equal(byText(off.container, 'button', en['ui.scout.thinkNow']), undefined, 'mode Off: no Think now');
});

test('ui/ProductHome（DOM）: the head has the mode switch (Off / Research only / Research and pre-fix, the last not pressable, "Arrives later"); picking sends PATCH scoutMode. Without the state endpoint there is no Think now', async () => {
  let saved = null as Project | null;
  serve({ active: [] }, null, (path, method) => (path === `/api/projects/${PRODUCT}` && method === 'PATCH' ? { project: project({ scout_mode: 'research' }) } : undefined));
  const { container } = await render(createElement(ProductHome, { id: PRODUCT, project: project({ scout_mode: 'off' }), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0, onProject: p => { saved = p; } }));
  await settle();
  const options = [...container.querySelectorAll<HTMLButtonElement>('.ui-home__mode .bt-seg__opt')];
  assert.deepEqual(options.map(o => o.dataset.mode), ['off', 'research', 'fix']);
  assert.deepEqual(options.map(o => o.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  const fix = options[2]!;
  assert.equal(fix.disabled, true, 'pre-fix cannot be picked yet');
  assert.ok(fix.textContent?.includes(en['ui.scout.mode.later']));
  assert.equal(byText(container, 'button', en['ui.scout.thinkNow']), undefined);
  await click(options[1]);
  await settle();
  const patch = calls.find(c => c.method === 'PATCH');
  assert.deepEqual(patch?.body, { scoutMode: 'research' });
  assert.equal(saved?.scout_mode, 'research', 'the saved product goes back to the app');
});

test('ui/ProductHome（DOM）: while thinking, Running now has the thinking row (examined N areas); Think now shows only when the state allows it', async () => {
  serve({ active: [] }, { state: 'thinking', examined: 4, area: 'src/api/', lastChangeAt: null, note: null });
  const { container } = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  const row = container.querySelector('[data-scout-row]')!;
  assert.ok(row, 'the thinking row is in Running now');
  assert.equal(row.querySelector('.bt-row__sub')?.textContent, 'examined 4 areas · now reading src/api/');
  assert.equal(byText(container, 'button', en['ui.scout.thinkNow']), undefined, 'already thinking: no Think now');
  await cleanup();

  serve({ active: [] }, { state: 'idle', examined: 0, area: null, lastChangeAt: null, note: null });
  const idle = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  assert.equal(idle.container.querySelector('[data-scout-row]'), null);
  assert.ok(byText(idle.container, 'button', en['ui.scout.thinkNow']), 'research mode and not thinking: Think now');
});

test('ui/KanbanPane（DOM）: on a narrow screen the columns come in the order Proposed, Awaiting check, In progress, Approved, Done (then Failed), as tabs', async () => {
  narrow = true;
  serve({ active: [task('Queued', 'ready', { origin: 'user' })] }, null);
  const { container } = await pane();
  await settle();
  assert.deepEqual([...container.querySelectorAll('.bt-board > .bt-col')].map(c => c.id), ['ui-col-proposed', 'ui-col-check', 'ui-col-progress', 'ui-col-approved', 'ui-col-done', 'ui-col-failed']);
  assert.equal(container.querySelectorAll('.ui-coltabs [role="tab"]').length, 6);
});

test.after(() => { g.matchMedia = realMatch; });
