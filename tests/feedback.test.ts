import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { subscribe, toast, type FeedbackItem } from '../web/src/feedback.ts';

// 画面を持たないトーストの受け渡し（feedback.ts）。画面のトースト（ui/toasts.tsx）がここを購読する。

function collect(): { items: FeedbackItem[]; stop: () => void } {
  const items: FeedbackItem[] = [];
  return { items, stop: subscribe(item => { items.push(item); }) };
}

test('toast は購読しているすべての受け手に同じ知らせを渡し、購読をやめた受け手には渡さない', () => {
  const a = collect();
  const b = collect();
  toast({ title: 'one' });
  b.stop();
  toast({ kind: 'done', title: 'two', body: 'detail' });
  a.stop();
  toast({ title: 'three' });
  assert.deepEqual(a.items, [{ title: 'one' }, { kind: 'done', title: 'two', body: 'detail' }]);
  assert.deepEqual(b.items, [{ title: 'one' }]);
});

test('画面のトースト（ui/toasts.tsx）は feedback を購読して、届いた知らせを出す', () => {
  const source = readFileSync(new URL('../web/src/ui/toasts.tsx', import.meta.url), 'utf8').replace(/\r/gu, '');
  assert.match(source, /^import \{ subscribe \} from '\.\.\/feedback\.ts';$/mu);
  assert.match(source, /const stop = subscribe\(item => \{/u);
});

test('受け手がいないときの toast は何もしない（落ちない）', () => {
  assert.doesNotThrow(() => toast({ title: 'nobody' }));
});
