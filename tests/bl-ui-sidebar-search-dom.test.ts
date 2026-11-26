import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, HistoryHit, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

// 持ち主の頼み（2026-11-26）: 検索を Claude Code Desktop と同じ形にする。左の上の列に「Search」の行を置き、押すと真ん中のモーダルで検索する。
// 種類のタブ（All / Sessions / Products）・最近の項目・アクション・キーボードの案内つき。見出しの横の虫めがねはやめる。

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

const realFetch = globalThis.fetch;
let asked: string[] = [];
let hits: HistoryHit[] = [];

function serve(): void {
  asked = [];
  globalThis.fetch = (async (path: string | URL | Request) => {
    asked.push(String(path));
    const out = String(path).startsWith('/api/history?q=') ? { hits } : { error: 'not found' };
    return new Response(JSON.stringify(out), { status: 'hits' in out ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  hits = [];
  window.location.hash = '';
});

const product = (id: string, name: string): Project => ({
  id, name, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const SHOP = product('p1aaaa', 'Shop');
const BLOG = product('p2bbbb', 'Blog');
const chat = (id: string, title: string | null, at: number, projectId: string | null): Conversation => ({ id, title, created_at: 0, last_message_at: at, project_id: projectId } as Conversation);
const IN_SHOP = chat('c1aaaa', 'Fix the cart', 5, SHOP.id);
const LOOSE = chat('c2bbbb', 'Loose talk', 9, null);
const OLDER = chat('c3cccc', null, 1, BLOG.id);
const hit = (c: Conversation, snippet: string): HistoryHit => ({ conversationId: c.id, title: c.title, messageId: 1, role: 'user', createdAt: 0, snippet, projectId: c.project_id ?? null });

const sidebarOf = () => createElement(Sidebar, {
  state: 'idle', route: { view: 'new' }, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: [IN_SHOP, LOOSE, OLDER], conversationsMore: {}, projects: [SHOP, BLOG], running: new Set<string>(), setupPending: false, onSetup: () => undefined,
});

const findRow = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.ui-side-find')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="tab"]')];
const options = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="option"]')];
const names = () => options().map(o => o.querySelector('.bt-side__name')?.firstChild?.textContent);
const selectedTab = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;
const highlighted = () => options().filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.querySelector('.bt-side__name')?.firstChild?.textContent);
const press = (key: string, extra: KeyboardEventInit = {}) => update(() => { field().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })); });
const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const wait = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));

async function open() {
  serve();
  const rendered = await render(sidebarOf());
  await click(findRow(rendered.container));
  return rendered;
}

test('Search（DOM）: 左の上の列に「Search」の行がある（見出しの横ではない）。押すとモーダルが開き、焦点は入力欄、種類のタブは All / Sessions / Products の 3 つ', async () => {
  serve();
  const { container } = await render(sidebarOf());
  const scroll = container.querySelector('.bt-sidebar__scroll')!;
  assert.equal(scroll.firstElementChild, findRow(container), '列の先頭の行（Workspace の見出しより上）');
  assert.equal(findRow(container).textContent, en['ui.search.open']);
  assert.ok(findRow(container).querySelector('svg.bt-icon'), '虫めがねの印');
  assert.equal(findRow(container).closest('.ui-sidebar__labelrow'), null, '見出しの横ではない');
  assert.equal(container.querySelectorAll('.ui-sidebar__labelrow button').length, 0, 'Products の側も No product の側も、見出しの横は + だけ');
  assert.equal(dialog(), null, '押すまでは開かない');

  await click(findRow(container));
  assert.ok(dialog(), 'モーダルが開く');
  assert.equal(dialog()!.getAttribute('aria-modal'), 'true');
  assert.equal(document.activeElement, field(), '焦点は入力欄');
  assert.deepEqual(tabs().map(tab => tab.textContent), [en['ui.search.tabAll'], en['ui.search.tabSessions'], en['ui.search.tabProducts']]);
  assert.equal(selectedTab(), en['ui.search.tabAll']);
  assert.equal(container.querySelector('.ui-search'), null, '左の列の中に検索の欄は広げない（昔の作り）');
  assert.ok(!container.contains(dialog()), 'モーダルは左の列の外に出す（狭い画面の引き出しや overflow に切られない）');
});

test('Search（DOM）: 何も打たないときは「Recent」に最近の会話（製品の会話も製品の無い会話も、新しい順）と、「Actions」に New session / New product。Enter で今の行（先頭）を開く', async () => {
  await open();
  assert.deepEqual(names(), ['Loose talk', 'Fix the cart', en['ui.session.untitled'], en['ui.session.new'], en['ui.product.new']]);
  assert.deepEqual([...document.querySelectorAll('[role="dialog"] [role="group"]')].map(g => g.getAttribute('aria-label')), [en['ui.search.recent'], en['ui.search.actions']]);
  assert.deepEqual(options().map(o => o.querySelector('.ui-find__meta')?.textContent ?? null), [null, 'Shop', 'Blog', null, null], '右の端に製品の名前（製品の無い会話は空）');
  assert.deepEqual(options().map(o => o.getAttribute('href')), ['#/c/c2bbbb', '#/c/c1aaaa', '#/c/c3cccc', '#/', '#/products/new']);
  assert.deepEqual(highlighted(), ['Loose talk']);
  assert.equal(field().getAttribute('aria-activedescendant'), options()[0]!.id);
  await press('Enter');
  assert.equal(window.location.hash, '#/c/c2bbbb');
  assert.equal(dialog(), null, '開いたら閉じる');
});

test('Search（DOM）: 打つと、いつもの履歴の検索（/api/history）の結果が出る。製品の会話も製品の無い会話も届き、製品の名前に当たれば Products が先に出る', async () => {
  hits = [hit(LOOSE, 'about shop talk'), hit(IN_SHOP, 'the shop cart'), hit(IN_SHOP, 'the shop cart again')];
  await open();
  await input(field(), 'shop');
  await wait(300);
  await settle();
  assert.deepEqual(asked.filter(p => p.startsWith('/api/history')), ['/api/history?q=shop'], '1 回だけ');
  assert.deepEqual(names(), ['Shop', 'Loose talk', 'Fix the cart'], '製品 → 会話（会話ごとに 1 行）。Actions と Recent は検索中は出ない');
  assert.deepEqual(options().map(o => o.getAttribute('href')), [`#/p/${SHOP.id}`, '#/c/c2bbbb', '#/c/c1aaaa'], '製品は製品の画面へ、会話は会話へ');
  assert.deepEqual(options().map(o => o.querySelector('.ui-find__snippet')?.textContent ?? null), [null, 'about shop talk', 'the shop cart']);
  assert.deepEqual(options().map(o => o.querySelector('.ui-find__meta')?.textContent ?? null), [null, null, 'Shop'], '製品の会話には製品の名前');
});

test('Search（DOM）: ← → で種類のタブが替わる（端は回る）。選ぶ行の並びも種類に合わせて替わり、入力欄から焦点が動かない', async () => {
  await open();
  assert.equal(selectedTab(), en['ui.search.tabAll']);
  await press('ArrowRight');
  assert.equal(selectedTab(), en['ui.search.tabSessions']);
  assert.deepEqual(names(), ['Loose talk', 'Fix the cart', en['ui.session.untitled']], 'Sessions は会話だけ（Actions は出ない）');
  await press('ArrowRight');
  assert.equal(selectedTab(), en['ui.search.tabProducts']);
  assert.deepEqual(names(), ['Shop', 'Blog']);
  await press('ArrowRight');
  assert.equal(selectedTab(), en['ui.search.tabAll'], '右の端の次は先頭へ');
  await press('ArrowLeft');
  assert.equal(selectedTab(), en['ui.search.tabProducts'], '先頭の前は右の端へ');
  assert.equal(document.activeElement, field());
  await update(() => { document.querySelector<HTMLElement>(`[role="dialog"] button[aria-label="${en['ui.search.close']}"]`)!.focus(); });
  await click(tabs()[1]);
  assert.equal(selectedTab(), en['ui.search.tabSessions'], 'マウスでも替わる');
  assert.equal(document.activeElement, field(), '焦点が別の所にあっても、タブを押したら打つ場所は入力欄へ戻る');
});

test('Search（DOM）: ↑ ↓ で選ぶ行が動く（端は回る）。選んでいる行だけ aria-selected、Enter で開く。Products の行は製品の画面、Actions の行は新しい会話', async () => {
  await open();
  assert.deepEqual(highlighted(), ['Loose talk']);
  await press('ArrowDown');
  assert.deepEqual(highlighted(), ['Fix the cart']);
  await press('ArrowUp');
  await press('ArrowUp');
  assert.deepEqual(highlighted(), [en['ui.product.new']], '先頭の上は末尾へ');
  await press('ArrowUp');
  assert.deepEqual(highlighted(), [en['ui.session.new']]);
  assert.equal(options().filter(o => o.querySelector('kbd')).length, 1, 'Enter の印（↵）は選んでいる行だけ');
  await press('Enter');
  assert.equal(window.location.hash, '#/');
  assert.equal(dialog(), null);

  await click(findRow(document.body));
  await press('ArrowRight');
  await press('ArrowRight');
  await press('ArrowDown');
  assert.deepEqual(highlighted(), ['Blog']);
  await press('Enter');
  assert.equal(window.location.hash, `#/p/${BLOG.id}`);
  assert.equal(dialog(), null);
});

test('Search（DOM）: Products の種類は製品の名前で絞る。当たりが無ければ「No matches」', async () => {
  await open();
  await press('ArrowRight');
  await press('ArrowRight');
  await input(field(), 'blo');
  assert.deepEqual(names(), ['Blog']);
  assert.equal(document.querySelector('[role="dialog"] [role="status"]')!.textContent, '');
  await input(field(), 'zzz');
  assert.deepEqual(names(), []);
  assert.equal(document.querySelector('[role="dialog"] [role="status"]')!.textContent, en['ui.search.none']);
});

test('Search（DOM）: 入力を替えると、選ぶ行は先頭へ戻る（動かしていた行が、新しい並びの途中に残らない）', async () => {
  hits = [hit(LOOSE, 'a'), hit(IN_SHOP, 'b'), hit(OLDER, 'c')];
  await open();
  await input(field(), 'c');
  await wait(300);
  await settle();
  assert.deepEqual(names(), ['Loose talk', 'Fix the cart', en['ui.session.untitled']]);
  await press('ArrowDown');
  await press('ArrowDown');
  assert.deepEqual(highlighted(), [en['ui.session.untitled']]);
  await input(field(), 'ca');
  assert.deepEqual(names(), ['Loose talk', 'Fix the cart', en['ui.session.untitled']], '届いた結果は、次の結果が来るまで同じ並び');
  assert.deepEqual(highlighted(), ['Loose talk'], '入力を替えたら先頭');
});

test('Search（DOM）: Esc で閉じて焦点は「Search」の行へ戻る。Esc は外のハンドラ（狭い画面の引き出しを閉じる処理）へ届かない。× でも同じ', async () => {
  const { container } = await open();
  let reached = 0;
  const outside = () => { reached += 1; };
  window.addEventListener('keydown', outside);
  try {
    const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await update(() => { field().dispatchEvent(event); });
    assert.equal(dialog(), null, 'Esc で閉じる');
    assert.equal(document.activeElement, findRow(container), '焦点は Search の行へ');
    assert.equal(event.defaultPrevented, true);
    assert.equal(reached, 0, '外のハンドラへ Esc を渡さない');
  } finally { window.removeEventListener('keydown', outside); }

  await click(findRow(container));
  assert.ok(dialog());
  await click(document.querySelector(`[role="dialog"] button[aria-label="${en['ui.search.close']}"]`));
  assert.equal(dialog(), null, '× で閉じる');
  assert.equal(document.activeElement, findRow(container));
});

test('Search（DOM）: 結果を押すと開いて閉じる。外（暗い所）を押すと閉じる。日本語の変換中の Enter と矢印は何もしない', async () => {
  const { container } = await open();
  await press('Enter', { keyCode: 229 });
  await press('ArrowRight', { keyCode: 229 });
  assert.ok(dialog(), '変換中の Enter では開かない');
  assert.equal(selectedTab(), en['ui.search.tabAll'], '変換中の矢印でタブは替わらない');
  await click(options()[1]);
  assert.equal(window.location.hash, '#/c/c1aaaa');
  assert.equal(dialog(), null);

  await click(findRow(container));
  const scrim = document.querySelector<HTMLElement>('.bt-scrim')!;
  await update(() => { scrim.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
  assert.equal(dialog(), null, '外を押すと閉じる');
});

test('Search（DOM）: 検索の失敗は Products の種類には出さない。All と Sessions では、製品の当たりがあっても失敗を知らせる', async () => {
  const { container } = await render(sidebarOf());
  globalThis.fetch = (async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await click(findRow(container));
  await input(field(), 'shop');
  await wait(300);
  await settle();
  const status = () => document.querySelector('[role="dialog"] [role="status"]')!.textContent;
  assert.deepEqual(names(), ['Shop'], '製品の当たりは出る');
  assert.equal(status(), en['ui.kanban.loadFailed'], '会話の検索が失敗したことは知らせる');
  await press('ArrowRight');
  await press('ArrowRight');
  assert.equal(status(), '', 'Products は履歴の検索に頼らないので、失敗を出さない');
});
