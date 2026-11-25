import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, StrictMode, type ComponentType } from 'react';
import { defaultConfig } from '../src/config/store.ts';

// backlog 352（Settings の積み重ねの途中から入ったときの「閉じる」）と 356（App が消えたあとの製品一覧の読み直し）の、App ごとの確かめ。

const { App } = await loadTsx<{ App: ComponentType }>('../web/src/ui/App.tsx', import.meta.url);

const g = globalThis as Record<string, unknown>;
g.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
g.EventSource = class { onmessage = null; onerror = null; onopen = null; addEventListener() {} removeEventListener() {} close() {} };
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollTo ??= () => undefined;
const realFetch = globalThis.fetch;
const realGo = window.history.go;
const realSetTimeout = globalThis.setTimeout;

let paths: string[] = [];

function serve(routes: (path: string) => { status: number; body: unknown } | undefined = () => undefined): void {
  globalThis.fetch = (async (path: string | URL | Request) => {
    paths.push(String(path));
    const given = routes(String(path));
    let out = given?.body;
    let status = given?.status ?? 200;
    if (out === undefined && String(path) === '/api/onboarding') out = { done: true, steps: { user: true, identity: true, persona: true, model: true } };
    if (out === undefined && String(path) === '/api/settings') out = { config: defaultConfig(), apiKeys: {}, configError: null, restartRequired: false, configPath: '/tmp/config.json' };
    if (out === undefined && String(path) === '/api/models') out = { models: [], routing: { chat: [], background: [] } };
    if (out === undefined) { out = { error: 'not found' }; status = 404; }
    return new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
// 閉じたあと、約 300ms 後の「まだ Settings なら置き換える」保険の時計が、次の試験の中で鳴らないよう、App が生きているうちに待つ
const fallbackDone = () => update(() => new Promise(resolve => realSetTimeout(resolve, 400)));
async function settingsShown(): Promise<void> {
  for (let i = 0; i < 100 && !document.querySelector('.ui-overlay'); i += 1) await settle();
  assert.ok(document.querySelector('.ui-overlay'), 'Settings が開いた');
}
const esc = async (): Promise<void> => {
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  await update(() => { document.body.dispatchEvent(event); });
};

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
  window.history.go = realGo;
  delete g.navigation;
  paths = [];
  window.history.replaceState(null, '', '/');
});

async function start(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
  await render(createElement(App));
  await settle();
  await settle();
}

// 履歴の 1 件ずつの行き先（ハッシュ）。navigation の entries() と currentEntry を、動かせる偽物にする
function fakeHistory(hashes: string[]) {
  const nav = {
    currentEntry: { index: 0 },
    entries: () => hashes.map((hash, index) => ({ index, url: `http://localhost/${hash}` })),
  };
  g.navigation = nav;
  return nav;
}

async function closeFrom(hashes: string[], at: number): Promise<number[]> {
  const nav = fakeHistory(hashes);
  serve();
  nav.currentEntry.index = 0;
  await start(hashes[0]!);
  const went: number[] = [];
  window.history.go = (by?: number) => { went.push(by ?? 0); };
  nav.currentEntry.index = at;
  await update(() => { window.location.hash = hashes[at]!; });
  await settingsShown();
  await esc();
  await fallbackDone();
  return went;
}

test('backlog 352（DOM）: Settings の積み重ねの真ん中へ「戻る・進む」で入っても、最初の閉じるで積んだ分だけ戻って、Settings の前の画面に着く', async () => {
  const stack = ['#/kanban', '#/settings/models', '#/settings/memory', '#/settings/models'];
  assert.deepEqual(await closeFrom(stack, 2), [-2], '2 つ目の Settings から入った: 前の Settings の行を 1 つ飛ばして、Kanban まで 2 歩');
});

test('backlog 352（DOM）: 積み重ねの最初から入ったとき・積んでいない 1 つだけのときは、今までどおりの歩数', async () => {
  const stack = ['#/kanban', '#/settings/models', '#/settings/memory'];
  assert.deepEqual(await closeFrom(stack, 1), [-1], '最初の Settings から入った: 1 歩');
  await cleanup();
  assert.deepEqual(await closeFrom(['#/kanban', '#/settings'], 1), [-1], '1 つだけ: 1 歩');
});

test('backlog 352（DOM）: 履歴の一覧が読めない環境（navigation が無い・entries が無い）では、今までどおり 1 歩', async () => {
  const nav = { currentEntry: { index: 0 } };
  g.navigation = nav;
  serve();
  await start('#/kanban');
  const went: number[] = [];
  window.history.go = (by?: number) => { went.push(by ?? 0); };
  nav.currentEntry.index = 2;
  await update(() => { window.location.hash = '#/settings/memory'; });
  await settingsShown();
  await esc();
  await fallbackDone();
  assert.deepEqual(went, [-1], '一覧が無ければ、Settings を開いた位置から数えて 1 歩（今までどおり）');
});

test('backlog 356（DOM）: App が消えたあとは、製品一覧の読み直し（失敗の再試行も、件数の更新の遅れた分も）をもう出さない', async () => {
  const waiting: Array<() => void> = [];
  globalThis.setTimeout = ((run: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 2000 || ms === 5000) { waiting.push(run); return 0 as unknown as ReturnType<typeof setTimeout>; }
    return realSetTimeout(run, ms, ...rest);
  }) as typeof setTimeout;
  serve(path => (path === '/api/projects' ? { status: 500, body: { error: 'down' } } : undefined));
  await start('#/');
  const before = paths.filter(p => p === '/api/projects').length;
  assert.ok(before >= 1, '最初の読み込みは出る');
  assert.ok(waiting.length >= 1, '失敗したので、再試行の時計が積まれている');
  await cleanup();
  const asked = paths.filter(p => p === '/api/projects').length;
  for (const run of waiting.splice(0)) run();
  await new Promise(resolve => realSetTimeout(resolve, 20));
  assert.equal(paths.filter(p => p === '/api/projects').length, asked, '消えたあとの時計は何も読まない');
  assert.equal(waiting.length, 0, '消えたあとの時計は次の時計を積まない');
});

test('backlog 356（DOM）: 開発中の二重の起動（StrictMode が一度つけて外してまたつける）でも、製品の一覧は読めて、サイドバーに出る', async () => {
  const shop = { id: 'p1aaaa', name: 'Shop', root: 'C:\work\p1aaaa', check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1, is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null };
  serve(path => (path === '/api/projects' ? { status: 200, body: { projects: [shop] } } : undefined));
  window.history.replaceState(null, '', '/#/');
  const { container } = await render(createElement(StrictMode, null, createElement(App)));
  await settle();
  await settle();
  assert.ok(paths.includes('/api/projects'));
  assert.ok([...container.querySelectorAll('.bt-side--product .bt-side__name')].some(el => el.textContent === 'Shop'), '読んだ製品がサイドバーに出る');
});
