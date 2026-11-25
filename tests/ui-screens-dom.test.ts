import { cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Acceptance, Conversation, Project } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import { PLAN_EDITS, planDrafts, planStays } from '../web/src/ui/plan.ts';
import type { Route } from '../web/src/ui/routes.ts';
import { clearUnsaved, hasUnsavedEdits, leaveAsks, SCREEN_EDITS } from '../web/src/ui/unsaved.ts';

interface PlanProps { productId: string; conversationId?: string; revision: string; isGit: boolean }
interface HomeProps { id: string; project: Project | undefined; conversations: Conversation[]; drafts: never[]; checklists: ReadonlyMap<string, never[]>; worker: null; revision: number }
interface ArchivedProps { revision: number; projects: readonly Project[]; projectsLoaded: boolean }

const { PlanPane } = await loadTsx<{ PlanPane: ComponentType<PlanProps> }>('../web/src/ui/panes/PlanPane.tsx', import.meta.url);

const { Archived } = await loadTsx<{ Archived: ComponentType<ArchivedProps> }>('../web/src/ui/screens/Archived.tsx', import.meta.url);

const { ProductHome } = await loadTsx<{ ProductHome: ComponentType<HomeProps> }>('../web/src/ui/screens/ProductHome.tsx', import.meta.url);

const { Sidebar } = await loadTsx<{ Sidebar: ComponentType<Record<string, unknown>> }>('../web/src/ui/Sidebar.tsx', import.meta.url);

const PRODUCT = 'prod-abc123';
const realFetch = globalThis.fetch;

const refuse = (status: number, body: unknown) => ({ refused: true, status, body });

const never = () => new Promise<never>(() => undefined);

function serve(routes: (path: string, method: string) => unknown): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const out = await routes(String(path), init?.method ?? 'GET') as { refused?: boolean; status?: number; body?: unknown } | undefined;
    if (out?.refused) return new Response(JSON.stringify(out.body), { status: out.status ?? 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.location.hash = '';
  localStorage.clear();
});

test('ui/PlanPane（DOM）: Build の知らせ（changed・frozen）は、前から置いてある role="status" の入れ物の中に出る（backlog 406）', async () => {
  const acceptance: Acceptance = { version: 1, language: 'en', items: [], not_doing: [], draft: false, hash: 'a1', frozen: null } as unknown as Acceptance;
  const refusals = ['build.changed', 'build.frozen'];
  serve((path, method) => {
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/plan`) return { plan: { content: '# Parser', hash: 'p1', updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false } };
    if (path.split('?')[0] === `/api/projects/${PRODUCT}/acceptance`) return { acceptance };
    if (path === `/api/projects/${PRODUCT}/acceptance/versions`) return { versions: [] };
    if (path === `/api/projects/${PRODUCT}/build` && method === 'POST') return refuse(409, { error: 'refused', code: refusals.shift() });
    return undefined;
  });
  const { container } = await render(createElement(PlanPane, { productId: PRODUCT, conversationId: 'aaaaaaaa-0000-4000-8000-000000000001', revision: '0', isGit: true }));
  await settle();
  await settle();
  const live = container.querySelector('[role="status"].ui-plan__live');
  assert.ok(live, '知らせの前から入れ物がある');
  assert.equal(live.textContent, '');
  const build = [...container.querySelectorAll('button')].find(b => b.textContent === 'Build with this plan');
  await click(build);
  await settle();
  await settle();
  assert.ok(container.querySelector('[role="status"].ui-plan__live') === live, '同じ入れ物のまま');
  assert.equal(live.querySelector('.bt-notice')?.textContent, en['ui.plan.buildChanged'], '知らせは入れ物の中');
  await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Build with this plan'));
  await settle();
  await settle();
  assert.ok(container.querySelector('[role="status"].ui-plan__live') === live, '2 つ目の知らせも同じ入れ物');
  assert.match(live.querySelector('.bt-notice')?.textContent ?? '', new RegExp(`^${en['ui.plan.buildFrozen']}`, 'u'));
});

test('ui/PlanPane（DOM, R2）: 会話 A の書きかけは A のもの。B へ移ると「離れますか」の対象になり、B には A の書きかけが出ず、A に戻ると書きかけが戻る', async () => {
  const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
  const acceptance = { version: 0, language: 'en', items: [], not_doing: [], draft: true, hash: 'a0', frozen: null } as unknown as Acceptance;
  const planOf: Record<string, string> = { [A]: '# Plan of A', [B]: '# Plan of B' };
  serve(path => {
    const [route, query] = path.split('?');
    if (route === `/api/projects/${PRODUCT}/plan`) {
      const id = new URLSearchParams(query).get('conversationId') ?? '';
      return { plan: { content: planOf[id], hash: `h-${id}`, updated_at: 1, updated_by: 'owner', tainted: false, writing: false, reviewLocked: false, built_hash: null } };
    }
    if (route === `/api/projects/${PRODUCT}/acceptance`) return { acceptance };
    if (route === `/api/projects/${PRODUCT}/acceptance/versions`) return { versions: [] };
    return undefined;
  });
  const pane = (conversationId: string) => createElement(PlanPane, { key: `${PRODUCT}:${conversationId}`, productId: PRODUCT, conversationId, revision: '0', isGit: true });
  const editor = (container: HTMLElement) => container.querySelector<HTMLTextAreaElement>('textarea.ui-plan__editor');
  const { container, root } = await render(pane(A));
  await settle();
  await settle();
  await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Edit'));
  await input(editor(container), '# Plan of A\n\nhalf-written step');
  try {
    const kept = planStays({ view: 'chat', id: A }, { view: 'chat', id: B });
    assert.equal(leaveAsks(hasUnsavedEdits(SCREEN_EDITS, kept === null ? undefined : PLAN_EDITS + kept), { view: 'chat', id: A }, { view: 'chat', id: B }), true, 'moving to B asks first');
    await update(() => root.render(pane(B)));
    await settle();
    await settle();
    assert.equal(editor(container) === null, true, 'B opens to read, not to the draft of A');
    assert.match(container.textContent ?? '', /Plan of B/u);
    assert.doesNotMatch(container.textContent ?? '', /half-written step/u);
    await update(() => root.render(pane(A)));
    await settle();
    await settle();
    assert.equal(editor(container)?.value, '# Plan of A\n\nhalf-written step', 'back in A the draft is there again');
  } finally {
    clearUnsaved('');
    planDrafts.clear();
  }
});

const SHELF = 'prod-shelf01';
const shelvedProduct = { id: SHELF, name: 'Old shop', archived_at: 5 } as Project;
const archivedSession = { id: 'c1', title: 'Pricing notes', project_id: SHELF, archived_at: Date.now() - 1000, message_count: 3 } as unknown as Conversation;
const metaOf = (container: HTMLElement) => container.querySelector('.ui-lib__archived .bt-row__sub')?.textContent ?? '';

test('ui/Archived（DOM）: しまった製品の札は、しまった製品の一覧が届いてから決める。読めなければ名前なしの札にし、前に読めた一覧は消さない（backlog 308）', async () => {
  let shelvedReads = 0;
  serve(path => {
    if (path === '/api/conversations?archived=1') return { conversations: [archivedSession] };
    if (path === '/api/projects?archived=1') { shelvedReads += 1; return shelvedReads === 1 ? { projects: [shelvedProduct] } : refuse(500, { error: 'down' }); }
    return undefined;
  });
  const first = await render(createElement(Archived, { revision: 0, projects: [], projectsLoaded: true }));
  await update(() => new Promise(resolve => setTimeout(resolve, 150)));
  await settle();
  assert.match(metaOf(first.container), /^Old shop · archived · /u);
  await update(() => first.root.render(createElement(Archived, { revision: 1, projects: [], projectsLoaded: true })));
  await update(() => new Promise(resolve => setTimeout(resolve, 150)));
  await settle();
  assert.equal(shelvedReads, 2);
  assert.match(metaOf(first.container), /^Old shop · archived · /u, '読み直しに失敗しても、前に読めた一覧のまま');
  await cleanup();

  serve(path => {
    if (path === '/api/conversations?archived=1') return { conversations: [archivedSession] };
    if (path === '/api/projects?archived=1') return refuse(500, { error: 'down' });
    return undefined;
  });
  const failed = await render(createElement(Archived, { revision: 0, projects: [], projectsLoaded: true }));
  await update(() => new Promise(resolve => setTimeout(resolve, 150)));
  await settle();
  assert.match(metaOf(failed.container), /^archived product · /u, '初めて読めなければ名前なしの札');
});

test('ui/Archived（DOM）: 動いている製品の一覧が届く前は、しまった印の無い製品に札を付けない（backlog 502）', async () => {
  const active = { id: PRODUCT, name: 'Parser', archived_at: null } as Project;
  serve(path => {
    if (path === '/api/conversations?archived=1') return { conversations: [{ ...archivedSession, project_id: PRODUCT }] };
    if (path === '/api/projects?archived=1') return { projects: [active] };
    return undefined;
  });
  const { container, root } = await render(createElement(Archived, { revision: 0, projects: [], projectsLoaded: false }));
  await update(() => new Promise(resolve => setTimeout(resolve, 150)));
  await settle();
  assert.match(metaOf(container), /^3 /u, '札を出さない');
  await update(() => root.render(createElement(Archived, { revision: 0, projects: [active], projectsLoaded: true })));
  assert.match(metaOf(container), /^Parser · 3 /u);
});

test('ui/Archived（DOM）: しまった製品の一覧がまだ無いうちに Restore したら、そのときに読みに行き、戻した先の製品の名前を知らせる（backlog 308）', async () => {
  const seen: FeedbackItem[] = [];
  const stop = subscribe(item => { seen.push(item); });
  let shelvedReads = 0;
  try {
    serve((path, method) => {
      if (path === '/api/conversations?archived=1') return { conversations: [archivedSession] };
      if (path === '/api/projects?archived=1') { shelvedReads += 1; return shelvedReads === 1 ? never() : { projects: [shelvedProduct] }; }
      if (path === '/api/conversations/c1' && method === 'PATCH') return { ok: true };
      return undefined;
    });
    const { container } = await render(createElement(Archived, { revision: 0, projects: [], projectsLoaded: true }));
    await update(() => new Promise(resolve => setTimeout(resolve, 150)));
    await settle();
    assert.match(metaOf(container), /^3 /u, '届くまでは札を決めない');
    await click([...container.querySelectorAll('button')].find(b => b.textContent === 'Restore'));
    await settle();
    await settle();
    assert.equal(shelvedReads, 2, 'Restore のときにもう一度読む');
    assert.equal(seen.at(-1)?.body, en['ui.pf.restoredUnder']('Old shop'));
  } finally {
    stop();
  }
});

test('ui/Archived（DOM）: 製品の会話を消す確認には、その会話の計画・控え・下書きの一覧も消えると出す。製品の無い会話はいつもの文のまま', async () => {
  const loose = { ...archivedSession, id: 'c2', title: 'Loose talk', project_id: null };
  serve(path => {
    if (path === '/api/conversations?archived=1') return { conversations: [archivedSession, loose] };
    if (path === '/api/projects?archived=1') return { projects: [shelvedProduct] };
    return undefined;
  });
  const { container } = await render(createElement(Archived, { revision: 0, projects: [], projectsLoaded: true }));
  await update(() => new Promise(resolve => setTimeout(resolve, 150)));
  await settle();
  const deleteOf = (name: string) => [...container.querySelectorAll('.ui-lib__archived')].find(row => row.textContent?.includes(name))?.querySelector<HTMLButtonElement>('.bt-btn--danger');
  await click(deleteOf('Pricing notes'));
  assert.ok(container.textContent?.includes(en['ui.session.deleteWhatProduct']), 'product conversation');
  assert.match(en['ui.session.deleteWhatProduct'], /plan of this conversation with its saved versions and its draft acceptance list/u);
  await click(deleteOf('Loose talk'));
  assert.ok(container.textContent?.includes(en['ui.session.deleteWhat']), 'conversation without a product');
  assert.equal(container.textContent?.includes(en['ui.session.deleteWhatProduct']), false);
});

test('ui/ProductHome（DOM）: 知らない製品の ID で開いても、最後に見た時刻 beat.lastLook.<ID> を書かない。製品が分かったら書く（backlog 302）', async () => {
  serve(path => {
    if (path.startsWith('/api/tasks/finished')) return { tasks: [], next: null, total: 0 };
    if (path.startsWith('/api/tasks')) return { active: [], finished: [], awaiting: [] };
    if (path.startsWith('/api/runs')) return { runs: [], total: 0, judged: {} };
    return {};
  });
  const key = `beat.lastLook.${PRODUCT}`;
  const parser: Project = {
    id: PRODUCT, name: 'Parser', root: '/w/parser', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
    is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
  };
  const props = { id: PRODUCT, conversations: [], drafts: [], checklists: new Map(), worker: null, revision: 0 };
  await render(createElement(ProductHome, { ...props, project: undefined }));
  await settle();
  window.dispatchEvent(new window.Event('pagehide'));
  await cleanup();
  assert.equal(localStorage.getItem(key), null, '閉じても、ページを離れても書かない');

  const later = await render(createElement(ProductHome, { ...props, project: undefined }));
  await settle();
  await update(() => later.root.render(createElement(ProductHome, { ...props, project: parser })));
  await settle();
  window.dispatchEvent(new window.Event('pagehide'));
  assert.match(localStorage.getItem(key) ?? '', /^\d+$/u, '製品が分かったあとは書く');
});

test('ui/Sidebar（DOM）: 検索の失敗は「0 件」と分けて Could not load を出す。知らせは、検索を開いたときからある role="status" の入れ物の中に出る（backlog 242）', async () => {
  let fail = true;
  serve(path => {
    if (path.startsWith('/api/history?q=')) return fail ? refuse(500, { error: 'down' }) : { hits: [] };
    return undefined;
  });
  const { container } = await render(createElement(Sidebar, {
    state: 'idle', route: { view: 'new' }, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
    conversations: [], conversationsMore: {}, projects: [], running: new Set(), setupPending: false, onSetup: () => undefined,
  }));
  await click(container.querySelector('button[aria-label="Search sessions"]'));
  const status = container.querySelector('.ui-search [role="status"]');
  assert.ok(status, '打つ前から入れ物がある');
  assert.equal(status.textContent, '');
  await input(container.querySelector('input[aria-label="Search past sessions"]'), 'pricing');
  await update(() => new Promise(resolve => setTimeout(resolve, 300)));
  await settle();
  assert.ok(container.querySelector('.ui-search [role="status"]') === status, '同じ入れ物のまま');
  assert.equal(status.textContent, 'Could not load');
  fail = false;
  await input(container.querySelector('input[aria-label="Search past sessions"]'), 'pricing notes');
  await update(() => new Promise(resolve => setTimeout(resolve, 300)));
  await settle();
  assert.equal(status.textContent, 'No matches', '0 件は失敗と分ける');
});

const sideProject = (id: string, name: string, over: Partial<Project> = {}): Project => ({
  id, name, root: `C:\work\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});
const SHOP = sideProject('p1aaaa', 'Shop', { created_at: 1, waiting: { proposals: 1, questions: 1, pending: 0 } });
const BLOG = sideProject('p2bbbb', 'Blog', { created_at: 2, folder_missing: true });
const SHOP_CHAT: Conversation = { id: 'c1aaaa', title: 'Fix the cart', created_at: 0, last_message_at: 5, project_id: SHOP.id };

const sidebarOf = (route: Route) => createElement(Sidebar, {
  state: 'idle', route, foot: { kind: 'idle' }, kanban: 0, questions: 0, pending: 0, sessionPending: new Map(), drafts: 0, unread: 0,
  conversations: [SHOP_CHAT], conversationsMore: {}, projects: [SHOP, BLOG], running: new Set(), setupPending: false, onSetup: () => undefined,
});
const productRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.bt-side--product')];

test('ui/Sidebar（DOM）: 製品の行のリンクはひとつで、マークと名前が同じリンクの中。行き先は製品の画面。選んでいる・待ちの印と読み上げの名前はそのリンクにある', async () => {
  const { container, root } = await render(sidebarOf({ view: 'new' }));
  const [shop, blog] = productRows(container);
  assert.ok(shop && blog, '製品 2 つの行');
  for (const [row, product] of [[shop, SHOP], [blog, BLOG]] as const) {
    const links = row.querySelectorAll('a');
    assert.equal(links.length, 1, `${product.name}: 行のリンクはひとつ`);
    const link = links[0]!;
    assert.equal(link.getAttribute('href'), `#/p/${product.id}`);
    assert.ok(link.querySelector('svg.bt-icon'), `${product.name}: マークはリンクの中`);
    assert.equal(link.textContent, product.name, `${product.name}: 名前はリンクの中（見える文字は名前だけ）`);
    assert.equal(container.querySelectorAll(`a[href="#/p/${product.id}"]`).length, 1, `${product.name}: 製品の画面へのリンクはほかに無い`);
  }
  const shopLink = shop.querySelector('a')!;
  const blogLink = blog.querySelector('a')!;
  assert.ok(shopLink.classList.contains('has-waiting'), '待ちがある製品のリンクに待ちの印');
  assert.ok(!blogLink.classList.contains('has-waiting'));
  assert.equal(shopLink.getAttribute('aria-label'), 'Overview of Shop, something is waiting');
  assert.equal(blogLink.getAttribute('aria-label'), 'Overview of Blog');
  assert.ok(shopLink.getAttribute('aria-label')!.includes(shopLink.textContent!), '読み上げの名前に見える名前が入っている');
  assert.ok(shop.querySelector('.bt-count'), '待ちの数はそのまま出る');
  assert.equal(blog.querySelector('.ui-side-missing')?.textContent, en['ui.product.folderMissing'], 'folder missing の札はそのまま出る');
  for (const link of [shopLink, blogLink]) assert.ok(!link.classList.contains('is-active') && !link.hasAttribute('aria-current'), '製品の画面でなければ選んでいる印は無い');

  await update(() => root.render(sidebarOf({ view: 'product', id: SHOP.id })));
  assert.ok(shopLink.classList.contains('is-active'), '製品の画面を開いているときは、そのリンクが選んでいる印');
  assert.equal(shopLink.getAttribute('aria-current'), 'page');
  assert.ok(!blogLink.classList.contains('is-active') && !blogLink.hasAttribute('aria-current'), 'ほかの製品には付けない');

  for (const route of [{ view: 'productNew', id: SHOP.id }, { view: 'chat', id: SHOP_CHAT.id }] as const) {
    await update(() => root.render(sidebarOf(route)));
    assert.ok(!shopLink.classList.contains('is-active') && !shopLink.hasAttribute('aria-current'), `${route.view}: 製品の画面ではないので選んでいる印は無い`);
  }
});

test('ui/Sidebar（DOM）: 製品の行のマークを押しても名前を押しても製品の画面（#/p/<id>）が開く。会話の行と New session の行き先は今までどおり', async () => {
  const { container } = await render(sidebarOf({ view: 'new' }));
  const [shop, blog] = productRows(container);
  assert.ok(shop && blog);
  const open = async (target: Element | null) => { window.location.hash = ''; await click(target); return window.location.hash; };
  assert.equal(await open(shop.querySelector('.bt-side__name')), `#/p/${SHOP.id}`, '名前（会話がある製品）');
  assert.equal(await open(shop.querySelector('svg.bt-icon')), `#/p/${SHOP.id}`, 'マーク');
  assert.equal(await open(blog.querySelector('.bt-side__name')), `#/p/${BLOG.id}`, '名前（会話が無い製品）');
  assert.equal(await open(blog.querySelector('svg.bt-icon')), `#/p/${BLOG.id}`, 'マーク（会話が無い製品）');

  const chat = container.querySelector('a[href="#/c/c1aaaa"]');
  assert.equal(chat?.textContent, SHOP_CHAT.title, '製品の会話の行はそのまま並ぶ');
  assert.equal(await open(chat), '#/c/c1aaaa');
  const fresh = [...container.querySelectorAll(`a[href="#/p/${SHOP.id}/new"]`)];
  assert.equal(fresh.length, 1, 'この製品の New session の行はそのまま');
  assert.ok(fresh[0]!.textContent!.includes(en['ui.session.new']));
  assert.equal(await open(fresh[0]!), `#/p/${SHOP.id}/new`);
});
