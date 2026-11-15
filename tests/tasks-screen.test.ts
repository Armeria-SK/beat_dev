import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskStatus } from '../web/src/api.ts';
import { en } from '../web/src/i18n/en.ts';
import { setTimezone } from '../web/src/i18n/index.ts';
import { buildNewTask, draftError, draftSummary, emptyDraft, type TaskDraft } from '../web/src/task-form.ts';
import {
  eventKey, ORIGIN_KEY, plainLine, sheetActions, STATUS_KEY,
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

test('辞書: 状態・出どころ・経過の種類は、en にある', () => {
  const keys = [
    ...Object.values(STATUS_KEY), ...Object.values(ORIGIN_KEY),
    ...['created', 'note', 'requeued', 'question', 'approval', 'answer', 'run', 'done', 'failed', 'cancelled', 'approved', 'reopened', 'skipped', 'edited', 'context', 'uncancelled'].map(kind => eventKey(kind)!),
  ];
  for (const key of keys) {
    assert.equal(typeof (en as Record<string, unknown>)[key], 'string', `${key} が en に無い`);
  }
  assert.equal(eventKey('something-new'), null, '知らない種類は辞書を引かない（そのまま出す）');
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
