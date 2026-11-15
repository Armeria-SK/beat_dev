import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';
import type { Conversation, Project } from '../web/src/api.ts';
import { ONBOARD_DONE_HASH } from '../web/src/ui/onboarding-steps.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';
import { clearUnsaved, SCREEN_EDITS, setUnsaved } from '../web/src/ui/unsaved.ts';

const { App } = await loadTsx<{ App: ComponentType }>('../web/src/ui/App.tsx', import.meta.url);

const g = globalThis as Record<string, unknown>;
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
g.EventSource = class { onmessage = null; onerror = null; onopen = null; addEventListener() {} removeEventListener() {} close() {} };
const observed: Array<{ run: () => void; el: Element }> = [];
g.ResizeObserver = class { readonly #run: () => void; constructor(run: () => void) { this.#run = run; } observe(el: Element) { observed.push({ run: this.#run, el }); } unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
const realGo = window.history.go;
const never = () => new Promise<never>(() => undefined);

interface Call { method: string; path: string }
let calls: Call[] = [];

function serve(routes: (path: string, method: string) => unknown = () => undefined): void {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, path: String(path) });
    let out = await routes(String(path), method);
    if (out === undefined && String(path) === '/api/onboarding') out = { done: true, steps: { user: true, identity: true, persona: true, model: true } };
    if (out === undefined && String(path) === '/api/settings') out = { config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' };
    if (out === undefined && String(path) === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    return new Response(JSON.stringify(out ?? { error: 'not found' }), { status: out === undefined ? 404 : 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const wait = (ms: number) => update(() => new Promise(resolve => setTimeout(resolve, ms)));
const esc = async (target: EventTarget = document.body): Promise<KeyboardEvent> => {
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await update(() => { target.dispatchEvent(event); });
  return event;
};
const posted = (path: string) => calls.filter(c => c.method === 'POST' && c.path === path).length;
const onboarding = (container: HTMLElement) => container.querySelector('.ui-onboard');

async function start(hash = '#/') {
  window.history.replaceState(null, '', `/${hash}`);
  const { container } = await render(createElement(App));
  await settle();
  await settle();
  return container;
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  window.history.go = realGo;
  delete g.navigation;
  calls = [];
  observed.length = 0;
  localStorage.clear();
  clearUnsaved('');
  window.history.replaceState(null, '', '/');
});

const firstRun = { done: false, steps: { user: false, identity: false, persona: false, model: false } };

test('ui/onboarding（DOM）: 初めてのはじめの設定は自動で開き、Esc と Skip for now で閉じる。閉じても「済み」にせず、次の読み込みでは勝手に開かない', async () => {
  serve(path => (path === '/api/onboarding' ? firstRun : undefined));
  let container = await start();
  assert.ok(onboarding(container), '初めては自動で開く');
  const closed = await esc();
  assert.equal(closed.defaultPrevented, true);
  assert.equal(onboarding(container), null, 'Esc で閉じる');
  assert.equal(posted('/api/onboarding/done'), 0, '閉じても「済み」にしない');
  await cleanup();
  container = await start();
  assert.equal(onboarding(container), null, '閉じたあとの読み込みでは開かない');
  await cleanup();

  localStorage.clear();
  container = await start();
  await click(byText(container, 'button', 'Skip for now'));
  assert.equal(onboarding(container), null, 'Skip で閉じる');
  assert.equal(posted('/api/onboarding/done'), 0);
  assert.equal(localStorage.getItem('beat.onboardingSeen'), '1', '閉じたと覚える');
  assert.notEqual(window.location.hash, ONBOARD_DONE_HASH, '済んだときの行き先（New product）へは行かない');
});

test('ui/onboarding（DOM）: 「済み」にするのは最後の段の New product だけ', async () => {
  serve(path => {
    if (path === '/api/onboarding') return { done: false, steps: { user: true, identity: true, persona: true, model: true } };
    if (path === '/api/onboarding/done') return { done: true, steps: { user: true, identity: true, persona: true, model: true } };
    return undefined;
  });
  const container = await start();
  assert.ok(onboarding(container), '続きの段（hello）で開く');
  await click(byText(container, 'button', 'New product'));
  await settle();
  assert.equal(posted('/api/onboarding/done'), 1);
  assert.equal(onboarding(container), null);
  assert.equal(window.location.hash, ONBOARD_DONE_HASH, '済んだら製品を作る画面へ移る');
});

test('ui/onboarding（DOM）: 送っている最中の Esc では、はじめの設定を閉じない（App は受け済みの Esc で閉じない）', async () => {
  serve((path, method) => {
    if (path === '/api/onboarding') return firstRun;
    if (path === '/api/onboarding/persona' && method === 'POST') return never();
    return undefined;
  });
  const container = await start();
  await input(onboarding(container)?.querySelector('.bt-onboard__step.is-current input'), 'Sam');
  await click(byText(container, 'button', 'Continue'));
  await settle();
  assert.equal(posted('/api/onboarding/persona'), 1, '送っている');
  const event = await esc();
  assert.equal(event.defaultPrevented, true);
  assert.ok(onboarding(container), '閉じない');
});

async function leaveSteps(sameRouteJump: boolean): Promise<number[]> {
  const nav = { currentEntry: { index: 0 } };
  g.navigation = nav;
  serve();
  await start('#/kanban');
  nav.currentEntry.index = 1;
  await update(() => { window.location.hash = '#/memory'; });
  await wait(10);
  if (sameRouteJump) {
    nav.currentEntry.index = 3;
    await update(() => { window.dispatchEvent(new window.PopStateEvent('popstate')); });
  }
  const went: number[] = [];
  window.history.go = (by?: number) => { went.push(by ?? 0); };
  setUnsaved(`${SCREEN_EDITS}probe`, true);
  nav.currentEntry.index += 1;
  await update(() => { window.location.hash = '#/skills'; });
  await wait(10);
  await cleanup();
  clearUnsaved('');
  window.history.go = realGo;
  return went;
}

test('書きかけの確かめ（DOM）: App は動きを受け入れるたびに履歴の位置と経路を覚え直し、書きかけの画面から出る動きを、その位置からの歩数だけ戻す（同じ経路どうしの行き来のあとも）', async () => {
  assert.deepEqual(await leaveSteps(false), [-1], '受け入れた動きの位置から 1 歩');
  assert.deepEqual(await leaveSteps(true), [-1], '同じ経路の別の履歴へ動いたあとも、その位置から 1 歩');
});

test('ui/Archived（DOM）: App は、動いている製品の一覧が届いたかどうかを Archived に渡す（届く前は、しまった印の無い製品に札を付けない。backlog 502）', async () => {
  const active = { id: 'prod-abc123', name: 'Parser', archived_at: null } as Project;
  const session = { id: 'c1', title: 'Pricing notes', project_id: active.id, archived_at: Date.now() - 1000, message_count: 3 } as unknown as Conversation;
  serve(path => {
    if (path === '/api/projects') return never();
    if (path === '/api/projects?archived=1') return { projects: [active] };
    if (path === '/api/conversations?archived=1') return { conversations: [session] };
    return undefined;
  });
  const container = await start('#/archived');
  await wait(150);
  await settle();
  assert.match(container.querySelector('.ui-lib__archived .bt-row__sub')?.textContent ?? '', /^3 /u);
});

interface ConversationProps {
  id: string | null; listTitle: string | null; product?: Project | undefined; draft: unknown; notices: never[]; liveChecklist: Array<{ text: string; status: string }> | undefined;
  revision: number; disconnected: boolean; onReconnect: () => void; onClearNotices: (id: string) => void; onInterrupt: (id: string, on: boolean) => void;
}
const { Conversation: Chat } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const chatRow = { id: 'c1', title: 'Pricing', project_id: null, archived: 0, has_summary: false, created_at: 1, updated_at: 1 } as unknown as Conversation;
const shop = { id: 'p1aaaa', name: 'Shop', has_plan: true } as unknown as Project;

async function openChat(over: Partial<ConversationProps> = {}, read: Array<{ text: string; status: string }> = []) {
  serve(path => {
    if (path === '/api/conversations/c1/messages') return { conversation: chatRow, messages: [], pending: [], activeRun: null };
    if (path === '/api/conversations/c1/checklist') return { items: read, tainted: false, updatedAt: read.length ? 1 : null };
    if (path === '/api/models') return { models: [], routing: { chat: [], background: [] } };
    return undefined;
  });
  const { container } = await render(createElement(Chat, {
    id: 'c1', listTitle: 'Pricing', draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false,
    onReconnect: () => undefined, onClearNotices: () => undefined, onInterrupt: () => undefined, ...over,
  }));
  await settle();
  await settle();
  return container;
}

async function slash(container: HTMLElement, text: string) {
  const box = container.querySelector('textarea')!;
  await input(box, text);
  await update(() => { box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
}

test('ui/product-nav（DOM）: 入力欄の /new は、製品の会話からならその製品の新しい会話へ、製品でなければ #/ へ', async () => {
  let container = await openChat({ product: shop });
  await slash(container, '/new');
  assert.equal(window.location.hash, '#/p/p1aaaa/new');
  await cleanup();
  window.history.replaceState(null, '', '/#/c/c1');
  container = await openChat();
  await slash(container, '/new');
  assert.equal(window.location.hash, '#/');
});

const draft = { runId: 'r1', conversationId: 'c1', modelId: 'm', text: '' };
const items = (container: HTMLElement) => [...container.querySelectorAll('section.bt-checklist')];

test('作業の一覧の置き場所（DOM）: 実行中は会話の外、入力欄（Composer）の直前に 1 つ。出来事の一覧が届いていればそれを、無ければ開いたときに読んだ一覧を出す。終わったあとは会話の中', async () => {
  const read = [{ text: 'Read the old notes', status: 'done' }, { text: 'Write the summary', status: 'pending' }];
  const live = [{ text: 'Check prices', status: 'in_progress' }];
  let container = await openChat({ draft, liveChecklist: live }, read);
  let lists = items(container);
  assert.equal(lists.length, 1);
  assert.equal(lists[0]!.closest('.bt-thread'), null, '会話の中ではない');
  assert.ok(lists[0]!.nextElementSibling?.querySelector('textarea'), '入力欄のすぐ上');
  assert.match(lists[0]!.textContent ?? '', /Check prices/u, '出来事の一覧が先');
  assert.doesNotMatch(lists[0]!.textContent ?? '', /Read the old notes/u);
  await cleanup();

  container = await openChat({ draft }, read);
  lists = items(container);
  assert.equal(lists.length, 1);
  assert.match(lists[0]!.textContent ?? '', /Read the old notes/u, '出来事が無ければ読んだ一覧');
  await cleanup();

  container = await openChat({}, read);
  lists = items(container);
  assert.equal(lists.length, 1);
  assert.ok(lists[0]!.closest('.bt-thread'), '終わったあとは会話の中');
});

test('会話の画面（DOM）: 発言の欄の大きさが変わると、片わきのスクロールバーの幅を --ui-gutter として親に渡す（入力欄と一覧の幅をそろえる）', async () => {
  const container = await openChat();
  const thread = container.querySelector<HTMLElement>('.bt-thread')!;
  const watch = observed.find(o => o.el === thread);
  assert.ok(watch, '発言の欄の大きさを見ている');
  Object.defineProperty(thread, 'offsetWidth', { configurable: true, value: 600 });
  Object.defineProperty(thread, 'clientWidth', { configurable: true, value: 580 });
  await update(() => { watch.run(); });
  assert.equal(thread.parentElement?.style.getPropertyValue('--ui-gutter'), '10px');
});

test('作業の一覧の出来事（checklist.updated）は、その会話の出来事の一覧を置き換える（会話の画面の liveChecklist の出どころ）', () => {
  const one = [{ text: 'Check prices', status: 'in_progress' as const }];
  const next = reduce(EMPTY, { type: 'event', hidden: false, event: { type: 'checklist.updated', runId: 'r1', conversationId: 'c1', items: one, tainted: false } }).state;
  assert.deepEqual(next.checklists.get('c1'), one);
  const two = [{ text: 'Check prices', status: 'done' as const }];
  assert.deepEqual(reduce(next, { type: 'event', hidden: false, event: { type: 'checklist.updated', runId: 'r1', conversationId: 'c1', items: two, tainted: false } }).state.checklists.get('c1'), two);
});
