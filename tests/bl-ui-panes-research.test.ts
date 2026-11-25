import { cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ResearchRecord, ResearchStatus, ResearchView } from '../web/src/api.ts';

// backlog 335 は直していない（開いたまま）。確定のボタンは、products の記録から libraries の調べへ進む唯一の口なので、
// 1 行も見つからなかった記録でも消さない。ボタンの文言を直すときも、この口は残す（ボタンは文言ではなく入れ物で見る）

const { ResearchSection } = await loadTsx<{ ResearchSection: ComponentType<{ productId: string; conversationId: string | undefined; revision: string }> }>('../web/src/ui/panes/ResearchSection.tsx', import.meta.url);

const PRODUCT = 'prod-r1';
const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const record = (phase: ResearchRecord['phase'], status: ResearchStatus): ResearchRecord => ({
  id: 'r1', phase, mode: 'batch', status, partial: false, auto: true, stopReason: status === 'failed' ? 'search_blocked' : null, createdAt: 1, finishedAt: 2, confirmedAt: null, shownHash: 'a'.repeat(64), items: [],
});
const SETTINGS = { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] } as const;

const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

async function pane(products: ResearchRecord | null, libraries: ResearchRecord | null) {
  const view: ResearchView = { settings: { ...SETTINGS, preferLanguages: [], avoidLanguages: [] }, products, libraries, suggestedCheck: null };
  globalThis.fetch = (async () => new Response(JSON.stringify(view), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const { container } = await render(createElement(ResearchSection, { productId: PRODUCT, conversationId: CONVERSATION, revision: '0' }));
  for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  return container;
}

test('335（未修正の見張り）: 失敗して 1 行も見つからなかった記録にも、確定のボタン（libraries の調べへ進む口）を残す。products でも libraries でも', async () => {
  const products = await pane(record('products', 'failed'), null);
  assert.ok(products.querySelector('[data-phase="products"] [data-failed]'), '前提: 失敗の文が出ている');
  assert.ok(products.querySelector('[data-phase="products"] .ui-rs__actions button'), 'products: 確定のボタンがある');
  await cleanup();
  const libraries = await pane(record('products', 'confirmed'), record('libraries', 'failed'));
  assert.ok(libraries.querySelector('[data-phase="libraries"] [data-failed]'), '前提: libraries の失敗の文が出ている');
  assert.ok(libraries.querySelector('[data-phase="libraries"] .ui-rs__actions button'), 'libraries: やり直す口が無いので、確定のボタンが唯一の口');
});
