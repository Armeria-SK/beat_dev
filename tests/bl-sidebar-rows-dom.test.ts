import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import type { Route } from '../web/src/ui/routes.ts';

// backlog 375（キーボードで消している間に別の所へ移った焦点を奪わない）と 372（200 件で切れた「N more」の残りを見せる）。

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };

let paths: string[] = [];

function serve(routes: (path: string, method: string) => unknown): void {
  paths = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    paths.push(String(path));
    const out = await routes(String(path), init?.method ?? 'GET');
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const focused = (element: Element | null, message = '焦点が合っていない') => assert.ok(element !== null && document.activeElement === element, message);
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  window.location.hash = '';
});

const shop = (): Project => ({
  id: 'p1aaaa', name: 'Shop', root: 'C:\\work\\p1aaaa', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const chat = (id: string, at: number, projectId: string | null): Conversation => ({ id, title: `Chat ${id}`, created_at: 0, last_message_at: at, project_id: projectId } as Conversation);
const FIRST = chat('c1aaaa', 5, 'p1aaaa');
const SECOND = chat('c2bbbb', 4, 'p1aaaa');

const sidebarOf = (route: Route, chats: Conversation[], more: Record<string, number> = {}) => createElement(Sidebar, {
  state: 'idle', route, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: chats, conversationsMore: more, projects: [shop()], running: new Set<string>(), setupPending: false, onSetup: () => undefined,
});

const linkOf = (container: HTMLElement, c: Conversation) => container.querySelector<HTMLAnchorElement>(`a[href="#/c/${c.id}"]`)!;
const menuButtonOf = (container: HTMLElement, c: Conversation) => linkOf(container, c).closest('.bt-side--session')!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const itemNamed = (container: HTMLElement, text: string) => items(container).find(el => el.textContent === text);
const moreRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ui-side-more')];

async function confirmDelete(container: HTMLElement, c: Conversation): Promise<void> {
  await click(menuButtonOf(container, c));
  await click(itemNamed(container, en['ui.session.delete']));
  await click(itemNamed(container, en['ui.session.deleteConfirm']));
}

test('backlog 375（DOM）: キーボードで Delete を押したあと、消す処理が終わる前に持ち主が別の所へ焦点を移していたら、終わっても焦点を奪わない', async () => {
  let release: () => void = () => undefined;
  serve((path, method) => (path === `/api/conversations/${FIRST.id}` && method === 'DELETE' ? new Promise(resolve => { release = () => resolve({ deleted: true }); }) : undefined));
  const { container } = await render(sidebarOf({ view: 'new' }, [FIRST, SECOND]));
  await confirmDelete(container, FIRST);
  const elsewhere = container.querySelector<HTMLElement>('.bt-wordmark')!;
  await update(() => { elsewhere.focus(); });
  focused(elsewhere, '消している間に、持ち主がワードマークへ移った');
  release();
  await settle();
  focused(elsewhere, '終わっても、焦点は持ち主が移した所のまま（となりの行へ引き戻さない）');
});

test('backlog 375（DOM）: 消している間、焦点がメニューの中・行の中に残っているとき、または <body> に落ちたときは、今までどおりとなりの行へ移す', async () => {
  let release: () => void = () => undefined;
  serve((path, method) => (path === `/api/conversations/${FIRST.id}` && method === 'DELETE' ? new Promise(resolve => { release = () => resolve({ deleted: true }); }) : undefined));
  const { container } = await render(sidebarOf({ view: 'new' }, [FIRST, SECOND]));
  await confirmDelete(container, FIRST);
  release();
  await settle();
  focused(linkOf(container, SECOND), '焦点が行の中（メニューの上）にあったとき: となりの行へ');
  await cleanup();

  serve((path, method) => (path === `/api/conversations/${FIRST.id}` && method === 'DELETE' ? new Promise(resolve => { release = () => resolve({ deleted: true }); }) : undefined));
  const again = await render(sidebarOf({ view: 'new' }, [FIRST, SECOND]));
  await confirmDelete(again.container, FIRST);
  await update(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  focused(document.body, '消している間に、焦点が <body> に落ちた');
  release();
  await settle();
  focused(linkOf(again.container, SECOND), '<body> に落ちていたら、となりの行へ');
});

test('backlog 375（DOM）: Archive も同じ。待っている間に別の所へ移した焦点は奪わない', async () => {
  let release: () => void = () => undefined;
  serve((path, method) => (path === `/api/conversations/${FIRST.id}` && method === 'PATCH' ? new Promise(resolve => { release = () => resolve({ conversation: {} }); }) : undefined));
  const { container } = await render(sidebarOf({ view: 'new' }, [FIRST, SECOND]));
  await click(menuButtonOf(container, FIRST));
  await click(itemNamed(container, en['ui.session.archive']));
  const elsewhere = container.querySelector<HTMLElement>('.bt-wordmark')!;
  await update(() => { elsewhere.focus(); });
  release();
  await settle();
  focused(elsewhere);
});

const MORE_PATH = '/api/conversations?project=p1aaaa&limit=200';
const olderChats = (n: number) => Array.from({ length: n }, (_, i) => chat(`old${i}`, 3 - i / 1000, 'p1aaaa'));

test('backlog 372（DOM）: 「N more」を押して読み足しても、まだ 200 件で切れて残りがあるなら、残りの数を「N more」で見せる（もう押しても読めないので、押せるボタンにはしない）', async () => {
  serve(path => (path === MORE_PATH ? { conversations: [FIRST, SECOND, ...olderChats(3)], more: { p1aaaa: 17 } } : undefined));
  const { container } = await render(sidebarOf({ view: 'new' }, [FIRST], { p1aaaa: 204 }));
  const before = moreRows(container);
  assert.equal(before.length, 1);
  assert.equal(before[0]!.tagName, 'BUTTON');
  assert.equal(before[0]!.textContent, en['ui.product.more'](204));
  await click(before[0]);
  await settle();
  assert.ok(paths.includes(MORE_PATH), '読み足しを頼む');
  assert.ok(container.querySelector('a[href="#/c/old2"]'), '読み足した分が出る');
  const after = moreRows(container);
  assert.equal(after.length, 1, '残りがあることを見せる');
  assert.equal(after[0]!.textContent, en['ui.product.more'](17));
  assert.notEqual(after[0]!.tagName, 'BUTTON', '押しても同じ 200 件しか来ないので、押せる形にしない');
});

test('backlog 372（DOM）: 全部読み足せたとき（残りが 0）は、「N more」の行を消す', async () => {
  serve(path => (path === MORE_PATH ? { conversations: [FIRST, SECOND, ...olderChats(3)], more: {} } : undefined));
  const { container } = await render(sidebarOf({ view: 'new' }, [FIRST], { p1aaaa: 4 }));
  await click(moreRows(container)[0]);
  await settle();
  assert.equal(moreRows(container).length, 0);
});
