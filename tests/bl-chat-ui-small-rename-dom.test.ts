import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import type { Route } from '../web/src/ui/routes.ts';

// L164: サイドバーの会話の「…」メニューに Rename を足す。Claude Code と同じく、その場の入力欄で名前を直す（Enter で決める・Escape でやめる）

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };

interface Call { path: string; method: string; body: unknown }
let calls: Call[] = [];

function serve(reply: (path: string, method: string) => { status?: number; body: unknown }): void {
  calls = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ path: String(path), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const out = reply(String(path), method);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
const renames = () => calls.filter(c => c.method === 'PATCH');

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  window.location.hash = '';
});

const CHAT: Conversation = { id: 'c1aaaa', title: 'Fix the cart', created_at: 0, last_message_at: 5, project_id: null } as unknown as Conversation;
const OTHER: Conversation = { id: 'c2bbbb', title: 'Loose talk', created_at: 0, last_message_at: 4, project_id: null } as unknown as Conversation;

const sidebarOf = (route: Route = { view: 'new' }) => createElement(Sidebar, {
  state: 'idle', route, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: [CHAT, OTHER], conversationsMore: {}, projects: [] as Project[], running: new Set<string>(), setupPending: false, onSetup: () => undefined,
});

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.ui-side-row')];
const fieldOf = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input.ui-side-row__field');
const moreOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;

async function press(target: Element | null, key: string): Promise<void> {
  if (!target) throw new Error('press: no element');
  await update(() => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
}

async function startRename(container: HTMLElement, row: HTMLElement): Promise<HTMLInputElement> {
  await click(moreOf(row));
  const item = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === en['ui.session.rename']);
  assert.ok(item, 'メニューに Rename がある');
  await click(item);
  const field = fieldOf(container);
  assert.ok(field, '名前の入力欄が出る');
  return field;
}

function watchToasts(): { seen: FeedbackItem[]; stop: () => void } {
  const seen: FeedbackItem[] = [];
  return { seen, stop: subscribe(item => { seen.push(item); }) };
}

test('L164: サイドバーのメニューの先頭に Rename が出る。押すとメニューが閉じ、その行のリンクが入力欄（今の題が入り、焦点が合う）に替わる。ほかの行は替わらない', async () => {
  serve(() => ({ body: {} }));
  const { container } = await render(sidebarOf());
  const row = rows(container)[0]!;
  await click(moreOf(row));
  assert.deepEqual([...container.querySelectorAll('[role="menuitem"]')].map(el => el.textContent), [en['ui.session.rename'], en['ui.session.archive'], en['ui.session.delete']]);
  await click([...container.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]);
  const field = fieldOf(container)!;
  assert.ok(field, '入力欄');
  assert.equal(field.value, 'Fix the cart');
  assert.equal(field.getAttribute('aria-label'), en['ui.session.renameField']);
  assert.equal(document.activeElement, field, '焦点が入力欄に合う');
  assert.deepEqual([field.selectionStart, field.selectionEnd], [0, field.value.length], '今の題は全部選んである（打てば置き換わる）');
  assert.equal(container.querySelector('[role="menu"]'), null, 'メニューは閉じる');
  assert.equal(row.querySelector('.ui-side-row__link'), null, 'その行のリンクは入力欄に替わる');
  assert.equal(container.querySelectorAll('input.ui-side-row__field').length, 1);
  assert.ok(container.querySelector(`a[href="#/c/${OTHER.id}"]`), 'ほかの行はそのまま');
  assert.equal(renames().length, 0, '打つまでは何も送らない');
});

test('L164: 新しい名前を打って Enter を押すと PATCH { title } を 1 回だけ送り、行に新しい名前が出て、焦点は行のリンクへ戻る。知らせ（toast）は出さない', async () => {
  serve(() => ({ body: { conversation: { ...CHAT, title: 'New name' } } }));
  const toasts = watchToasts();
  try {
    const { container } = await render(sidebarOf());
    const field = await startRename(container, rows(container)[0]!);
    await input(field, '  New name  ');
    await press(field, 'Enter');
    await settle();
    assert.deepEqual(renames().map(c => [c.path, c.body]), [[`/api/conversations/${CHAT.id}`, { title: 'New name' }]]);
    assert.equal(fieldOf(container), null, '入力欄は閉じる');
    const link = container.querySelector<HTMLAnchorElement>(`a[href="#/c/${CHAT.id}"]`)!;
    assert.equal(link.textContent, 'New name', '行に新しい名前');
    assert.equal(document.activeElement, link, '焦点は行のリンクへ戻る');
    assert.deepEqual(toasts.seen, [], '成功しても知らせは出さない');
  } finally { toasts.stop(); }
});

test('L164: 日本語の入力の変換中の Enter では決めない。Escape は何も送らずに元の名前へ戻し、ほかの Escape（ドロワーを閉じる）へ渡さない', async () => {
  serve(() => ({ body: {} }));
  const { container } = await render(sidebarOf());
  const field = await startRename(container, rows(container)[0]!);
  await input(field, 'とりあえず');
  await update(() => { field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })); });
  assert.equal(renames().length, 0, '変換中の Enter は決定ではない');
  assert.ok(fieldOf(container), '入力欄は残る');
  let reached = false;
  const outer = () => { reached = true; };
  document.addEventListener('keydown', outer);
  try { await press(field, 'Escape'); } finally { document.removeEventListener('keydown', outer); }
  assert.equal(reached, false, 'Escape は外へ渡さない');
  assert.equal(renames().length, 0, 'Escape は何も送らない');
  assert.equal(fieldOf(container), null);
  assert.equal(container.querySelector(`a[href="#/c/${CHAT.id}"]`)!.textContent, 'Fix the cart', '名前はそのまま');
});

test('L164: 空・今と同じ名前では送らない。入力欄の外へ焦点が出たとき（blur）は、打った名前を決める', async () => {
  serve(() => ({ body: {} }));
  const { container } = await render(sidebarOf());
  let field = await startRename(container, rows(container)[0]!);
  await input(field, '   ');
  await press(field, 'Enter');
  await settle();
  assert.equal(renames().length, 0, '空は送らない');
  field = await startRename(container, rows(container)[0]!);
  await press(field, 'Enter');
  await settle();
  assert.equal(renames().length, 0, '今と同じ名前は送らない');
  field = await startRename(container, rows(container)[1]!);
  await input(field, 'Renamed by blur');
  await update(() => { field.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
  await settle();
  assert.deepEqual(renames().map(c => [c.path, c.body]), [[`/api/conversations/${OTHER.id}`, { title: 'Renamed by blur' }]]);
});

test('L164: サーバーが断ったら、名前は元のまま。理由を既存の「Not renamed」の文で知らせる（成功のときは出さない）', async () => {
  serve(() => ({ status: 404, body: { error: 'not_found', code: 'http.not_found', message: 'conversation gone' } }));
  const toasts = watchToasts();
  try {
    const { container } = await render(sidebarOf());
    const field = await startRename(container, rows(container)[0]!);
    await input(field, 'Will fail');
    await press(field, 'Enter');
    await settle();
    assert.equal(renames().length, 1);
    assert.equal(container.querySelector(`a[href="#/c/${CHAT.id}"]`)!.textContent, 'Fix the cart', '名前は元のまま');
    assert.equal(toasts.seen.length, 1);
    assert.match(String(toasts.seen[0]!.title), /^Not renamed · /u);
  } finally { toasts.stop(); }
});

test('L164: 一覧が新しい名前に替わったら、画面の側の仮の名前をやめてサーバーの名前を見せる（あとで別の名前に替わっても古い仮の名前に戻らない）', async () => {
  serve(() => ({ body: {} }));
  const { container, root } = await render(sidebarOf());
  const field = await startRename(container, rows(container)[0]!);
  await input(field, 'Mine');
  await press(field, 'Enter');
  await settle();
  assert.equal(container.querySelector(`a[href="#/c/${CHAT.id}"]`)!.textContent, 'Mine');
  await update(() => root.render(createElement(Sidebar, { ...(sidebarOf().props as Record<string, unknown>), conversations: [{ ...CHAT, title: 'Mine' }, OTHER] })));
  assert.equal(container.querySelector(`a[href="#/c/${CHAT.id}"]`)!.textContent, 'Mine');
  await update(() => root.render(createElement(Sidebar, { ...(sidebarOf().props as Record<string, unknown>), conversations: [{ ...CHAT, title: 'Someone else renamed it' }, OTHER] })));
  assert.equal(container.querySelector(`a[href="#/c/${CHAT.id}"]`)!.textContent, 'Someone else renamed it');
});
