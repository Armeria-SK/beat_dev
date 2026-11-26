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

test('ui/ToolRow（DOM）（AR-8a）: 実行役の求めの行は、beat が持ち主に聞かず断ったものを「Stopped by beat」、持ち主が決めたものを「You allowed it / You declined it」と出し、決めた行へのリンクを付ける', async () => {
  const row = (key: string, gate: unknown, isError: boolean) => ({ key, name: 'claude-code:Write', input: JSON.stringify({ file_path: 'src/a.ts', content: 'x' }), result: { text: 'result', isError }, gate });
  const { container } = await render(createElement(ToolGroup, {
    rows: [row('a', { by: 'guard', key: 'secret' }, true), row('b', { by: 'owner', id: 7, allowed: true }, false), row('c', { by: 'owner', id: 8, allowed: false }, true), row('d', { by: 'owner', id: 9, allowed: false, closed: true }, true)], isNew: () => false,
  }));
  const lines = [...container.querySelectorAll('details.bt-tool')];
  const text = (index: number) => lines[index]?.textContent ?? '';
  assert.match(text(0), /Stopped by beat/u);
  assert.match(text(1), /You allowed it/u);
  assert.match(text(2), /You declined it/u);
  assert.match(text(3), /Closed without your answer/u, 'a request that ended with no answer from the owner is not shown as declined by the owner');
  assert.doesNotMatch(text(3), /You declined it/u);
  const links = [...container.querySelectorAll('a.ui-tool__open')].map(a => a.textContent);
  assert.equal(links.length, 3, 'the three the owner was asked about link to Pending; the one beat stopped has nothing to open');
  assert.ok(links[0]!.includes('7') && links[1]!.includes('8') && links[2]!.includes('9'), links.join(' | '));
});
