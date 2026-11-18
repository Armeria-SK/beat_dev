import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, defaultConfig, ConfigError } from '../src/config/store.ts';
import { en } from '../web/src/i18n/en.ts';
import { EXPLAIN_KEYS, NOT_EXPLAIN } from '../web/src/i18n/explain.ts';
import { applyServerSettings, getExplainChoice, getExplainLanguage, resolveAuto, setExplainLanguage, t } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { subscribe } from '../web/src/i18n/state.ts';
import type { PlainKey } from '../web/src/i18n/types.ts';

// beat i18n I-1: 説明の文だけを日本語にする仕組み。名前（ナビ・ボタン・見出し・行の題）は英語のまま。

const enTable = en as Record<string, unknown>;
const jaTable = ja as Record<string, unknown>;
const listed = new Set<string>(EXPLAIN_KEYS);

// 最初に置く（ほかの試験が選びを変える前の既定を見る）
test('既定の選び（Auto）は、試験では PC の言語によらず英語になる（tests/helpers/tsx-loader.mjs が言語の並びを en-US にする）', () => {
  assert.equal(getExplainChoice(), 'auto');
  assert.deepEqual([...navigator.languages], ['en-US']);
  assert.equal(getExplainLanguage(), 'en');
  assert.equal(t('ui.set.look.reduceDesc'), en['ui.set.look.reduceDesc']);
});

test('説明の一覧の鍵は、すべて英語の表にある', () => {
  assert.ok(EXPLAIN_KEYS.length > 0);
  assert.deepEqual(EXPLAIN_KEYS.filter(key => !(key in enTable)), []);
  assert.equal(new Set(EXPLAIN_KEYS).size, EXPLAIN_KEYS.length, '一覧に同じ鍵が 2 回ある');
});

test('説明の一覧の鍵は、すべて日本語の表にある（説明に日本語があるかの確かめ）', () => {
  assert.deepEqual(EXPLAIN_KEYS.filter(key => !(key in jaTable)), []);
});

test('日本語の表の鍵は、すべて説明の一覧にある（名前が日本語にならない）', () => {
  assert.deepEqual(Object.keys(jaTable).filter(key => !listed.has(key)), []);
  assert.deepEqual(Object.keys(NOT_EXPLAIN).filter(key => listed.has(key)), [], '説明と名前の両方に入っている鍵がある');
});

test('日本語の表の値は英語と同じ形（文字列なら文字列、関数なら同じ数の引数）', () => {
  const bad = Object.entries(jaTable).filter(([key, value]) => {
    const original = enTable[key];
    if (typeof value !== typeof original) return true;
    return typeof value === 'function' && (value as (...a: unknown[]) => string).length !== (original as (...a: unknown[]) => string).length;
  }).map(([key]) => key);
  assert.deepEqual(bad, []);
  assert.ok(Object.values(jaTable).some(value => typeof value === 'function'), '関数の項目を 1 つは試す');
});

test('日本語の表: 文字列の項目は空でなく、関数の項目は引数が訳に出る（tests/i18n.test.ts の en と同じ確かめ）', () => {
  let functionEntries = 0;
  for (const [key, entry] of Object.entries(jaTable)) {
    assert.ok(typeof entry === 'string' ? entry.trim().length > 0 : typeof entry === 'function', `${key}: 空の訳`);
    if (typeof entry !== 'function') continue;
    functionEntries += 1;
    const fn = entry as (...a: unknown[]) => string;
    const args = Array.from({ length: fn.length }, (_, i) => 7001 + i);
    const out = fn(...args);
    for (const arg of args) assert.ok(out.includes(String(arg)), `${key}: 引数 ${arg} が訳に出ない: ${out}`);
  }
  assert.ok(functionEntries > 0, '関数の項目を 1 つは試す');
});

test('ja を選ぶと説明は日本語、名前は英語のまま。en に戻すと今と同じ。聞き手が呼ばれる', () => {
  let calls = 0;
  const off = subscribe(() => { calls += 1; });
  try {
    setExplainLanguage('en');
    const before = calls;
    setExplainLanguage('ja');
    assert.equal(calls, before + 1);
    assert.equal(getExplainLanguage(), 'ja');
    assert.equal(t('ui.set.look.reduceDesc'), ja['ui.set.look.reduceDesc']);
    assert.notEqual(t('ui.set.look.reduceDesc'), en['ui.set.look.reduceDesc']);
    assert.equal(t('ui.set.models.judgeBackups', 'a, b'), ja['ui.set.models.judgeBackups']('a, b'));
    assert.equal(t('ui.nav.settings'), 'Settings');
    assert.equal(t('ui.set.look.reduce'), 'Reduce motion');
    assert.equal(t('ui.set.models.scout'), 'Scout');
    // 日本語の表に無い鍵は英語に落ちる
    const untranslated = Object.keys(enTable).find(key => !(key in jaTable) && typeof enTable[key] === 'string') as PlainKey;
    assert.ok(untranslated);
    assert.equal(t(untranslated), enTable[untranslated]);
    setExplainLanguage('ja');
    assert.equal(calls, before + 1, '同じ値では描き直さない');
    setExplainLanguage('en');
    assert.equal(calls, before + 2);
    assert.equal(t('ui.set.look.reduceDesc'), en['ui.set.look.reduceDesc']);
    assert.equal(t('ui.set.models.judgeBackups', 'a, b'), en['ui.set.models.judgeBackups']('a, b'));
  } finally { off(); setExplainLanguage('en'); }
});

test('Auto の解き方: ja* が en* より先にあれば ja、ほかは en', () => {
  assert.equal(resolveAuto(['ja-JP', 'en']), 'ja');
  assert.equal(resolveAuto(['en-US', 'ja']), 'en');
  assert.equal(resolveAuto([]), 'en');
  assert.equal(resolveAuto(['fr', 'JA']), 'ja');
  assert.equal(resolveAuto(['jav', 'en']), 'en');
});

test('applyServerSettings: ui.explainLanguage を入れる。知らない値・形の違うものは無視する', () => {
  try {
    setExplainLanguage('en');
    applyServerSettings({ config: { ui: { explainLanguage: 'ja' } } });
    assert.equal(getExplainChoice(), 'ja');
    applyServerSettings({ config: { ui: { explainLanguage: 'fr' } } });
    assert.equal(getExplainChoice(), 'ja');
    applyServerSettings({ config: { ui: 'ja' } });
    applyServerSettings({ config: {} });
    assert.equal(getExplainChoice(), 'ja');
    applyServerSettings({ config: { ui: { explainLanguage: 'auto' } } });
    assert.equal(getExplainChoice(), 'auto');
  } finally { setExplainLanguage('en'); }
});

test('設定の形: ui.explainLanguage を受け、既定は auto、知らない値は誤り。一番上の language は今までどおり落ちる', () => {
  assert.equal(defaultConfig().ui.explainLanguage, 'auto');
  const base = { version: 1, server: {}, routing: {} };
  assert.equal(parseConfig(base).ui.explainLanguage, 'auto');
  assert.equal(parseConfig({ ...base, ui: { explainLanguage: 'ja' } }).ui.explainLanguage, 'ja');
  assert.equal(parseConfig({ ...base, ui: { explainLanguage: 'en' } }).ui.explainLanguage, 'en');
  assert.throws(() => parseConfig({ ...base, ui: { explainLanguage: 'fr' } }), (e: unknown) => e instanceof ConfigError && e.problems.some(p => p.includes('/ui/explainLanguage')));
  assert.throws(() => parseConfig({ ...base, ui: { other: 1 } }), ConfigError);
  const legacy = parseConfig({ ...base, language: 'ja' }) as unknown as Record<string, unknown>;
  assert.ok(!('language' in legacy));
  assert.equal((legacy.ui as { explainLanguage: string }).explainLanguage, 'auto');
});

// 説明の形: 鍵の末尾が説明の役（Desc・Hint など）か、6 語以上の文。I-2 で 0 にし、I-4 で 1 つでもあれば落ちる形にする。
const EXPLAIN_SUFFIX = /(?:Desc|desc|Hint|Help|Note|About|Empty|Intro|Lead|Tip)$/u;
function explainShaped(key: string, value: unknown): boolean {
  if (EXPLAIN_SUFFIX.test(key.slice(key.lastIndexOf('.') + 1))) return true;
  return typeof value === 'string' && value.trim().split(/\s+/u).length >= 6;
}

test('見張り: 説明の形なのに一覧にも NOT_EXPLAIN にも無い鍵の数を出す（この段では落とさない）', t => {
  assert.ok(explainShaped('ui.set.models.scoutDesc', en['ui.set.models.scoutDesc']), '見張りの形の決まりが説明を見つけられない');
  assert.ok(!explainShaped('ui.nav.settings', en['ui.nav.settings']), '見張りの形の決まりが名前を説明と見ている');
  const missing = Object.entries(enTable).filter(([key, value]) => explainShaped(key, value) && !listed.has(key) && !(key in NOT_EXPLAIN));
  t.diagnostic(`explain-shaped keys not yet listed: ${missing.length}`);
  assert.ok(missing.length < Object.keys(enTable).length);
});
