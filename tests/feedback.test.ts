import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { archiveConversation } from '../web/src/conversation-actions.ts';
import { subscribe, toast, type FeedbackItem } from '../web/src/feedback.ts';
import { t } from '../web/src/i18n/index.ts';
import { performTaskAction } from '../web/src/task-actions.ts';

// 画面を持たないトーストの受け渡し（feedback.ts）。古い画面の toast.tsx も新しい画面もここを購読する。
// task-actions.ts と conversation-actions.ts は、画面の部品（toast.tsx）を読まず、ここへ知らせを出す。

function collect(): { items: FeedbackItem[]; stop: () => void } {
  const items: FeedbackItem[] = [];
  return { items, stop: subscribe(item => { items.push(item); }) };
}

async function withFetch<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return Response.json({ task: { id: 't1' } });
  }) as typeof fetch;
  try { return await fn(calls); } finally { globalThis.fetch = original; }
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

test('今の画面の toast.tsx は、読み込まれたときに feedback を購読して、届いた知らせを自分のトーストに出す', () => {
  const source = readFileSync(new URL('../web/src/toast.tsx', import.meta.url), 'utf8').replace(/\r/gu, '');
  assert.match(source, /^import \{[^}]*\bsubscribe as subscribeFeedback\b[^}]*\} from '\.\/feedback\.ts';$/mu);
  assert.match(source, /^subscribeFeedback\(item => \{ toast\(item\); \}\);$/mu, '一番上の階層で購読し、toast に渡す');
  assert.match(source, /^export function toast\(input: ToastInput\): number \{$/mu);
});

test('受け手がいないときの toast は何もしない（落ちない）', () => {
  assert.doesNotThrow(() => toast({ title: 'nobody' }));
});

test('タスクの取り消しは feedback に「元に戻す」つきの知らせを出し、押すと uncancel を送って「戻した」を知らせる', async () => {
  await withFetch(async calls => {
    const sink = collect();
    try {
      assert.equal(await performTaskAction('cancel', { id: 't1', title: 'Write the report' }), true);
      assert.equal(sink.items.length, 1);
      const first = sink.items[0]!;
      assert.equal(first.title, t('tasks.toast.cancelled'));
      assert.equal(first.body, 'Write the report');
      assert.equal(first.action?.label, t('tasks.toast.undo'));
      first.action!.run();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls, ['POST /api/tasks/t1/cancel', 'POST /api/tasks/t1/uncancel']);
      assert.equal(sink.items[1]?.title, t('tasks.toast.restored'));
    } finally { sink.stop(); }
  });
});

test('会話のアーカイブは feedback に「元に戻す」つきの知らせを出す', async () => {
  await withFetch(async calls => {
    const sink = collect();
    const changes: string[] = [];
    try {
      await archiveConversation('c1', 'Plan', t, change => { changes.push(change.kind); });
      assert.deepEqual(calls, ['PATCH /api/conversations/c1']);
      assert.equal(sink.items[0]?.title, t('chat.archive.done'));
      assert.equal(sink.items[0]?.action?.label, t('chat.archive.undo'));
      assert.deepEqual(changes, ['archived']);
    } finally { sink.stop(); }
  });
});
