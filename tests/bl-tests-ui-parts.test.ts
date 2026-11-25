import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, AcceptanceItem, CheckFileChange, DiffFlags, Project, Task } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';

// backlog 384: 部品の試験で固めていなかった 3 つ。
//  ① PlanPane: 直す・消す・足す欄を開いたときの版（baseVersion / baseHash）で送る（AI が裏で書き直したあとの版では送らない）
//  ② ProductHome: Pending 待ちの「確かめ待ち」のタスク（awaiting）を、小さな板の Check の列に混ぜる
//  ③ PlanPane の「Differs from the plan」: 「No tests deleted, no check files changed」を出す場合と出さない場合

interface PlanProps { productId: string; conversationId?: string; revision: string; isGit: boolean }
interface HomeProps { id: string; project: Project | undefined; conversations: never[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; worker: null; revision: number }

const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);
const { ProductHome } = await loadTsx<{ ProductHome: ComponentType<HomeProps> }>('../web/src/ui/screens/ProductHome.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const realFetch = globalThis.fetch;

type Reply = unknown;
function serve(routes: (path: string, method: string, body: unknown) => Reply): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const out = await routes(String(path), init?.method ?? 'GET', raw === undefined ? undefined : JSON.parse(raw));
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const settleAll = async () => { for (let i = 0; i < 4; i++) await settle(); };

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.location.hash = '';
  localStorage.clear();
});

const item = (id: string, result: string): AcceptanceItem => ({
  id, result, source: { kind: 'owner_edit' }, check: { kind: 'look' }, state: 'open', evidence: [], changedIn: null, removedIn: null,
});
const acceptance = (over: Partial<Acceptance>): Acceptance => ({ version: 2, language: 'en', items: [item('A-1', 'It opens')], not_doing: [], draft: false, hash: 'h2', frozen: null, ...over });
const PLAN = { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false };

const buttonNamed = (container: ParentNode, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label);

// 製品の計画の欄。受け入れの一覧は current を返し続ける（テストの途中で差し替えて「AI が書き直した」を作る）。edit の POST の本文は posted に溜める
function planPane(state: { current: Acceptance }) {
  const posted: Array<Record<string, any>> = [];
  let loads = 0;
  serve((path, method, body) => {
    const [route] = path.split('?');
    if (route === `/api/projects/${PRODUCT}/plan`) return { plan: PLAN };
    if (route === `/api/projects/${PRODUCT}/acceptance`) { loads += 1; return { acceptance: state.current }; }
    if (route === `/api/projects/${PRODUCT}/acceptance/edit` && method === 'POST') { posted.push(body as Record<string, any>); return { acceptance: state.current }; }
    return undefined;
  });
  const element = (revision: string) => createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision, isGit: true });
  return { posted, loads: () => loads, element };
}

async function openRow(container: HTMLElement): Promise<void> {
  await click(container.querySelector('li.ui-acc__row button.ui-acc__text'));
}

// AI が裏で計画を書き直し、受け入れの一覧が新しい版に替わった、を画面に届ける（revision が変わると読み直す）
async function aiRewrites(rendered: { root: { render: (node: any) => void } }, pane: ReturnType<typeof planPane>, state: { current: Acceptance }): Promise<void> {
  const before = pane.loads();
  state.current = acceptance({ version: 3, hash: 'h3', items: [item('A-1', 'It opens'), item('A-2', 'Added by the AI')] });
  await update(() => rendered.root.render(pane.element('1')));
  await settleAll();
  assert.ok(pane.loads() > before, '前提: 受け入れの一覧を読み直した');
}

test('ui/PlanPane（DOM）: 項目を直す欄は、開いたときの版（v2 / h2）で送る。開いている間に AI が書き直して画面が v3 / h3 に替わっても、新しい版では送らない', async () => {
  const state = { current: acceptance({}) };
  const pane = planPane(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await openRow(rendered.container);
  await click(buttonNamed(rendered.container.querySelector('.ui-acc__detail')!, en['ui.acc.edit.edit']));
  const field = rendered.container.querySelector('textarea.ui-acc__input');
  assert.ok(field, '前提: 直す欄が開いた');
  await aiRewrites(rendered, pane, state);
  assert.ok(rendered.container.querySelector('textarea.ui-acc__input'), '前提: 読み直したあとも直す欄は開いたまま');
  assert.ok(rendered.container.textContent?.includes('Added by the AI'), '前提: 画面は新しい版（A-2 が増えた）');
  await input(rendered.container.querySelector('textarea.ui-acc__input'), 'It opens fast');
  await click(buttonNamed(rendered.container, en['ui.acc.edit.save']));
  await settleAll();
  assert.equal(pane.posted.length, 1);
  assert.equal(pane.posted[0]!.baseVersion, 2, '開いたときの版');
  assert.equal(pane.posted[0]!.baseHash, 'h2', '開いたときのハッシュ（サーバーが古いと断れる）');
  assert.equal(pane.posted[0]!.ops[0].op, 'change');
  assert.equal(pane.posted[0]!.ops[0].id, 'A-1');
});

test('ui/PlanPane（DOM）: 項目を消す確かめも、開いたときの版で送る', async () => {
  const state = { current: acceptance({}) };
  const pane = planPane(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await openRow(rendered.container);
  await click(buttonNamed(rendered.container, en['ui.acc.edit.remove']));
  assert.ok(rendered.container.textContent?.includes(en['ui.acc.edit.removeWhat']), '前提: 消す確かめが開いた');
  await aiRewrites(rendered, pane, state);
  await click(buttonNamed(rendered.container, en['ui.acc.edit.remove']));
  await settleAll();
  assert.equal(pane.posted.length, 1);
  assert.deepEqual([pane.posted[0]!.baseVersion, pane.posted[0]!.baseHash, pane.posted[0]!.ops[0].op, pane.posted[0]!.ops[0].id], [2, 'h2', 'remove', 'A-1']);
});

test('ui/PlanPane（DOM）: 項目を足す欄も、開いたときの版で送る', async () => {
  const state = { current: acceptance({}) };
  const pane = planPane(state);
  const rendered = await render(pane.element('0'));
  await settleAll();
  await click(buttonNamed(rendered.container, en['ui.acc.edit.add']));
  assert.ok(rendered.container.querySelector('textarea.ui-acc__input'), '前提: 足す欄が開いた');
  await aiRewrites(rendered, pane, state);
  await input(rendered.container.querySelector('textarea.ui-acc__input'), 'It closes');
  await click(buttonNamed(rendered.container, en['ui.acc.edit.save']));
  await settleAll();
  assert.equal(pane.posted.length, 1);
  assert.deepEqual([pane.posted[0]!.baseVersion, pane.posted[0]!.baseHash, pane.posted[0]!.ops[0].op], [2, 'h2', 'add']);
});

// --- ProductHome: awaiting ---

const project: Project = {
  id: PRODUCT, name: 'Parser', root: '/w/parser', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
};
const task = (id: string, title: string, over: Partial<Task>): Task => ({
  id, title, body: '', next_action: null, done_criteria: null, status: 'done', origin: 'user', priority: 0, cron: null, cron_text: null, run_at: null, parent_id: null, waiting_text: null,
  conversation_id: null, result_summary: null, attempts: 1, max_attempts: 3, created_at: 1, updated_at: 10, completed_at: 10, project_id: PRODUCT, ...over,
});
const homeProps = { id: PRODUCT, project, conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 };

function serveHome(tasks: { active: Task[]; awaiting?: Task[]; finished?: Task[] }): void {
  serve(path => {
    if (path.startsWith('/api/tasks/finished')) return { tasks: tasks.finished ?? [], next: null, total: (tasks.finished ?? []).length };
    if (path.startsWith('/api/tasks')) return { active: tasks.active, finished: [], ...(tasks.awaiting ? { awaiting: tasks.awaiting } : {}) };
    if (path.startsWith('/api/runs')) return { runs: [], total: 0, judged: {} };
    return undefined;
  });
}

const column = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-col="${id}"]`)!;
const cardNames = (el: HTMLElement): string[] => [...el.querySelectorAll('.bt-mini__name')].map(n => n.textContent ?? '');

test('ui/ProductHome（DOM）: 確かめ待ち（awaiting）のタスクは、小さな板の Check の列に出る。ふつうの動いているタスクは混ざらず、awaiting が無い返事でも落ちない', async () => {
  const waiting = task('t-wait', 'Check the parser', { check_state: 'awaiting' });
  const running = task('t-run', 'Parse the tokens', { status: 'running' });
  serveHome({ active: [running], awaiting: [waiting] });
  const { container } = await render(createElement(ProductHome, homeProps));
  await settleAll();
  assert.deepEqual(cardNames(column(container, 'check')), ['Check the parser'], '確かめ待ちは Check の列');
  assert.deepEqual(cardNames(column(container, 'progress')), ['Parse the tokens'], '動いているものは Progress の列のまま');
  assert.equal(column(container, 'check').querySelector('.bt-count__n')?.textContent, '1');
});

test('ui/ProductHome（DOM）: 古いサーバーの返事（awaiting の欄が無い）でも、板は出て、動いているタスクは並ぶ', async () => {
  serveHome({ active: [task('t-run', 'Parse the tokens', { status: 'running' })] });
  const { container } = await render(createElement(ProductHome, homeProps));
  await settleAll();
  assert.deepEqual(cardNames(column(container, 'progress')), ['Parse the tokens']);
  assert.deepEqual(cardNames(column(container, 'check')), []);
});

// --- PlanPane: 「No tests deleted, no check files changed」 ---

const builtAcceptance = acceptance({ frozen: { version: 2, hash: 'h2', plan_hash: 'p1', created_at: 5, source: 'build', build_task_id: 'b1' } });

async function differsSection(flags: DiffFlags): Promise<HTMLElement> {
  serve((path) => {
    const [route] = path.split('?');
    if (route === `/api/projects/${PRODUCT}/plan`) return { plan: PLAN };
    if (route === `/api/projects/${PRODUCT}/acceptance`) return { acceptance: builtAcceptance };
    if (route === `/api/projects/${PRODUCT}/deviations`) return { deviations: { rows: [], unreadable: 0, unusable: false }, flags };
    return undefined;
  });
  const { container } = await render(createElement(PlanPane, { productId: PRODUCT, conversationId: CHAT, revision: '0', isGit: true }));
  await settleAll();
  const section = container.querySelector<HTMLElement>(`section[aria-label="${en['ui.dev.title']}"]`);
  assert.ok(section, '前提: 「Differs from the plan」の欄が出ている');
  return section;
}

const NONE = { checked: true as const, testsDeleted: [] as string[], testsDeletedMore: 0, checkChanged: [] as CheckFileChange[], checkChangedMore: 0 };

test('ui/PlanPane（DOM）: ビルドと比べて、消えた試験も変わった確かめのファイルも無いときだけ「No tests deleted, no check files changed」を出す', async () => {
  const section = await differsSection({ ...NONE, since: 'build' });
  assert.ok(section.textContent?.includes(en['ui.dev.noFlags']));
  assert.ok(section.textContent?.includes(en['ui.dev.since.build']));
});

test('ui/PlanPane（DOM）: 「いまの HEAD と比べた」（since: head）結果が空のときは、その文を出さない（ビルドと比べたわけではないので「無い」とは言えない）', async () => {
  const section = await differsSection({ ...NONE, since: 'head' });
  assert.equal(section.textContent?.includes(en['ui.dev.noFlags']), false);
  assert.equal(section.textContent?.includes(en['ui.dev.testsDeleted']), false);
});

test('ui/PlanPane（DOM）: 消えた試験があれば、その名前を出し、「無い」の文は出さない。確かめのファイルだけが変わったときも同じ', async () => {
  const deleted = await differsSection({ ...NONE, since: 'build', testsDeleted: ['tests/parser.test.ts'] });
  assert.ok(deleted.textContent?.includes(en['ui.dev.testsDeleted']));
  assert.ok(deleted.textContent?.includes('tests/parser.test.ts'));
  assert.equal(deleted.textContent?.includes(en['ui.dev.noFlags']), false);
  const changed = await differsSection({ ...NONE, since: 'build', checkChanged: [{ path: 'package.json', change: 'modified', scripts: ['test'] }] });
  assert.ok(changed.textContent?.includes(en['ui.dev.checkChanged']));
  assert.ok(changed.textContent?.includes('package.json'));
  assert.equal(changed.textContent?.includes(en['ui.dev.noFlags']), false, '確かめのファイルが変わっているのに「無い」とは言わない');
});

test('ui/PlanPane（DOM）: 比べられなかったとき（git が無い）は、比べられなかったと言い、「無い」とは言わない', async () => {
  const section = await differsSection({ checked: false, reason: 'no_git' });
  assert.ok(section.textContent?.includes(en['ui.dev.notChecked.no_git']));
  assert.equal(section.textContent?.includes(en['ui.dev.noFlags']), false);
});
