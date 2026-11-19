import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import { window } from './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { BrowserView } from '../web/src/api.ts';

// beat 9-2b: Browser の欄（Design BrowserPane。見るだけ）

const { BrowserPane, pointerStyle, agoShort } = await loadTsx<{
  BrowserPane: ComponentType<{ productId: string }>;
  pointerStyle: (pointer: { x: number; y: number }, viewport: { width: number; height: number }) => { left: string; top: string };
  agoShort: (ms: number) => string;
}>('../web/src/ui/panes/BrowserPane.tsx', import.meta.url);
const panes = await import('../web/src/ui/panes.ts');

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const PNG_A = Buffer.from('frame-a');
const PNG_B = Buffer.from('frame-b');

const viewOf = (over: Partial<BrowserView> = {}): BrowserView => ({
  tab: 't1', conversationId: 'c1', runId: 'run-7', url: 'http://localhost:5173/upload', title: 'Upload', driving: true,
  action: { kind: 'click', target: 'Upload' }, at: Date.now(), seq: 3, viewport: { width: 1280, height: 800 },
  profile: { kind: 'work' }, pointer: { x: 640, y: 200 }, by: { kind: 'task', id: 'task-1', title: 'Check the upload page' }, ...over,
});

interface Server { view: BrowserView | null; frames: Record<number, Buffer>; calls: string[]; stopped?: boolean }

function serve(server: Server) {
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    server.calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/browser/view') return reply({ view: server.view });
    if (url.pathname === '/api/browser/frame') {
      const seq = server.view?.seq ?? 0;
      const data = server.frames[seq];
      if (!data) return reply({ error: 'not_found' }, 404);
      return new Response(new Uint8Array(data), { status: 200, headers: { 'Content-Type': 'image/png', 'X-Frame-Seq': String(seq) } });
    }
    if (/^\/api\/runs\/[^/]+\/stop$/u.test(url.pathname)) return reply({ stopped: server.stopped ?? true });
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setImmediate(resolve)));

async function show(server: Server) {
  mock.timers.enable({ apis: ['setInterval'] });
  serve(server);
  const rendered = await render(createElement(BrowserPane, { productId: 'prod01' }));
  for (let i = 0; i < 4; i++) await settle();
  return rendered;
}

async function tick(ms = 1000) {
  await update(() => { mock.timers.tick(ms); });
  for (let i = 0; i < 4; i++) await settle();
}

const frameCalls = (server: Server) => server.calls.filter(c => c.startsWith('GET /api/browser/frame'));
const blobText = async (src: string) => (await (await realFetch(src)).text());

test('ui/BrowserPane（DOM）: 動いているとき。札「beat is driving」・いまの操作・Stop、帯にアドレス、画面は blob: の画像、AI の指、下の 1 行', async () => {
  const server: Server = { view: viewOf(), frames: { 3: PNG_A }, calls: [] };
  const { container } = await show(server);
  const pill = container.querySelector('.bt-pane__bar .bt-pill');
  assert.equal(pill?.textContent, 'beat is driving');
  assert.ok(pill?.classList.contains('bt-pill--running'));
  assert.equal(container.querySelector('.ui-browser__status')?.textContent, 'click “Upload”');
  assert.ok(byText(container, '.bt-pane__bar button', 'Stop'));
  assert.equal(container.querySelector('.bt-browser__url')?.textContent, 'localhost:5173/upload');
  assert.equal(container.querySelector('.bt-browser')?.getAttribute('aria-label'), 'Mirror of the page at localhost:5173/upload');
  assert.equal(container.querySelector('.bt-browser__bar button'), null, '帯の印はボタンでない');
  const img = container.querySelector<HTMLImageElement>('.ui-browser__stage > img');
  assert.ok(img?.getAttribute('src')?.startsWith('blob:'), 'blob: で出す（iframe ではない）');
  assert.ok(img);
  assert.equal(await blobText(img.getAttribute('src')!), 'frame-a');
  assert.equal(container.querySelector('iframe'), null);
  const cursor = container.querySelector<HTMLElement>('.ui-browser__stage > .bt-cursor');
  assert.equal(cursor?.style.left, '50%');
  assert.equal(cursor?.style.top, '25%');
  assert.equal(container.querySelector('.ui-browser__meta')?.textContent, 'watching only · 1280 × 800 · profile work · tab of the task “Check the upload page”');
  assert.equal(frameCalls(server).length, 1);
  assert.deepEqual(server.calls[0], 'GET /api/browser/view?product=prod01');
});

test('ui/BrowserPane（DOM）: 止まっているとき。札「Idle」、Stop と指が無く、最後の画面が残り「last frame 2m ago」', async () => {
  const server: Server = { view: viewOf({ driving: false, at: Date.now() - 125_000 }), frames: { 3: PNG_A }, calls: [] };
  const { container } = await show(server);
  assert.equal(container.querySelector('.bt-pane__bar .bt-pill')?.textContent, 'Idle');
  assert.ok(!container.querySelector('.bt-pane__bar .bt-pill')?.classList.contains('bt-pill--running'));
  assert.equal(byText(container, '.bt-pane__bar button', 'Stop'), undefined);
  assert.equal(container.querySelector('.bt-cursor'), null);
  assert.equal(container.querySelector('.ui-browser__status')?.textContent, 'last frame 2m ago');
  assert.ok(container.querySelector('.ui-browser__stage > img'));
});

test('ui/BrowserPane（DOM）: 札の切り替え。動いている → 止まった、で指と Stop が消え、画像は読み直さない', async () => {
  const server: Server = { view: viewOf(), frames: { 3: PNG_A }, calls: [] };
  const { container } = await show(server);
  assert.ok(container.querySelector('.bt-cursor'));
  server.view = viewOf({ driving: false, at: Date.now() - 5_000 });
  await tick();
  assert.equal(container.querySelector('.bt-pane__bar .bt-pill')?.textContent, 'Idle');
  assert.equal(container.querySelector('.bt-cursor'), null);
  assert.equal(byText(container, '.bt-pane__bar button', 'Stop'), undefined);
  assert.equal(container.querySelector('.ui-browser__status')?.textContent, 'last frame 5s ago');
  assert.equal(frameCalls(server).length, 1, '同じ seq なら画像を読み直さない');
});

test('ui/BrowserPane（DOM）: 1 秒ごとに view を読み、seq が変わったときだけ画像を読み直して差し替える', async () => {
  const server: Server = { view: viewOf(), frames: { 3: PNG_A, 4: PNG_B }, calls: [] };
  const { container } = await show(server);
  const views = () => server.calls.filter(c => c.startsWith('GET /api/browser/view')).length;
  assert.equal(views(), 1);
  await tick();
  assert.equal(views(), 2);
  assert.equal(frameCalls(server).length, 1);
  const before = container.querySelector('img')!.getAttribute('src')!;
  server.view = viewOf({ seq: 4, action: { kind: 'type', target: 'Name' } });
  await tick();
  assert.equal(frameCalls(server).length, 2);
  const after = container.querySelector('img')!.getAttribute('src')!;
  assert.notEqual(after, before);
  assert.equal(await blobText(after), 'frame-b');
  await assert.rejects(realFetch(before), '前の blob: は捨てる');
  assert.equal(container.querySelector('.ui-browser__status')?.textContent, 'type in “Name”');
});

test('ui/BrowserPane（DOM）: Stop は動かしている runId を止める', async () => {
  const server: Server = { view: viewOf({ runId: 'run-42' }), frames: { 3: PNG_A }, calls: [] };
  const { container } = await show(server);
  await click(byText(container, '.bt-pane__bar button', 'Stop'));
  await settle();
  assert.ok(server.calls.includes('POST /api/runs/run-42/stop'), server.calls.join('\n'));
});

test('ui/BrowserPane（DOM）: 画面の中の押下・キーは何もしない（要求が出ず、DOM も変わらない）。押せる要素・フォーカスできる要素が無い', async () => {
  const server: Server = { view: viewOf(), frames: { 3: PNG_A }, calls: [] };
  const { container } = await show(server);
  const mirror = container.querySelector('.bt-browser')!;
  const html = container.innerHTML;
  const calls = server.calls.length;
  for (const target of [mirror, mirror.querySelector('img')!, mirror.querySelector('.ui-browser__view')!]) {
    await click(target);
    await update(() => {
      target.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      target.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });
  }
  await settle();
  assert.equal(server.calls.length, calls);
  assert.equal(container.innerHTML, html);
  assert.equal(mirror.querySelector('a, button, input, textarea, select, [tabindex], [contenteditable]'), null);
  assert.equal(mirror.querySelector('img')?.getAttribute('draggable'), 'false');
});

test('ui/BrowserPane（DOM）: タブが無いときは空の状態', async () => {
  const server: Server = { view: null, frames: {}, calls: [] };
  const { container } = await show(server);
  assert.equal(container.querySelector('.bt-empty__title')?.textContent, 'No browser tab to watch');
  assert.match(container.querySelector('.bt-empty__text')?.textContent ?? '', /You can only watch/u);
  assert.equal(container.querySelector('.bt-browser'), null);
  assert.equal(frameCalls(server).length, 0);
});

test('ui/BrowserPane: 指の位置は画面の大きさに対する割合（欄の幅に合わせて縮めても同じ所）。外は端に留める', () => {
  assert.deepEqual(pointerStyle({ x: 640, y: 400 }, { width: 1280, height: 800 }), { left: '50%', top: '50%' });
  assert.deepEqual(pointerStyle({ x: 320, y: 100 }, { width: 1280, height: 800 }), { left: '25%', top: '12.5%' });
  assert.deepEqual(pointerStyle({ x: 1, y: 1 }, { width: 3, height: 3 }), { left: '33.333%', top: '33.333%' });
  assert.deepEqual(pointerStyle({ x: 2000, y: -5 }, { width: 1280, height: 800 }), { left: '100%', top: '0%' });
});

test('ui/BrowserPane: 最後の画面の時刻の文', () => {
  assert.equal(agoShort(0), '0s');
  assert.equal(agoShort(59_999), '59s');
  assert.equal(agoShort(125_000), '2m');
  assert.equal(agoShort(3 * 3_600_000 + 1), '3h');
  assert.equal(agoShort(3 * 86_400_000), '3d');
  assert.equal(agoShort(-5_000), '0s');
});

test('ui/panes: Browser は製品の会話だけ、Terminal の後ろ。数の札なし。760px より狭いと出さない', () => {
  assert.deepEqual(panes.tabOrder(panes.openable({ productId: 'p' }), false), ['plan', 'questions', 'kanban', 'pending', 'changes', 'files', 'terminal', 'browser']);
  assert.equal(panes.paneDef('browser').counted, false);
  assert.deepEqual(panes.openable({ productId: null }), [], '製品に属さない会話では欄が無い');
  assert.ok(!panes.openable({ productId: 'p', narrow: true }).includes('browser'));
  assert.ok(panes.openable({ productId: 'p', narrow: true }).includes('terminal'), 'ほかの欄は狭くても出す');
  assert.deepEqual(panes.parseLayout(JSON.stringify([{ view: 'browser', width: 500 }])), [{ view: 'browser', width: 500 }]);
});
