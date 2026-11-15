import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holdChange, isHeld, NO_HOLD, notificationToast, pauseClock, pushToast, resumeClock, startClock, TOAST_A, TOAST_B, toastDuration, type ToastEntry } from '../web/src/ui/toast-list.ts';

// 新しい画面のトースト（steps/p1-ui.md の T6 と PR 1-4a）。数と長さは 2 つの形（a: 2 つまで・5 秒、b: 3 つまで・3.6 秒。Undo つきはどちらも 6 秒）。
// 乗せているあいだ止まる時計と、サーバーの通知 → トーストの直し方。画面を持たない関数（web/src/ui/toast-list.ts）。

const entry = (id: number): ToastEntry => ({ id, item: { title: `t${id}` }, leaving: false });
const undo = { label: 'Undo', run: () => undefined };

test('ui/toasts: T6 の 2 つの形。a は 2 つまで・5 秒、b は 3 つまで・3.6 秒、Undo つきはどちらも 6 秒', () => {
  assert.deepEqual([TOAST_A.max, TOAST_A.ms, TOAST_A.undoMs], [2, 5000, 6000]);
  assert.deepEqual([TOAST_B.max, TOAST_B.ms, TOAST_B.undoMs], [3, 3600, 6000]);
  assert.equal(toastDuration({ title: 'x' }, TOAST_B), 3600);
  assert.equal(toastDuration({ title: 'x', action: undo }, TOAST_B), 6000);
  assert.equal(toastDuration({ title: 'x', action: undo }, TOAST_A), 6000);
  assert.equal(toastDuration({ title: 'x' }), 5000, '渡さなければ a');
  const four = [1, 2, 3, 4].reduce<ToastEntry[]>((list, id) => pushToast(list, entry(id), TOAST_B.max), []);
  assert.deepEqual(four.map(e => e.id), [2, 3, 4], '古いものから消える');
  assert.deepEqual([1, 2, 3].reduce<ToastEntry[]>((list, id) => pushToast(list, entry(id), TOAST_A.max), []).map(e => e.id), [2, 3]);
});

test('ui/toasts: 乗せているあいだ時計は止まり、離すと残りの時間から続く', () => {
  const started = startClock(5000, 100);
  const paused = pauseClock(started, 1600);
  assert.deepEqual(paused, { remaining: 3500, startedAt: null });
  assert.deepEqual(pauseClock(paused, 9999), paused, '止まっている時計をもう一度止めても減らない');
  const resumed = resumeClock(paused, 20_000);
  assert.deepEqual(resumed, { remaining: 3500, startedAt: 20_000 });
  assert.deepEqual(resumeClock(resumed, 30_000), resumed, '動いている時計は始め直さない');
  assert.equal(pauseClock(started, 99_999).remaining, 0, '負にならない');
});

test('ui/toasts: 乗せている・フォーカスがあるは別々に持つ。どちらかがあるあいだ止まり、両方が無くなったときだけ動かす（対にならない合図で残り時間をやり直さない）', () => {
  const hovered = holdChange(NO_HOLD, 'hover', true);
  assert.deepEqual(hovered, { hold: { hover: true, focus: false }, flip: true });
  const focused = holdChange(hovered.hold, 'focus', true);
  assert.equal(focused.flip, null, 'もう止まっているので、時計には触らない');
  const left = holdChange(focused.hold, 'hover', false);
  assert.equal(left.flip, null, 'フォーカスが残っているあいだは止めたまま');
  assert.equal(isHeld(left.hold), true);
  const blurred = holdChange(left.hold, 'focus', false);
  assert.deepEqual(blurred, { hold: NO_HOLD, flip: false });
  assert.equal(holdChange(NO_HOLD, 'focus', false).flip, null, '止まっていないのに来た「動かす」は何もしない');
  assert.equal(holdChange(NO_HOLD, 'hover', false).flip, null);

  let clock = startClock(5000, 0);
  let hold = NO_HOLD;
  const signal = (part: 'hover' | 'focus', on: boolean, now: number) => {
    const change = holdChange(hold, part, on);
    hold = change.hold;
    if (change.flip !== null) clock = change.flip ? pauseClock(clock, now) : resumeClock(clock, now);
  };
  signal('hover', false, 1000);
  signal('focus', false, 2000);
  assert.deepEqual(clock, { remaining: 5000, startedAt: 0 }, '対にならない「離れた」が続いても、始めの時刻のまま');
  signal('hover', true, 3000);
  signal('focus', true, 3500);
  signal('hover', false, 4000);
  signal('focus', false, 9000);
  assert.deepEqual(clock, { remaining: 2000, startedAt: 9000 });
});

test('ui/toasts: サーバーの通知をトーストにする。待ちは点、失敗は alert、ほかは check。行き先は新しい経路に読み替える', () => {
  assert.deepEqual(notificationToast({ kind: 'task_waiting', title: 'Waiting for you', body: 'Pick a name\nsecond line', link: '#/tasks/abc' }),
    { title: 'Waiting for you', body: 'Pick a name', lead: 'dot', href: '#/tasks/abc' });
  assert.deepEqual(notificationToast({ kind: 'approval_needed', title: 'A', body: null, link: '#/c/x1' }), { title: 'A', lead: 'dot', href: '#/c/x1' });
  assert.deepEqual(notificationToast({ kind: 'task_failed', title: 'F', body: '', link: null }), { title: 'F', icon: 'alert' });
  assert.deepEqual(notificationToast({ kind: 'task_done', title: 'D', body: 'x', link: '#/tasks' }), { title: 'D', body: 'x', icon: 'check', href: '#/kanban' });
  assert.equal(notificationToast({ kind: 'info', title: 'I', body: null, link: 'https://example.com/' }).href, undefined, '外の URL へは飛ばさない');
});

test('ui/toasts: トーストを押した行き先は、知らせの一覧の行のボタンと同じ（Pending は製品の一覧へ。新しい質問は点。beat 5-u2）', () => {
  assert.deepEqual(notificationToast({ kind: 'approval_needed', title: 'Parked', body: '#12 git commit', link: '#/pending', project_id: 'prod-abc123' }),
    { title: 'Parked', body: '#12 git commit', lead: 'dot', href: '#/pending/prod-abc123' });
  assert.deepEqual(notificationToast({ kind: 'question_new', title: 'New question', body: null, link: null, project_id: 'prod-abc123' }),
    { title: 'New question', lead: 'dot', href: '#/questions/prod-abc123' });
  assert.equal(notificationToast({ kind: 'task_failed', title: 'F', body: null, link: '#/tasks/t1', action: 'retry' }).href, '#/tasks/t1');
});
