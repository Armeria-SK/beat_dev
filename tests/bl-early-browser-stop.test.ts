import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import './helpers/dom-env.ts';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { BrowserView } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';

// backlog: Browser の欄の Stop でタスクを止めても約 20 秒でまた動き出す（今の作り）。Task 画面と Home の知らせは「約 20 秒で再開」と言うのに、
// Browser の欄の知らせだけが言わなかった（案 A: 知らせだけ直す）

const { BrowserPane, stopToastKeys } = await loadTsx<{
  BrowserPane: ComponentType<{ productId: string }>;
  stopToastKeys: (stopped: boolean, by: BrowserView['by']['kind']) => { title: string; body?: string };
}>('../web/src/ui/panes/BrowserPane.tsx', import.meta.url);
const feedback = await import('../web/src/feedback.ts');

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  mock.timers.reset();
  globalThis.fetch = realFetch;
});

const viewOf = (by: BrowserView['by']): BrowserView => ({
  tab: 't1', conversationId: 'c1', runId: 'run-7', url: 'http://localhost:5173/', title: 'Home', driving: true,
  action: { kind: 'read', target: '' }, at: Date.now(), seq: 0, viewport: { width: 1280, height: 800 },
  profile: { kind: 'work' }, pointer: null, by,
});

function serve(view: BrowserView) {
  globalThis.fetch = (async (path: string | URL | Request) => {
    const url = new URL(String(path), 'http://x');
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/browser/view') return reply({ view });
    if (/^\/api\/runs\/[^/]+\/stop$/u.test(url.pathname)) return reply({ stopped: true });
    return reply({ error: 'not_found' }, 404);
  }) as typeof fetch;
}

const settle = () => update(() => new Promise(resolve => setImmediate(resolve)));

async function stopAndCollect(view: BrowserView): Promise<Array<{ title: string; body?: string }>> {
  const toasts: Array<{ title: string; body?: string }> = [];
  const unsubscribe = feedback.subscribe(item => toasts.push({ title: item.title, ...(item.body ? { body: item.body } : {}) }));
  try {
    mock.timers.enable({ apis: ['setInterval'] });
    serve(view);
    const { container } = await render(createElement(BrowserPane, { productId: 'prod01' }));
    for (let i = 0; i < 4; i++) await settle();
    await click(byText(container, '.bt-pane__bar button', 'Stop'));
    await settle();
    return toasts;
  } finally { unsubscribe(); }
}

test('bl-early browser stop: タスクの実行を止めたときは、再開を言う文の鍵（Task 画面と同じ）を使う', () => {
  assert.deepEqual(stopToastKeys(true, 'task'), { title: 'ui.browser.stopped', body: 'ui.task.toast.stoppedBody' });
  assert.deepEqual(stopToastKeys(true, 'conversation'), { title: 'ui.browser.stopped' });
  assert.deepEqual(stopToastKeys(false, 'task'), { title: 'ui.browser.notRunning' });
});

test('bl-early browser stop（DOM）: タスクの実行で Stop を押すと、知らせが約 20 秒で再開することを言う', async () => {
  const toasts = await stopAndCollect(viewOf({ kind: 'task', id: 'task-1', title: 'Check' }));
  assert.deepEqual(toasts, [{ title: en['ui.browser.stopped'], body: en['ui.task.toast.stoppedBody'] }]);
  assert.match(en['ui.task.toast.stoppedBody'], /20 s/u);
});

test('bl-early browser stop（DOM）: 会話の実行では今の文のまま', async () => {
  const toasts = await stopAndCollect(viewOf({ kind: 'conversation', id: 'c1', title: 'Chat' }));
  assert.deepEqual(toasts, [{ title: en['ui.browser.stopped'] }]);
});
