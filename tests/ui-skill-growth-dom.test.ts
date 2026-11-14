import { byText, cleanup, click, loadTsx, render } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import type { SkillDraft } from '../web/src/api.ts';
import { draftGrowth } from '../web/src/skills-meta.ts';

type RowProps = { draft: SkillDraft; open: boolean; now: number; onDone: () => void };
const { DraftRow } = await loadTsx<{ DraftRow: ComponentType<RowProps> }>('../web/src/ui/screens/Skills.tsx', import.meta.url);

afterEach(cleanup);

const BODY = 'Use the forecast page for ten days';
const base: SkillDraft = {
  id: 1, name: 'weather', description: 'When asked about the weather', body: `1. ${BODY}`, reason: 'wttr.in only had 3 days', change_summary: null,
  status: 'pending', created_at: 0, current: { description: 'When asked about the weather', body: '1. Use wttr.in' }, from_title: null,
};
const CHANGE = 'Next week: wttr.in gives only 3 days → use the 10-day page, and search again if its URL is 404';

async function show(draft: SkillDraft) {
  const { container } = await render(createElement('ul', null, createElement(DraftRow, { draft, open: true, now: 0, onDone: () => undefined })));
  return container;
}

test('スキルの成長（DOM）: 直す下書きは「What changes」と前 → 今だけを先に見せ、本文は「Show the whole skill」を押したときだけ出る', async () => {
  const container = await show({ ...base, change_summary: CHANGE });
  assert.ok(byText(container, '.bt-label', 'What changes'));
  assert.equal(container.querySelector('.ui-lib__growthtext')?.textContent, CHANGE);
  assert.equal(container.textContent?.includes(BODY), false, '本文は閉じたまま');
  assert.equal(container.textContent?.includes('wttr.in only had 3 days'), false, '理由も閉じたまま');
  const more = byText(container, 'button', 'Show the whole skill');
  assert.equal(more?.getAttribute('aria-expanded'), 'false');
  await click(more);
  assert.equal(container.textContent?.includes(BODY), true);
  assert.equal(container.textContent?.includes('wttr.in only had 3 days'), true);
  assert.equal(byText(container, 'button', 'Hide the whole skill')?.getAttribute('aria-expanded'), 'true');
  assert.match(container.textContent ?? '', /\+1/u, '行の足し引きは行に残る');
});

test('スキルの成長（DOM）: change の無い前からの直す下書きは、理由を「Why it changes」として先に見せ、本文は押したときだけ。理由は 2 度出さない', async () => {
  const container = await show(base);
  assert.ok(byText(container, '.bt-label', 'Why it changes'));
  assert.equal(container.querySelector('.ui-lib__growthtext')?.textContent, 'wttr.in only had 3 days');
  assert.equal(container.textContent?.includes(BODY), false);
  await click(byText(container, 'button', 'Show the whole skill'));
  assert.equal(container.textContent?.includes(BODY), true);
  assert.equal(container.textContent?.split('wttr.in only had 3 days').length, 2, '理由は 1 回だけ');
});

test('スキルの成長（DOM）: 新しいスキルの下書きは、今までどおり全文をそのまま見せる', async () => {
  const container = await show({ ...base, current: null, change_summary: CHANGE });
  assert.equal(container.querySelector('.ui-lib__growth'), null);
  assert.equal(container.textContent?.includes(BODY), true);
});

test('draftGrowth: 直す下書きは change_summary、無ければ理由、どちらも無ければ null。新しいスキルは null', () => {
  assert.deepEqual(draftGrowth({ ...base, change_summary: ` ${CHANGE} ` }), { kind: 'change', text: CHANGE });
  assert.deepEqual(draftGrowth({ ...base, change_summary: '  ' }), { kind: 'reason', text: 'wttr.in only had 3 days' });
  assert.deepEqual(draftGrowth({ reason: base.reason, current: base.current }), { kind: 'reason', text: 'wttr.in only had 3 days' });
  assert.equal(draftGrowth({ ...base, reason: null }), null);
  assert.equal(draftGrowth({ ...base, current: null, change_summary: CHANGE }), null);
});
