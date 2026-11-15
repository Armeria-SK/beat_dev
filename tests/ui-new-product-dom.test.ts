import { byText, cleanup, click, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Project } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

const { NewProduct } = await loadTsx<{ NewProduct: ComponentType<{ onProject: (project: Project) => void }> }>('../web/src/ui/screens/NewProduct.tsx', import.meta.url);

const realFetch = globalThis.fetch;
interface Sent { path: string; method: string; body: unknown }
type Reply = { status?: number; body: unknown } | 'down';

function serve(routes: (path: string, method: string, body: unknown) => Reply | undefined): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const entry = { path: String(path), method: init?.method ?? 'GET', body };
    sent.push(entry);
    const out = routes(entry.path, entry.method, body);
    if (out === 'down') throw new TypeError('Failed to fetch');
    if (out === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const field = (c: HTMLElement) => c.querySelector<HTMLInputElement>('#ui-np-root')!;
const openButton = (c: HTMLElement) => byText(c, 'button', en['ui.np.open']) as HTMLButtonElement | undefined;
const nameField = (c: HTMLElement) => c.querySelectorAll<HTMLInputElement>('input.bt-field')[1]!;

async function show(): Promise<HTMLElement> {
  const { container } = await render(createElement(NewProduct, { onProject: () => undefined }));
  await settle();
  await settle();
  return container;
}

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
});

test('ui/NewProduct（DOM）: 一覧（Places to start）は無く、この PC から開いたときは Open が窓を開き、選んだフォルダが欄に入って確かめに進む', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
    if (path === '/api/folders/pick' && method === 'POST') return { body: { path: 'C:\\work\\shop' } };
    if (path === '/api/folders/list') return { body: { path: 'C:\\work\\shop', parent: 'C:\\work', entries: [], truncated: false } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    return undefined;
  });
  const c = await show();
  assert.equal(c.textContent?.includes('Places to start'), false);
  assert.equal(sent.some(s => s.path === '/api/folders/list'), false, 'nothing is listed on open');
  assert.equal(field(c).placeholder, en['ui.np.folderFieldPick']);
  assert.equal(openButton(c)?.disabled, false, 'Open works with an empty field');
  await click(openButton(c));
  await settle();
  assert.deepEqual(sent.filter(s => s.method === 'POST').map(s => [s.path, s.body]), [['/api/folders/pick', {}], ['/api/folders/list', { path: 'C:\\work\\shop' }]]);
  assert.equal(field(c).value, 'C:\\work\\shop');
  assert.equal(nameField(c).value, 'shop');
});

test('ui/NewProduct（DOM）: 窓を閉じた（cancelled）ら何も変えない。欄の値は窓の出発点として送る', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
    if (path === '/api/folders/pick' && method === 'POST') return { body: { cancelled: true } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    return undefined;
  });
  const c = await show();
  await input(field(c), 'C:\\work');
  await click(openButton(c));
  await settle();
  assert.deepEqual(sent.filter(s => s.method === 'POST').map(s => [s.path, s.body]), [['/api/folders/pick', { path: 'C:\\work' }]]);
  assert.equal(field(c).value, 'C:\\work');
});

test('ui/NewProduct（DOM）: 窓が断られた（409）ら、その理由を欄の下に出す', async () => {
  serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
    if (path === '/api/folders/pick' && method === 'POST') return { status: 409, body: { error: 'folder_dialog_busy', message: 'A folder window is already open' } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    return undefined;
  });
  const c = await show();
  await click(openButton(c));
  await settle();
  assert.match(c.querySelector('[role="alert"]')?.textContent ?? '', /already open/u);
});

test('ui/NewProduct（DOM）: 別の端末から・Windows でないときは、Open は打ったパスを開く（窓は出さない）。欄の案内は「フルパスを貼る」', async () => {
  const sent = serve((path, method) => {
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: false } };
    if (path === '/api/folders/list') return { body: { path: 'C:\\work', parent: null, entries: [], truncated: false } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    return undefined;
  });
  const c = await show();
  assert.equal(field(c).placeholder, en['ui.np.folderField']);
  assert.match(en['ui.np.folderField'], /full path/u);
  assert.equal(openButton(c)?.disabled, true);
  await input(field(c), 'C:\\work');
  await click(openButton(c));
  await settle();
  assert.deepEqual(sent.filter(s => s.method === 'POST').map(s => [s.path, s.body]), [['/api/folders/list', { path: 'C:\\work' }]]);
});

test('ui/NewProduct（DOM）: サーバーが応えないときは「TypeError: Failed to fetch」ではなく、応えていないことと Retry を出す。Retry で同じ要求をやり直す', async () => {
  let down = true;
  const sent = serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    return undefined;
  });
  const c = await show();
  assert.equal(c.textContent?.includes('TypeError'), false);
  assert.equal(c.textContent?.includes('Failed to fetch'), false);
  assert.ok(c.textContent?.includes(en['ui.np.notAnswering']));
  const retry = byText(c, 'button', en['ui.fail.retry']);
  assert.ok(retry);
  down = false;
  await click(retry);
  await settle();
  assert.equal(c.textContent?.includes(en['ui.np.notAnswering']), false);
  assert.equal(field(c).placeholder, en['ui.np.folderFieldPick']);
  assert.equal(sent.filter(s => s.path === '/api/folders/pick' && s.method === 'GET').length, 2);
});

test('ui/NewProduct（DOM）: Enter で打ったパスを開くときにサーバーが応えなくても、同じ文と Retry を出す', async () => {
  let down = false;
  serve((path, method) => {
    if (down) return 'down';
    if (path === '/api/folders/pick' && method === 'GET') return { body: { available: true } };
    if (path === '/api/projects?archived=1') return { body: { projects: [] } };
    if (path === '/api/folders/list') return { body: { path: 'C:\\work', parent: null, entries: [], truncated: false } };
    return undefined;
  });
  const c = await show();
  await input(field(c), 'C:\\work');
  down = true;
  await update(() => { field(c).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await settle();
  assert.ok(c.textContent?.includes(en['ui.np.notAnswering']));
  assert.equal(c.textContent?.includes('Failed to fetch'), false);
});
