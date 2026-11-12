import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmable, hasUnsaved, serial, type Answer } from '../web/src/ui/settings/flow.ts';

// Settings の保存の流れ（1-5b のセキュリティ審査の直し）。確かめを挟んだ保存が「確かめたあとの結果」で終わること、
// 同時の保存が 1 つずつ順に走ること（互いに上書きしない）、書きかけがあれば閉じる前に聞くこと。

test('ui/settings flow: 確かめを挟んだ操作は、Confirm のあとの結果で終わる（秘密の欄を空にする・Add の行を閉じるのはこの結果を見る）', async () => {
  let answer: Answer | null = null;
  let runs = 0;
  const done = confirmable(a => { answer = a; }, async () => { runs += 1; return true; });
  answer!.confirm();
  answer!.confirm();
  assert.equal(await done, true);
  assert.equal(runs, 1, '2 回押しても 1 回だけ');
  const failed = confirmable(a => { a.confirm(); }, async () => false);
  assert.equal(await failed, false);
  const thrown = confirmable(a => { a.confirm(); }, async () => { throw new Error('x'); });
  assert.equal(await thrown, false);
});

test('ui/settings flow: Cancel や区分の切り替えで閉じた確かめは false で終わり、操作は走らない', async () => {
  let runs = 0;
  const cancelled = confirmable(a => { a.cancel(); a.confirm(); }, async () => { runs += 1; return true; });
  assert.equal(await cancelled, false);
  assert.equal(runs, 0);
});

test('ui/settings flow: 保存は 1 つずつ順に走る（前の保存が終わってから、次が最新を読み直す）。失敗しても次は走る', async () => {
  const enqueue = serial();
  const log: string[] = [];
  let release: () => void = () => undefined;
  const first = enqueue(() => new Promise<string>(resolve => { log.push('a:start'); release = () => { log.push('a:end'); resolve('a'); }; }));
  const second = enqueue(async () => { log.push('b:start'); return 'b'; });
  const third = enqueue(async () => { log.push('c:start'); throw new Error('c'); });
  const fourth = enqueue(async () => { log.push('d:start'); return 'd'; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(log, ['a:start'], 'a が終わるまで b は始まらない');
  release();
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
  await assert.rejects(third);
  assert.equal(await fourth, 'd');
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'c:start', 'd:start']);
});

test('ui/settings flow: 書きかけ（SOUL.md・USER.md・設定ファイル）が 1 つでもあれば、閉じる前に聞く', () => {
  assert.equal(hasUnsaved(new Map()), false);
  assert.equal(hasUnsaved(new Map([['persona:soul', false]])), false);
  assert.equal(hasUnsaved(new Map([['persona:soul', false], ['adv:file', true]])), true);
});
