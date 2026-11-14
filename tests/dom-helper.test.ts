import { cleanup, input, render } from './helpers/dom.ts';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createElement } from 'react';

afterEach(cleanup);

test('試験の道具（DOM）: 入力欄に打つと React の onChange が呼ばれ、打った値が渡る', async () => {
  const seen: string[] = [];
  const { container } = await render(createElement('input', { defaultValue: '', onChange: (e: { target: { value: string } }) => { seen.push(e.target.value); } }));
  await input(container.querySelector('input'), 'hello');
  assert.deepEqual(seen, ['hello']);
});

test('試験の道具（DOM）: Event と CustomEvent は jsdom のもので、jsdom の要素に送れる', () => {
  const box = document.createElement('div');
  let got = 0;
  box.addEventListener('ping', () => { got += 1; });
  box.dispatchEvent(new Event('ping'));
  box.dispatchEvent(new CustomEvent('ping', { detail: 1 }));
  assert.equal(got, 2);
  assert.ok(box instanceof EventTarget);
});
