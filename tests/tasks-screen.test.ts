import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatus } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { setTimezone } from '../web/src/i18n/index.ts';
import { PendingSet, runOnce } from '../web/src/pending.ts';
import { buildNewTask, draftError, draftSummary, emptyDraft, type TaskDraft } from '../web/src/task-form.ts';
import {
  CURIOSITY_STATUS_KEY, eventKey, ORIGIN_KEY, plainLine, priorityKey, sheetActions, STATUS_KEY,
} from '../web/src/task-meta.ts';

const reset = () => { setTimezone('Asia/Tokyo'); };

test('plainLine: Markdown と改行を 1 行に平らにし、長いものは切る', () => {
  assert.equal(plainLine('## 結果\n- **3 件** 見つけた\n- [記事](https://example.com/a) を読んだ'), '結果 3 件 見つけた 記事 を読んだ');
  assert.equal(plainLine('前\n```js\nconst x = 1;\n```\n後'), '前 後', 'コードブロックは落とす');
  assert.equal(plainLine(null), '');
  assert.equal(plainLine(undefined), '');
  assert.equal(plainLine('a'.repeat(300), 10), `${'a'.repeat(10)}…`);
  assert.equal(plainLine('あ'.repeat(5), 3), 'あああ…', '文字数で切る');
});

test('sheetActions: 状態ごとの操作（デザインの並び + 終わったタスクをもう一度動かす）', () => {
  const names = (status: TaskStatus) => sheetActions(status).map(a => a.action);
  assert.deepEqual(names('inbox'), ['approve', 'cancel']);
  assert.deepEqual(names('ready'), ['runNow', 'done', 'cancel']);
  assert.deepEqual(names('scheduled'), ['runNow', 'cancel']);
  assert.deepEqual(names('running'), ['done', 'cancel']);
  assert.deepEqual(names('waiting'), ['done', 'cancel']);
  assert.deepEqual(names('failed'), ['retry']);
  assert.deepEqual(names('done'), ['retry']);
  assert.deepEqual(names('cancelled'), ['retry']);
  assert.equal(sheetActions('ready').filter(a => a.primary).length, 1, '主な操作は 1 つ');
});

test('buildNewTask: 今すぐは題と優先度だけ（空の詳細は送らない）。題が空なら作れない', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: '  来週の予定を整理する  ', body: '   ', priority: 1 };
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: '来週の予定を整理する', priority: 1 } });
  assert.deepEqual(buildNewTask({ ...draft, body: ' 詳細 ' }), { ok: true, task: { title: '来週の予定を整理する', priority: 1, body: '詳細' } });
  assert.deepEqual(buildNewTask({ ...draft, title: '   ' }), { ok: false, error: 'title' });
});

test('buildNewTask: 日時の指定は、ブラウザではなくサーバーのタイムゾーンの時刻として読んで送る', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: 'x', when: 'at', at: '2026-11-06T09:00' };
  reset();
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: 'x', priority: 2, when: '2026-11-06T00:00:00.000Z' } }, '東京の 9 時は 0 時 UTC');
  setTimezone('America/New_York');
  assert.deepEqual(buildNewTask(draft), { ok: true, task: { title: 'x', priority: 2, when: '2026-11-06T14:00:00.000Z' } }, 'ニューヨークの 9 時は 14 時 UTC');
  assert.deepEqual(buildNewTask({ ...draft, at: '' }), { ok: false, error: 'at' });
  assert.deepEqual(buildNewTask({ ...draft, at: '2026-02-30T10:00' }), { ok: false, error: 'at' });
  reset();
});

test('buildNewTask: 繰り返しは頻度と値を送る。曜日の値はサーバーが読む日本語のまま（英語の画面でも）', () => {
  const draft: TaskDraft = { ...emptyDraft(), title: 'weekly report', when: 'repeat', freq: 'weekly', time: '17:30', day: '金' };
  for (const lang of ['en'] as const) {
    const built = buildNewTask(draft);
    assert.ok(built.ok);
    assert.deepEqual(built.task.repeat, { freq: 'weekly', values: { time: '17:30', day: '金', minute: '0', interval: '30' } }, `${lang} でも曜日は金のまま`);
  }
  reset();
});

test('draftError: 繰り返しの時刻・分・間隔の入力を確かめる', () => {
  const base: TaskDraft = { ...emptyDraft(), title: 'x', when: 'repeat' };
  assert.equal(draftError({ ...base, freq: 'daily', time: '' }), 'time');
  assert.equal(draftError({ ...base, freq: 'weekday', time: '24:00' }), 'time');
  assert.equal(draftError({ ...base, freq: 'weekly', time: '09:00' }), null);
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '60' }), 'minute');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '-1' }), 'minute');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '0' }), null);
  assert.equal(draftError({ ...base, freq: 'interval', interval: '0' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'interval', interval: '60' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'interval', interval: '1' }), null, 'サーバーは 1 分から受け付ける');
  assert.equal(draftError({ ...base, freq: 'interval', interval: 'abc' }), 'interval');
  assert.equal(draftError({ ...base, freq: 'hourly', minute: '99', when: 'now' }), null, '繰り返しでなければ見ない');
});

test('draftSummary: 「〜に実行します」の要約の元になる値（入力が足りなければ null）', () => {
  const base: TaskDraft = { ...emptyDraft(), title: 'x', when: 'repeat' };
  assert.deepEqual(draftSummary({ ...base, freq: 'daily', time: '08:15' }), { kind: 'daily', time: '08:15' });
  assert.deepEqual(draftSummary({ ...base, freq: 'weekday', time: '09:00' }), { kind: 'weekday', time: '09:00' });
  assert.deepEqual(draftSummary({ ...base, freq: 'weekly', time: '09:00', day: '水' }), { kind: 'weekly', day: '水', time: '09:00' });
  assert.deepEqual(draftSummary({ ...base, freq: 'hourly', minute: '15' }), { kind: 'hourly', minute: 15 });
  assert.deepEqual(draftSummary({ ...base, freq: 'interval', interval: '30' }), { kind: 'interval', every: 30 });
  assert.equal(draftSummary({ ...base, freq: 'daily', time: '' }), null);
  assert.equal(draftSummary({ ...base, when: 'now' }), null);
  reset();
  assert.deepEqual(draftSummary({ ...base, when: 'at', at: '2026-11-06T09:00' }), { kind: 'at', ms: Date.UTC(2026, 10, 6, 0, 0) });
  assert.equal(draftSummary({ ...base, when: 'at', at: '' }), null);
});

test('辞書: 状態・出どころ・優先度・経過の種類・気になることの状態は、en にある', () => {
  const keys = [
    ...Object.values(STATUS_KEY), ...Object.values(ORIGIN_KEY), ...Object.values(CURIOSITY_STATUS_KEY),
    priorityKey(1), priorityKey(2), priorityKey(3), priorityKey(9),
    ...['created', 'note', 'requeued', 'question', 'approval', 'answer', 'run', 'done', 'failed', 'cancelled', 'approved', 'reopened', 'skipped', 'edited', 'context', 'uncancelled'].map(kind => eventKey(kind)!),
  ];
  for (const key of keys) {
    assert.equal(typeof (en as Record<string, unknown>)[key], 'string', `${key} が en に無い`);
  }
  assert.equal(eventKey('something-new'), null, '知らない種類は辞書を引かない（そのまま出す）');
  assert.equal(priorityKey(9), priorityKey(2), '範囲外の優先度は「中」');
});

test('辞書: タスク画面（stage 7）の英語に日本語が混ざらない', () => {
  const mine = Object.keys(en).filter(key => /^(tasks|newtask|curiosity)\./u.test(key));
  assert.ok(mine.length > 20, `タスク画面の文字が ${mine.length} 件しか読めていない`);
  const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
  for (const key of mine) {
    const enEntry = (en as Record<string, unknown>)[key];
    const enText = typeof enEntry === 'function' ? (enEntry as (...a: string[]) => string)('a', 'b') : String(enEntry);
    assert.ok(!japanese.test(enText), `${key}: 英語に日本語が混ざっている: ${enText}`);
  }
});

test('PendingSet: 同じものは送信中に 2 回始められず、終われば また始められる。別のものは邪魔しない', () => {
  const set = new PendingSet();
  assert.equal(set.begin('t1'), true);
  assert.equal(set.begin('t1'), false, '送信中の 2 回目は始めない');
  assert.equal(set.begin('t2'), true, '別のタスクは同時に送れる');
  assert.deepEqual([...set.snapshot()].sort(), ['t1', 't2']);
  set.end('t1');
  assert.equal(set.has('t1'), false);
  assert.equal(set.begin('t1'), true, '終わったら、また送れる');
  const copy = set.snapshot() as Set<string>;
  copy.clear();
  assert.equal(set.has('t2'), true, '写しを変えても元は変わらない');
});

test('runOnce: Enter を続けて 2 回押しても（描き直しの前でも）送るのは 1 回。失敗しても、終われば解ける', async () => {
  const set = new PendingSet();
  let sent = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const send = async () => { sent += 1; await gate; return 'ok'; };
  const first = runOnce(set, 'answer:t1', send);
  const second = runOnce(set, 'answer:t1', send);
  const timeout = new Promise<string>(resolve => setTimeout(() => resolve('waited for the first send'), 50));
  assert.equal(await Promise.race([second, timeout]), undefined, '2 回目は、1 回目の送信が終わるのを待たず、何もせずに戻る');
  assert.equal(set.has('answer:t1'), true);
  release();
  assert.equal(await first, 'ok');
  assert.equal(sent, 1);
  assert.equal(set.has('answer:t1'), false, '終わったら送信中ではない');
  await assert.rejects(runOnce(set, 'answer:t1', async () => { throw new Error('409'); }), /409/u);
  assert.equal(set.has('answer:t1'), false, '失敗でも送信中のまま残らない');
  assert.equal(await runOnce(set, 'answer:t1', async () => 'again'), 'again');
  let changes = 0;
  await runOnce(set, 'x', async () => 1, () => { changes += 1; });
  assert.equal(changes, 2, '始まりと終わりで描き直しを知らせる');
});
