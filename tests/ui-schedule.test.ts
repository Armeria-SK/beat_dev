import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RepeatingTask, Task } from '../web/src/api.ts';
import { formatZonedInput, parseZonedInput } from '../web/src/i18n/index.ts';
import { emptyDraft } from '../web/src/task-form.ts';
import { WEEKDAYS } from '../web/src/weekdays.ts';
import {
  confirmStale, draftFromTask, isTimed, otherZone, RELOAD_DELAY_MS, reloadWait, repeatFromCron, repeatingRow, repeatPatch, runNowKind, sameRule, splitSchedule, timePatch,
} from '../web/src/ui/schedule.ts';

// 新しい画面の Schedule（steps/p1-ui.md の「画面」の Schedule と PR 1-4b）の決まり。画面を持たない純粋な関数（web/src/ui/schedule.ts）。

const task = (id: string, status: Task['status'], extra: Partial<Task> = {}): Task => ({
  id, title: id, body: '', next_action: null, done_criteria: null, status, origin: 'user', priority: 2, cron: null, cron_text: null, run_at: null,
  parent_id: null, waiting_text: null, conversation_id: null, result_summary: null, attempts: 0, max_attempts: 3, created_at: 0, updated_at: 0, completed_at: null, ...extra,
});
const template = (id: string, status: Task['status'], extra: Partial<RepeatingTask> = {}): RepeatingTask =>
  ({ ...task(id, status, { cron: '0 9 * * *', cron_text: 'every day at 09:00', run_at: status === 'scheduled' ? 5000 : null }), last_run: null, ...extra });
const lastRun = (status: Task['status']) => ({ id: 'child', status, summary: null, at: 100 });

test('ui/schedule: ひな形の行は、動いている・止めた（Paused）・閉じたを見分け、止めた行と閉じた行は「次の実行」を持たない', () => {
  assert.deepEqual([repeatingRow(template('a', 'scheduled')).state, repeatingRow(template('a', 'scheduled')).next], ['active', 5000]);
  assert.deepEqual([repeatingRow(template('a', 'cancelled', { run_at: 9000 })).state, repeatingRow(template('a', 'cancelled', { run_at: 9000 })).next], ['paused', null]);
  assert.equal(repeatingRow(template('a', 'done')).state, 'ended');
  assert.equal(repeatingRow(template('a', 'failed')).state, 'ended');
});

test('ui/schedule: ひな形の Delete は、動いている回（実行待ち・実行中・返事待ち）があると押せない。終わった回だけなら押せる', () => {
  for (const status of ['ready', 'running', 'waiting'] as const) {
    const row = repeatingRow(template('a', 'scheduled', { last_run: lastRun(status) }));
    assert.deepEqual([row.runOpen, row.blocked], [true, 'run_open'], status);
  }
  for (const status of ['done', 'failed', 'cancelled'] as const) {
    const row = repeatingRow(template('a', 'scheduled', { last_run: lastRun(status) }));
    assert.deepEqual([row.runOpen, row.blocked], [false, null], status);
  }
  assert.equal(repeatingRow(template('a', 'cancelled', { last_run: lastRun('running') })).blocked, 'run_open');
  assert.equal(repeatingRow(template('a', 'scheduled')).blocked, null);
  assert.equal(repeatingRow(template('a', 'scheduled', { conversation_id: 'c1' })).blocked, 'linked');
});

test('ui/schedule: 時刻指定の行は、実行待ちで時刻があり、繰り返しでも毎回の実行でもないタスクだけ', () => {
  assert.equal(isTimed(task('a', 'ready', { run_at: 10 })), true);
  assert.equal(isTimed(task('a', 'ready')), false);
  assert.equal(isTimed(task('a', 'waiting', { run_at: 10 })), false);
  assert.equal(isTimed(task('a', 'inbox', { run_at: 10 })), false);
  assert.equal(isTimed(task('a', 'ready', { run_at: 10, parent_id: 'p' })), false);
  assert.equal(isTimed(task('a', 'scheduled', { run_at: 10, cron: '0 9 * * *' })), false);
});

test('ui/schedule: 分け方。繰り返しは 動いている → 止めた → 閉じた の順で次の実行の早い順、時刻指定は時刻の早い順。動いたことがある時刻指定のタスクは Delete を押せない', () => {
  const split = splitSchedule({
    repeating: [template('ended', 'done'), template('paused', 'cancelled'), template('late', 'scheduled', { run_at: 900 }), template('soon', 'scheduled', { run_at: 100 })],
    active: [task('t2', 'ready', { run_at: 700 }), task('now', 'ready'), task('t1', 'ready', { run_at: 300, conversation_id: 'c' }), task('w', 'waiting', { run_at: 1 }), task('child', 'ready', { run_at: 5, parent_id: 'soon' })],
  });
  assert.deepEqual(split.repeating.map(row => row.task.id), ['soon', 'late', 'paused', 'ended']);
  assert.deepEqual(split.timed.map(row => [row.task.id, row.at, row.blocked]), [['t1', 300, 'ran'], ['t2', 700, null]]);
});

test('ui/schedule: 繰り返しの決まり（cron）を入力の形に戻す。画面で作れる 5 つの形だけ読み、ほかは null（決まりをそのまま残す）', () => {
  assert.deepEqual(repeatFromCron('0 9 * * *'), { freq: 'daily', time: '09:00', day: WEEKDAYS[0].value, minute: '0', interval: '30' });
  assert.equal(repeatFromCron('5 18 * * MON-FRI')?.freq, 'weekday');
  assert.equal(repeatFromCron('5 18 * * MON-FRI')?.time, '18:05');
  assert.deepEqual([repeatFromCron('30 7 * * FRI')?.freq, repeatFromCron('30 7 * * FRI')?.day, repeatFromCron('30 7 * * FRI')?.time], ['weekly', WEEKDAYS[4].value, '07:30']);
  assert.deepEqual([repeatFromCron('15 * * * *')?.freq, repeatFromCron('15 * * * *')?.minute], ['hourly', '15']);
  assert.deepEqual([repeatFromCron('*/5 * * * *')?.freq, repeatFromCron('*/5 * * * *')?.interval], ['interval', '5']);
  for (const cron of ['0 9 1 * *', '0 9 * 6 *', '0 9,18 * * *', '*/5 9 * * *', '0 9 * * MON,WED', '61 9 * * *', '0 9 * *', '', null]) assert.equal(repeatFromCron(cron), null, String(cron));
});

test('ui/schedule: Edit の入力は題・本文・優先度・決まりを今の値で始める。読めない決まりは ruleKnown が false', () => {
  const known = draftFromTask({ title: 'Morning', body: 'b', priority: 1, cron: '0 9 * * *' });
  assert.deepEqual([known.ruleKnown, known.draft.title, known.draft.body, known.draft.priority, known.draft.when, known.draft.freq, known.draft.time], [true, 'Morning', 'b', 1, 'repeat', 'daily', '09:00']);
  assert.equal(draftFromTask({ title: 'x', body: '', priority: 2, cron: '0 9 1 * *' }).ruleKnown, false);
});

test('ui/schedule: Edit の保存は変えた欄だけ送る。決まりは変えたときだけ repeat を送り、読めない決まりは「変える」を開いたときだけ送る', () => {
  const start = draftFromTask({ title: 'Morning', body: '', priority: 2, cron: '0 9 * * *' }).draft;
  assert.deepEqual(repeatPatch(start, { ...start }, { known: true, open: true }), {});
  assert.deepEqual(repeatPatch(start, { ...start, title: ' Evening ', priority: 1 }, { known: true, open: true }), { title: 'Evening', priority: 1 });
  assert.deepEqual(repeatPatch(start, { ...start, time: '10:30' }, { known: true, open: true }), { repeat: { freq: 'daily', values: { time: '10:30', day: start.day, minute: '0', interval: '30' } } });
  assert.deepEqual(repeatPatch(start, { ...start, freq: 'hourly' }, { known: true, open: true }).repeat?.freq, 'hourly');
  assert.deepEqual(repeatPatch(start, { ...start, minute: '7', interval: '9' }, { known: true, open: true }), {});
  assert.deepEqual(repeatPatch(start, { ...start, body: 'more' }, { known: false, open: false }), { body: 'more' });
  assert.equal(repeatPatch(start, { ...start }, { known: false, open: true }).repeat?.freq, 'daily');
  assert.equal(sameRule({ ...emptyDraft(), freq: 'interval', interval: '05' }, { ...emptyDraft(), freq: 'interval', interval: '5' }), true);
  assert.equal(sameRule({ ...emptyDraft(), freq: 'weekly', day: WEEKDAYS[0].value }, { ...emptyDraft(), freq: 'weekly', day: WEEKDAYS[1].value }), false);
});

test('ui/schedule: 閉じたひな形の Run now は "Restart" と名乗り、止めた行には出さない', () => {
  assert.deepEqual([runNowKind('active'), runNowKind('ended'), runNowKind('paused')], ['run', 'restart', null]);
});

test('ui/schedule: Delete の確かめを開いているあいだに押せない理由が付いたら、確かめを閉じる', () => {
  const open = repeatingRow(template('a', 'scheduled', { last_run: lastRun('running') }));
  const free = repeatingRow(template('b', 'scheduled'));
  assert.equal(confirmStale('a', [open, free]), true);
  assert.equal(confirmStale('b', [open, free]), false);
  assert.equal(confirmStale(null, [open, free]), false);
  assert.equal(confirmStale('gone', [open, free]), false);
});

test('ui/schedule: 知らせで起きる読み直しは、前の読み直しから 2 秒より詰めない', () => {
  assert.equal(reloadWait(10_000, 10_100), 1900);
  assert.equal(reloadWait(10_000, 11_900), RELOAD_DELAY_MS);
  assert.equal(reloadWait(10_000, 60_000), RELOAD_DELAY_MS);
  assert.equal(reloadWait(0, 60_000), RELOAD_DELAY_MS);
});

test('ui/schedule: ひな形のタイムゾーンが今の設定と違うときだけ、欄の横に出す', () => {
  assert.equal(otherZone('America/New_York', 'Asia/Tokyo'), 'America/New_York');
  assert.equal(otherZone('Asia/Tokyo', 'Asia/Tokyo'), null);
  assert.equal(otherZone(null, 'Asia/Tokyo'), null);
  assert.equal(otherZone(undefined, 'Asia/Tokyo'), null);
});

test('ui/schedule: 時刻指定の Edit の欄は、サーバーのタイムゾーンの時刻で始まり、そのまま読み戻せる', () => {
  const ms = Date.UTC(2026, 10, 12, 5, 30);
  assert.equal(formatZonedInput(ms, 'Asia/Tokyo'), '2026-11-12T14:30');
  assert.equal(parseZonedInput(formatZonedInput(ms, 'Asia/Tokyo'), 'Asia/Tokyo'), ms);
  assert.equal(formatZonedInput(ms, 'America/New_York'), '2026-11-12T00:30');
});

test('ui/schedule: 時刻指定の Edit を変えずに Save しても when を送らない（秒の付いた予定・夏時間が戻る夜の 2 回目の時刻がずれない）', () => {
  const withSeconds = Date.UTC(2026, 10, 12, 5, 30, 45);
  const tokyo = formatZonedInput(withSeconds, 'Asia/Tokyo');
  assert.equal(timePatch(tokyo, tokyo, 'Asia/Tokyo'), null);
  assert.equal(timePatch(tokyo, ` ${tokyo} `, 'Asia/Tokyo'), null);
  const secondOneThirty = Date.UTC(2026, 10, 1, 6, 30);
  const ny = formatZonedInput(secondOneThirty, 'America/New_York');
  assert.equal(ny, '2026-11-01T01:30');
  assert.notEqual(parseZonedInput(ny, 'America/New_York'), secondOneThirty);
  assert.equal(timePatch(ny, ny, 'America/New_York'), null);
  assert.deepEqual(timePatch(tokyo, '2026-11-12T15:00', 'Asia/Tokyo'), { when: new Date(Date.UTC(2026, 10, 12, 6, 0)).toISOString() });
  assert.equal(timePatch(tokyo, '', 'Asia/Tokyo'), 'invalid');
  assert.equal(timePatch('', '', 'Asia/Tokyo'), 'invalid');
});
