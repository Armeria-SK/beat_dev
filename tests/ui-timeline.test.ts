import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScheduleSlot } from '../web/src/api.ts';
import { buildRows, dayBars, dayHours, nowAt, scrollToNow, weekBars, windowOf, type Stream, type TimeWindow } from '../web/src/ui/timeline.ts';

// 新しい画面の時間割の線（steps/p1-ui.md の Schedule の「時間割の線」と PR 1-4b）。枠を幅の % に直す・Day / Week・今の印・打ち切られたひな形の帯。
// 画面を持たない純粋な関数（web/src/ui/timeline.ts）。

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utcDay = (ms: number): number => Math.floor(ms / DAY) * DAY;
const slot = (taskId: string, start: number, length: number, state: ScheduleSlot['state'] = 'planned'): ScheduleSlot => ({ taskId, runTaskId: null, title: taskId, start, length, state });
const DAY_WINDOW: TimeWindow = { from: 0, to: DAY, days: [0, DAY] };
const stream = (id: string, extra: Partial<Stream> = {}): Stream => ({ id, title: id, paused: false, rule: null, truncated: false, ...extra });

test('ui/timeline: Day は今日の 0 時から次の 0 時、Week は 3 日前から 7 日ぶん（今の印が真ん中の日に来る）', () => {
  const now = 10 * DAY + 5 * HOUR;
  assert.deepEqual(windowOf('day', now, utcDay), { from: 10 * DAY, to: 11 * DAY, days: [10 * DAY, 11 * DAY] });
  const week = windowOf('week', now, utcDay);
  assert.deepEqual([week.from, week.to, week.days.length], [7 * DAY, 14 * DAY, 8]);
  assert.deepEqual(week.days, [7, 8, 9, 10, 11, 12, 13, 14].map(n => n * DAY));
  assert.ok(week.to - week.from <= 8 * DAY);
  assert.deepEqual(dayHours(), ['00', '03', '06', '09', '12', '15', '18', '21']);
});

test('ui/timeline: 1 日が 23 時間・25 時間の日（夏時間の切り替え）でも、日の境目は「その日の始まり」で決まる', () => {
  const starts = [0, 23 * HOUR, 23 * HOUR + 25 * HOUR, 23 * HOUR + 25 * HOUR + DAY];
  const dayStart = (ms: number): number => [...starts].reverse().find(start => start <= ms) ?? (ms < 0 ? -DAY : 0);
  assert.deepEqual(windowOf('day', 5 * HOUR, dayStart), { from: 0, to: 23 * HOUR, days: [0, 23 * HOUR] });
  assert.deepEqual(windowOf('day', 30 * HOUR, dayStart).to - windowOf('day', 30 * HOUR, dayStart).from, 25 * HOUR);
});

test('ui/timeline: 今の印の位置は範囲の中の割合（0〜1。外にはみ出さない）', () => {
  assert.equal(nowAt(6 * HOUR, DAY_WINDOW), 0.25);
  assert.equal(nowAt(-5, DAY_WINDOW), 0);
  assert.equal(nowAt(2 * DAY, DAY_WINDOW), 1);
});

test('ui/timeline: 枠の位置と幅は範囲に対する %。範囲からはみ出す分は切り、範囲の外の枠は出さない', () => {
  const bars = dayBars([slot('a', 6 * HOUR, 3 * HOUR, 'past'), slot('b', 12 * HOUR, 6 * HOUR, 'live'), slot('c', 23 * HOUR, 4 * HOUR), slot('out', 2 * DAY, HOUR), slot('before', -3 * HOUR, HOUR, 'past')], DAY_WINDOW);
  assert.deepEqual(bars.map(b => [b.title, b.at, b.len, b.state]), [['a', 25, 12.5, 'past'], ['b', 50, 25, 'live'], ['c', 95.833, 4.167, 'planned']]);
  const cut = dayBars([slot('x', -2 * HOUR, 8 * HOUR, 'past')], DAY_WINDOW)[0]!;
  assert.deepEqual([cut.at, cut.len], [0, 25]);
});

test('ui/timeline: 隣り合う同じ種類の枠（すき間が範囲の 0.25% 以下）は 1 本にまとめ、数を持つ。種類が違えばまとめない', () => {
  const minute = 60_000;
  const many = Array.from({ length: 60 }, (_, i) => slot('m', HOUR + i * minute, 5000, 'past'));
  const bars = dayBars(many, DAY_WINDOW);
  assert.equal(bars.length, 1);
  assert.deepEqual([bars[0]!.count, bars[0]!.state, bars[0]!.band], [60, 'past', false]);
  assert.ok(Math.abs(bars[0]!.at - (HOUR / DAY) * 100) < 0.01 && bars[0]!.len > 4 && bars[0]!.len < 4.2);
  assert.equal(dayBars([slot('a', HOUR, 1000, 'past'), slot('b', HOUR + 2000, 1000, 'planned')], DAY_WINDOW).length, 2);
  assert.equal(dayBars([slot('a', HOUR, 1000, 'past'), slot('b', 3 * HOUR, 1000, 'past')], DAY_WINDOW).length, 2);
});

test('ui/timeline: Week は 1 日に「動いた分」と「これからの分」を 1 本ずつ。幅はその日の合計の長さ', () => {
  const week = windowOf('week', 3 * DAY + HOUR, utcDay);
  const bars = weekBars([
    slot('a', 2 * DAY + HOUR, 2 * HOUR, 'past'), slot('a', 2 * DAY + 5 * HOUR, HOUR, 'past'),
    slot('a', 3 * DAY, HOUR, 'live'), slot('a', 3 * DAY + 4 * HOUR, 2 * HOUR), slot('a', 5 * DAY, 3 * HOUR),
  ], week);
  const span = 7 * DAY;
  assert.deepEqual(bars.map(b => [b.state, b.count, Math.round(b.len * span / 100 / HOUR)]), [['past', 2, 3], ['live', 1, 1], ['planned', 1, 2], ['planned', 1, 3]]);
  assert.equal(bars[0]!.at, Math.round((2 * DAY / span) * 100_000) / 1000);
  assert.ok(bars[2]!.at > bars[1]!.at && bars[2]!.at < (4 * DAY / span) * 100);
  assert.equal(bars[3]!.at, Math.round((5 * DAY / span) * 100_000) / 1000);
});

test('ui/timeline: 行は "Tasks"（ひな形でないタスクの回）が先頭、次にひな形ごと。止めたひな形は場所を保ち、これからの枠を持たない', () => {
  const rows = buildRows({
    slots: [slot('t1', 2 * HOUR, HOUR), slot('one-off', 3 * HOUR, HOUR, 'past'), slot('r1', 4 * HOUR, HOUR, 'past'), slot('r1', 9 * HOUR, HOUR), slot('r2', 5 * HOUR, HOUR, 'past'), slot('r2', 10 * HOUR, HOUR)],
    streams: [stream('r1'), stream('r2', { paused: true })], tasksTitle: 'Tasks', range: 'day', window: DAY_WINDOW, now: 6 * HOUR,
  });
  assert.deepEqual(rows.map(row => [row.id, row.title, row.paused, row.bars.map(b => b.state)]), [
    ['', 'Tasks', false, ['planned', 'past']],
    ['r1', 'r1', false, ['past', 'planned']],
    ['r2', 'r2', true, ['past']],
  ]);
});

test('ui/timeline: ひな形でないタスクの回は製品ごとの行に分かれる。製品なしと一覧に無い製品は "Tasks" の行（2-2c）', () => {
  const at = (taskId: string, start: number, projectId?: string | null): ScheduleSlot => ({ ...slot(taskId, start, HOUR), ...(projectId === undefined ? {} : { projectId }) });
  const rows = buildRows({
    slots: [at('a', HOUR, 'p1aaaa'), at('b', 3 * HOUR), at('c', 5 * HOUR, null), at('d', 7 * HOUR, 'gone01'), at('r1', 9 * HOUR, 'p1aaaa'), at('e', 11 * HOUR, 'p2aaaa')],
    streams: [stream('r1')], tasksTitle: 'Tasks', range: 'day', window: DAY_WINDOW, now: 0,
    products: [{ id: 'p1aaaa', title: 'One' }, { id: 'p2aaaa', title: 'Two' }, { id: 'p3aaaa', title: 'Three' }],
  });
  assert.deepEqual(rows.map(row => [row.id, row.title, row.bars.map(b => b.start / HOUR)]), [
    ['', 'Tasks', [3, 5, 7]],
    ['product:p1aaaa', 'One', [1]],
    ['product:p2aaaa', 'Two', [11]],
    ['product:p3aaaa', 'Three', []],
    ['r1', 'r1', [9]],
  ]);
});

test('ui/timeline: 閉じたひな形の行は ended と分かり、止めただけの行・動いている行には付かない', () => {
  const rows = buildRows({
    slots: [slot('r3', 10 * HOUR, HOUR)],
    streams: [stream('r1', { ended: false }), stream('r2', { paused: true }), stream('r3', { paused: true, ended: true })], tasksTitle: 'Tasks', range: 'day', window: DAY_WINDOW, now: 6 * HOUR,
  });
  assert.deepEqual(rows.slice(1).map(row => [row.id, row.paused, row.ended === true, row.bars.length]), [['r1', false, false, 0], ['r2', true, false, 0], ['r3', true, true, 0]]);
});

test('ui/timeline: 打ち切られたひな形（毎分の決まりなど）は、これからの枠を並べずに、今から範囲の終わりまでの 1 本の帯で描き、決まりの文を持つ', () => {
  const minute = 60_000;
  const planned = Array.from({ length: 200 }, (_, i) => slot('every', 6 * HOUR + (i + 1) * minute, 30_000));
  for (const range of ['day', 'week'] as const) {
    const w = range === 'day' ? DAY_WINDOW : { from: -3 * DAY, to: 4 * DAY, days: [-3, -2, -1, 0, 1, 2, 3, 4].map(n => n * DAY) };
    const rows = buildRows({ slots: [slot('every', 5 * HOUR, 30_000, 'past'), ...planned], streams: [stream('every', { truncated: true, rule: 'every minute' })], tasksTitle: 'Tasks', range, window: w, now: 6 * HOUR });
    const row = rows[1]!;
    const bands = row.bars.filter(b => b.band);
    assert.equal(row.rule, 'every minute', range);
    assert.equal(bands.length, 1, range);
    assert.equal(row.bars.filter(b => b.state === 'planned').length, 1, range);
    assert.deepEqual([bands[0]!.start, bands[0]!.end, bands[0]!.count], [6 * HOUR, w.to, 200], range);
    assert.equal(Math.round(bands[0]!.at + bands[0]!.len), 100, range);
    assert.equal(row.bars.filter(b => b.state === 'past').length, 1, range);
  }
  const plain = buildRows({ slots: planned.slice(0, 3), streams: [stream('every', { rule: 'every minute' })], tasksTitle: 'Tasks', range: 'day', window: DAY_WINDOW, now: 6 * HOUR })[1]!;
  assert.deepEqual([plain.rule, plain.bars.some(b => b.band)], [null, false]);
});

test('ui/timeline: 狭い幅では、今の印が（止めてある名前の列の右の）見える所の真ん中に来るまで横にスクロールして開く', () => {
  assert.equal(scrollToNow(0.5, 560, 120, 340), 110);
  assert.equal(120 + (560 - 120) * 0.5 - scrollToNow(0.5, 560, 120, 340), 120 + (340 - 120) / 2);
  assert.equal(scrollToNow(0, 560, 120, 340), 0);
});
