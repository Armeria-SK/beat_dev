import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOGS } from '../src/shared/messages/index.ts';

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
