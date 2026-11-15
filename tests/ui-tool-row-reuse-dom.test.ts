import { cleanup, loadTsx, render } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';

// beat J-3: 判定役の答えを使い回した道具の行は「Allowed (same as an earlier call in this run)」と出す。判定役が答えた行は今までどおり「judge: 理由」

afterEach(async () => { await cleanup(); });

const { ToolGroup } = await loadTsx<{ ToolGroup: ComponentType<{ rows: unknown[]; isNew: (key: string) => boolean }> }>('../web/src/ui/ToolRow.tsx', import.meta.url);

test('ui/ToolRow（DOM）: 使い回した答えの行は「Allowed (same as an earlier call in this run)」、判定役が答えた行は「judge: 理由」。どちらも中には理由を出す', async () => {
  const row = (key: string, gate: unknown) => ({ key, name: 'shell_run', input: JSON.stringify({ command: 'npm test' }), result: { text: 'ok', isError: false }, gate });
  const { container } = await render(createElement(ToolGroup, {
    rows: [row('a', { by: 'judge', reason: 'in scope' }), row('b', { by: 'judge', reason: 'in scope', same: 1 })], isNew: () => false,
  }));
  const meta = [...container.querySelectorAll('.ui-tool__why')].map(e => [e.textContent, e.getAttribute('title')]);
  assert.deepEqual(meta, [['judge: in scope', 'in scope'], ['Allowed (same as an earlier call in this run)', 'in scope']]);
  const body = [...container.querySelectorAll('.ui-tool__gate')].map(e => e.textContent);
  assert.deepEqual(body, ['judge: in scope', 'judge: in scope']);
});

test('runlog: 決めたのが judge-reuse の道具の行は、コードではなく言葉で出す', async () => {
  const { decidedByLabel } = await import('../web/src/runlog-meta.ts');
  assert.equal(decidedByLabel('judge-reuse'), 'Auto-approve (earlier answer in this run)');
});
