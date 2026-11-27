import { cleanup, input, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { Project } from '../web/src/api.ts';
import { subscribe, type FeedbackItem } from '../web/src/feedback.ts';
import { en } from '../web/src/i18n/en.ts';
import { setExplainLanguage } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { composerDrafts } from '../web/src/ui/composer-state.ts';

// スラッシュの /propose: 製品の会話で、考える役を今すぐ動かす（Think now と同じ POST /api/projects/:id/scout/run）。発言としては送らない。製品の外の会話では出さない。考える役が Off の製品では出し、選んだら Off だと言って場所を案内する（何も送らない）。

interface ConversationProps {
  id: string | null; listTitle: string | null; product?: Project; draft: undefined; notices: never[]; liveChecklist: undefined; revision: number;
  disconnected: boolean; onReconnect: () => void; onClearNotices: () => void; onInterrupt: () => void;
}

const { Conversation } = await loadTsx<{ Conversation: ComponentType<ConversationProps> }>('../web/src/ui/Conversation.tsx', import.meta.url);

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000071';
const realFetch = globalThis.fetch;
const g = globalThis as { matchMedia?: unknown; ResizeObserver?: unknown };
const real = { matchMedia: g.matchMedia, ResizeObserver: g.ResizeObserver };
let calls: string[] = [];
let toasts: FeedbackItem[] = [];
let off: (() => void) | null = null;

afterEach(async () => {
  await cleanup();
  off?.();
  off = null;
  globalThis.fetch = realFetch;
  g.matchMedia = real.matchMedia;
  g.ResizeObserver = real.ResizeObserver;
  composerDrafts.forget(CHAT);
  calls = [];
  toasts = [];
});

const settle = () => update(() => new Promise(resolve => setTimeout(resolve, 0)));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const MODEL = { id: 'm1', label: 'M1', provider: 'p', model: 'm1', inChat: true, limits: { context: null, maxOutput: null, required: null }, probe: { modelId: 'm1', status: 'ok', server: 's', required: 0, message: '', checkedAt: 0 } };
const shop = (scout_mode: Project['scout_mode']): Project => ({ id: 'p1', name: 'Shop', root: 'D:\\work\\shop', is_git: true, archived_at: null, has_plan: true, scout_mode } as unknown as Project);

async function mount(product: Project | undefined, scoutRun: () => Response) {
  const row = { id: CHAT, title: 'Propose', created_at: 0, last_message_at: 0, permission_mode: 'auto', model_id: null, effort: null };
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), 'http://x');
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/api/projects/p1/scout/run' && init?.method === 'POST') return scoutRun();
    if (url.pathname === `/api/conversations/${CHAT}/messages` && (init?.method ?? 'GET') === 'GET') return json({ conversation: row, messages: [{ id: 1, role: 'user', text: 'hi', runId: 'r1', createdAt: 10 }], pending: [], builds: [], activeRun: null });
    if (url.pathname === `/api/conversations/${CHAT}/checklist`) return json({ items: [], tainted: false, updatedAt: null });
    if (url.pathname === '/api/models') return json({ models: [MODEL], routing: { chat: ['m1'], background: [] } });
    return json({ error: 'not_found' }, 404);
  }) as typeof fetch;
  g.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  g.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  off = subscribe(item => { toasts.push(item); });
  const { container } = await render(createElement(Conversation, { id: CHAT, listTitle: null, ...(product ? { product } : {}), draft: undefined, notices: [], liveChecklist: undefined, revision: 0, disconnected: false, onReconnect: () => {}, onClearNotices: () => {}, onInterrupt: () => {} }));
  await settle();
  await settle();
  const field = container.querySelector<HTMLTextAreaElement>('textarea.bt-composer__input')!;
  const menu = () => [...container.querySelectorAll('#ui-slash [role="option"]')].map(o => o.textContent);
  const enter = async () => { await update(() => { field.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }); await settle(); await settle(); };
  return { field, menu, enter };
}

test('ui/Conversation（DOM）: /propose は製品の会話で考える役を今すぐ動かし（POST scout/run）、「Started thinking」を出す。発言としては送らない', async () => {
  const ui = await mount(shop('research'), () => json({ state: 'thinking', examined: 0, area: null, lastChangeAt: null, note: null }, 202));
  await input(ui.field, '/pro');
  assert.deepEqual(ui.menu(), ['/proposeAsk for proposals now']);
  await ui.enter();
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), ['POST /api/projects/p1/scout/run']);
  assert.deepEqual(toasts.map(x => x.title), ['Started thinking']);
  assert.equal(ui.field.value, '', '入力欄は空に戻る（発言として残らない）');
});

test('ui/Conversation（DOM）: /propose が断られたら（考える役が動けない）、「Started thinking」は出さず、理由を出す', async () => {
  const ui = await mount(shop('research'), () => json({ error: { code: 'http.scout_busy', message: 'busy' } }, 409));
  await input(ui.field, '/propose');
  await ui.enter();
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), ['POST /api/projects/p1/scout/run']);
  assert.equal(toasts.some(x => x.title === 'Started thinking'), false);
  assert.deepEqual(toasts.map(x => x.icon), ['alert']);
});

test('ui/Conversation（DOM）: 考える役が Off の製品でも /propose は候補に出る。選ぶと、どこで切り替えるかまで言い、モデルへは何も送らない（POST 無し）', async () => {
  const ui = await mount(shop('off'), () => json({}, 202));
  await input(ui.field, '/pro');
  assert.deepEqual(ui.menu(), ['/proposeAsk for proposals now'], 'Off でも候補に出る');
  await ui.enter();
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), [], 'Off の製品では何も呼ばない・何も送らない');
  assert.deepEqual(toasts.map(x => [x.title, x.body, x.href, x.icon]), [[en['ui.scout.proposeOff'], en['ui.scout.proposeOffWhere'], '#/p/p1/settings', 'alert']]);
  assert.match(en['ui.scout.proposeOffWhere'], /top right of the product home, or in Product settings/u);
  assert.equal(ui.field.value, '', '入力欄は空に戻る（発言として残らない）');
  await input(ui.field, '/propose');
  await ui.enter();
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), [], '/propose と書いて Enter でも同じ');
  assert.equal(toasts.length, 2);
});

test('ui/Conversation（DOM）: 説明の言語が日本語なら、Off の製品での /propose の返事も日本語（画面の名前は英語のまま）', async () => {
  setExplainLanguage('ja');
  try {
    const ui = await mount(shop('off'), () => json({}, 202));
    await input(ui.field, '/propose');
    await ui.enter();
    assert.deepEqual(calls.filter(c => c.startsWith('POST')), []);
    assert.deepEqual(toasts.map(x => [x.title, x.body]), [[ja['ui.scout.proposeOff'], ja['ui.scout.proposeOffWhere']]]);
    assert.match(ja['ui.scout.proposeOffWhere'], /ホーム画面の右上か Product settings で、Research only/u);
  } finally { setExplainLanguage('en'); }
});

test('ui/Conversation（DOM）: 製品の外の会話では、/propose は候補に出ず、押しても何も呼ばない', async () => {
  const none = await mount(undefined, () => json({}, 202));
  await input(none.field, '/pro');
  assert.deepEqual(none.menu(), []);
  await input(none.field, '/propose');
  await none.enter();
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), []);
  assert.deepEqual(toasts.map(x => x.title), ['/propose is not available here · nothing was sent']);
});
