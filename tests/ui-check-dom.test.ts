import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, AcceptanceItem, Deviations, Project, Task, TaskEvent } from '../web/src/api.ts';

// beat 5-3c-u: 持ち主の確かめ待ち（Kanban の Awaiting check・タスクの画面の項目ごとの確かめ・Plan の欄の状態と「Differs from the plan」）。

interface KanbanProps {
  conversations: never[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>;
}
interface TaskProps { id: string; revision: string; worker: null; projects: readonly Project[]; pending: number }
interface PlanProps { productId: string; revision: string; isGit: boolean }

const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);
const { TaskScreen } = await loadTsx<{ TaskScreen: ComponentType<TaskProps> }>('../web/src/ui/screens/Task.tsx', import.meta.url);
const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const project = { id: PRODUCT, name: 'Parser' } as Project;
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown };
const realMedia = g.matchMedia;

interface Sent { method: string; path: string; body: unknown }
class Refused { status: number; body: unknown; constructor(status: number, body: unknown) { this.status = status; this.body = body; } }
let sent: Sent[] = [];

function serve(routes: (path: string, method: string) => unknown): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null;
    if (method !== 'GET') sent.push({ method, path: String(path), body });
    const out = routes(String(path), method);
    if (out instanceof Refused) return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const narrow = (on: boolean) => { g.matchMedia = () => ({ matches: on, addEventListener: () => {}, removeEventListener: () => {} }); };
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = realMedia;
  sent = [];
  window.location.hash = '';
});

function task(extra: Partial<Task>): Task {
  return {
    id: 't1', title: 'Ship the parser', body: '', next_action: null, done_criteria: null, status: 'done', origin: 'user', priority: 2,
    cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3,
    created_at: 1, updated_at: 2, completed_at: 2, project_id: PRODUCT, ...extra,
  };
}

const item = (id: string, extra: Partial<AcceptanceItem>): AcceptanceItem => ({
  id, result: `result ${id}`, source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null, ...extra,
});

const ITEMS = [
  item('A-1', { state: 'met', check: { kind: 'command', command: 'npm test' }, evidence: [{ tool: 'shell_run', command: 'npm test', ok: true, at: 1 }] }),
  item('A-2', { result: 'The parser reads empty files', state: 'unverified', evidence: [{ tag: 'E-3', tool: 'shell_run', input: '{"command":"node parse.js empty.txt"}', ok: true, at: 1 }] }),
  item('A-3', { result: 'The output looks right', state: 'open', check: { kind: 'command', command: 'npm run lint' }, evidence: [{ tool: 'shell_run', command: 'npm run lint', ok: false, output: 'lint: 2 errors', at: 1 }] }),
];

const acceptance = (items = ITEMS): Acceptance => ({
  version: 3, language: 'en', items, not_doing: [], draft: false, hash: 'h3',
  frozen: { version: 3, hash: 'h3', plan_hash: 'p1', created_at: 1, source: 'build', build_task_id: 'b1' },
});

const awaiting = (extra: Partial<Task> = {}) => task({ check_state: 'awaiting', items: { owned: 3, met: 1, remaining: ['A-2', 'A-3'] }, ...extra });

test('ui/Kanban（DOM）: 確かめ待ちのタスクは Awaiting check の列に「Task · check it」で出る。残った項目と証拠の写し・済の数・Open を持ち、Mark checked で版つきの /check を送り Done へ移る', async () => {
  narrow(false);
  let checked = false;
  serve((path, method) => {
    if (path === `/api/tasks/t1/check` && method === 'POST') { checked = true; return { task: task({ check_state: 'checked' }) }; }
    const now = checked ? task({ check_state: 'checked' }) : awaiting();
    if (path === '/api/tasks') return { active: [], finished: [now] };
    if (path === '/api/tasks/finished?limit=20') return { tasks: [now], next: null, total: 1 };
    if (path === '/api/runs?limit=500') return { runs: [], total: 0, judged: {} };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance() };
    return undefined;
  });
  const { container } = await render(createElement(Kanban, { conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map() }));
  await settle();
  const column = container.querySelector('#ui-col-check')!;
  assert.equal(column.querySelector('.bt-col__head .bt-label')?.textContent, 'Awaiting check');
  assert.ok(column.querySelector('.bt-col__head .bt-count:not(.bt-count--quiet)'), 'Awaiting check の数は Proposed と同じく光る');
  const card = column.querySelector('.bt-card')!;
  assert.ok(card, '確かめ待ちのカードが Awaiting check にある');
  assert.equal(container.querySelector('#ui-col-done .bt-card'), null, 'Done には出ない');
  assert.ok(byText(card, '.bt-label', 'Task · check it'));
  assert.ok(card.querySelector('.bt-dot'), '持ち主を待つカードは点が打つ');
  assert.deepEqual([...card.querySelectorAll('[data-item]')].map(li => li.getAttribute('data-item')), ['A-2', 'A-3'], '残った項目だけ（済の A-1 は出さない）');
  assert.match(card.querySelector('[data-item="A-2"]')!.textContent!, /The parser reads empty files.*E-3 · shell_run/u, '項目の文と証拠の写し');
  assert.match(card.querySelector('[data-item="A-3"]')!.textContent!, /npm run lint · failed/u);
  assert.ok(byText(card, '.bt-card__meta span', '1 of 3 met'));
  assert.equal(byText(card, 'a', 'Open')?.getAttribute('href'), '#/tasks/t1');
  await click(byText(card, 'button', 'Mark checked'));
  await settle();
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/tasks/t1/check', body: { version: 3 } }], '/check は版を持つ');
  assert.equal(container.querySelector('#ui-col-check .bt-card'), null, '残りが無くなったカードは Awaiting check から消える');
  assert.ok(container.querySelector('#ui-col-done .bt-card'), 'Done へ移る');
});

test('ui/Kanban（DOM）: 狭い幅の列のタブは Proposed・Awaiting check・In progress・Approved・Done の順（待つものが先）', async () => {
  narrow(true);
  serve(path => {
    if (path === '/api/tasks') return { active: [], finished: [] };
    if (path === '/api/tasks/finished?limit=20') return { tasks: [], next: null, total: 0 };
    if (path === '/api/runs?limit=500') return { runs: [], total: 0, judged: {} };
    return undefined;
  });
  const { container } = await render(createElement(Kanban, { conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map() }));
  await settle();
  const tabs = [...container.querySelectorAll('.ui-coltabs .bt-tab')].map(tab => tab.firstChild?.textContent);
  assert.deepEqual(tabs, ['Proposed', 'Awaiting check', 'In progress', 'Approved', 'Done', 'Failed']);
});

const event = (id: number, kind: string, content: string | null): TaskEvent => ({ id, kind, actor: kind === 'owner_check' ? 'user' : 'beat', content, run_id: null, created_at: id });

async function renderTask(t: Task, events: TaskEvent[] = [], after?: () => Task) {
  serve((path, method) => {
    if (path === '/api/tasks/t1') return { task: after ? after() : t, events, runs: [] };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance() };
    if (method === 'POST' && path.startsWith('/api/tasks/t1/items/')) {
      const body = sent.at(-1)!.body as { result: string };
      return body.result === 'insufficient' ? { task: t, fix: task({ id: 'fix1', title: 'Fix A-3', status: 'ready', check_state: null }) } : { task: t };
    }
    return undefined;
  });
  const rendered = await render(createElement(TaskScreen, { id: 't1', revision: '0', worker: null, projects: [project], pending: 0 }));
  await settle();
  return rendered.container;
}

test('ui/Task（DOM）: 確かめ待ちのタスクの画面に、残った項目ごとの状態・証拠・Checked / Not enough。Checked は版つきで項目の口へ、Not enough はメモつきで送り、項目は残る', async () => {
  const container = await renderTask(awaiting());
  assert.ok(byText(container, '.ui-task__state .bt-pill', 'Awaiting check'), '状態の札は Awaiting check');
  const section = container.querySelector('section[aria-label="Awaiting check"]')!;
  assert.ok(section, '確かめ待ちの節がある');
  assert.ok(byText(section, '.bt-meta', '1 of 3 met'));
  const a2 = section.querySelector('[data-item="A-2"]')!;
  const a3 = section.querySelector('[data-item="A-3"]')!;
  assert.equal(section.querySelector('[data-item="A-1"]'), null, '済の項目は出さない');
  assert.ok(byText(a2, '.bt-pill', 'Unverified'));
  assert.ok(byText(a3, '.bt-pill', 'Open'));
  assert.ok(byText(a3, 'pre', 'lint: 2 errors'), '失敗したコマンドの出力の末尾');
  await click(byText(a2, 'button', 'Checked'));
  await settle();
  assert.deepEqual(sent.at(-1), { method: 'POST', path: '/api/tasks/t1/items/A-2/check', body: { result: 'checked', version: 3 } });
  await click(byText(a3, 'button', 'Not enough'));
  const note = a3.querySelector('input');
  assert.ok(note, 'Not enough でメモの欄が開く');
  await input(note, 'The lint errors are still there');
  await click(byText(a3, 'button', 'Make a fix task'));
  await settle();
  assert.deepEqual(sent.at(-1), { method: 'POST', path: '/api/tasks/t1/items/A-3/check', body: { result: 'insufficient', version: 3, note: 'The lint errors are still there' } });
  assert.ok(container.querySelector('[data-item="A-3"]'), '「まだ足りない」のあとも項目とタスクは確かめ待ちに残る');
});

test('ui/Task（DOM）: Mark checked は残り全部を版つきの /check で送る。確かめが済んだタスクには確かめ待ちの節を出さない', async () => {
  let done = false;
  const container = await renderTask(awaiting(), [], () => (done ? task({ check_state: 'checked' }) : awaiting()));
  const section = container.querySelector('section[aria-label="Awaiting check"]')!;
  done = true;
  await click(byText(section, 'button', 'Mark checked'));
  await settle();
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/tasks/t1/check', body: { version: 3 } }]);
  assert.equal(container.querySelector('section[aria-label="Awaiting check"]'), null);
  assert.ok(byText(container, '.ui-task__state .bt-pill', 'Done'));
});

test('ui/Task（DOM）: 一覧のファイルが外で変えられた知らせ（#/tasks/<id>）の行き先に、その印と経過の名前を出す。持ち主の確かめは読める文で出す', async () => {
  const events = [
    event(4, 'owner_check', JSON.stringify({ item: 'A-3', result: 'insufficient', note: 'still broken', fix: 'fix1' })),
    event(3, 'gate_list_changed', 'acceptance.json did not match the fixed version 3 at task_complete (changed outside beat)'),
    event(2, 'gate_passed', null),
  ];
  const container = await renderTask(task({ status: 'running' }), events);
  assert.match(container.querySelector('.bt-notice--warn .ui-notice__text')?.textContent ?? '', /^acceptance.json was changed outside beat · beat does not accept this task as done/u, '変えられた印');
  const names = [...container.querySelectorAll('.ui-event .bt-row__title')].map(el => el.firstChild?.textContent);
  assert.deepEqual(names, ['Your check', 'List changed outside beat', 'Completion accepted']);
  assert.ok(byText(container, '.ui-event__text', 'A-3 · Not enough · still broken'), 'JSON のままではなく読める文');
});

test('ui/Task（DOM）: 一覧の変更のあとに完了が受け付けられていれば、変えられた印は出さない', async () => {
  const container = await renderTask(task({}), [event(3, 'gate_passed', null), event(2, 'gate_list_changed', 'x')]);
  assert.equal(container.textContent!.includes('acceptance.json was changed outside beat'), false);
});

test('ui/PlanPane（DOM）: 項目ごとに Met / Open / Unverified、計画と違った所（Differs from the plan）と差分の印。Build からの差分を見ていないときはそう書く', async () => {
  const deviations: Deviations = {
    deviations: { rows: [{ item: 'A-2', what: 'Empty files return an empty list', why: 'The format has no header', task: 't1', date: '2026-11-15', by: 'task', external: false }], unreadable: 0, unusable: false },
    flags: { checked: true, since: 'head', testsDeleted: ['tests/parse.test.ts'], testsDeletedMore: 0, checkChanged: [{ path: 'package.json', change: 'modified', scripts: ['test'] }], checkChangedMore: 2 },
  };
  serve(path => {
    if (path === `/api/projects/${PRODUCT}/plan`) return { plan: { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false } };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance() };
    if (path === `/api/projects/${PRODUCT}/deviations`) return deviations;
    if (path === `/api/projects/${PRODUCT}/acceptance/versions`) return { versions: [] };
    return undefined;
  });
  const { container } = await render(createElement(PlanPane, { productId: PRODUCT, revision: '0', isGit: true }));
  await settle();
  await settle();
  const list = container.querySelector('section[aria-label="Acceptance"]')!;
  const pills = [...list.querySelectorAll('.ui-acc__row .bt-row__end .bt-pill')].map(p => p.textContent);
  assert.deepEqual(pills, ['Met', 'Unverified', 'Open']);
  const rows = [...list.querySelectorAll('.ui-acc__row')];
  assert.ok(rows[1]!.querySelector('[data-differs]'), 'ずれの記録がある項目に Differs の印');
  assert.equal(rows[0]!.querySelector('[data-differs]'), null);
  const differs = container.querySelector('section[aria-label="Differs from the plan"]')!;
  assert.ok(differs, 'Differs from the plan の節');
  assert.ok(byText(differs, '.ui-acc__text', 'Empty files return an empty list'));
  assert.ok(byText(differs, '.bt-meta', 'why: The format has no header'));
  assert.equal(byText(differs, 'a', 'by a task')?.getAttribute('href'), '#/tasks/t1');
  assert.ok(byText(differs, '.bt-meta', 'Changes since the build were not compared; only uncommitted changes were'), 'since が head のとき、合格のように見せない');
  assert.ok(byText(differs, '.ui-acc__text', 'tests/parse.test.ts'));
  assert.ok(byText(differs, '.bt-meta', 'scripts: test'));
  assert.ok(byText(differs, '.bt-meta', '2 more'), 'checkChangedMore の数');
  await click(rows[1]!.querySelector('button.ui-acc__text'));
  assert.ok(byText(rows[1]!, 'dd', 'E-3 · shell_run · {"command":"node parse.js empty.txt"}'), '開くと証拠の写し');
});

const { countChecks, kanbanCount } = await import('../web/src/ui/agent-state.ts');
const { mergeTasks } = await import('../web/src/ui/live-state.ts');
const ACTIVE: ReadonlySet<string> = new Set([PRODUCT]);

test('ui/agent-state: Kanban の数は Proposed と Awaiting check（確かめ待ちの終わったタスク）を数える。確かめが済めば数えない', () => {
  const marks = mergeTasks(new Map(), [awaiting({ id: 'a' }), task({ id: 'b', check_state: 'checked' }), task({ id: 'c' })]);
  assert.equal(marks.get('a')?.checkState, 'awaiting', '一覧の行の check_state を覚える');
  assert.equal(countChecks(marks.values(), ACTIVE), 1);
  assert.equal(kanbanCount({ proposals: 2, answers: 0, checks: countChecks(marks.values(), ACTIVE) }), 3);
  assert.equal(countChecks(marks.values(), new Set(['other-product'])), 0, 'しまった製品（いまの製品の一覧に無い）の確かめ待ちは数えない');
  assert.equal(countChecks(mergeTasks(new Map(), [awaiting({ id: 'n', project_id: null })]).values(), new Set()), 1, '製品の無いタスクは数える');
});

const { agentState, footLine, waitingTotal } = await import('../web/src/ui/agent-state.ts');
const { EMPTY, reduce } = await import('../web/src/ui/live-state.ts');
const { subscribe } = await import('../web/src/feedback.ts');

test('ui/agent-state: 確かめ待ちは「待ち」の合計に入り、ほかに待ちが無くても姿は waiting、下の一言は待ちの数（Design の Avatar・KanbanPane「Waits for the owner? Yes」）', () => {
  const w = { proposals: 0, answers: 0, drafts: 0, pending: 0, questions: 0, checks: 1 };
  assert.equal(waitingTotal(w), 1);
  assert.equal(agentState(w, false), 'waiting');
  assert.deepEqual(footLine(w, false, [], null), { kind: 'waiting', n: 1 });
});

test('ui/live-state: task.changed の check_state を覚え、確かめが済めば checked に変わる（数が減る）', () => {
  const first = reduce(EMPTY, { type: 'event', event: { type: 'task.changed', task: awaiting({ updated_at: 5 }) }, hidden: false, now: 1 }).state;
  assert.equal(first.tasks.get('t1')?.checkState, 'awaiting');
  assert.equal(countChecks(first.tasks.values(), ACTIVE), 1);
  assert.equal(countChecks(first.tasks.values(), new Set()), 0, 'task.changed でも製品を覚え、しまった製品のものは数えない');
  const next = reduce(first, { type: 'event', event: { type: 'task.changed', task: task({ check_state: 'checked', updated_at: 6 }) }, hidden: false, now: 2 }).state;
  assert.equal(next.tasks.get('t1')?.checkState, 'checked');
  assert.equal(countChecks(next.tasks.values(), ACTIVE), 0);
});

test('ui/Kanban（DOM）: 終わったタスクの新しい 50 件にもめくった分にも無い確かめ待ちも、/api/tasks の awaiting から Awaiting check に出る', async () => {
  narrow(false);
  serve(path => {
    if (path === '/api/tasks') return { active: [], finished: [], awaiting: [awaiting({ completed_at: 1, updated_at: 1 })] };
    if (path === '/api/tasks/finished?limit=20') return { tasks: Array.from({ length: 20 }, (_, i) => task({ id: `d${i}`, completed_at: 100 + i, updated_at: 100 + i })), next: null, total: 80 };
    if (path === '/api/runs?limit=500') return { runs: [], total: 0, judged: {} };
    if (path === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: acceptance() };
    return undefined;
  });
  const { container } = await render(createElement(Kanban, { conversations: [], drafts: [], checklists: new Map(), revision: 0, projects: [project], pendingByTask: new Map(), questionsByTask: new Map() }));
  await settle();
  const card = container.querySelector('#ui-col-check .bt-card');
  assert.ok(card, '確かめ待ちのカードが出る');
  assert.ok(byText(card, 'button', 'Mark checked'));
});

test('ui/Task（DOM）: 古い版で 409 が返ると「表示のあとで変わった」と出し、一覧を読み直して次は新しい版で送る。送れなかったメモは消さない', async () => {
  let version = 3;
  let reads = 0;
  const toasts: string[] = [];
  const stop = subscribe(item => { toasts.push(item.title); });
  serve((path, method) => {
    if (path === '/api/tasks/t1') return { task: awaiting(), events: [], runs: [] };
    if (path === `/api/projects/${PRODUCT}/acceptance`) { reads += 1; return { acceptance: { ...acceptance(), version } }; }
    if (method === 'POST' && path === '/api/tasks/t1/items/A-3/check') {
      if ((sent.at(-1)!.body as { version: number }).version !== version) return new Refused(409, { error: 'conflict', message: 'stale' });
      return { task: awaiting(), fix: task({ id: 'fix1', title: 'Fix A-3', status: 'ready', check_state: null }) };
    }
    return undefined;
  });
  try {
    const { container } = await render(createElement(TaskScreen, { id: 't1', revision: '0', worker: null, projects: [project], pending: 0 }));
    await settle();
    const before = reads;
    version = 4;
    const a3 = () => container.querySelector('[data-item="A-3"]')!;
    await click(byText(a3(), 'button', 'Not enough'));
    await input(a3().querySelector('input')!, 'Still red');
    await click(byText(a3(), 'button', 'Make a fix task'));
    await settle();
    assert.equal((sent.at(-1)!.body as { version: number }).version, 3);
    assert.ok(toasts.includes('This changed since it was shown. Look again.'), toasts.join(' | '));
    assert.ok(reads > before, '一覧を読み直す');
    assert.equal(a3().querySelector('input')?.value, 'Still red', '送れなかったメモは残る');
    await click(byText(a3(), 'button', 'Make a fix task'));
    await settle();
    assert.deepEqual(sent.at(-1)!.body, { result: 'insufficient', version: 4, note: 'Still red' }, '読み直した版で送る');
    assert.equal(a3().querySelector('input'), null, '送れたらメモの欄を閉じる');
  } finally { stop(); }
});

for (const kind of ['gate_refused', 'gate_closed', 'item_check_failed']) {
  test(`ui/Task（DOM）: 一覧の変更のあとに ${kind} があれば、ファイルは元に戻っているので変えられた印は出さない`, async () => {
    const container = await renderTask(task({ status: 'running' }), [event(3, kind, 'x'), event(2, 'gate_list_changed', 'x')]);
    assert.equal(container.textContent!.includes('acceptance.json was changed outside beat'), false);
  });
}

test('ui/Task（DOM）: gate_list_notified は印を消さない（知らせただけ）', async () => {
  const container = await renderTask(task({ status: 'running' }), [event(3, 'gate_list_notified', null), event(2, 'gate_list_changed', 'x')]);
  assert.equal(container.textContent!.includes('acceptance.json was changed outside beat'), true);
});
