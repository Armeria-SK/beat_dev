import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { ApiError, type Project, type RepeatingTask, type Task } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import { formatDateTime } from '../web/src/i18n/index.ts';
import { RELOAD_DELAY_MS, repeatingRow, splitSchedule } from '../web/src/ui/schedule.ts';

// backlog 308・309・315（Schedule）: 動いている回の見つけ方、Pause の Undo、しまわれた製品を送らない。

interface ScheduleProps { revision: number; projects: readonly Project[] }
const { Schedule } = await loadTsx<{ Schedule: ComponentType<ScheduleProps> }>('../web/src/ui/screens/Schedule.tsx', import.meta.url);

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});
const template = (id: string, status: Task['status'], extra: Partial<RepeatingTask> = {}): RepeatingTask =>
  ({ ...task(id, status, { cron: '0 9 * * *', cron_text: 'every day at 09:00', run_at: status === 'scheduled' ? Date.now() + 3_600_000 : null }), last_run: null, ...extra });
const project = (id: string, archived = false): Project => ({
  id, name: `Shop ${id}`, root: '/w/shop', check_command: null, scout_mode: 'off', remotes: [], archived_at: archived ? 5 : null, created_at: 1, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});

test('ui/schedule（308）: 古い回を開き直して動かしているあいだは、いちばん新しい回が終わっていても、ひな形は「動いている回あり」で Delete を押せない', () => {
  const newest = { id: 'new', status: 'done' as const, summary: null, at: 100 };
  const split = splitSchedule({
    repeating: [template('tpl', 'scheduled', { last_run: newest }), template('quiet', 'scheduled', { last_run: newest })],
    active: [task('old', 'running', { parent_id: 'tpl' }), task('other', 'running', { parent_id: 'someone-else' }), task('plain', 'running')],
  });
  const row = split.repeating.find(r => r.task.id === 'tpl')!;
  assert.deepEqual([row.runOpen, row.blocked, row.openRun?.id, row.openRun?.status], [true, 'run_open', 'old', 'running']);
  const quiet = split.repeating.find(r => r.task.id === 'quiet')!;
  assert.deepEqual([quiet.runOpen, quiet.blocked, quiet.openRun], [false, null, null], '別のひな形の回・ひな形でないタスクは数えない');
  const waiting = splitSchedule({ repeating: [template('tpl', 'scheduled', { last_run: newest })], active: [task('old', 'waiting', { parent_id: 'tpl' })] });
  assert.equal(waiting.repeating[0]!.blocked, 'run_open', '返事待ちの回も動いている回');
  const queued = splitSchedule({ repeating: [template('tpl', 'scheduled', { last_run: newest })], active: [task('q', 'ready', { parent_id: 'tpl', run_at: 5 })] });
  assert.equal(queued.repeating[0]!.blocked, null, '実行待ちの回はサーバーの Delete が断らない');
  const last = repeatingRow(template('tpl', 'scheduled', { last_run: { id: 'new', status: 'running', summary: null, at: 100 } }));
  assert.deepEqual([last.runOpen, last.openRun?.id], [true, 'new'], '一番新しい回が動いているときは今までどおり');
});

const realFetch = globalThis.fetch;
const calls: Array<{ path: string; method: string; body: unknown }> = [];
const seen: FeedbackItem[] = [];
let stopListening = (): void => undefined;

const ARCHIVED = { error: 'project', code: 'project.error.archived', message: 'This product is archived. Restore it first' };

function serve(data: () => { repeating: RepeatingTask[]; active: Task[] }): void {
  calls.length = 0;
  seen.length = 0;
  stopListening();
  stopListening = subscribe(item => { seen.push(item); });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    calls.push({ path: url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'GET' && url === '/api/tasks') { const now = data(); return reply(200, { active: now.active, finished: [], awaiting: [], repeating: now.repeating }); }
    if (url.startsWith('/api/schedule')) return reply(200, { from: 0, to: 1, slots: [], templates: [], ranTruncated: false });
    if (method === 'POST' && /^\/api\/tasks\/[^/]+\/(cancel|uncancel)$/u.test(url)) return reply(200, { task: task('x', 'cancelled') });
    if (method === 'POST' && url === '/api/tasks') {
      if ((calls.at(-1)!.body as { projectId?: string } | null)?.projectId === 'p1') return reply(400, ARCHIVED);
      return reply(201, { task: task('created', 'scheduled') });
    }
    return reply(404, { error: 'not_found' });
  }) as typeof fetch;
}
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const later = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const rowOf = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`li[data-task="${id}"]`)!;

afterEach(async () => {
  await cleanup();
  stopListening();
  stopListening = () => undefined;
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('ui/Schedule（DOM, 308）: 古い回が動いているあいだ、行に Cancel run が出て、その古い回を止める。Delete は押せない', async () => {
  serve(() => ({
    repeating: [template('tpl', 'scheduled', { last_run: { id: 'new', status: 'done', summary: null, at: 100 } })],
    active: [task('old', 'running', { parent_id: 'tpl' })],
  }));
  const { container } = await render(createElement(Schedule, { revision: 0, projects: [] }));
  await later(10);
  await settle();
  const row = rowOf(container, 'tpl');
  const cancelRun = byText(row, 'button', en['ui.schedule.cancelRun']);
  assert.ok(cancelRun, '動いている回があるので Cancel run が出る');
  assert.equal(row.querySelector<HTMLButtonElement>('[data-delete="tpl"]')!.disabled, true, '動いている回があるあいだ Delete は押せない');
  assert.ok(byText(row, '.bt-pill', en['ui.kanban.running']), '動いている印も出る');
  await click(cancelRun);
  await settle();
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/old/cancel'), 'いちばん新しい回ではなく、動いている古い回を止める');
  assert.ok(!calls.some(c => c.path === '/api/tasks/new/cancel'));
});

test('ui/Schedule（DOM, 309）: Pause のトーストには Undo が付き、押すと止めたひな形を戻す（uncancel）。止めた行に Run now は出ない', async () => {
  let paused = false;
  serve(() => ({ repeating: [template('tpl', paused ? 'cancelled' : 'scheduled')], active: [] }));
  const { container } = await render(createElement(Schedule, { revision: 0, projects: [] }));
  await later(10);
  await settle();
  assert.ok(byText(rowOf(container, 'tpl'), 'button', en['ui.task.runNow']), '動いている行には Run now がある');
  paused = true;
  await click(byText(rowOf(container, 'tpl'), 'button', en['ui.schedule.pause']));
  await later(10);
  await settle();
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/tpl/cancel'));
  const toastItem = seen.find(item => item.title === en['ui.schedule.toast.paused'])!;
  assert.ok(toastItem, 'Pause のトースト');
  assert.equal(toastItem.action?.label, en['ui.toast.undo'], 'トーストに Undo が付く');
  assert.equal(byText(rowOf(container, 'tpl'), 'button', en['ui.task.runNow']), undefined, '止めた行に Run now は出さない');
  assert.ok(byText(rowOf(container, 'tpl'), 'button', en['ui.schedule.resume']));
  paused = false;
  toastItem.action!.run();
  await later(10);
  await settle();
  assert.ok(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/tpl/uncancel'), 'Undo は uncancel を呼ぶ');
  assert.ok(byText(rowOf(container, 'tpl'), 'button', en['ui.schedule.pause']), 'Undo のあと、行は動いている行に戻って読み直される');
});

test('ui/Schedule（DOM, 315）: 新しい予定の入力を開いているあいだに製品がしまわれたら、画面の選びは「製品なし」になり、送るとサーバーの「しまわれている」の断りが出て、選びも送る値も「製品なし」に揃う。次に送ると製品なしで作られる', async () => {
  serve(() => ({ repeating: [], active: [] }));
  const { container, root } = await render(createElement(Schedule, { revision: 0, projects: [project('p1'), project('p2')] }));
  await later(10);
  await settle();
  await click(byText(container, 'button', en['ui.schedule.newShort']));
  const select = () => container.querySelector<HTMLSelectElement>(`select[aria-label="${en['ui.pf.product']}"]`)!;
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select(), 'p1');
    select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(select().value, 'p1');
  await update(() => root.render(createElement(Schedule, { revision: 0, projects: [project('p1', true), project('p2')] })));
  assert.equal(select().value, '', '画面の選びは「製品なし」');
  await input(container.querySelector(`input[aria-label="${en['ui.task.title']}"]`), 'Morning sweep');
  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  const posts = () => calls.filter(c => c.method === 'POST' && c.path === '/api/tasks');
  assert.equal(posts().length, 1);
  assert.equal((posts()[0]!.body as { projectId?: string }).projectId, 'p1', '選んだ製品の id を 1 度送り、サーバーの断りを出させる');
  assert.equal(container.querySelector('[role="alert"]')?.textContent, new ApiError(400, ARCHIVED).message, 'サーバーの断りの文が出る（黙って製品なしで作らない）');
  assert.ok(container.querySelector('form[aria-label="' + en['ui.schedule.new'] + '"]'), '断られたので入力は開いたまま');
  assert.equal(select().value, '');

  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  assert.equal(posts().length, 2);
  assert.equal((posts()[1]!.body as { projectId?: string }).projectId, undefined, '選びと送る値が揃ったので、次は製品なしで送る');
  assert.equal(container.querySelector('form[aria-label="' + en['ui.schedule.new'] + '"]'), null, '作ったら入力は閉じる');
});

test('ui/Schedule（DOM, 309）: Undo は、押した時点の Day / Week で読み直す（Pause のあとに Week へ替えても、Day の一覧を Week の下に戻さない）', async () => {
  serve(() => ({ repeating: [template('tpl', 'scheduled')], active: [] }));
  const { container } = await render(createElement(Schedule, { revision: 0, projects: [] }));
  await later(10);
  await settle();
  await click(byText(rowOf(container, 'tpl'), 'button', en['ui.schedule.pause']));
  await later(10);
  await settle();
  const toastItem = seen.find(item => item.title === en['ui.schedule.toast.paused'])!;
  assert.ok(toastItem?.action, 'Pause のトースト');
  const spans = () => calls.filter(c => c.path.startsWith('/api/schedule')).map(c => { const q = new URLSearchParams(c.path.split('?')[1]); return Number(q.get('to')) - Number(q.get('from')); });
  const daySpan = spans().at(-1)!;
  await click(byText(container, 'button', en['ui.schedule.range.week']));
  await later(RELOAD_DELAY_MS + 100);
  await settle();
  const weekSpan = spans().at(-1)!;
  assert.ok(weekSpan > daySpan, 'Week は Day より広い');
  const before = spans().length;
  toastItem.action!.run();
  await later(10);
  await settle();
  assert.ok(spans().length > before, 'Undo のあと、一覧を読み直す');
  assert.equal(spans().at(-1), weekSpan, 'Undo の読み直しは今の範囲（Week）で');
});

test('ui/Schedule（DOM）: 同じ年のうちの次の実行は、日の十の位や月が替わっても年を付けない短い形（月/日 時:分）で出す。年が替わるときだけ年付き', async () => {
  const NOW = Date.UTC(2026, 5, 29, 3, 0);
  const sameMonth = Date.UTC(2026, 5, 30, 3, 0);
  const nextMonth = Date.UTC(2026, 6, 2, 3, 0);
  const nextYear = Date.UTC(2027, 0, 2, 3, 0);
  const full = (ms: number) => formatDateTime(ms, 'full');
  const compact = (ms: number) => formatDateTime(ms, 'compact');
  assert.equal(full(sameMonth).slice(0, 4), full(NOW).slice(0, 4), '前提: 同じ年');
  assert.notEqual(full(sameMonth).slice(0, 9), full(NOW).slice(0, 9), '前提: 日の十の位が違う');
  assert.notEqual(full(nextMonth).slice(0, 7), full(NOW).slice(0, 7), '前提: 月が違う');
  assert.notEqual(full(nextYear).slice(0, 4), full(NOW).slice(0, 4), '前提: 年が違う');
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    serve(() => ({
      repeating: [template('a', 'scheduled', { run_at: sameMonth }), template('b', 'scheduled', { run_at: nextMonth }), template('c', 'scheduled', { run_at: nextYear })],
      active: [],
    }));
    const { container } = await render(createElement(Schedule, { revision: 0, projects: [] }));
    await later(10);
    await settle();
    const text = (id: string) => rowOf(container, id).textContent ?? '';
    assert.ok(text('a').includes(`next ${compact(sameMonth)} · `), `同じ月の別の十の位: 短い形 ${compact(sameMonth)}（実際: ${text('a')}）`);
    assert.ok(!text('a').includes(full(sameMonth)), '年付きの形は出さない');
    assert.ok(text('b').includes(`next ${compact(nextMonth)} · `), `次の月: 短い形 ${compact(nextMonth)}（実際: ${text('b')}）`);
    assert.ok(!text('b').includes(full(nextMonth)), '年付きの形は出さない');
    assert.ok(text('c').includes(`next ${full(nextYear)} · `), `年が替わるときは年付き ${full(nextYear)}（実際: ${text('c')}）`);
  } finally {
    Date.now = realNow;
  }
});
