import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ResearchItem, ResearchRecord, ResearchView } from '../web/src/api.ts';
import { setExplainLanguage } from '../web/src/i18n/index.ts';

// B6 ui-small（backlog 230・323）: 似ている製品の調べが失敗して 0 件のとき、確かめるボタンは「選びで計画する」でなく、ライブラリの調べへ進むボタン。押したときの動きは同じ。

const { ResearchSection } = await loadTsx<{ ResearchSection: ComponentType<{ productId: string; conversationId: string | undefined; revision: string }> }>('../web/src/ui/panes/ResearchSection.tsx', import.meta.url);

const PRODUCT = 'prod-r1';
const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const item = (over: Partial<ResearchItem> & Pick<ResearchItem, 'id' | 'kind' | 'name'>): ResearchItem => ({
  detail: null, url: null, license: null, updated: null, language: null, products: [], options: null, by: null, defaultChecked: false, defaultReason: null, recommended: null, decision: null, reason: null, ...over,
});
const record = (over: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id: 'r1', phase: 'products', mode: 'batch', status: 'done', partial: false, auto: true, stopReason: null, createdAt: 1, finishedAt: 2, confirmedAt: null, shownHash: 'a'.repeat(64),
  items: [item({ id: 5, kind: 'feature', name: 'Sync' })], ...over,
});
const SETTINGS = { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] } as const;
const view = (products: ResearchRecord | null, libraries: ResearchRecord | null = null): ResearchView => ({ settings: { ...SETTINGS, preferLanguages: [], avoidLanguages: [] }, products, libraries, suggestedCheck: null });

const realFetch = globalThis.fetch;
const calls: Array<{ path: string; method: string; body: any }> = [];
function serve(current: () => ResearchView) {
  calls.length = 0;
  globalThis.fetch = (async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    const method = init?.method ?? 'GET';
    calls.push({ path: url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
    const body = url === `/api/projects/${PRODUCT}/research` && method === 'GET' ? current() : { research: current().products };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; setExplainLanguage('en'); });
const settle = async () => { for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0))); };
const pane = async () => {
  const out = await render(createElement(ResearchSection, { productId: PRODUCT, conversationId: CONVERSATION, revision: '0' }));
  await settle();
  return out.container;
};
const confirmButton = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('.ui-rs__actions .bt-btn--primary');

test('bl-ui-small/research: 失敗して 0 件の似ている製品の記録は、確かめるボタンが「ライブラリの調べへ進む」。ふつうの記録の文は今までどおり', async () => {
  serve(() => view(record({ status: 'failed', stopReason: 'search_blocked', items: [] })));
  const failed = await pane();
  assert.equal(confirmButton(failed)?.textContent, 'Continue to the libraries research');
  assert.ok(!byText(failed, 'button', 'Plan with these picks'), '0 件の失敗では「選びで計画する」と言わない');
  await cleanup();

  for (const [label, over] of [
    ['終わった記録', { status: 'done' }],
    ['失敗したが行がある記録', { status: 'failed', stopReason: 'time' }],
    ['0 件で終わった記録（失敗でない）', { status: 'done', items: [] }],
    ['取り消した 0 件の記録', { status: 'cancelled', items: [] }],
    ['ライブラリの段の失敗した 0 件の記録', { phase: 'libraries', status: 'failed', items: [] }],
  ] as const) {
    serve(() => view(record(over as Partial<ResearchRecord>)));
    const root = await pane();
    assert.equal(confirmButton(root)?.textContent, 'Plan with these picks', label);
    await cleanup();
  }
});

test('bl-ui-small/research: 押したときの動きは同じ（確定の呼び出しに記録の版と空の選びを送る）。日本語の説明では「部品の調べへ進む」', async () => {
  serve(() => view(record({ status: 'failed', items: [] })));
  const root = await pane();
  await click(confirmButton(root));
  await settle();
  const sent = calls.find(c => c.path === '/api/research/r1/confirm');
  assert.ok(sent, 'confirm was called');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.shownHash, 'a'.repeat(64));
  assert.deepEqual(sent.body.picks, []);
  await cleanup();

  setExplainLanguage('ja');
  serve(() => view(record({ status: 'failed', items: [] })));
  const ja = await pane();
  assert.equal(confirmButton(ja)?.textContent, '部品の調べへ進む');
});
