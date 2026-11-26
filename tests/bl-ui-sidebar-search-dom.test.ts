import { readFileSync } from 'node:fs';
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

const sidebarOf = (conversations: Conversation[] = [IN_SHOP, LOOSE, OLDER]) => createElement(Sidebar, {
  state: 'idle', route: { view: 'new' }, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations, conversationsMore: {}, projects: [SHOP, BLOG], running: new Set<string>(), setupPending: false, onSetup: () => undefined,
});

const findRow = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('button.ui-side-find')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="tab"]')];
const options = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"] [role="option"]')];
const names = () => options().map(o => o.querySelector('.bt-side__name')?.firstChild?.textContent);
const selectedTab = () => tabs().find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;
const highlighted = () => options().filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.querySelector('.bt-side__name')?.firstChild?.textContent);
async function pressOn(target: Element, key: string, extra: KeyboardEventInit = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  await update(() => { target.dispatchEvent(event); });
  return event;
}
const press = (key: string, extra: KeyboardEventInit = {}) => pressOn(field(), key, extra);
const closeButton = () => document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${en['ui.search.close']}"]`)!;
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

const ANOTHER = chat('c4dddd', 'Another cart', 3, null);

test('Search（DOM）: 入力を替えると、選ぶ行は先頭へ戻る（動かしていた行が、新しい並びの途中に残らない）', async () => {
  serve();
  const { container } = await render(sidebarOf([IN_SHOP, LOOSE, ANOTHER]));
  await click(findRow(container));
  await input(field(), 'a');
  assert.deepEqual(names(), ['Loose talk', 'Fix the cart', 'Another cart'], '題に a を含む会話が、新しい順');
  await press('ArrowDown');
  await press('ArrowDown');
  assert.deepEqual(highlighted(), ['Another cart']);
  await input(field(), 'ar');
  assert.deepEqual(names(), ['Fix the cart', 'Another cart']);
  assert.deepEqual(highlighted(), ['Fix the cart'], '入力を替えたら先頭（Another cart が並びに残っていても、そこには留まらない）');
});

test('Search（DOM）: 選ぶ行は、並びの位置ではなく会話で覚える。会話の一覧が動いても（新しい会話が先頭に入っても）、選んでいた会話のまま', async () => {
  serve();
  const { container, root } = await render(sidebarOf());
  await click(findRow(container));
  await press('ArrowDown');
  assert.deepEqual(highlighted(), ['Fix the cart']);
  const fresh = chat('c5eeee', 'Brand new', 99, null);
  await update(() => { root.render(sidebarOf([fresh, IN_SHOP, LOOSE, OLDER])); });
  assert.deepEqual(names().slice(0, 3), ['Brand new', 'Loose talk', 'Fix the cart'], '前提: 新しい会話が先頭に入った');
  assert.deepEqual(highlighted(), ['Fix the cart'], '位置（2 番目）ではなく、Fix the cart のまま');
  await press('Enter');
  assert.equal(window.location.hash, '#/c/c1aaaa');
});

test('Search（DOM）: 会話は、いま左の列にある題でも探す（大文字小文字を問わない）。履歴の結果を待たずに出て、同じ会話は 1 行で、題の当たりが先', async () => {
  hits = [hit(LOOSE, 'my cart notes'), hit(IN_SHOP, 'a cart in the text')];
  await open();
  await input(field(), 'CART');
  assert.deepEqual(names(), ['Fix the cart'], '履歴の検索（250ms 待ち）より前に、題の当たりが出る');
  assert.equal(options()[0]!.querySelector('.ui-find__meta')?.textContent, 'Shop');
  assert.equal(document.querySelector('[role="dialog"] [role="status"]')!.textContent, '', '待っている間に「ない」とは言わない');
  await wait(300);
  await settle();
  assert.deepEqual(names(), ['Fix the cart', 'Loose talk'], '題の当たり → 発言の当たり。Fix the cart は両方に当たっても 1 行');
  assert.deepEqual(options().map(o => o.querySelector('.ui-find__snippet')?.textContent ?? null), [null, 'my cart notes']);
  assert.deepEqual(options().map(o => o.getAttribute('href')), ['#/c/c1aaaa', '#/c/c2bbbb']);
  hits = [];
  await input(field(), 'zzz');
  await wait(300);
  await settle();
  assert.deepEqual(names(), []);
  assert.equal(document.querySelector('[role="dialog"] [role="status"]')!.textContent, en['ui.search.none']);
});

test('Search（DOM）: 履歴の検索が失敗しても、題の当たりは残る', async () => {
  const { container } = await render(sidebarOf());
  globalThis.fetch = (async () => new Response('{}', { status: 500, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  await click(findRow(container));
  await input(field(), 'cart');
  await wait(300);
  await settle();
  assert.deepEqual(names(), ['Fix the cart']);
  assert.equal(document.querySelector('[role="dialog"] [role="status"]')!.textContent, en['ui.kanban.loadFailed']);
});

test('Search（DOM）: 打ち直している間（履歴の結果が来る前）に Enter を押しても、前の入力の当たりは開かない', async () => {
  hits = [hit(LOOSE, 'about shop talk')];
  await open();
  await input(field(), 'shop');
  await wait(300);
  await settle();
  assert.deepEqual(names(), ['Shop', 'Loose talk'], '前提: 前の入力の結果（Loose talk）が出ている');
  await input(field(), 'shopx');
  assert.deepEqual(names(), [], '入力が替わったら、次の結果が来るまで、前の結果は出さない');
  await press('Enter');
  assert.equal(window.location.hash, '', '前の入力の当たり（Loose talk）を開かない');
  assert.ok(dialog(), '閉じもしない');
  await wait(300);
  await settle();
  assert.deepEqual(names(), ['Loose talk'], '新しい入力の結果は来たら出る');
});

test('Search（DOM）: ← → は、欄が空か、カーソルがその端のときだけタブを替える。途中・反対の端ではカーソルの移動に任せる（タブも替えず、キーも奪わない）', async () => {
  await open();
  await input(field(), 'shop');
  field().setSelectionRange(2, 2);
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    const event = await press(key);
    assert.equal(event.defaultPrevented, false, `${key}: 途中ではカーソルへ任せる`);
    assert.equal(selectedTab(), en['ui.search.tabAll']);
  }
  field().setSelectionRange(4, 4);
  assert.equal((await press('ArrowLeft')).defaultPrevented, false, '末尾の ← はカーソル');
  assert.equal(selectedTab(), en['ui.search.tabAll']);
  field().setSelectionRange(0, 0);
  assert.equal((await press('ArrowRight')).defaultPrevented, false, '先頭の → はカーソル');
  assert.equal(selectedTab(), en['ui.search.tabAll']);
  field().setSelectionRange(0, 4);
  assert.equal((await press('ArrowRight')).defaultPrevented, false, '範囲を選んでいる間は端でもカーソル');
  assert.equal(selectedTab(), en['ui.search.tabAll']);

  field().setSelectionRange(4, 4);
  assert.equal((await press('ArrowRight')).defaultPrevented, true, '末尾の → はタブ');
  assert.equal(selectedTab(), en['ui.search.tabSessions']);
  field().setSelectionRange(0, 0);
  assert.equal((await press('ArrowLeft')).defaultPrevented, true, '先頭の ← はタブ');
  assert.equal(selectedTab(), en['ui.search.tabAll']);
  assert.equal(document.activeElement, field());
});

test('Search（DOM）: 閉じて開き直すと、打った言葉と種類のタブがそのまま戻り、言葉は選ばれている（打てば置き換わる）。保存はしない（開いている間だけ）', async () => {
  const { container } = await open();
  await input(field(), 'cart');
  await press('ArrowRight');
  await press('ArrowRight');
  assert.equal(selectedTab(), en['ui.search.tabProducts']);
  await press('Escape');
  assert.equal(dialog(), null);
  await click(findRow(container));
  assert.equal(field().value, 'cart', '打った言葉が残る');
  assert.equal(selectedTab(), en['ui.search.tabProducts'], '種類も残る');
  assert.deepEqual([field().selectionStart, field().selectionEnd], [0, 4], '言葉は選ばれている');
  assert.equal(document.activeElement, field());
  await input(field(), 'x');
  assert.equal(field().value, 'x');
  assert.equal(window.localStorage.length + window.sessionStorage.length, 0, 'ブラウザの保存先には書かない');
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
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await update(() => { scrim.dispatchEvent(down); });
  assert.equal(dialog(), null, '外を押すと閉じる');
  assert.equal(down.defaultPrevented, true, '押した所へ焦点を移させない（暗い所は焦点を受けず、body へ落ちてしまう）');
  assert.equal(document.activeElement, findRow(container), '焦点は Search の行へ戻る');
});

test('Search（DOM）: モーダルの中の、焦点を受けない所を押しても、焦点は枠が受ける。そこでも Esc で閉じる（body へ落ちて、狭い画面の引き出しごと閉じない）', async () => {
  const { container } = await open();
  assert.equal(dialog()!.getAttribute('tabindex'), '-1', '枠そのものが焦点を受けられる');
  await update(() => { dialog()!.focus(); });
  assert.equal(document.activeElement, dialog(), '焦点を受ける所が無いと、ブラウザは body へ落とす。枠が受ければ落ちない');
  const event = await pressOn(dialog()!, 'Escape');
  assert.equal(dialog(), null, '枠にあるときも Esc で閉じる');
  assert.equal(event.defaultPrevented, true);
  assert.equal(document.activeElement, findRow(container));
});

test('Search（DOM）: Tab は入力欄と × のあいだを回る（外へ出ない）。Shift+Tab も同じ', async () => {
  await open();
  assert.equal(document.activeElement, field());
  const first = await pressOn(field(), 'Tab');
  assert.equal(first.defaultPrevented, true, '外へ出さない');
  assert.equal(document.activeElement, closeButton());
  await pressOn(closeButton(), 'Tab');
  assert.equal(document.activeElement, field(), '× の次は入力欄へ戻る');
  await pressOn(field(), 'Tab', { shiftKey: true });
  assert.equal(document.activeElement, closeButton(), 'Shift+Tab でも外へ出ない');
});

test('Search（DOM）: マウスを乗せた行が選ぶ行になる（Enter でそれを開く）。すでに選んでいる行へ乗せても何も変えない', async () => {
  await open();
  assert.deepEqual(highlighted(), ['Loose talk']);
  await update(() => { options()[1]!.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true })); });
  assert.deepEqual(highlighted(), ['Fix the cart'], 'マウスを乗せた行');
  assert.equal(field().getAttribute('aria-activedescendant'), options()[1]!.id);
  await update(() => { options()[1]!.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true })); });
  assert.deepEqual(highlighted(), ['Fix the cart']);
  await press('Enter');
  assert.equal(window.location.hash, '#/c/c1aaaa');
});

test('Search（DOM）: Search の行は開いている間 aria-expanded=true（閉じれば false）。ダイアログを開くボタンだと伝える', async () => {
  const { container } = await open();
  const row = findRow(container);
  assert.equal(row.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(row.getAttribute('aria-expanded'), 'true');
  await press('Escape');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  await click(row);
  assert.equal(row.getAttribute('aria-expanded'), 'true');
});

test('Search（DOM）: いま開いている画面の行を選んだとき、モーダルは閉じて焦点は Search の行へ戻る。狭い画面の引き出しが開いていれば、引き出しも閉じる（hashchange を出して、アプリの閉じる処理に任せる）', async () => {
  const changes: string[] = [];
  const onChange = (e: Event) => { changes.push(e.type); };
  window.addEventListener('hashchange', onChange);
  try {
    window.location.hash = '#/';
    await wait(10);
    changes.length = 0;
    serve();
    const wide = await render(sidebarOf());
    await click(findRow(wide.container));
    await click(options().find(o => o.getAttribute('href') === '#/'));
    assert.equal(dialog(), null);
    assert.equal(document.activeElement, findRow(wide.container), '引き出しではない画面: 焦点は Search の行');
    assert.deepEqual(changes, [], '引き出しが開いていなければ、何も出さない');
    await wide.root.unmount();

    await wait(10);
    const drawer = await render(createElement('div', { className: 'ui-frame is-drawer-open' }, sidebarOf()));
    await click(findRow(drawer.container));
    await click(options().find(o => o.getAttribute('href') === '#/'));
    assert.equal(dialog(), null);
    assert.deepEqual(changes.filter(type => type === 'hashchange'), ['hashchange'], '開いている画面の行は、アドレスが変わらないので hashchange が出ない。引き出しを閉じるために 1 回だけ出す');

    changes.length = 0;
    await click(findRow(drawer.container));
    await click(options().find(o => o.getAttribute('href') === '#/c/c1aaaa'));
    assert.equal(window.location.hash, '#/c/c1aaaa');
    await wait(10);
    assert.deepEqual(changes.filter(type => type === 'hashchange').length, 1, '別の画面へ行くときは、ブラウザ自身の hashchange だけ（二重に出さない）');
  } finally { window.removeEventListener('hashchange', onChange); }
});

// ---- CSS（jsdom は CSS を当てないので、規則の文を読む。狭い画面の見た目は本物のブラウザで確かめる） ----

const frame = readFileSync(new URL('../web/src/ui/styles/frame.css', import.meta.url), 'utf8').replace(/\r/gu, '');
const bundleCss = readFileSync(new URL('../web/src/ui/styles/bundle.css', import.meta.url), 'utf8').replace(/\r/gu, '');

function mediaBlock(text: string, header: string): string {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `${header} が無い`);
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`${header} が閉じていない`);
}
const ruleBody = (text: string, selector: string): string => {
  const m = new RegExp(`(?:^|[}\\s])${selector.replace(/[.[\]]/gu, '\\$&')} \\{([^}]*)\\}`, 'u').exec(text);
  assert.ok(m, `${selector} の規則が無い`);
  return m[1]!;
};

test('Search（CSS）: 狭い画面（760px 以下）でも、モーダルの枠と角丸を戻す。設定の画面用の「border: 0; border-radius: 0」（.bt-modal）より詳しい書き方で、外側にも余白を残す', () => {
  const theirs = ruleBody(mediaBlock(bundleCss, '@media (max-width: 760px) {\n  .bt-scrim { padding: 0; }'), '.bt-modal');
  assert.match(theirs, /border: 0/u, '前提: 設定の画面は、狭い画面で枠も角丸もやめる');
  assert.match(theirs, /border-radius: 0/u);
  const narrow = mediaBlock(frame, '@media (max-width: 760px) { .ui-find__scrim');
  const mine = ruleBody(narrow, '.bt-modal.ui-find');
  assert.match(mine, /border: 1px solid var\(--line\)/u);
  assert.match(mine, /border-radius: var\(--radius-lg\)/u);
  assert.match(ruleBody(narrow, '.ui-find__scrim'), /padding: var\(--space-3\)/u, '画面の端に張り付かない');
  assert.match(ruleBody(frame, '.bt-modal.ui-find:focus'), /outline: none/u, '枠が焦点を受けても、枠線を出さない（中の入力欄・行が示す）');
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
