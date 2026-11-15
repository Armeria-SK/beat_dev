import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ChecklistItem, Conversation, PendingCounts, Project, QuestionCounts, Task, WorkerStatus } from '../web/src/api.ts';
import type { Waiting } from '../web/src/ui/agent-state.ts';
import type { LiveDraft } from '../web/src/ui/live-state.ts';

interface OverviewProps {
  waiting: Waiting; conversations: Conversation[]; drafts: LiveDraft[]; checklists: ReadonlyMap<string, ChecklistItem[]>; worker: WorkerStatus | null; onWorker: (status: WorkerStatus) => void;
  revision: number; projects: Project[]; projectsLoaded: boolean; questionCounts: QuestionCounts | null; pendingCounts: PendingCounts | null;
}

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const scope = globalThis as unknown as Record<string, unknown>;
scope.addEventListener ??= window.addEventListener.bind(window);
scope.removeEventListener ??= window.removeEventListener.bind(window);

const { Overview } = await loadTsx<{ Overview: ComponentType<OverviewProps> }>('../web/src/ui/screens/Overview.tsx', import.meta.url);

const realFetch = globalThis.fetch;
const realInterval = globalThis.setInterval;
afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  globalThis.setInterval = realInterval;
  localStorage.clear();
});

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

const worker = (runs: WorkerStatus['runningAll']): WorkerStatus => ({
  enabled: true, autonomy: false, paused: false, quiet: false, running: runs[0] ?? null, runningAll: runs, maxParallel: 1, nextWakeAt: null, runsLastHour: 0, maxRunsPerHour: 10,
});

interface Server { active: Task[]; awaiting?: Task[]; finished: (url: URL) => { tasks: Task[]; next: { beforeT: number; beforeId: string } | null; total: number }; hold?: Promise<void> }

const limits: string[] = [];

function serve(server: Server): string[] {
  const seen: string[] = [];
  limits.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://localhost/');
    seen.push(url.pathname);
    if (url.pathname === '/api/tasks/finished') limits.push(url.searchParams.get('limit') ?? '');
    if (server.hold) await server.hold;
    const body = url.pathname === '/api/tasks' ? { active: server.active, finished: [], awaiting: server.awaiting ?? [] }
      : url.pathname === '/api/tasks/finished' ? server.finished(url)
      : url.pathname === '/api/runs' ? { runs: [], total: 0, judged: {} }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return seen;
}

const noFinished = () => ({ tasks: [], next: null, total: 0 });

test('Overview（DOM）: 小さな盤の Awaiting check は /api/tasks の awaiting から数える（終わったタスクの新しい分に無くても）。数は Proposed と違って静か（Design の AllProducts）', async () => {
  serve({ active: [task('p-1', 'inbox')], awaiting: [task('a-old', 'done', { check_state: 'awaiting', completed_at: 1, updated_at: 1 })], finished: noFinished });
  const { container } = await render(createElement(Overview, props({})));
  await settle();
  const check = container.querySelector('[data-col="check"] .bt-count');
  assert.equal(check?.textContent, '1');
  assert.ok(check?.classList.contains('bt-count--quiet'), 'Awaiting check の数は静か');
  assert.equal(container.querySelector('[data-col="proposed"] .bt-count')?.classList.contains('bt-count--quiet'), false, 'Proposed だけ光る');
});

function props(over: Partial<OverviewProps>): OverviewProps {
  return {
    waiting: { proposals: 0, answers: 0, drafts: 0, pending: 0, questions: 0, checks: 0 }, conversations: [], drafts: [], checklists: new Map(), worker: null, onWorker: () => undefined,
    revision: 0, projects: [], projectsLoaded: true, questionCounts: null, pendingCounts: null, ...over,
  };
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 20)));

test('Overview（DOM）: 読み込みが終わる前は、タスクの実行を「No product」に出さない。しまった製品の動くタスクは「No product」に Stop つきで出る（backlog 303）', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const goneFailed = task('f-gone', 'failed', { project_id: 'gone11', title: 'Gone failure', completed_at: Date.now() - 1000, updated_at: Date.now() - 1000 });
  serve({ active: [task('t-mine', 'running', { project_id: 'p1aaaa' }), task('t-gone', 'running', { project_id: 'gone11' })], finished: () => ({ tasks: [goneFailed], next: null, total: 1 }), hold });
  const runs = worker([{ kind: 'task', taskId: 't-mine', runId: 'r1', title: 'Mine run' }, { kind: 'task', taskId: 't-gone', runId: 'r2', title: 'Gone run' }]);
  const { container } = await render(createElement(Overview, props({ worker: runs, projects: [project('p1aaaa')] })));
  await settle();
  assert.equal(container.querySelector('[data-product="none"]'), null, '読み込み中は No product の節が無い');
  assert.equal(container.textContent?.includes('Mine run'), false);
  release();
  await settle();
  assert.match(container.querySelector('[data-product="p1aaaa"]')?.textContent ?? '', /Mine run/u);
  const none = container.querySelector('[data-product="none"]');
  assert.match(none?.textContent ?? '', /Gone run/u);
  assert.ok([...(none?.querySelectorAll('button') ?? [])].some(b => b.textContent === 'Stop'));
  assert.equal(none?.querySelector('[data-archived]')?.textContent, 'archived product', 'しまった製品の動くものには印をつける');
  assert.equal(container.querySelector('[data-product="p1aaaa"] [data-archived]'), null);
  assert.equal([...container.querySelectorAll('.ui-home__products')].some(el => el.textContent?.includes('Gone failure')), false, 'しまった製品の失敗は Retry ごと出さない');
  assert.equal([...(none?.querySelectorAll('button') ?? [])].some(b => b.textContent === 'Retry'), false);
  assert.equal(none?.textContent?.includes('finished since'), false, 'しまった製品の終わった数は数えない');
});

test('Overview（DOM）: 製品の一覧を読み終える前（読めないままのときも）は、製品の動くもの・会話・失敗・終わった数を「No product」に出さない（B12 の審査）', async () => {
  const failedMine = task('f-mine', 'failed', { project_id: 'p1aaaa', title: 'Mine failure', completed_at: Date.now() - 1000, updated_at: Date.now() - 1000 });
  const doneMine = task('d-mine', 'done', { project_id: 'p1aaaa', title: 'Mine done', completed_at: Date.now() - 2000, updated_at: Date.now() - 2000 });
  serve({ active: [task('t-mine', 'running', { project_id: 'p1aaaa' })], finished: () => ({ tasks: [failedMine, doneMine], next: null, total: 2 }) });
  const { container } = await render(createElement(Overview, props({
    projects: [], projectsLoaded: false, worker: worker([{ kind: 'task', taskId: 't-mine', runId: 'r1', title: 'Mine run' }]),
    conversations: [{ id: 'c1', title: 'Mine chat', project_id: 'p1aaaa' } as OverviewProps['conversations'][number]],
    drafts: [{ runId: 'r9', conversationId: 'c1', startedAt: Date.now() - 5000 } as OverviewProps['drafts'][number]],
  })));
  await settle();
  assert.ok(container.querySelector('[data-col]'), '読み込みは終わっている');
  assert.equal(container.querySelector('[data-product="none"]'), null);
  for (const text of ['Mine run', 'Mine chat', 'Mine failure', 'finished since']) assert.equal([...container.querySelectorAll('.ui-home__products')].some(el => el.textContent?.includes(text)), false, text);
});

test('Overview（DOM）: 止めている最中の Stop の 2 度押しは、止める口へ 1 回だけ送る', async () => {
  serve({ active: [task('t-mine', 'running', { project_id: 'p1aaaa' })], finished: noFinished });
  const answer = globalThis.fetch;
  const stops: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => (init?.method === 'POST' ? (stops.push(String(input)), new Promise<never>(() => undefined)) : answer(input, init))) as typeof fetch;
  const { container } = await render(createElement(Overview, props({ worker: worker([{ kind: 'task', taskId: 't-mine', runId: 'r1', title: 'Mine run' }]), projects: [project('p1aaaa')] })));
  await settle();
  const stop = byText(container.querySelector('[data-product="p1aaaa"]')!, 'button', 'Stop');
  await click(stop);
  await click(stop);
  await settle();
  assert.deepEqual(stops, ['/api/runs/r1/stop']);
});

test('Overview（DOM）: 製品が 5 つ以上の一覧の形でも、動いている製品の行が光る（backlog 306）', async () => {
  serve({ active: [task('t3', 'running', { project_id: 'p3aaaa' })], finished: noFinished });
  const projects = ['p1aaaa', 'p2aaaa', 'p3aaaa', 'p4aaaa', 'p5aaaa'].map((id, i) => project(id, { created_at: i }));
  const { container } = await render(createElement(Overview, props({ worker: worker([{ kind: 'task', taskId: 't3', runId: 'r3', title: 'Third' }]), projects })));
  await settle();
  const rows = [...container.querySelectorAll('.ui-home__products li[data-product]')];
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.filter(row => row.classList.contains('bt-sheen')).map(row => row.getAttribute('data-product')), ['p3aaaa']);
});

test('Overview（DOM）: 「No product N」は製品の無い問いだけ。しまった製品の問いは入れない（backlog 301）', async () => {
  serve({ active: [], finished: noFinished });
  const questionCounts: QuestionCounts = { open: 4, byProject: { p1aaaa: 1, gone11: 2 }, byTask: {}, answered: 0, changed: 0 };
  const { container } = await render(createElement(Overview, props({
    waiting: { proposals: 0, answers: 0, drafts: 0, pending: 0, questions: 4, checks: 0 }, questionCounts, projects: [project('p1aaaa', { waiting: { proposals: 0, questions: 1, pending: 0 } })],
  })));
  await settle();
  assert.equal(container.querySelector('[data-tile="questions"] .bt-meta')?.textContent, 'p1aaaa 1 · No product 1');
});

test('Overview（DOM）: 行の増えないページが続いても読み足しは止まり、終わったものが 0 の製品に「0+ finished」と出さない（backlog 341）', async () => {
  const stamp = Date.now();
  const done = (from: number, n: number) => Array.from({ length: n }, (_, i) => task(`d${from + i}`, 'done', { completed_at: stamp - from - i, updated_at: stamp - from - i }));
  let calls = 0;
  const seen = serve({
    active: [],
    finished: url => {
      calls += 1;
      if (calls > 10) throw new Error('paging never stops');
      const before = url.searchParams.get('beforeId');
      return before === null ? { tasks: done(0, 20), next: { beforeT: 1, beforeId: 'a' }, total: 500 }
        : before === 'a' ? { tasks: done(20, 100), next: { beforeT: 1, beforeId: 'b' }, total: 500 }
        : { tasks: done(20, 100), next: { beforeT: 1, beforeId: 'b' }, total: 500 };
    },
  });
  const { container } = await render(createElement(Overview, props({ projects: [project('p1aaaa')] })));
  await settle();
  assert.equal(seen.filter(path => path === '/api/tasks/finished').length, 3, '行が増えないページで止まる');
  assert.deepEqual(limits, ['20', '100', '100'], '最初は Kanban の 1 ページ、そのあとは 100 件ずつ');
  const section = container.querySelector('[data-product="p1aaaa"]');
  assert.ok(section);
  assert.equal(section.textContent?.includes('0+'), false);
  assert.match(container.querySelector('[data-product="none"]')?.textContent ?? '', /120\+ finished since/u);
  const column = container.querySelector('[data-col="done"] .bt-count__n')?.textContent;
  assert.equal(column, '20', '小さな盤は Kanban の最初のページと同じ数');
});

test('Overview（DOM）: タスクだけが動いているときは毎秒の時計を回さない。始まった時刻のある会話が動くと回す（backlog 304）', async () => {
  const delays: number[] = [];
  globalThis.setInterval = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return realInterval(fn, ms); }) as typeof setInterval;
  serve({ active: [task('t1', 'running', { project_id: 'p1aaaa' })], finished: noFinished });
  const runs = worker([{ kind: 'task', taskId: 't1', runId: 'r1', title: 'Run' }]);
  const { root } = await render(createElement(Overview, props({ worker: runs, projects: [project('p1aaaa')] })));
  await settle();
  assert.equal(delays.includes(1000), false);
  await update(() => root.render(createElement(Overview, props({
    worker: runs, projects: [project('p1aaaa')], conversations: [{ id: 'c1', title: 'Chat', project_id: 'p1aaaa' } as OverviewProps['conversations'][number]],
    drafts: [{ runId: 'r9', conversationId: 'c1', startedAt: Date.now() - 5000 } as OverviewProps['drafts'][number]],
  }))));
  await settle();
  assert.equal(delays.includes(1000), true);
});

test('Overview（DOM）: 一覧の形（製品が 5 つ以上）では、製品の行に時間を出さないので、製品の会話が動いていても毎秒の時計を回さない（B12 の審査）', async () => {
  const delays: number[] = [];
  globalThis.setInterval = ((fn: () => void, ms?: number) => { delays.push(ms ?? 0); return realInterval(fn, ms); }) as typeof setInterval;
  serve({ active: [], finished: noFinished });
  const projects = ['p1aaaa', 'p2aaaa', 'p3aaaa', 'p4aaaa', 'p5aaaa'].map((id, i) => project(id, { created_at: i }));
  await render(createElement(Overview, props({
    projects, conversations: [{ id: 'c1', title: 'Chat', project_id: 'p1aaaa' } as OverviewProps['conversations'][number]],
    drafts: [{ runId: 'r9', conversationId: 'c1', startedAt: Date.now() - 5000 } as OverviewProps['drafts'][number]],
  })));
  await settle();
  assert.equal(delays.includes(1000), false);
});

test('Overview（DOM）: with Work on its own Off, a paused worker still shows the paused line and Resume (pause also holds the owner work)', async () => {
  serve({ active: [], finished: () => ({ tasks: [], next: null, total: 0 }) });
  const off: WorkerStatus = { ...worker([]), enabled: false, paused: true };
  const { container } = await render(createElement(Overview, props({ worker: off, projects: [project('p1aaaa')] })));
  await settle();
  assert.ok(container.querySelector('[data-worker="off"]'), 'the Off line is there');
  assert.ok(container.querySelector('button[data-worker="paused"]'), 'Resume is offered');
  assert.ok(container.textContent?.includes('Background work is paused'), container.textContent ?? '');
  assert.ok(container.querySelector('[data-worker-line]'), 'the runs-per-hour line shows, since the owner work counts toward it');
});
