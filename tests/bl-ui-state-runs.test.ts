import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project, ReviewJob, RunRow, ToolCallRow } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { filterLog, logFooter, logRows, rowDuration } from '../web/src/ui/library.ts';

// backlog 359（Runs の前の 2 つ）と、316 の残り（Runs の件数が絞り込み直後に古い数のまま）。

interface RunsProps { tab?: undefined; revision: number; conversations: readonly Conversation[]; projects: readonly Project[] }
const { Runs } = await loadTsx<{ Runs: ComponentType<RunsProps> }>('../web/src/ui/screens/Runs.tsx', import.meta.url);

const runRow = (id: string, at: number, extra: Partial<RunRow> = {}): RunRow => ({
  id, kind: 'chat', conversation_id: null, model_id: 'm', attempts: 1, started_at: at, duration_ms: 1000, ok: 1, error_kind: null, error_message: null,
  input_tokens: 1000, output_tokens: 200, cache_read_tokens: null, est_prompt_tokens: null, flags: [], ...extra,
});
const callRow = (id: string, at: number, extra: Partial<ToolCallRow> = {}): ToolCallRow => ({
  id, run_id: 'r1', conversation_id: null, tool: 'shell_run', input: JSON.stringify({ command: 'npm test' }), decision: 'allow', decided_by: 'policy',
  approval_id: null, ok: 1, duration_ms: 8100, output_preview: null, full_ref: null, created_at: at, autoReason: null, ...extra,
});
const job = (id: number, at: number, status: ReviewJob['status'], extra: Partial<ReviewJob> = {}): ReviewJob => ({
  id, trigger: 'idle', triggerLabel: 'idle', status, note: null, conversation_id: null, task_id: null, run_id: null, created_at: at, finished_at: null, changes: [], ...extra,
});
const rowsOf = (input: { runs?: RunRow[]; calls?: ToolCallRow[]; jobs?: ReviewJob[] }) =>
  logRows({ runs: input.runs ?? [], calls: input.calls ?? [], jobs: input.jobs ?? [], runLabel: k => k, titleOf: () => null });

test('359 Runs の All: 振り返りの実行（run）と振り返りの行（Review）が 2 回出ない。Review の行だけにして、Run の絞り込みでは実行として残る', () => {
  const rows = rowsOf({
    runs: [runRow('chat1', 300), runRow('rev1', 200, { kind: 'review', input_tokens: 5000, output_tokens: 400 })],
    jobs: [job(1, 190, 'done', { run_id: 'rev1', finished_at: 2190 })],
  });
  assert.deepEqual(filterLog(rows, 'all').map(r => r.key), ['run:chat1', 'review:1'], 'All は振り返りを 1 回だけ');
  assert.deepEqual(filterLog(rows, 'run').map(r => r.key), ['run:chat1', 'run:rev1'], 'Run の絞り込みは実行をすべて出す');
  assert.deepEqual(filterLog(rows, 'review').map(r => r.key), ['review:1']);
  assert.equal(rows.find(r => r.key === 'review:1')!.tokens, 5400, 'All から消える実行のトークンは Review の行に出す');
});

test('359 Runs の All: 実行がまだ読み込まれていない（古い）振り返りは、そのまま Review の行だけ。実行を持たない振り返りの行も消さない', () => {
  const rows = rowsOf({ jobs: [job(1, 100, 'done', { run_id: 'gone' }), job(2, 90, 'done')] });
  assert.deepEqual(filterLog(rows, 'all').map(r => r.key), ['review:1', 'review:2']);
  assert.equal(rows[0]!.tokens, null);
});

test('359 Runs の件数の 1 行: All の全体は 3 つの API の和から、All で隠した振り返りの実行の分（今日の分）を引く。ほかの絞り込みは変えない', () => {
  const day = 100;
  const rows = rowsOf({
    runs: [runRow('a', 500), runRow('rev', 400, { kind: 'review' })],
    jobs: [job(1, 390, 'done', { run_id: 'rev' })],
  });
  const totals = { run: 2, tool: 0, review: 1 };
  assert.deepEqual(logFooter(rows, 'all', totals, day), { shown: 2, total: 2 }, '3 件 - 2 回出ている 1 件 = 2 件');
  assert.deepEqual(logFooter(rows, 'run', totals, day), { shown: 2, total: 2 });
  assert.deepEqual(logFooter(rows, 'review', totals, day), { shown: 1, total: 1 });
});

test('359 Runs の動いている行: 経過の時間は、動いている間だけ「いま − 始まった時刻」。終わった行・待っている行は記録の値のまま', () => {
  const rows = rowsOf({
    runs: [runRow('run', 1000, { ok: null, duration_ms: null }), runRow('done', 500, { duration_ms: 42_000 })],
    calls: [callRow('tool', 2000, { ok: null, duration_ms: null })],
    jobs: [job(1, 3000, 'pending'), job(2, 3000, 'running', { run_id: 'run' }), job(3, 3000, 'running')],
  });
  const by = (key: string) => rows.find(r => r.key === key)!;
  assert.equal(rowDuration(by('run:run'), 6000), 5000, '動いている実行');
  assert.equal(rowDuration(by('tool:tool'), 6000), 4000, '動いている道具の呼び出し');
  assert.equal(rowDuration(by('run:done'), 6000), 42_000, '終わった実行は記録の値');
  assert.equal(rowDuration(by('review:1'), 6000), null, '順番待ちの振り返りは、まだ始まっていない');
  assert.equal(rowDuration(by('review:2'), 6000), 5000, '動いている振り返りは、その実行の始まりから');
  assert.equal(rowDuration(by('review:3'), 6000), null, '実行が分からない振り返りは出さない（作った時刻からは測らない）');
  assert.equal(rowDuration(by('run:run'), 500), 0, '時計が戻っても負にならない');
});

const g = globalThis as { matchMedia?: unknown };
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
const realFetch = globalThis.fetch;
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const later = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const settle = async () => { for (let i = 0; i < 3; i++) await later(0); };
const project = (id: string): Project => ({
  id, name: `Shop ${id}`, root: '/w/shop', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: id === 'pa' ? 1 : 2, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const props = (projects: readonly Project[]): RunsProps => ({ revision: 0, conversations: [], projects });
const judged = { allowed: 0, parked: {}, notParked: 0 };
const footerOf = (container: HTMLElement) => container.querySelector('.ui-lib__footer')?.textContent ?? null;

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('316/359 Runs（DOM）: 製品の絞り込みを替えた直後、新しい読み込みが届くまでは、前の絞り込みの総数から出した件数を出さない。届いたら新しい数になる', async () => {
  const now = Date.now();
  const mixed = [runRow('a1', now - 3000, { project_id: 'pa' }), runRow('a2', now - 2000, { project_id: 'pa' }), runRow('b1', now - 1000, { project_id: 'pb' })];
  let release: () => void = () => undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    const mine = url.includes('project=pa');
    if (url.startsWith('/api/runs')) {
      if (mine) { await held; return reply({ runs: [mixed[0], mixed[1]], total: 2, judged }); }
      return reply({ runs: mixed, total: 100, judged });
    }
    if (url.startsWith('/api/tool-calls')) return reply({ toolCalls: [], total: 0 });
    if (url.startsWith('/api/reviews')) return reply({ jobs: [], pending: 0, total: 0 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const { container } = await render(createElement(Runs, props([project('pa'), project('pb')])));
  await later(350);
  await settle();
  assert.equal(footerOf(container), en['ui.runs.footer']('3', '100'), 'すべての製品: 3 件のうち、全体は 100');

  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${en['ui.pf.product']}"]`)!;
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, 'pa');
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await later(10);
  assert.equal(container.querySelectorAll('tr.ui-lib__logrow').length, 2, '前の読み込みの中の pa の行は見せたまま');
  assert.equal(footerOf(container), null, '届くまでは、前の総数（100）に今の行数（2）を並べた件数を出さない');

  release();
  await later(10);
  await settle();
  assert.equal(footerOf(container), en['ui.runs.footer']('2', '2'), '届いたら、pa の総数から出す');
});

test('359 Runs（DOM）: 動いている行の経過の秒が、1 秒ごとに増える（記録の長さが無いあいだは、始まりから数える）', async () => {
  const started = Date.now() - 5000;
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    if (url.startsWith('/api/runs')) return reply({ runs: [runRow('live', started, { ok: null, duration_ms: null })], total: 1, judged });
    if (url.startsWith('/api/tool-calls')) return reply({ toolCalls: [], total: 0 });
    if (url.startsWith('/api/reviews')) return reply({ jobs: [], pending: 0, total: 0 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const { container } = await render(createElement(Runs, props([])));
  await later(350);
  await settle();
  const seconds = () => container.querySelector('tr.ui-lib__logrow td.bt-table__num')?.textContent ?? '';
  const first = parseFloat(seconds());
  assert.ok(first >= 5, `動いている実行に経過の秒が出る（出ているのは「${seconds()}」）`);
  await later(1300);
  const second = parseFloat(seconds());
  assert.ok(second >= first + 0.8, `1 秒近くたてば、秒が増える（${first} → ${second}）`);
});
