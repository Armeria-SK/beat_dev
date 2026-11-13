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

const BEAT_VERB = /\bbeat (?:[a-z]+ed|made|wrote|found|ran|took|gave|did|said|saw|got|went|kept|left|sent|read|built|chose)\b/u;

test('メッセージの表: 小文字の beat を過去形の動詞の前に置かない（beat が動詞に読める。名前は後ろへ回す）', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    for (const [key, text] of Object.entries(catalog.tables.en)) assert.doesNotMatch(text as string, BEAT_VERB, `${domain}.${key}`);
  }
  for (const [key, value] of Object.entries(screenText)) {
    const text = typeof value === 'function' ? String((value as (...a: string[]) => string)('x', 'y', 'z')) : String(value);
    assert.doesNotMatch(text, BEAT_VERB, key);
  }
});
