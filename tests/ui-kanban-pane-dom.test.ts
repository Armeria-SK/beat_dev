import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project, Proposal, ScoutState, Task, WorkerRun, WorkerStatus } from '../web/src/api.ts';
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

test('ui/KanbanPane（DOM）: state off says why: mode Off points to Research only, mode on with no Scout model points to Settings › Models, an archived product says to restore it; none offers Think now', async () => {
  const off: ScoutState = { state: 'off', examined: 0, area: null, lastChangeAt: null, note: null };
  const cases: Array<[Partial<Project>, string]> = [
    [{ scout_mode: 'off' }, en['ui.scout.offMeta']],
    [{ scout_mode: 'research' }, en['ui.scout.offMetaModel']],
    [{ scout_mode: 'research', archived_at: 5 }, en['ui.scout.offMetaArchived']],
  ];
  for (const [over, hint] of cases) {
    serve({ active: [] }, off);
    const { container } = await pane([project(over)]);
    await settle();
    assert.equal(container.querySelector('[data-scout]')?.getAttribute('data-scout'), 'off');
    assert.equal(container.querySelector('.ui-scout__meta')?.textContent, hint, JSON.stringify(over));
    assert.equal(byText(container, 'button', en['ui.scout.thinkNow']), undefined);
    await cleanup();
  }
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

test('ui/Task and ProductHome（DOM）: a thinking run ("scout") is not "another task is running": Run now on the task screen and Retry on the product home say "Task started"; a task run still makes them "Runs next"', async () => {
  const { TaskScreen } = await loadTsx<{ TaskScreen: ComponentType<{ id: string; revision: string; worker: WorkerStatus | null; projects: readonly Project[]; pending: number }> }>('../web/src/ui/screens/Task.tsx', import.meta.url);
  const { subscribe } = await import('../web/src/feedback.ts');
  const toasts: string[] = [];
  const stop = subscribe(item => { toasts.push(item.title); });
  const worker = (kind: WorkerRun['kind']): WorkerStatus => ({
    enabled: true, paused: false, running: null, maxParallel: 1, nextWakeAt: null, runsLastHour: 0, maxRunsPerHour: 10,
    runningAll: [{ kind, taskId: 'other', runId: `r-${kind}`, title: 'other' }],
  });
  const ready = task('t1', 'ready', { origin: 'user' });
  const failed = task('Broken build', 'failed', { origin: 'user', completed_at: Date.now() - 1000 });
  try {
    for (const [kind, title] of [['scout', en['ui.task.toast.started']], ['task', en['ui.task.toast.runNext']]] as const) {
      toasts.length = 0;
      serve({ active: [] }, null, (path, method) => (path === '/api/tasks/t1' && method === 'GET' ? { task: ready, events: [], runs: [] } : undefined));
      const screen = await render(createElement(TaskScreen, { id: 't1', revision: '0', worker: worker(kind), projects: [project()], pending: 0 }));
      await settle();
      await click(byText(screen.container, 'button', en['ui.task.runNow']));
      await settle();
      assert.deepEqual(toasts, [title], `task screen, other run: ${kind}`);
      await cleanup();

      toasts.length = 0;
      localStorage.clear();
      serve({ active: [], finished: [failed] }, null);
      const home = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: worker(kind) as never, revision: 0 }));
      await settle();
      await click(byText(home.container, 'button', en['ui.task.retry']));
      await settle();
      assert.deepEqual(toasts, [title], `product home retry, other run: ${kind}`);
      await cleanup();
    }
  } finally { stop(); }
});

test('ui/KanbanPane and ProductHome（DOM）: before the first load finishes, the board area says Loading… (it used to be blank), and the cards replace it once they come (backlog 7-9)', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  serve({ active: [task('Resume interrupted uploads', 'inbox', { proposal: PROPOSAL })] }, null);
  const served = globalThis.fetch;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    if (String(path).startsWith('/api/tasks')) await gate;
    return served(path, init);
  }) as typeof fetch;
  const { container } = await pane();
  await settle();
  assert.equal(container.querySelector('[data-loading]')?.textContent, en['ui.set.loading'], 'the pane says Loading');
  assert.equal(container.querySelector('.bt-col'), null, 'no empty columns while loading');
  const home = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  const homeLoading = home.container.querySelector('[data-loading]');
  assert.equal(homeLoading?.textContent, en['ui.set.loading'], 'the product home says Loading where the board goes');
  assert.ok(homeLoading?.classList.contains('ui-home__board'), 'it takes the place of the board in the narrow order');
  release();
  await settle();
  assert.equal(container.querySelector('[data-loading]'), null);
  assert.ok(byText(column(container, 'proposed'), '.bt-card__title', 'Resume interrupted uploads'));
  assert.equal(home.container.querySelector('[data-loading]'), null);
});

test('ui/KanbanPane and ProductHome（DOM）: when the first load fails, the failure notice shows and Loading… does not stay (backlog 7-9 review)', async () => {
  serve({ active: [] }, null);
  const served = globalThis.fetch;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    if (String(path).startsWith('/api/tasks')) return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    return served(path, init);
  }) as typeof fetch;
  const { container } = await pane();
  await settle();
  assert.ok(container.textContent!.includes(en['ui.kanban.loadFailed']), 'the failure notice');
  assert.equal(container.querySelector('[data-loading]'), null, 'no Loading… next to the failure');
  const home = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  assert.ok(home.container.textContent!.includes(en['ui.kanban.loadFailed']));
  assert.equal(home.container.querySelector('[data-loading]'), null);
});

test('walk-1118 D6: a rejected proposal leaves the board (Design: Reject removes the card; Undo is the toast), so it is in no column and not counted as Failed on the board or the product home; a task the owner cancelled and a failed task stay in Failed', async () => {
  const at = Date.now() - 30_000;
  const ended = { completed_at: at, updated_at: at, result_summary: 'Cancelled from the screen' };
  const finished = [
    task('Rejected idea', 'cancelled', { ...ended, cancelled_from: 'inbox', proposal: PROPOSAL, reject_reason: 'Not now, the shop has no users yet' }),
    task('Rejected without reason', 'cancelled', { ...ended, cancelled_from: 'inbox', reject_reason: null }),
    task('Stopped task', 'cancelled', { ...ended, cancelled_from: 'ready' }),
    task('Broken task', 'failed', { completed_at: at, updated_at: at, result_summary: 'The page did not answer.' }),
  ];
  serve({ active: [], finished }, null);
  const { container } = await pane();
  await settle();
  const titles = (el: Element) => [...el.querySelectorAll('article.bt-card .bt-card__title')].map(n => n.textContent).sort();
  assert.deepEqual(titles(column(container, 'failed')), ['Broken task', 'Stopped task']);
  assert.equal(container.textContent?.includes('Rejected idea'), false, 'no column shows a rejected proposal');
  assert.equal(container.textContent?.includes('Rejected without reason'), false);
  await cleanup();
  serve({ active: [], finished }, null);
  const home = await render(createElement(ProductHome, { id: PRODUCT, project: project(), conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 }));
  await settle();
  const failed = home.container.querySelector('.ui-home__board [data-col=failed]')!;
  assert.equal(failed.querySelector('.bt-count__n')?.textContent, '2', 'the product home counts only the stopped and the failed task');
  assert.equal(home.container.textContent?.includes('Rejected idea'), false);
});
