import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_MAP } from '../src/tasks/schedule.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';
import {
  applyServerSettings, formatDateTime, formatDateTimeSmart, formatList, formatNumber, formatRelative, getTimezone, loadServerSettings, parseZonedInput, pluralEn,
  setTimezone, startOfDay, t, timezoneLabel,
} from '../web/src/i18n/index.ts';
import { subscribe } from '../web/src/i18n/state.ts';
import { WEEKDAYS } from '../web/src/weekdays.ts';

function reset() {
  setTimezone('Asia/Tokyo');
}

test('applyServerSettings: 設定の timezone を画面に反映する', () => {
  reset();
  applyServerSettings({ config: { timezone: 'America/New_York' } });
  assert.equal(getTimezone(), 'America/New_York');
  reset();
});

test('t(): 英語の辞書を引き、関数の項目には引数を差し込む', () => {
  reset();
  assert.equal(t('ui.nav.kanban'), 'Kanban');
  assert.equal(t('ui.foot.waiting', 3), '3 waiting for you');
  assert.equal(t('ui.checklist.count', 2, 5), '2 / 5');
  reset();
});

test('辞書: en の文字列の項目は空でなく、関数の項目は引数が訳に出る', () => {
  const enKeys = Object.keys(en).sort();
  assert.ok(enKeys.length > 30, `キーが ${enKeys.length} 件しか読めていない`);
  let functionEntries = 0;
  for (const key of enKeys) {
    const enEntry = (en as Record<string, unknown>)[key];
    assert.ok(typeof enEntry === 'string' ? enEntry.length > 0 : typeof enEntry === 'function', `${key}: 空の訳`);
    if (typeof enEntry !== 'function') continue;
    functionEntries += 1;
    const args = Array.from({ length: enEntry.length }, (_, i) => 7001 + i);
    const out = (enEntry as (...a: number[]) => string)(...args);
    for (const arg of args) assert.ok(out.includes(String(arg)), `${key} の訳に引数 ${arg} が出ていない: ${out}`);
  }
  assert.ok(functionEntries >= 5, `関数の項目が ${functionEntries} 件しか読めていない`);
});

test('formatDateTime: ブラウザではなくサーバーのタイムゾーンで表示する', () => {
  reset();
  const instant = Date.UTC(2026, 10, 5, 0, 30);
  assert.equal(formatDateTime(instant), '11/5 09:30');
  assert.equal(formatDateTime(instant, 'full'), '2026/11/05 09:30');
  assert.equal(formatDateTime(instant, 'precise'), '11/05 09:30:00');
  assert.equal(formatDateTime(instant, 'time'), '09:30');
  const midnight = Date.UTC(2026, 10, 19, 15, 5);
  assert.equal(formatDateTime(midnight), '11/20 00:05', '0 時は 24 時でなく 00 時');
  assert.equal(formatDateTime(midnight, 'full'), '2026/11/20 00:05');
  assert.equal(formatDateTime(midnight, 'precise'), '11/20 00:05:00');
  assert.equal(formatDateTime(midnight, 'time'), '00:05');
  setTimezone('America/New_York');
  assert.equal(formatDateTime(instant), '11/4 19:30', 'ニューヨークでは前の日の夜');
  assert.equal(formatDateTime(null), '—');
  assert.equal(formatDateTime(undefined), '—');
  reset();
});

test('setTimezone: 読めないタイムゾーンは既定（Asia/Tokyo）に戻し、購読者へ知らせる', () => {
  reset();
  let calls = 0;
  const off = subscribe(() => { calls += 1; });
  setTimezone('America/New_York');
  assert.equal(getTimezone(), 'America/New_York');
  assert.equal(calls, 1);
  setTimezone('America/New_York');
  assert.equal(calls, 1, '同じ値では知らせない');
  setTimezone('Not/AZone');
  assert.equal(getTimezone(), 'Asia/Tokyo');
  assert.equal(calls, 2);
  off();
  reset();
});

test('parseZonedInput: datetime-local の値を、サーバーのタイムゾーンの時刻として読む', () => {
  assert.equal(parseZonedInput('2026-11-06T09:00', 'Asia/Tokyo'), Date.UTC(2026, 10, 6, 0, 0));
  assert.equal(parseZonedInput('2026-01-15T09:00', 'America/New_York'), Date.UTC(2026, 0, 15, 14, 0), '冬は UTC-5');
  assert.equal(parseZonedInput('2026-07-15T09:00', 'America/New_York'), Date.UTC(2026, 6, 15, 13, 0), '夏は UTC-4');
  assert.equal(parseZonedInput('2026-07-15T09:00:30', 'America/New_York'), Date.UTC(2026, 6, 15, 13, 0, 30), '秒つきも読める');
  assert.equal(parseZonedInput('2026-06-01T12:00', 'UTC'), Date.UTC(2026, 5, 1, 12, 0));
  assert.equal(parseZonedInput('2026-06-01T12:00', 'Asia/Kolkata'), Date.UTC(2026, 5, 1, 6, 30), '30 分ずれの地域');
  assert.equal(parseZonedInput('2026-03-08T02:30', 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30), '存在しない時刻（夏時間に入る日）は後ろへずらす');
  assert.equal(parseZonedInput('2026-11-01T01:30', 'America/New_York'), Date.UTC(2026, 10, 1, 5, 30), '2 回ある時刻（夏時間が終わる日）は先の方');
  assert.equal(parseZonedInput('2026-03-08T03:30', 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30), '夏時間に入った直後の時刻');
  assert.equal(parseZonedInput('2026-11-01T03:30', 'America/New_York'), Date.UTC(2026, 10, 1, 8, 30), '夏時間が終わった直後の時刻');
  assert.equal(parseZonedInput('2026-04-04T20:00', 'Australia/Sydney'), Date.UTC(2026, 3, 4, 9, 0), 'UTC より進んでいる地域の、夏時間が終わる前の時刻');
  for (const bad of ['', 'abc', '2026-02-30T10:00', '2026-13-01T10:00', '2026-11-06T25:00', '2026-11-06']) assert.equal(parseZonedInput(bad, 'Asia/Tokyo'), null, `「${bad}」は読めない`);
  setTimezone('America/New_York');
  assert.equal(parseZonedInput('2026-01-15T09:00'), Date.UTC(2026, 0, 15, 14, 0), '引数なしは設定のタイムゾーン');
  reset();
});

test('startOfDay: 設定のタイムゾーンでその日の 0 時を返す', () => {
  const instant = Date.UTC(2026, 10, 5, 0, 30);
  assert.equal(startOfDay(instant, 'Asia/Tokyo'), Date.UTC(2026, 10, 4, 15, 0), '東京は 11/5 09:30。0 時は前日の 15:00Z');
  assert.equal(startOfDay(instant, 'America/New_York'), Date.UTC(2026, 10, 4, 5, 0), 'ニューヨークは 11/4 19:30（夏時間は 11/1 に終わっている）。0 時は 05:00Z');
  assert.equal(startOfDay(Date.UTC(2026, 6, 5, 3, 0), 'America/New_York'), Date.UTC(2026, 6, 4, 4, 0), '夏は UTC-4。0 時は 04:00Z');
  assert.equal(startOfDay(instant, 'UTC'), Date.UTC(2026, 10, 5, 0, 0));
});

test('timezoneLabel: 名前と UTC からのずれを返す', () => {
  const winter = Date.UTC(2026, 0, 15);
  assert.equal(timezoneLabel('Asia/Tokyo', winter), 'Asia/Tokyo (UTC+09:00)');
  assert.equal(timezoneLabel('America/New_York', winter), 'America/New_York (UTC-05:00)');
  assert.equal(timezoneLabel('America/New_York', Date.UTC(2026, 6, 15)), 'America/New_York (UTC-04:00)');
  assert.equal(timezoneLabel('Asia/Kolkata', winter), 'Asia/Kolkata (UTC+05:30)');
  assert.equal(timezoneLabel('UTC', winter), 'UTC (UTC+00:00)');
});

test('formatRelative / formatNumber / formatList / pluralEn: 英語で整える', () => {
  reset();
  const now = Date.UTC(2026, 10, 5, 12, 0);
  assert.equal(formatRelative(now - 3 * 86_400_000, now), '3 days ago');
  assert.equal(formatRelative(now - 10_000, now), 'now');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatList([]), '');
  assert.equal(formatRelative(now - 3 * 60_000, now), '3 minutes ago');
  assert.equal(formatRelative(now + 2 * 3_600_000, now), 'in 2 hours');
  assert.equal(formatRelative(now - 800 * 86_400_000, now), '2 years ago');
  assert.equal(formatRelative(now, now), 'now');
  assert.equal(formatList(['a', 'b', 'c']), 'a, b, and c');
  assert.equal(formatList(['a', 'b']), 'a and b');
  assert.equal(pluralEn(1, { one: '1 task', other: '2+ tasks' }), '1 task');
  assert.equal(pluralEn(0, { one: '1 task', other: '0 tasks' }), '0 tasks');
  assert.equal(pluralEn(5, { one: 'x', other: '5 tasks' }), '5 tasks');
  reset();
});

test('WEEKDAYS: API に送る値はサーバーの曜日の読み取りと同じ日本語のままで、ラベルは英語', () => {
  reset();
  assert.deepEqual(WEEKDAYS.map(d => d.value), Object.keys(DAY_MAP), 'サーバー（src/tasks/schedule.ts の DAY_MAP）と同じ値・同じ順');
  assert.deepEqual(WEEKDAYS.map(d => t(d.label)), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  reset();
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => undefined;
  try { return await fn(); } finally { console.warn = warn; }
}

test('loadServerSettings: 待ち時間のうちに届いた設定のタイムゾーンを反映する', async () => {
  reset();
  await loadServerSettings(async () => ({ config: { timezone: 'America/New_York' } }), { waitMs: 200 });
  assert.equal(getTimezone(), 'America/New_York');
  reset();
});

test('loadServerSettings: 待ち時間のあとに届いた設定も捨てず、届いた時点でタイムゾーンを反映する', async () => {
  reset();
  const started = Date.now();
  await loadServerSettings(async () => { await sleep(120); return { config: { timezone: 'America/New_York' } }; }, { waitMs: 20 });
  assert.ok(Date.now() - started < 100, '最初の描画は待ち時間で先へ進む');
  assert.equal(getTimezone(), 'Asia/Tokyo', '届くまでは既定のまま');
  await sleep(200);
  assert.equal(getTimezone(), 'America/New_York', '遅れて届いた設定で入れ替わる');
  reset();
});

test('loadServerSettings: 読めなかったときは一度だけやり直し、それでも読めなければ既定のまま', async () => {
  reset();
  let calls = 0;
  await quietly(async () => {
    await loadServerSettings(async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return { config: { timezone: 'Europe/Paris' } };
    }, { waitMs: 200, retryMs: 20 });
    assert.equal(getTimezone(), 'Asia/Tokyo', '最初の読み込みは失敗');
    await sleep(120);
    assert.equal(calls, 2);
    assert.equal(getTimezone(), 'Europe/Paris', 'やり直しで届いた設定を反映する');
  });
  let failures = 0;
  await quietly(async () => {
    await loadServerSettings(async () => { failures += 1; throw new Error('down'); }, { waitMs: 200, retryMs: 20 });
    await sleep(150);
  });
  assert.equal(failures, 2, '最初の 1 回とやり直しの 1 回だけ');
  assert.equal(getTimezone(), 'Europe/Paris', '失敗では書き換えない');
  reset();
});

test('loadServerSettings: timezone が文字列でなければ何もしない', async () => {
  reset();
  await loadServerSettings(async () => ({ config: {} }), { waitMs: 200 });
  await loadServerSettings(async () => ({ config: { timezone: 9 } }), { waitMs: 200 });
  assert.equal(getTimezone(), 'Asia/Tokyo');
});

test('t(): 引数が違うキーの和集合は型で断り、引数が同じ和集合は呼べる', () => {
  reset();
  const mixed = 'ui.nav.kanban' as 'ui.nav.kanban' | 'ui.foot.waiting';
  // @ts-expect-error 文字列の項目と関数の項目の和集合は、引数が決まらないので呼べない
  const rejected = () => t(mixed);
  assert.equal(typeof rejected, 'function');
  const memory = 'ui.notice.memoryCreate' as 'ui.notice.memoryCreate' | 'ui.notice.memoryUpdate';
  assert.equal(t(memory, 'x'), 'Memory saved: x');
  const plain = 'ui.nav.kanban' as 'ui.nav.kanban' | 'ui.nav.memory';
  assert.equal(t(plain), 'Kanban');
});

test('formatDateTimeSmart: 今日（設定のタイムゾーンで）の時刻は時刻だけ、別の日は日付つき', () => {
  reset();
  const now = Date.UTC(2026, 10, 5, 3, 0);
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 0, 30), now), '09:30', '同じ日（東京）は時刻だけ');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 20, 0), now), '11/6 05:00', '翌日は日付つき');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 4, 14, 59), now), '11/4 23:59', '前日は日付つき');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 14, 59), now), '23:59', '今日の終わりまで');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 15, 0), now), '11/6 00:00', '東京の 0 時から別の日');
  assert.equal(formatDateTimeSmart(null, now), '—');
  setTimezone('America/New_York');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 0, 30), now), '19:30', 'ニューヨークでは now と同じ日（11/4）の晩');
  assert.equal(formatDateTimeSmart(Date.UTC(2026, 10, 5, 12, 0), now), '11/5 07:00', 'ニューヨークでは翌日（11/5）の朝');
  reset();
});

test('walk-1118 D1: Check command の説明は「まだ実行しない」と言わず、タスクが終わったと言うたびに実行し、通るまで完了にしないと言う（task_complete が runProductCheck を呼ぶので）', () => {
  assert.doesNotMatch(en['ui.np.checkHint'], /does not run|not run it/u);
  assert.match(en['ui.np.checkHint'], /runs it each time a task says it is finished/u);
  assert.match(en['ui.np.checkHint'], /not marked done until it passes/u);
  assert.doesNotMatch(ja['ui.np.checkHint'], /まだ実行しません|控えるだけ/u);
  assert.match(ja['ui.np.checkHint'], /タスクが終わったと言うたびに beat が実行し/u);
  assert.match(ja['ui.np.checkHint'], /通るまでタスクは完了になりません/u);
});
