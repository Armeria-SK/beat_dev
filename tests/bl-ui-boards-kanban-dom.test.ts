import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project, Task } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

// backlog 315・316（Kanban）: しまわれた製品を送らない、絞り込み直後の古い "N more"。

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
const props = (projects: readonly Project[]): KanbanProps => ({
  conversations: [], drafts: [], checklists: new Map(), revision: 0, projects, pendingByTask: new Map(), questionsByTask: new Map(),
});
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const later = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const moreButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.ui-more');
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  localStorage.clear();
});

test('ui/Kanban（DOM, 316）: 絞り込みを替えた直後、新しい一覧が届くまでは、前の絞り込みの総数から出した "N more" を出さない。届いたら新しい数になる', async () => {
  const mixed = [...Array.from({ length: 10 }, (_, i) => done(`a${i}`, 'pa', 1000 - i)), ...Array.from({ length: 10 }, (_, i) => done(`b${i}`, 'pb', 900 - i))];
  const onlyA = Array.from({ length: 20 }, (_, i) => done(`a${i}`, 'pa', 1000 - i));
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
    if (url.startsWith('/api/runs')) return reply(200, { runs: [], total: 0, judged: {} });
    if (url.startsWith('/api/session-checks')) return reply(200, { sessions: [] });
    return reply(404, { error: 'not_found' });
  }) as typeof fetch;

  const { container } = await render(createElement(Kanban, props([project('pa'), project('pb')])));
  await later(10);
  await settle();
  assert.equal(moreButton(container)?.textContent, en['ui.kanban.more'](80), 'すべての製品: 100 件のうち 20 件を読んだ');

  await click(byText(container, 'button', 'Shop pa'));
  await later(10);
  assert.ok(calls.some(c => c.path.includes('/api/tasks/finished') && c.path.includes('project=pa')), '絞り込みで読み直しが始まっている（まだ届かない）');
  assert.equal(moreButton(container)?.textContent ?? null, null, '届くまでは前の総数（100）から出した数（90 more）を出さない');
  assert.equal(container.querySelectorAll('[data-col="done"] article.bt-card').length, 10, '前の一覧の中の A の分は見せたまま');

  releaseA();
  await later(10);
  await settle();
  assert.equal(moreButton(container)?.textContent, en['ui.kanban.more'](5), '届いたら新しい総数（25）から出す');
});

test('ui/Kanban（DOM, 315）: New task を開いているあいだに製品がしまわれたら、しまわれた製品の id を送らない（画面の選びも「製品なし」に戻る）', async () => {
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    calls.push({ path: url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST' && url === '/api/tasks') return reply(201, { task: done('created', 'pa', 1) });
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
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select(), 'pa');
    select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  assert.equal(select().value, 'pa');

  await update(() => root.render(createElement(Kanban, props([project('pa', true), project('pb')]))));
  assert.equal(select().value, '', 'しまわれた製品は選びから外れ、「製品なし」を指す');
  await input(container.querySelector(`input[aria-label="${en['ui.task.title']}"]`), 'Tidy up');
  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  const post = calls.find(c => c.method === 'POST' && c.path === '/api/tasks')!;
  assert.ok(post, '作成の POST が出る');
  assert.equal((post.body as { projectId?: string }).projectId, undefined, 'しまわれた製品の id は送らない（送ると 400 になる）');

  calls.length = 0;
  assert.equal(container.querySelector('form[aria-label="' + en['ui.kanban.new'] + '"]'), null, '作ったら入力は閉じる');
  await click(byText(container, 'button', en['ui.kanban.new']));
  await update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set?.call(select(), 'pb');
    select().dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await input(container.querySelector(`input[aria-label="${en['ui.task.title']}"]`), 'Second');
  await click(byText(container, 'button', en['ui.newtask.create']));
  await later(10);
  await settle();
  assert.equal((calls.find(c => c.method === 'POST' && c.path === '/api/tasks')!.body as { projectId?: string }).projectId, 'pb', '生きている製品はそのまま送る');
});
