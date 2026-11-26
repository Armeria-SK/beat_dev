import { cleanup, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { composerDrafts } from '../web/src/ui/composer-state.ts';

// スラッシュの /think: いまの会話の考える深さを、選べる値の並びで 1 つ進める（すでにある PATCH /api/conversations/:id の effort を使う）。選べる深さの無いモデルでは出さない。

interface ConversationProps {
  id: string | null; listTitle: string | null; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000071';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
let patches: unknown[] = [];

afterEach(async () => {
  await cleanup();
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  composerDrafts.forget(CHAT);
  patches = [];
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const model = (efforts: string[] | undefined) => ({
  id: 'm1', label: 'M1', provider: 'p', model: 'm1', inChat: true, limits: { context: null, maxOutput: null, required: null },
  probe: { modelId: 'm1', status: 'ok', server: 's', required: 0, message: '', checkedAt: 0 }, ...(efforts ? { efforts } : {}),
});

async function mount(efforts: string[] | undefined, effort: string | null) {
  let current = effort;
  const row = () => ({ id: CHAT, title: 'Think', created_at: 0, last_message_at: 0, permission_mode: 'auto', model_id: 'm1', effort: current });
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    const method = init?.method ?? 'GET';
    if (url.pathname === `/api/conversations/${CHAT}` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { effort: string | null };
      patches.push(body);
      current = body.effort;
      return json({ conversation: row() });
    }
    if (url.pathname === `/api/conversations/${CHAT}/messages`) return json({ conversation: row(), messages: [{ id: 1, role: 'user', text: 'hi', runId: 'r1', createdAt: 10 }], pending: [], builds: [], activeRun: null });
    if (url.pathname === `/api/conversations/${CHAT}/checklist`) return json({ items: [], tainted: false, updatedAt: null });
    if (url.pathname === '/api/models') return json({ models: [model(efforts)], routing: { chat: ['m1'], background: [] } });
    return json({ error: 'not_found' }, 404);
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const { container } = await render(createElement(Conversation, { id: CHAT, listTitle: null, draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {} }));
  await settle();
  await settle();
  const field = container.querySelector<HTMLTextAreaElement>('textarea.bt-composer__input')!;
  const menu = () => [...container.querySelectorAll('#ui-slash [role="option"]')].map(o => o.querySelector('b')?.textContent);
  const enter = () => update(() => { field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  const depthLabel = () => container.querySelector('button[aria-haspopup="menu"][aria-label^="Thinking depth"]')?.textContent?.trim();
  return { field, menu, enter, depthLabel };
}

test('ui/Conversation（DOM）: /think は選べる深さの並びで 1 つ進める（default → low → medium → high → default）。送るのは effort だけで、発言にはしない', async () => {
  const ui = await mount(['low', 'medium', 'high'], null);
  assert.equal(ui.depthLabel(), 'depth: default');
  await input(ui.field, '/th');
  assert.deepEqual(ui.menu(), ['/think'], '候補に出る');
  await ui.enter();
  await settle();
  assert.deepEqual(patches, [{ effort: 'low' }]);
  assert.equal(ui.field.value, '', '入力欄は空に戻る（発言として残らない）');
  assert.equal(ui.depthLabel(), 'depth: low', '深さの表示が変わる');
  for (const next of ['medium', 'high', null]) {
    await input(ui.field, '/think');
    await ui.enter();
    await settle();
    assert.deepEqual(patches.at(-1), { effort: next });
  }
  assert.equal(patches.length, 4);
  assert.equal(ui.depthLabel(), 'depth: default', '最後は default に戻る');
});

test('ui/Conversation（DOM）: 選べる深さの無いモデルでは、/think は候補に出ない', async () => {
  const ui = await mount(undefined, null);
  assert.equal(ui.depthLabel(), undefined, '深さの選び口が無い');
  await input(ui.field, '/th');
  assert.deepEqual(ui.menu(), []);
  assert.deepEqual(patches, []);
});
