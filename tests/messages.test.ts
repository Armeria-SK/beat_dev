import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CATALOGS } from '../src/shared/messages/index.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const ENGLISH_ONLY: readonly string[] = ['guard', 'tool'];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(m => m[1]!).sort();

test('メッセージの表: 日本語と英語のキーが同じで、差し込みの名前も同じ', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    const { ja, en } = catalog.tables;
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort(), `${domain}: キーが同じ`);
    assert.equal(catalog.domain, domain);
    for (const key of Object.keys(ja)) {
      assert.deepEqual(placeholders((en as Record<string, string>)[key]!), placeholders((ja as Record<string, string>)[key]!), `${domain}.${key}: 差し込み`);
    }
  }
});

test('メッセージの表: 英語の文に日本語が混ざらない', () => {
  for (const [domain, catalog] of Object.entries(CATALOGS)) {
    for (const [key, text] of Object.entries(catalog.tables.en)) {
      assert.doesNotMatch(text as string, CJK, `${domain}.${key}`);
    }
  }
});

test('メッセージの表: 日本語の文は、段階 12b の前の出力と一字も違わない（tests/fixtures/messages-ja.json）', () => {
  const expected = JSON.parse(readFileSync(new URL('./fixtures/messages-ja.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>;
  const actual = Object.fromEntries(Object.entries(CATALOGS).filter(([domain]) => !ENGLISH_ONLY.includes(domain)).map(([domain, catalog]) => [domain, catalog.tables.ja]));
  assert.deepEqual(actual, expected);
});

test('メッセージの表: 道具（tool）と見張り（guard）は英語の表だけ（設定が ja でも英語を返す）', () => {
  for (const domain of ENGLISH_ONLY) {
    const catalog = CATALOGS[domain as keyof typeof CATALOGS];
    assert.equal(catalog.tables.ja, catalog.tables.en, domain);
  }
  assert.equal(CATALOGS.tool('ja', 'failed', { detail: 'x' }), 'Failed: x');
  assert.equal(CATALOGS.guard('ja', 'hook.exit_code', { code: 2 }), 'Exit code 2');
});
