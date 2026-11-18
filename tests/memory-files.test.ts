import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MEMORY_FILE_DESCRIPTIONS } from '../src/tools/builtin/memory-files.ts';

test('10-2 製品の記憶の書く道具の説明: 3 つの道具にあり、ChatGPT・right away が無い', () => {
  assert.deepEqual(Object.keys(MEMORY_FILE_DESCRIPTIONS).sort(), ['memory_forget', 'memory_save', 'memory_update']);
  for (const [name, text] of Object.entries(MEMORY_FILE_DESCRIPTIONS)) {
    assert.ok(!/ChatGPT/iu.test(text) && !/right away/iu.test(text), `${name}: ${text}`);
    assert.match(text, /without asking/u, `${name}: 聞かずに書いてよい`);
  }
});

test('10-2 memory_save の説明: 目的・いつ書くか・書かないもの・確かめ方を書く', () => {
  const text = MEMORY_FILE_DESCRIPTIONS.memory_save;
  assert.match(text, /a later run.* without looking it up again/u, '目的: 次の実行の自分が調べ直さずに頼る');
  assert.match(text, /when the user asks you to remember/u, 'いつ: 持ち主に頼まれたとき');
  assert.match(text, /clearly help the next piece of work on this product/u, 'いつ: 次の作業で明らかに役立つとき');
  assert.match(text, /You may save without asking/u);
  for (const source of ["product's files", 'the plan', 'the acceptance list', 'search of past conversations']) assert.ok(text.includes(source), `書かないもの: ${source}`);
  assert.match(text, /only this time/u, 'その場限りの経緯は書かない');
  assert.match(text, /how you checked it/u, '確かめたことは、どう確かめたかを一言');
  assert.match(text, /start the content with "Unverified:"/u);
});

test('10-2 memory_update の説明も、確かめていないことは Unverified: で始める', () => {
  assert.match(MEMORY_FILE_DESCRIPTIONS.memory_update, /"Unverified:"/u);
});
