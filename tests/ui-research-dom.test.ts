import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ResearchItem, ResearchRecord, ResearchView } from '../web/src/api.ts';

// beat R (M7・R-2u): Plan の欄の最初の段「作る前に調べる」の見え方と、押したときに送るもの

const { ResearchSection } = await loadTsx<{ ResearchSection: ComponentType<{ productId: string; conversationId: string | undefined; revision: string }> }>('../web/src/ui/panes/ResearchSection.tsx', import.meta.url);

const PRODUCT = 'prod-r1';
const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const item = (over: Partial<ResearchItem> & Pick<ResearchItem, 'id' | 'kind' | 'name'>): ResearchItem => ({
  detail: null, url: null, license: null, updated: null, language: null, products: [], options: null, by: null, defaultChecked: false, defaultReason: null, recommended: null, decision: null, reason: null, ...over,
});
const record = (over: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id: 'r1', phase: 'products', mode: 'batch', status: 'done', partial: false, auto: true, stopReason: null, createdAt: 1, finishedAt: 2, confirmedAt: null, shownHash: 'a'.repeat(64),
  items: [
    item({ id: 1, kind: 'similar', name: 'Alpha Notes', url: 'https://alpha.example/notes', license: 'MIT' }),
    item({ id: 3, kind: 'feature', name: 'Tag search', products: [1], defaultChecked: true, defaultReason: 'standard' }),
    item({ id: 4, kind: 'feature', name: 'Live preview', defaultChecked: true, defaultReason: 'owner_said' }),
    item({ id: 5, kind: 'feature', name: 'Sync' }),
    item({ id: 6, kind: 'choice', name: 'How to store notes?', options: ['Files', 'SQLite'], by: 'model', recommended: 1 }),
  ],
  ...over,
});
const SETTINGS = { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] } as const;
const view = (products: ResearchRecord | null, libraries: ResearchRecord | null = null): ResearchView => ({ settings: { ...SETTINGS, preferLanguages: [], avoidLanguages: [] }, own: null, products, libraries, suggestedCheck: null });

const realFetch = globalThis.fetch;
const calls: Array<{ path: string; method: string; body: any }> = [];
function serve(current: () => ResearchView, answer: (path: string) => { status: number; body: unknown } | undefined = () => undefined) {
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    calls.push({ path: url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const special = method === 'POST' ? answer(url) : undefined;
    if (special) return reply(special.status, special.body);
    if (url === `/api/projects/${PRODUCT}/research`) return method === 'GET' ? reply(200, current()) : reply(202, { research: current().products });
    return reply(200, { research: current().products });
  }) as typeof fetch;
}
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const pane = async (conversation: { id: string | undefined } = { id: CONVERSATION }) => {
  const out = await render(createElement(ResearchSection, { productId: PRODUCT, conversationId: conversation.id, revision: '0' }));
  await settle();
  return out.container;
};
const radio = (root: HTMLElement, label: string) => byText(root, 'label', label)?.querySelector('input') as HTMLInputElement | null;

test('終わった記録: 3 つの一覧・札・N 個。モデルの推しには札があり、前もって選ばれていない', async () => {
  serve(() => view(record()));
  const root = await pane();
  assert.ok(byText(root, '.bt-label', 'Similar products'));
  assert.ok(byText(root, '.bt-card__title', 'Alpha Notes'));
  assert.equal(root.querySelector('[data-feature="3"] [data-tag]')?.textContent, 'Standard');
  assert.equal(root.querySelector('[data-feature="4"] [data-tag]')?.textContent, 'You said it');
  assert.equal(root.querySelector('[data-feature="5"] [data-tag]'), null);
  assert.equal(root.querySelector('[data-picked]')?.textContent, 'You picked 2 features');
  const choice = root.querySelector('[data-choice="6"]')!;
  assert.equal(choice.querySelector('[data-tag="ai"]')?.textContent, 'AI suggestion · from the web');
  assert.equal([...choice.querySelectorAll('input')].filter(i => (i as HTMLInputElement).checked).length, 0, 'the model recommendation is not pre-selected');
  assert.ok(choice.querySelector('[data-unanswered]'));
  assert.equal(byText(root, 'button', 'Plan with these picks')?.hasAttribute('disabled'), false);
});

test('この選択で計画へ: 答えていない選択は送らない。チェックを外すと later、土台にすると足りない機能だけ', async () => {
  serve(() => view(record()));
  const root = await pane();
  await click(radio(root, 'Build on this'));
  assert.ok(root.querySelector('[data-base-license]')?.textContent?.includes('MIT'));
  assert.equal(byText(root, '.bt-label', 'Missing features')?.textContent, 'Missing features');
  assert.equal(root.querySelector('[data-feature="3"]'), null, 'Tag search is on the base and folded away');
  await click(root.querySelector('[data-feature="5"] input'));
  await click(byText(root, 'button', 'Plan with these picks'));
  await settle();
  const sent = calls.find(c => c.path === '/api/research/r1/confirm')!;
  assert.ok(sent, 'confirm was called');
  assert.equal(sent.body.shownHash, 'a'.repeat(64));
  assert.deepEqual(sent.body.picks, [{ id: 1, decision: 'base' }, { id: 4, decision: 'picked' }, { id: 5, decision: 'picked' }]);
});

test('409 conversation_running: 「返事が終わってからもう一度」の 1 行だけ出し、記録は確定できるまま', async () => {
  serve(() => view(record()), path => (path.endsWith('/confirm') ? { status: 409, body: { error: 'research', code: 'research.conversation_running', message: 'busy' } } : undefined));
  const root = await pane();
  await click(byText(root, 'button', 'Plan with these picks'));
  await settle();
  assert.equal(root.querySelector('[data-busy]')?.textContent, 'The conversation is still replying. Try again after the reply finishes');
  assert.equal(root.querySelector('[role="alert"]'), null, 'not shown as a failure');
  assert.equal(byText(root, 'button', 'Plan with these picks')?.hasAttribute('disabled'), false, 'the owner can press again');
});

test('調べている間: 入力は止まり、確定は無く、飛ばすがある。飛ばすで skip を呼ぶ', async () => {
  let current = view(record({ status: 'running' }));
  serve(() => current);
  const root = await pane();
  assert.ok(byText(root, '.bt-pill', 'Researching'));
  assert.ok(!byText(root, 'button', 'Plan with these picks'));
  assert.equal((root.querySelector('[data-feature="5"] input') as HTMLInputElement).disabled, true);
  current = view(record({ status: 'skipped', items: [] }));
  await click(byText(root, 'button', 'Skip'));
  await settle();
  assert.ok(calls.some(c => c.path === '/api/research/r1/skip' && c.method === 'POST'));
  assert.ok(byText(root, '.bt-pill', 'Skipped'));
  assert.ok(byText(root, 'button', 'Research again'));
});

test('記録が無い: 調べるボタンで会話の id を送る。会話が無ければボタンは出ない。途中まで・0 件の見え方', async () => {
  let current = view(null);
  serve(() => current);
  let root = await pane();
  current = view(record({ status: 'running', items: [] }));
  await click(byText(root, 'button', 'Research'));
  await settle();
  const start = calls.find(c => c.path === `/api/projects/${PRODUCT}/research` && c.method === 'POST')!;
  assert.deepEqual(start.body, { conversationId: CONVERSATION });
  await cleanup();
  current = view(null);
  root = await pane({ id: undefined });
  assert.ok(!byText(root, 'button', 'Research'), 'no conversation, no Research button');
  await cleanup();
  current = view(record({ partial: true, stopReason: 'time', items: [] }));
  root = await pane();
  assert.ok(root.querySelector('[data-partial]'));
  assert.ok(root.querySelector('[data-empty]'));
  assert.ok(byText(root, '.bt-pill', 'Partly done'));
});

test('確定のあと: 選んだものだけを読み戻して出し、入力は無い。libraries の段は物差しの推しだけ前もって選ぶ', async () => {
  const libraries = record({ id: 'r2', phase: 'libraries', items: [
    item({ id: 10, kind: 'choice', name: 'Which language for the app?', options: ['Go', 'Rust'], by: 'code', recommended: 1 }),
    item({ id: 11, kind: 'library', name: 'goldmark', url: 'https://github.com/yuin/goldmark' }),
  ] });
  serve(() => view(record({ status: 'confirmed', items: [item({ id: 3, kind: 'feature', name: 'Tag search', decision: 'picked' }), item({ id: 5, kind: 'feature', name: 'Sync', decision: 'later' })] }), libraries));
  const root = await pane();
  const done = root.querySelector('[data-phase="products"]')!;
  assert.ok(byText(done as HTMLElement, '.bt-pill', 'Confirmed'));
  assert.equal(done.querySelectorAll('input').length, 0);
  assert.ok(done.textContent?.includes('Tag search'));
  assert.ok(!done.textContent?.includes('Sync'));
  const lib = root.querySelector('[data-phase="libraries"]')!;
  assert.equal(([...lib.querySelectorAll('label')].find(l => l.textContent?.startsWith('Rust'))?.querySelector('input') as HTMLInputElement).checked, true, 'the code ruler pick is pre-selected');
  assert.equal(lib.querySelector('[data-tag="measures"]')?.textContent, 'Measures pick');
  assert.ok(byText(lib as HTMLElement, '.bt-row__title', 'goldmark'));
  assert.equal(([...lib.querySelectorAll('label')].find(l => l.textContent?.startsWith('Go'))?.querySelector('input') as HTMLInputElement).checked, false);
});

test('止まり方の見え方（B1・B3）: 検索ができなかった記録は「何も見つからなかった」と言わず、検索ができなかったと言う。持ち主が止めた記録は「上限」と言わない', async () => {
  serve(() => view(record({ status: 'failed', stopReason: 'search_blocked', items: [] })));
  const blocked = await pane();
  assert.match(blocked.querySelector('[data-failed]')?.textContent ?? '', /Web search did not work/u);
  assert.equal(blocked.querySelector('[data-empty]') === null, true, 'no "nothing was found" line');
  await cleanup();
  serve(() => view(record({ status: 'done', partial: true, stopReason: 'stopped' })));
  const stopped = await pane();
  assert.equal(stopped.querySelector('[data-partial]')?.textContent, 'The research was stopped partway. The rows found so far are below');
});
