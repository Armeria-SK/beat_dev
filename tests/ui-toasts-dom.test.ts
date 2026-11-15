import { byText, cleanup, click, loadTsx, render, update } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement, type ComponentType } from 'react';
import { toast } from '../web/src/feedback.ts';
import { TOAST_A, TOAST_B } from '../web/src/ui/toast-list.ts';

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

test('ui/toasts（DOM）: 組み立てたあとの画面は ?v.toast=b でも a の形（2 つまで）。b の目印は b の側にしか無い', async () => {
  assert.match(TOAST_B.tag, /^toast-b-/u);
  assert.equal(TOAST_A.tag.includes('toast-b'), false);
  window.history.replaceState(null, '', '/?v.toast=b');
  try {
    const { container } = await render(createElement(Toasts));
    assert.equal(container.querySelector('.ui-toasts')?.getAttribute('data-toasts'), TOAST_A.tag);
    for (const title of ['one', 'two', 'three']) await update(() => toast({ title }));
    assert.deepEqual([...container.querySelectorAll('.bt-toast__title')].map(p => p.textContent), ['two', 'three']);
  } finally {
    window.history.replaceState(null, '', '/');
  }
});
