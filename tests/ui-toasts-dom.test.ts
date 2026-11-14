import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { toast } from '../web/src/feedback.ts';

const { Toasts } = await loadTsx<{ Toasts: ComponentType }>('../web/src/ui/toasts.tsx', import.meta.url);

afterEach(cleanup);

test('ui/toasts（DOM）: Undo を押すと、渡した口が 1 回だけ呼ばれ、トーストは去り始めてボタンは押せなくなる', async () => {
  let undone = 0;
  const { container } = await render(createElement(Toasts));
  await update(() => toast({ title: 'Deleted', action: { label: 'Undo', run: () => { undone += 1; } } }));
  assert.ok(byText(container, '.bt-toast__title', 'Deleted'));
  const undo = byText(container, 'button', 'Undo');
  await click(undo);
  assert.equal(undone, 1);
  assert.match(container.querySelector('.bt-toast')?.className ?? '', /\bis-leaving\b/u);
  assert.equal((undo as HTMLButtonElement).disabled, true);
  await click(undo);
  assert.equal(undone, 1);
});
