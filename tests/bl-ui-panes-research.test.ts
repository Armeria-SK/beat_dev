import { byText, cleanup, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { ResearchItem, ResearchRecord, ResearchStatus, ResearchView } from '../web/src/api.ts';

// backlog 335（Plan の欄の「作る前に調べる」）: 失敗で終わって 1 行も見つからなかった記録には「この選びで計画する」ボタンを出さない

const { ResearchSection } = await loadTsx<{ ResearchSection: ComponentType<{ productId: string; conversationId: string | undefined; revision: string }> }>('../web/src/ui/panes/ResearchSection.tsx', import.meta.url);

const PRODUCT = 'prod-r1';
const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const feature = (id: number, name: string): ResearchItem => ({
  id, kind: 'feature', name, detail: null, url: null, license: null, updated: null, language: null, products: [], options: null, by: null, defaultChecked: false, defaultReason: null, recommended: null, decision: null, reason: null,
});
const record = (status: ResearchStatus, items: ResearchItem[], over: Partial<ResearchRecord> = {}): ResearchRecord => ({
  id: 'r1', phase: 'products', mode: 'batch', status, partial: false, auto: true, stopReason: null, createdAt: 1, finishedAt: 2, confirmedAt: null, shownHash: 'a'.repeat(64), items, ...over,
});
const SETTINGS = { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] } as const;

const realFetch = globalThis.fetch;
afterEach(async () => { await cleanup(); globalThis.fetch = realFetch; });

async function pane(products: ResearchRecord) {
  const view: ResearchView = { settings: { ...SETTINGS, preferLanguages: [], avoidLanguages: [] }, products, libraries: null, suggestedCheck: null };
  globalThis.fetch = (async () => new Response(JSON.stringify(view), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const { container } = await render(createElement(ResearchSection, { productId: PRODUCT, conversationId: CONVERSATION, revision: '0' }));
  for (let i = 0; i < 3; i++) await update(() => new Promise(resolve => setTimeout(resolve, 0)));
  return container;
}

test('335 失敗で終わって 1 行も見つからなかった記録: 「Plan with these picks」と、その説明を出さない。やり直す口（Research again）は残る', async () => {
  for (const stopReason of ['failed', 'search_blocked']) {
    const root = await pane(record('failed', [], { stopReason }));
    assert.ok(root.querySelector('[data-failed]'), `前提: 失敗の文が出ている（${stopReason}）`);
    assert.ok(!byText(root, 'button', 'Plan with these picks'), `確定のボタンは出さない（${stopReason}）`);
    assert.ok(!byText(root, '.bt-meta', 'Only what you picked goes into the planning conversation'), '選んだものだけが入るという説明も出さない');
    assert.ok(byText(root, 'button', 'Research again'), 'やり直す口は残る');
    await cleanup();
  }
});

test('335 ボタンを出す記録は今までどおり: 失敗でも行が見つかっていれば出る。終わった（done）記録は 0 行でも出る', async () => {
  const failedWithRows = await pane(record('failed', [feature(5, 'Sync')], { stopReason: 'failed' }));
  assert.ok(byText(failedWithRows, 'button', 'Plan with these picks'), '途中までの行があれば選べる');
  await cleanup();
  const doneEmpty = await pane(record('done', []));
  assert.ok(byText(doneEmpty, 'button', 'Plan with these picks'), 'done の 0 行はこの行の外（今のまま）');
  await cleanup();
  const cancelledEmpty = await pane(record('cancelled', []));
  assert.ok(byText(cancelledEmpty, 'button', 'Plan with these picks'), 'cancelled はこの行の外（今のまま）');
});
