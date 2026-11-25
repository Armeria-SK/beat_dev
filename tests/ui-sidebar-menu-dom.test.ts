import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { httpText } from '../src/shared/messages/http.ts';
import type { Conversation, Project } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import type { Route } from '../web/src/ui/routes.ts';

// サイドバーの会話の行の「…」メニュー（Archive・Delete）。会話の画面の上の「…」メニューと同じ部品・同じ文を使う。

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

interface BarProps {
  id: string | null; listTitle: string | null; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}
const { Conversation: ConversationScreen } = await loadTsx<{ Conversation: ComponentType<BarProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };

interface Call { path: string; method: string; body: unknown }
let calls: Call[] = [];
const refuse = (status: number, body: unknown) => ({ refused: true, status, body });

function serve(routes: (path: string, method: string) => unknown): void {
  calls = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ path: String(path), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const out = await routes(String(path), method) as { refused?: boolean; status?: number; body?: unknown } | undefined;
    if (out?.refused) return new Response(JSON.stringify(out.body), { status: out.status ?? 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
const writes = () => calls.filter(c => c.method !== 'GET');

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  window.location.hash = '';
});

const sideProject = (id: string, name: string): Project => ({
  id, name, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const SHOP = sideProject('p1aaaa', 'Shop');
const SHOP_CHAT: Conversation = { id: 'c1aaaa', title: 'Fix the cart', created_at: 0, last_message_at: 5, project_id: SHOP.id } as Conversation;
const LOOSE_CHAT: Conversation = { id: 'c2bbbb', title: 'Loose talk', created_at: 0, last_message_at: 4, project_id: null } as unknown as Conversation;

const sidebarOf = (route: Route, running: string[] = []) => createElement(Sidebar, {
  state: 'idle', route, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: [SHOP_CHAT, LOOSE_CHAT], conversationsMore: {}, projects: [SHOP], running: new Set(running), setupPending: false, onSetup: () => undefined,
});

const rowOf = (container: HTMLElement, chat: Conversation) => container.querySelector<HTMLElement>(`a[href="#/c/${chat.id}"]`)!.closest<HTMLElement>('.bt-side--session')!;
const moreOf = (container: HTMLElement, chat: Conversation) => rowOf(container, chat).querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
const menuOf = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="menu"]');
const items = (container: HTMLElement) => [...(menuOf(container)?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
const itemText = (container: HTMLElement) => items(container).map(el => el.textContent);
const itemNamed = (container: HTMLElement, text: string) => items(container).find(el => el.textContent === text);

async function press(target: Element | null, key: string): Promise<boolean> {
  if (!target) throw new Error('press: no element');
  let proceeded = true;
  await update(() => { proceeded = target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  return proceeded;
}

async function open(container: HTMLElement, chat: Conversation): Promise<void> {
  await click(moreOf(container, chat));
  assert.ok(menuOf(container), `${chat.title}: メニューが開く`);
}

function watchToasts(): { seen: FeedbackItem[]; stop: () => void } {
  const seen: FeedbackItem[] = [];
  return { seen, stop: subscribe(item => { seen.push(item); }) };
}

test('ui/Sidebar（DOM）: 会話の行ごとに「…」ボタンがある。リンクの外（隣）にあり、読み上げの名前に題が入り、閉じている間は aria-expanded=false。製品の行・New session の行には付かない', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  for (const chat of [SHOP_CHAT, LOOSE_CHAT]) {
    const link = container.querySelector<HTMLAnchorElement>(`a[href="#/c/${chat.id}"]`)!;
    const more = moreOf(container, chat);
    assert.ok(more, `${chat.title}: 「…」ボタン`);
    assert.equal(more.type, 'button');
    assert.equal(link.contains(more), false, 'ボタンはリンクの中に入れない（ボタンの中にボタン・リンクの中にボタンを作らない）');
    assert.equal(more.parentElement, link.parentElement, 'リンクの隣');
    assert.equal(more.getAttribute('aria-label'), en['ui.session.menuOf'](chat.title!), '行ごとに読み上げの名前が違う');
    assert.equal(more.getAttribute('aria-haspopup'), 'menu');
    assert.equal(more.getAttribute('aria-expanded'), 'false');
    assert.equal(link.textContent, chat.title, 'リンクの文字は題のまま');
  }
  assert.equal(container.querySelectorAll('button[aria-haspopup="menu"]').length, 2, '会話の行の数だけ');
  assert.equal(menuOf(container), null, '開くまでメニューは無い');
  const fresh = container.querySelector(`a[href="#/p/${SHOP.id}/new"]`)!.closest('.bt-side');
  assert.equal(fresh?.querySelector('button'), null, 'New session の行にはボタンが無い');
});

test('ui/Sidebar（DOM）: 「…」を押すと Archive と Delete のメニューが開き、先頭に焦点が入る。矢印・Home・End で動き、Escape で閉じて焦点は「…」に戻る', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  const more = moreOf(container, SHOP_CHAT)!;
  await click(more);
  const menu = menuOf(container)!;
  assert.equal(menu.getAttribute('aria-label'), en['ui.session.menuOf']('Fix the cart'));
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(itemText(container), [en['ui.session.archive'], en['ui.session.delete']]);
  assert.equal(document.activeElement, items(container)[0], '先頭（Archive）に焦点');
  await press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, items(container)[1]);
  await press(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, items(container)[0], '端で先頭に戻る');
  await press(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement, items(container)[1], '先頭から上で末尾へ');
  await press(document.activeElement, 'Home');
  assert.equal(document.activeElement, items(container)[0]);
  await press(document.activeElement, 'End');
  assert.equal(document.activeElement, items(container)[1]);
  const proceeded = await press(document.activeElement, 'Escape');
  assert.equal(proceeded, false, 'Escape はほかの Escape（ドロワーを閉じる）に渡さない');
  assert.equal(menuOf(container), null, 'Escape で閉じる');
  assert.equal(document.activeElement, more, '焦点は「…」に戻る');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await press(more, 'ArrowDown');
  assert.ok(menuOf(container), '閉じている「…」で下矢印を押しても開く');
  assert.equal(document.activeElement, items(container)[0]);
});

test('ui/Sidebar（DOM）: メニューは画面に固定して置く。ボタンの下に入るなら下、入らないなら上へ開き、確かめの文でメニューが縦に伸びたときも置き直す。会話の画面の上のメニューは置き場を決めない（CSS のまま）', async () => {
  const proto = window.HTMLElement.prototype;
  const saved = { rect: proto.getBoundingClientRect, height: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'), inner: Object.getOwnPropertyDescriptor(window, 'innerHeight') };
  let anchorTop = 100;
  let menuHeight = 60;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const button = this.getAttribute('aria-haspopup') === 'menu';
    const top = button ? anchorTop : 0;
    return { top, bottom: button ? top + 26 : 0, left: button ? 195 : 0, right: button ? 221 : 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get(this: HTMLElement) { return this.getAttribute('role') === 'menu' ? menuHeight : 0; } });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 600 });
  try {
    const { container } = await render(sidebarOf({ view: 'new' }));
    await open(container, LOOSE_CHAT);
    const menu = menuOf(container)!;
    assert.equal(menu.style.top, '130px', '下に入るので、ボタンの下（ボタンの下端 126 + すき間 4）');
    assert.equal(menu.style.bottom, '');
    assert.equal(menu.style.right, `${window.innerWidth - 221}px`, 'ボタンの右端にそろえる');
    await press(document.activeElement, 'Escape');

    anchorTop = 540;
    await open(container, LOOSE_CHAT);
    assert.equal(menuOf(container)!.style.bottom, '64px', '下に入らないので上へ（画面の下端 600 − ボタンの上端 540 + すき間 4）');
    assert.equal(menuOf(container)!.style.top, '');
    assert.equal(menuOf(container)!.style.maxHeight, '536px', '上の空きまでに縮める');

    anchorTop = 400;
    await press(document.activeElement, 'Escape');
    await open(container, LOOSE_CHAT);
    assert.equal(menuOf(container)!.style.top, '430px', '最初は下に入る');
    menuHeight = 260;
    await click(itemNamed(container, en['ui.session.delete']));
    assert.equal(menuOf(container)!.style.top, '', '確かめの文で伸びて下に入らなくなったら置き直す');
    assert.equal(menuOf(container)!.style.bottom, '204px');
  } finally {
    proto.getBoundingClientRect = saved.rect;
    if (saved.height) Object.defineProperty(proto, 'scrollHeight', saved.height); else delete (proto as unknown as Record<string, unknown>).scrollHeight;
    if (saved.inner) Object.defineProperty(window, 'innerHeight', saved.inner);
  }
});

test('ui/Sidebar（DOM）: 「…」を押しても会話は開かない（行きのハッシュが変わらない）。もう一度押すと閉じる', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  window.location.hash = '#/overview';
  await click(moreOf(container, LOOSE_CHAT));
  assert.equal(window.location.hash, '#/overview');
  assert.ok(menuOf(container));
  await click(moreOf(container, LOOSE_CHAT));
  assert.equal(menuOf(container), null);
});

test('ui/Sidebar（DOM）: Archive は PATCH archived:true を 1 回だけ送り、メニューを閉じて「Session archived」を Undo つきで知らせる。Undo は archived:false を送る', async () => {
  serve((path, method) => (path === `/api/conversations/${LOOSE_CHAT.id}` && method === 'PATCH' ? { conversation: {} } : undefined));
  const { seen, stop } = watchToasts();
  try {
    const { container } = await render(sidebarOf({ view: 'new' }));
    window.location.hash = '#/overview';
    await open(container, LOOSE_CHAT);
    await click(itemNamed(container, en['ui.session.archive']));
    await settle();
    assert.deepEqual(writes(), [{ path: `/api/conversations/${LOOSE_CHAT.id}`, method: 'PATCH', body: { archived: true } }]);
    assert.equal(menuOf(container), null, '閉じる');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.title, en['ui.session.archivedToast']);
    assert.equal(seen[0]!.body, 'Loose talk');
    assert.equal(seen[0]!.action?.label, en['ui.toast.undo']);
    assert.equal(window.location.hash, '#/overview', 'ほかの画面にいるなら動かさない');
    seen[0]!.action!.run();
    await settle();
    assert.deepEqual(writes().at(-1), { path: `/api/conversations/${LOOSE_CHAT.id}`, method: 'PATCH', body: { archived: false } });
    assert.equal(writes().length, 2);
  } finally {
    stop();
  }
});

test('ui/Sidebar（DOM）: いま開いている会話を Archive / Delete したら、新しい会話（#/）へ移る。開いていない会話を消しても今の画面は動かさない', async () => {
  serve((path, method) => (path.startsWith('/api/conversations/') && (method === 'PATCH' || method === 'DELETE') ? { deleted: true, conversation: {} } : undefined));
  const { container } = await render(sidebarOf({ view: 'chat', id: SHOP_CHAT.id }));
  window.location.hash = `#/c/${SHOP_CHAT.id}`;
  await open(container, SHOP_CHAT);
  await click(itemNamed(container, en['ui.session.archive']));
  await settle();
  assert.equal(window.location.hash, '#/', '開いている会話を Archive すると新しい会話へ');

  window.location.hash = `#/c/${SHOP_CHAT.id}`;
  await open(container, SHOP_CHAT);
  await click(itemNamed(container, en['ui.session.delete']));
  await click(itemNamed(container, en['ui.session.deleteConfirm']));
  await settle();
  assert.equal(window.location.hash, '#/', '開いている会話を Delete すると新しい会話へ');

  window.location.hash = `#/c/${SHOP_CHAT.id}`;
  await open(container, LOOSE_CHAT);
  await click(itemNamed(container, en['ui.session.delete']));
  await click(itemNamed(container, en['ui.session.deleteConfirm']));
  await settle();
  assert.equal(window.location.hash, `#/c/${SHOP_CHAT.id}`, 'ほかの会話を消しても、いま見ている会話は動かさない');
});

test('ui/Sidebar（DOM）: Delete はすぐには消さない。確かめの文（製品の会話は計画も消えると書いた文）と「Delete · cannot be undone」が出て、Keep で戻れる。確かめて初めて DELETE を送る', async () => {
  serve((path, method) => (path === `/api/conversations/${SHOP_CHAT.id}` && method === 'DELETE' ? { deleted: true } : undefined));
  const { seen, stop } = watchToasts();
  try {
    const { container } = await render(sidebarOf({ view: 'new' }));
    window.location.hash = '#/overview';
    await open(container, SHOP_CHAT);
    await click(itemNamed(container, en['ui.session.delete']));
    assert.equal(writes().length, 0, '押しただけでは何も送らない');
    assert.ok(menuOf(container), 'メニューは開いたまま');
    assert.ok(menuOf(container)!.textContent!.includes(en['ui.session.deleteWhatProduct']), '製品の会話の確かめの文');
    const confirm = itemNamed(container, en['ui.session.deleteConfirm'])!;
    assert.ok(confirm, '取り消せないと書いた決める印');
    assert.equal(document.activeElement, confirm, '確かめの印に焦点');
    assert.ok(confirm.getAttribute('aria-describedby'), '何が消えるかの文を、決める印の説明に結ぶ');
    assert.equal(menuOf(container)!.querySelector(`#${confirm.getAttribute('aria-describedby')}`)?.textContent, en['ui.session.deleteWhatProduct']);

    await click(itemNamed(container, en['ui.session.keep']));
    assert.equal(writes().length, 0, 'Keep は何も送らない');
    assert.deepEqual(itemText(container), [en['ui.session.archive'], en['ui.session.delete']], 'もとのメニューに戻る');
    assert.equal(document.activeElement, itemNamed(container, en['ui.session.delete']), '焦点は Delete に戻る');

    await click(itemNamed(container, en['ui.session.delete']));
    await click(itemNamed(container, en['ui.session.deleteConfirm']));
    await settle();
    assert.deepEqual(writes(), [{ path: `/api/conversations/${SHOP_CHAT.id}`, method: 'DELETE', body: undefined }], '確かめたあとで DELETE を 1 回');
    assert.equal(menuOf(container), null);
    assert.equal(seen.at(-1)?.title, en['ui.archived.toast.deleted']);
    assert.equal(seen.at(-1)?.body, 'Fix the cart');
    assert.equal(seen.at(-1)?.action, undefined, '消したものに Undo は付けない');
  } finally {
    stop();
  }
});

test('ui/Sidebar（DOM）: 製品の無い会話の確かめの文は、いつもの文（計画の話は出さない）', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  await open(container, LOOSE_CHAT);
  await click(itemNamed(container, en['ui.session.delete']));
  assert.ok(menuOf(container)!.textContent!.includes(en['ui.session.deleteWhat']));
  assert.equal(menuOf(container)!.textContent!.includes(en['ui.session.deleteWhatProduct']), false);
});

test('ui/Sidebar（DOM）: 返事を書いている会話の Delete をサーバーが断ったら、その文をメニューの中に出し、メニューは開いたまま・会話は動かさず・消した知らせも出さない。Archive は止めない', async () => {
  const running = httpText('en', 'conversation_running', {});
  serve((path, method) => {
    if (path === `/api/conversations/${SHOP_CHAT.id}` && method === 'DELETE') return refuse(409, { error: 'conflict', message: running, code: 'http.conversation_running' });
    if (path === `/api/conversations/${SHOP_CHAT.id}` && method === 'PATCH') return { conversation: {} };
    return undefined;
  });
  const { seen, stop } = watchToasts();
  try {
    const { container } = await render(sidebarOf({ view: 'chat', id: SHOP_CHAT.id }, [SHOP_CHAT.id]));
    window.location.hash = `#/c/${SHOP_CHAT.id}`;
    await open(container, SHOP_CHAT);
    await click(itemNamed(container, en['ui.session.delete']));
    await click(itemNamed(container, en['ui.session.deleteConfirm']));
    await settle();
    assert.equal(writes().length, 1);
    assert.equal(menuOf(container)!.querySelector('[role="alert"]')?.textContent, running, 'サーバーの断りの文');
    assert.equal(window.location.hash, `#/c/${SHOP_CHAT.id}`, '会話から動かさない');
    assert.equal(seen.length, 0, '消せていないので「消した」と知らせない');
    assert.ok(itemNamed(container, en['ui.session.deleteConfirm']), '確かめの場面のまま（Keep で戻れる）');
    assert.equal(itemNamed(container, en['ui.session.deleteConfirm'])!.hasAttribute('disabled'), false, '押し直せる');
    await click(itemNamed(container, en['ui.session.keep']));
    await click(itemNamed(container, en['ui.session.archive']));
    await settle();
    assert.equal(writes().at(-1)?.method, 'PATCH', '動いている会話の Archive は止めない');
  } finally {
    stop();
  }
});

test('ui/Sidebar（DOM）: メニューの外を押す・焦点がメニューの外へ出る・別の行の「…」を押す、のどれでも閉じる。同時に開くのは 1 つだけ', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  await open(container, SHOP_CHAT);
  await update(() => { container.ownerDocument.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
  assert.equal(menuOf(container), null, '外を押すと閉じる');

  await open(container, SHOP_CHAT);
  await click(moreOf(container, LOOSE_CHAT));
  assert.equal(container.querySelectorAll('[role="menu"]').length, 1, '同時に開くのは 1 つ');
  assert.equal(menuOf(container)!.getAttribute('aria-label'), en['ui.session.menuOf']('Loose talk'));
  assert.equal(moreOf(container, SHOP_CHAT)!.getAttribute('aria-expanded'), 'false');

  await update(() => { container.querySelector<HTMLAnchorElement>('a[href="#/skills"]')!.focus(); });
  assert.equal(menuOf(container), null, 'Tab などで焦点が外へ出ると閉じる');
});

test('ui/Sidebar（DOM）: Archive が失敗したら、メニューの中に理由を出して開いたまま。知らせ（toast）は出さず、会話も動かさない', async () => {
  serve((path, method) => (path === `/api/conversations/${LOOSE_CHAT.id}` && method === 'PATCH' ? refuse(404, { error: 'not_found', message: 'The conversation was not found', code: 'http.conversation_missing' }) : undefined));
  const { seen, stop } = watchToasts();
  try {
    const { container } = await render(sidebarOf({ view: 'chat', id: LOOSE_CHAT.id }));
    window.location.hash = `#/c/${LOOSE_CHAT.id}`;
    await open(container, LOOSE_CHAT);
    await click(itemNamed(container, en['ui.session.archive']));
    await settle();
    assert.equal(menuOf(container)!.querySelector('[role="alert"]')?.textContent, 'The conversation was not found');
    assert.equal(seen.length, 0);
    assert.equal(window.location.hash, `#/c/${LOOSE_CHAT.id}`);
  } finally {
    stop();
  }
});

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000003';

async function renderBar() {
  calls = [];
  serve((path, method) => {
    if (path === `/api/conversations/${CHAT}/messages`) return { conversation: { id: CHAT, title: 'Search', created_at: 0, last_message_at: 0, permission_mode: 'auto', has_summary: true }, messages: [], pending: [], builds: [], activeRun: null };
    if (path === `/api/conversations/${CHAT}/checklist`) return { items: [], tainted: false, updatedAt: null };
    if (path === '/api/models') return { models: [], routing: { chat: [] } };
    if (path === `/api/conversations/${CHAT}` && (method === 'PATCH' || method === 'DELETE')) return { deleted: true, conversation: {} };
    return undefined;
  });
  g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { container } = await render(createElement(ConversationScreen, {
    id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {},
  }));
  await settle();
  await settle();
  return container;
}

test('ui/Conversation（DOM）: 会話の画面の上の「…」メニューは同じ部品のまま。Rename・Summary・Archive・Delete が並び、Delete は確かめてから DELETE を送って新しい会話（#/）へ移る', async () => {
  const container = await renderBar();
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${en['ui.session.menu']}"]`)!;
  await click(button);
  assert.deepEqual(itemText(container), [en['ui.session.rename'], en['ui.session.summary'], en['ui.session.archive'], en['ui.session.delete']]);
  assert.equal(menuOf(container)!.getAttribute('style'), null, '上のメニューは置き場を決めない');
  assert.equal(document.activeElement, items(container)[0], '先頭に焦点');
  await press(document.activeElement, 'Escape');
  assert.equal(menuOf(container), null);
  assert.equal(document.activeElement, button, '焦点は「…」に戻る');

  await click(button);
  await click(itemNamed(container, en['ui.session.archive']));
  await settle();
  assert.deepEqual(writes().filter(c => c.method === 'PATCH').map(c => c.body), [{ archived: true }]);

  window.location.hash = `#/c/${CHAT}`;
  await click(button);
  await click(itemNamed(container, en['ui.session.delete']));
  assert.equal(writes().filter(c => c.method === 'DELETE').length, 0, '確かめるまで消さない');
  await click(itemNamed(container, en['ui.session.deleteConfirm']));
  await settle();
  assert.equal(writes().filter(c => c.method === 'DELETE').length, 1);
  assert.equal(window.location.hash, '#/');
});

const { menuFixed } = await loadTsx<{ menuFixed: (anchor: { top: number; bottom: number; left: number; right: number }, fit: { up: boolean; left: boolean; maxHeight: number; maxWidth: number }, view: { width: number; height: number }, gap: number) => Record<string, number> }>('../web/src/ui/menu.ts', import.meta.url);

test('ui/menu: 画面に固定して置く一覧は、下に開くなら「ボタンの下 + すき間」、上に開くなら「画面の下端からの距離」、右端そろえなら「画面の右端からの距離」、左端そろえなら「ボタンの左」を返す', () => {
  const view = { width: 800, height: 600 };
  const anchor = { top: 100, bottom: 128, left: 500, right: 600 };
  assert.deepEqual(menuFixed(anchor, { up: false, left: false, maxHeight: 300, maxWidth: 400 }, view, 4), { top: 132, right: 200, maxHeight: 300, maxWidth: 400 });
  assert.deepEqual(menuFixed(anchor, { up: true, left: true, maxHeight: 90, maxWidth: 250 }, view, 4), { bottom: 504, left: 500, maxHeight: 90, maxWidth: 250 });
});
