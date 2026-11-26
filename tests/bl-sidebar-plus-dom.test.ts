import { cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Conversation, Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import type { Route } from '../web/src/ui/routes.ts';

// サイドバーの + 印（backlog 366・持ち主の頼み 2026-11-26）: 製品ごとの「New session」の行をやめ、製品の行の + に置き換える。
// Products の見出しの + は New product、No product の見出しの + は New session。会話の題の左端は製品の名前の左端にそろえる。

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

afterEach(async () => {
  await cleanup();
  window.location.hash = '';
});

const product = (id: string, name: string, over: Partial<Project> = {}): Project => ({
  id, name, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});
const SHOP = product('p1aaaa', 'Shop', { waiting: { proposals: 1, questions: 1, pending: 0 } });
const BLOG = product('p2bbbb', 'Blog', { created_at: 2, folder_missing: true });
const SHOP_CHAT = { id: 'c1aaaa', title: 'Fix the cart', created_at: 0, last_message_at: 5, project_id: SHOP.id } as Conversation;
const LOOSE_CHAT = { id: 'c2bbbb', title: 'Loose talk', created_at: 0, last_message_at: 4, project_id: null } as unknown as Conversation;

const sidebarOf = (route: Route) => createElement(Sidebar, {
  state: 'idle', route, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: [SHOP_CHAT, LOOSE_CHAT], conversationsMore: {}, projects: [SHOP, BLOG], running: new Set<string>(), setupPending: false, onSetup: () => undefined,
});

const adds = (container: HTMLElement) => [...container.querySelectorAll<HTMLAnchorElement>('a.ui-side-add')];
const addNamed = (container: HTMLElement, label: string) => adds(container).find(a => a.getAttribute('aria-label') === label)!;
const rowOf = (container: HTMLElement, p: Project) => container.querySelector<HTMLAnchorElement>(`a.bt-side__home[href="#/p/${p.id}"]`)!.closest<HTMLElement>('.bt-side--product')!;
const headingOf = (container: HTMLElement, text: string) => [...container.querySelectorAll<HTMLElement>('.ui-sidebar__labelrow')].find(row => row.querySelector('.bt-label')?.textContent === text)!;
const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

test('ui/Sidebar（DOM）: 製品の行ごとに + のリンクがひとつ。名前のリンクの外・待ちの数のあとにあり、読み上げの名前に製品の名前が入る。行き先はその製品の新しい会話', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  for (const p of [SHOP, BLOG]) {
    const row = rowOf(container, p);
    const own = [...row.querySelectorAll<HTMLAnchorElement>('a.ui-side-add')];
    assert.equal(own.length, 1, `${p.name}: + はひとつ`);
    const add = own[0]!;
    assert.equal(add.getAttribute('href'), `#/p/${p.id}/new`);
    assert.equal(add.getAttribute('aria-label'), en['ui.session.newIn'](p.name));
    assert.equal(en['ui.session.newIn'](p.name), `New session in ${p.name}`);
    assert.ok(add.querySelector('svg.bt-icon'), '印（plus）だけを見せる');
    assert.equal(add.textContent, '', '見える文字は無い');
    const home = row.querySelector('a.bt-side__home')!;
    assert.ok(!home.contains(add), '名前のリンクの外（リンクの中にリンクを作らない）');
    assert.ok(follows(home, add), '名前のあと');
    const badge = row.querySelector('.bt-count');
    if (badge) assert.ok(follows(badge, add), '待ちの数のあと（右端は会話の行の「…」と同じ列）');
  }
  assert.ok(rowOf(container, SHOP).querySelector('.bt-count'), '前提: Shop には待ちの数がある');
  assert.ok(rowOf(container, BLOG).querySelector('.ui-side-missing'), '前提: Blog には folder missing の札がある');
});

test('ui/Sidebar（DOM）: 製品ごとの「New session」の行と、末尾の「New product」「New session」の行は無い。入口は + の 4 つだけ', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  assert.equal(container.querySelectorAll('.ui-side-new').length, 0);
  const rowNames = [...container.querySelectorAll('.bt-side .bt-side__name')].map(n => n.textContent);
  for (const gone of [en['ui.session.new'], en['ui.product.new']]) assert.ok(!rowNames.includes(gone), `「${gone}」の名前の行は無い`);
  assert.deepEqual(adds(container).map(a => a.getAttribute('aria-label')).sort(), [
    en['ui.product.new'], en['ui.session.new'], en['ui.session.newIn']('Blog'), en['ui.session.newIn']('Shop'),
  ].sort());
});

test('ui/Sidebar（DOM）: Products の見出しの + は New product（#/products/new）、No product の見出しの + は New session（#/）。どちらの見出しの横も + だけ（検索の虫めがねは置かない。検索は上の列の行）', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  const products = headingOf(container, en['ui.product.section']);
  const productAdd = products.querySelector<HTMLAnchorElement>('a.ui-side-add')!;
  assert.equal(productAdd.getAttribute('href'), '#/products/new');
  assert.equal(productAdd.getAttribute('aria-label'), en['ui.product.new']);
  assert.equal(products.querySelectorAll('a, button').length, 1, 'Products の見出しの横は + だけ');

  const noProduct = headingOf(container, en['ui.section.noProduct']);
  const sessionAdd = noProduct.querySelector<HTMLAnchorElement>('a.ui-side-add')!;
  assert.equal(sessionAdd.getAttribute('href'), '#/');
  assert.equal(sessionAdd.getAttribute('aria-label'), en['ui.session.new']);
  assert.equal(noProduct.querySelectorAll('a, button').length, 1, 'No product の見出しの横も + だけ（製品の側と製品でない側の見た目が同じ）');
  assert.equal(container.querySelectorAll('.ui-sidebar__labelrow button').length, 0, '見出しの横に検索のボタンは無い');
});

test('ui/Sidebar（DOM）: 開いている画面の + だけに選んでいる印（is-active・aria-current）が付く。ほかの画面では誰にも付かない', async () => {
  const marked = (container: HTMLElement) => adds(container).filter(a => a.classList.contains('is-active') || a.hasAttribute('aria-current')).map(a => a.getAttribute('aria-label'));
  const { container, root } = await render(sidebarOf({ view: 'productNew', id: SHOP.id }));
  assert.deepEqual(marked(container), [en['ui.session.newIn']('Shop')]);
  assert.equal(addNamed(container, en['ui.session.newIn']('Shop')).getAttribute('aria-current'), 'page');
  await update(() => root.render(sidebarOf({ view: 'new' })));
  assert.deepEqual(marked(container), [en['ui.session.new']]);
  await update(() => root.render(sidebarOf({ view: 'newProduct' })));
  assert.deepEqual(marked(container), [en['ui.product.new']]);
  await update(() => root.render(sidebarOf({ view: 'chat', id: SHOP_CHAT.id })));
  assert.deepEqual(marked(container), []);
  await update(() => root.render(sidebarOf({ view: 'product', id: SHOP.id })));
  assert.deepEqual(marked(container), [], '製品の画面（Overview）では + に印は付かない');
});

test('ui/Sidebar（DOM）: + を押すと、その製品の新しい会話（#/p/<id>/new）・New product・新しい会話（#/）へ移る', async () => {
  const { container } = await render(sidebarOf({ view: 'chat', id: SHOP_CHAT.id }));
  const go = async (label: string) => { window.location.hash = ''; await click(addNamed(container, label)); return window.location.hash; };
  assert.equal(await go(en['ui.session.newIn']('Shop')), `#/p/${SHOP.id}/new`);
  assert.equal(await go(en['ui.session.newIn']('Blog')), `#/p/${BLOG.id}/new`, '会話が無い製品でも同じ');
  assert.equal(await go(en['ui.product.new']), '#/products/new');
  assert.equal(await go(en['ui.session.new']), '#/');
});

test('ui/Sidebar（DOM）: + はキーボードで届く。本物のリンク（Enter で開く）で、tabindex も hidden も無く、焦点を受け、Tab の順は 製品の名前 → + → その製品の会話', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  for (const add of adds(container)) {
    assert.equal(add.tagName, 'A');
    assert.ok(add.hasAttribute('href'));
    assert.equal(add.tabIndex, 0, `${add.getAttribute('aria-label')}: Tab で止まる`);
    assert.ok(!add.hasAttribute('hidden') && add.getAttribute('aria-hidden') === null, '隠していない');
    await update(() => { add.focus(); });
    assert.ok(document.activeElement === add, `${add.getAttribute('aria-label')}: 焦点を受ける`);
  }
  const order = [...container.querySelectorAll<HTMLElement>('a[href], button')].filter(el => el.tabIndex === 0);
  const home = order.indexOf(container.querySelector<HTMLElement>(`a.bt-side__home[href="#/p/${SHOP.id}"]`)!);
  const add = order.indexOf(addNamed(container, en['ui.session.newIn']('Shop')));
  const session = order.indexOf(container.querySelector<HTMLElement>(`a[href="#/c/${SHOP_CHAT.id}"]`)!);
  assert.ok(home >= 0 && home < add && add < session, `Tab の順: ${home} < ${add} < ${session}`);
});


// ---- CSS（jsdom は CSS を当てないので、規則の文を読む。広さの実測は本物のブラウザで: 製品の名前も会話の題も左端 44px） ----

const css = (name: string) => readFileSync(new URL(`../web/src/ui/styles/${name}`, import.meta.url), 'utf8').replace(/\r/gu, '');
const nav = css('product-nav.css');
const bundle = css('bundle.css');

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
const rule = (text: string, selector: string): string => {
  const line = text.split('\n').find(l => l.startsWith(`${selector} {`));
  assert.ok(line, `${selector} の規則が無い`);
  return line;
};
const px = (text: string, property: string): number => {
  const m = new RegExp(`(?:^|[ {;])${property}: (-?\\d+)px`, 'u').exec(text);
  assert.ok(m, `${property}: ◯px が無い: ${text}`);
  return Number(m[1]);
};
const sideMargin = (text: string): number => {
  const m = /margin: 0 (-?\d+)px/u.exec(text);
  assert.ok(m, `margin: 0 ◯px が無い: ${text}`);
  return Number(m[1]);
};

test('ui/Sidebar（CSS）: + は隠さない（opacity 0・幅 0・display none の規則が無い）。いつも見え、Tab でも触でも届く', () => {
  const rules = nav.split('\n').filter(line => line.includes('ui-side-add'));
  assert.ok(rules.length >= 2, '+ の規則を読めていない');
  for (const line of rules) assert.doesNotMatch(line, /opacity: 0|width: 0|display: none|visibility: hidden/u, line);
});

test('ui/Sidebar（CSS）: 狭い画面・タッチでは + も、見出しの横の検索も 40px 角。.bt-btn--icon.bt-btn--sm（26px）より詳しい書き方で、負けない', () => {
  const touch = mediaBlock(nav, '@media (pointer: coarse), (max-width: 760px) {');
  const sized = [...touch.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(m => ({ selector: m[1]!.trim(), body: m[2]! })).find(r => r.selector.includes('ui-side-add'));
  assert.ok(sized, '狭い画面向けの + の規則');
  assert.match(sized.body, /width: 40px/u);
  assert.match(sized.body, /height: 40px/u);
  for (const part of sized.selector.split(',').map(s => s.trim())) assert.ok(part.split('.').length - 1 >= 3, `${part}: クラスが 3 つ以上（.bt-btn--icon.bt-btn--sm の 2 つより詳しい）`);
  assert.ok(sized.selector.includes('ui-sidebar__labelrow'), '見出しの横の検索も同じ大きさ');
  assert.match(rule(bundle, '.bt-btn--icon.bt-btn--sm'), /width: 26px/u, '前提: 広い画面の小さい印は 26px');
});

test('ui/Sidebar（CSS）: 会話の題の左端 = 製品の名前の左端。行の左の余白・印が取る幅・すき間が同じで、広い画面も狭い・タッチも成り立つ', () => {
  const side = rule(bundle, '.bt-side');
  const home = rule(bundle, '.bt-side__home');
  const link = rule(nav, '.ui-side-row__link');
  const gap = (line: string) => /gap: (var\(--space-\d\))/u.exec(line)?.[1];
  assert.equal(/padding: 0 (var\(--space-\d\))/u.exec(side)?.[1], /padding-left: (var\(--space-\d\))/u.exec(link)?.[1], '行の左の余白: 製品の行（.bt-side）と会話のリンクが同じ');
  assert.ok(gap(side) && gap(side) === gap(home) && gap(home) === gap(link), '印と名前のすき間は 3 つとも同じ');
  assert.match(rule(nav, '.bt-side--session.ui-side-row'), /padding: 0 var\(--space-1\) 0 0;/u, '会話の行そのものは左の余白を持たない（リンクの中で決める）');

  const mark = rule(bundle, '.bt-side__ov');
  const dot = px(rule(bundle, '.bt-side__state'), 'width');
  const takes = (width: number) => width + 2 * sideMargin(mark);
  const wide = dot + 2 * sideMargin(rule(nav, '.ui-side-row__link .bt-side__state'));
  assert.equal(wide, takes(px(mark, 'width')), `広い画面: 点の枠 ${wide}px = 製品の印が行の中で取る幅`);

  const coarseMark = px(bundle.split('\n').find(l => l.startsWith('@media (pointer: coarse) { .bt-side__ov {'))!, 'width');
  const narrowMark = px(mediaBlock(nav, '@media (max-width: 760px) {').split('\n').find(l => l.includes('.ui-frame .bt-side__ov'))!, 'width');
  assert.equal(coarseMark, narrowMark, '前提: タッチと狭い画面の印は同じ大きさ');
  const touchDot = dot + 2 * sideMargin(mediaBlock(nav, '@media (pointer: coarse), (max-width: 760px) {').split('\n').find(l => l.includes('.ui-side-row__link .bt-side__state'))!);
  assert.equal(touchDot, takes(coarseMark), `狭い画面・タッチ: 点の枠 ${touchDot}px = 製品の印が行の中で取る幅`);
});
