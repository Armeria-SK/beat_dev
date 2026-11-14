import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGS } from '../src/shared/messages/index.ts';
import { en as screenText } from '../web/src/i18n/en.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;

test('メッセージの表: 英語の文に日本語が混ざらない', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    for (const [key, text] of Object.entries(catalog.tables.en)) {
      assert.doesNotMatch(text as string, CJK, `${domain}.${key}`);
    }
  }
});

test('メッセージの表: どの領域も英語の表 1 つだけで、領域の名前が合う', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(catalog.tables), ['en'], domain);
    assert.equal(catalog.domain, domain);
  }
  assert.equal(CATALOGS.tool('en', 'failed', { detail: 'x' }), 'Failed: x');
  assert.equal(CATALOGS.guard('en', 'hook.exit_code', { code: 2 }), 'Exit code 2');
});

const IRREGULAR_PAST = 'made|wrote|found|ran|took|gave|did|said|saw|got|went|kept|left|sent|read|built|chose|brought|bought|thought|taught|caught|sought|told|sold|put|set|lost|began|came|became|knew|meant|held|met|paid|stood|understood|spent|fell|felt|won|threw|drew|broke|spoke|wore|drove|forgot|hid|heard|led|let|cut|hit|ate|rode|fought';
const BEAT_VERB = new RegExp(`(?<!\\bby )\\b[Bb]eat (?!(?:need|feed|seed|speed)\\b)(?:[a-z]+ed|${IRREGULAR_PAST})\\b`, 'u');
const SCREEN_ARGS: unknown[][] = [['x', 'y', 'z'], [0, 0, 0], [1, 1, 1], [2, 2, 2], [true, true, true], [false, false, false], ['', '', '']];

test('BEAT_VERB の見張り: 不規則な過去形と文の頭の Beat を拾い、by beat のあと・need は拾わない', () => {
  for (const text of ['beat brought the files', 'Beat found 3 files.', 'beat used the key', 'so beat thought']) assert.match(text, BEAT_VERB, text);
  for (const text of ['made by beat based on the plan', 'started by beat used only here', 'what beat needs', 'beat need not ask', 'the beat itself']) assert.doesNotMatch(text, BEAT_VERB, text);
});

test('メッセージの表: 小文字の beat を過去形の動詞の前に置かない（beat が動詞に読める。名前は後ろへ回す）', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    for (const [key, text] of Object.entries(catalog.tables.en)) assert.doesNotMatch(text as string, BEAT_VERB, `${domain}.${key}`);
  }
  for (const [key, value] of Object.entries(screenText)) {
    if (typeof value !== 'function') { assert.doesNotMatch(String(value), BEAT_VERB, key); continue; }
    let called = 0;
    for (const args of SCREEN_ARGS) {
      let text: string;
      try { text = String((value as (...a: unknown[]) => unknown)(...args)); } catch { continue; }
      called++;
      assert.doesNotMatch(text, BEAT_VERB, `${key}(${args.map(a => JSON.stringify(a)).join(', ')})`);
    }
    assert.ok(called > 0, `${key}: どの引数でも呼べない`);
  }
});
