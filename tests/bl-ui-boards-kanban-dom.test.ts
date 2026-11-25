import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project, RunRow, Task } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';

// backlog 315・316（Kanban）: しまわれた製品を選んだまま送ったときの知らせ、絞り込み直後の古い "N more"。

interface KanbanProps {
  conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; revision: number; projects: readonly Project[];
  pendingByTask: ReadonlyMap<string, number>; questionsByTask: ReadonlyMap<string, number>;
}
const { Kanban } = await loadTsx<{ Kanban: ComponentType<KanbanProps> }>('../web/src/ui/screens/Kanban.tsx', import.meta.url);

const g = globalThis as { matchMedia?: unknown };
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
const realFetch = globalThis.fetch;
const calls: Array<{ path: string; method: string; body: unknown }> = [];

const project = (id: string, archived = false): Project => ({
  id, name: `Shop ${id}`, root: '/w/shop', check_command: null, scout_mode: 'off', remotes: [], archived_at: archived ? 5 : null, created_at: id === 'pa' ? 1 : 2, updated_at: 1,
  is_git: true, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const done = (id: string, projectId: string, at: number): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status: 'done', origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 1, max_attempts: 3, created_at: at, updated_at: at, completed_at: at, project_id: projectId,
});
const talk = (i: number, projectId: string): Conversation => ({ id: `c${i}`, title: `Talk ${i}`, project_id: projectId }) as unknown as Conversation;
const chatRun = (i: number): RunRow => ({ id: `r${i}`, kind: 'chat', conversation_id: `c${i}`, started_at: 100 + i, duration_ms: 10, ok: 1, error_kind: null }) as unknown as RunRow;
const props = (projects: readonly Project[], conversations: Conversation[] = []): KanbanProps => ({
  conversations, drafts: [], checklists: new Map(), revision: 0, projects, pendingByTask: new Map(), questionsByTask: new Map(),
});
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const later = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const moreButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.ui-more');
const doneCards = (container: HTMLElement) => container.querySelectorAll('[data-col="done"] article.bt-card').length;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const choose = (select: HTMLSelectElement, value: string) => update(() => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
});

let stopListening = (): void => undefined;
afterEach(async () => {
  await cleanup();
  stopListening();
  stopListening = () => undefined;
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('ui/Kanban（DOM, 316）: 絞り込みを替えた直後、新しい一覧が届くまでは、前の総数から出した "N more" を出さない。Done の欄は伸びも縮みもしない（古い会話の札を急に出さない）。届いたら新しい数になる', async () => {
  const mixed = [...Array.from({ length: 10 }, (_, i) => done(`a${i}`, 'pa', 1000 - i)), ...Array.from({ length: 10 }, (_, i) => done(`b${i}`, 'pb', 900 - i))];
  const onlyA = Array.from({ length: 20 }, (_, i) => done(`a${i}`, 'pa', 1000 - i));
  const talks = Array.from({ length: 30 }, (_, i) => talk(i, 'pa'));
  let releaseA: () => void = () => undefined;
  const heldA = new Promise<void>(resolve => { releaseA = resolve; });
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = String(path);
    calls.push({ path: url, method: 'GET', body: null });
    if (url.startsWith('/api/tasks/finished')) {
      if (url.includes('project=pa')) { await heldA; return reply(200, { tasks: onlyA, next: { beforeT: 1, beforeId: 'a19' }, total: 25 }); }
      return reply(200, { tasks: mixed, next: { beforeT: 1, beforeId: 'b9' }, total: 100 });
    }
    if (url.startsWith('/api/tasks')) return reply(200, { active: [], finished: [], awaiting: [] });
    if (url.startsWith('/api/runs')) return reply(200, { runs: talks.map((_, i) => chatRun(i)), total: 30, judged: {} });
    if (url.startsWith('/api/session-checks')) return reply(200, { sessions: [] });
    return reply(404, { error: 'not_found' });
  }) as typeof fetch;

  const { container } = await render(createElement(Kanban, props([project('pa'), project('pb')], talks)));
  await later(10);
  await settle();
  assert.equal(doneCards(container), 20, 'すべての製品: 読んだ終わったタスク 20 件だけ（それより古い会話の札は "N more" の中）');
  assert.equal(moreButton(container)?.textContent, en['ui.kanban.more'](110), 'すべての製品: 残りのタスク 80 件と、古くて隠した会話 30 件');

  await click(byText(container, 'button', 'Shop pa'));
  await later(10);
  assert.ok(calls.some(c => c.path.includes('/api/tasks/finished') && c.path.includes('project=pa')), '絞り込みで読み直しが始まっている（まだ届かない）');
  assert.equal(moreButton(container)?.textContent ?? null, null, '届くまでは前の総数（100）から出した数を出さない');
  assert.equal(doneCards(container), 10, '前の一覧の中の A の 10 件のまま。古い会話 30 件の札が Done に急に出ない');

  releaseA();
  await later(10);
  await settle();
  assert.equal(doneCards(container), 20, '届いたら A の 20 件');
  assert.equal(moreButton(container)?.textContent, en['ui.kanban.more'](35), '届いたら新しい総数（25 − 20）と、隠した会話 30 件から出す');
});

test('ui/Kanban（DOM, 315）: New task を開いているあいだに製品がしまわれたら、画面の選びは「製品なし」になり、送るとサーバーの「しまわれている」の断りが出て、選びも送る値も「製品なし」に揃う。次に送ると製品なしで作られる', async () => {
  const seen: FeedbackItem[] = [];
  stopListening = subscribe(item => { seen.push(item); });
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as { projectId?: string } : null;
    calls.push({ path: url, method, body });
    if (method === 'POST' && url === '/api/tasks') {
      if (body?.projectId === 'pa') return reply(400, { error: 'project', code: 'project.error.archived', message: 'This product is archived. Restore it first' });
      return reply(201, { task: done('created', 'pa', 1) });
    }
    if (url.startsWith('/api/tasks/finished')) return reply(200, { tasks: [], next: null, total: 0 });
    if (url.startsWith('/api/tasks')) return reply(200, { active: [], finished: [], awaiting: [] });
    if (url.startsWith('/api/runs')) return reply(200, { runs: [], total: 0, judged: {} });
    if (url.startsWith('/api/session-checks')) return reply(200, { sessions: [] });
    return reply(404, { error: 'not_found' });
  }) as typeof fetch;

  const { container, root } = await render(createElement(Kanban, props([project('pa'), project('pb')])));
  await later(10);
  await settle();
  await click(byText(container, 'button', en['ui.kanban.new']));
  const select = () => container.querySelector<HTMLSelectElement>(`select[aria-label="${en['ui.pf.product']}"]`)!;
  await choose(select(), 'pa');
  assert.equal(select().value, 'pa');

  await update(() => root.render(createElement(Kanban, props([project('pa', true), project('pb')]))));
  assert.equal(select().value, '', '画面の選びは「製品なし」');
  await input(container.querySelector(`input[aria-label="${en['ui.task.title']}"]`), 'Tidy up');
  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  const posts = () => calls.filter(c => c.method === 'POST' && c.path === '/api/tasks');
  assert.equal(posts().length, 1);
  assert.equal((posts()[0]!.body as { projectId?: string }).projectId, 'pa', '選んだ製品の id を 1 度送り、サーバーの断りを出させる');
  assert.equal(seen.at(-1)?.icon, 'alert');
  assert.equal(seen.at(-1)?.body, 'This product is archived. Restore it first', 'サーバーの断りの文がそのまま出る（黙って製品なしで作らない）');
  assert.ok(container.querySelector('form[aria-label="' + en['ui.kanban.new'] + '"]'), '断られたので入力は開いたまま');
  assert.equal(select().value, '');

  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  assert.equal(posts().length, 2);
  assert.equal((posts()[1]!.body as { projectId?: string }).projectId, undefined, '選びと送る値が揃ったので、次は製品なし（持ち主が選んだ形）で送る');
  assert.equal(container.querySelector('form[aria-label="' + en['ui.kanban.new'] + '"]'), null, '作ったら入力は閉じる');

  calls.length = 0;
  await click(byText(container, 'button', en['ui.kanban.new']));
  await choose(select(), 'pb');
  await input(container.querySelector(`input[aria-label="${en['ui.task.title']}"]`), 'Second');
  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  assert.equal((posts()[0]!.body as { projectId?: string }).projectId, 'pb', '生きている製品はそのまま送る');
});
