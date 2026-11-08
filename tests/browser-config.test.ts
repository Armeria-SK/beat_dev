import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, defaultConfig, parseConfig } from '../src/config/store.ts';
import { BROWSER_SITE_PATTERN } from '../src/config/schema.ts';
import { testConfig } from './helpers.ts';

const withBrowser = (browser: unknown) => ({ ...JSON.parse(JSON.stringify(testConfig())), tools: { browser } });

test('tools.browser: 既定は無効・auto・headless・空の一覧・limits の既定（T-01）', () => {
  const b = defaultConfig().tools.browser;
  assert.equal(b.enabled, false);
  assert.equal(b.channel, 'auto');
  assert.equal(b.executablePath, '');
  assert.equal(b.headless, true);
  assert.deepEqual(b.sites, []);
  assert.deepEqual(b.limits, { maxTabs: 3, navigationTimeoutSec: 30, actionTimeoutSec: 10, idleCloseMinutes: 10, pageChars: 20000, maxMbPerMinute: 50 });
  assert.equal('localOk' in b, false, 'localOk は作らない');
  assert.deepEqual(parseConfig({ version: 1, server: {}, routing: {} }).tools.browser, b, '書かない設定でも既定が入る');
  assert.deepEqual(parseConfig(withBrowser({ enabled: true })).tools.browser, { ...b, enabled: true });
});

test('tools.browser.limits: 範囲の端は通り、越えたら ConfigError（丸めない）', () => {
  const edges: Array<[string, number, number]> = [
    ['maxTabs', 1, 8], ['navigationTimeoutSec', 5, 120], ['actionTimeoutSec', 1, 60],
    ['idleCloseMinutes', 1, 120], ['pageChars', 2000, 100000], ['maxMbPerMinute', 1, 500],
  ];
  for (const [key, min, max] of edges) {
    for (const ok of [min, max]) {
      const config = parseConfig(withBrowser({ limits: { [key]: ok } }));
      assert.equal((config.tools.browser.limits as Record<string, number>)[key], ok, `${key}=${ok}`);
    }
    for (const bad of [min - 1, max + 1]) {
      assert.throws(() => parseConfig(withBrowser({ limits: { [key]: bad } })), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path.startsWith(`tools.browser.limits.${key}`)), `${key}=${bad}`);
    }
  }
  assert.throws(() => parseConfig(withBrowser({ limits: { maxTabs: 1.5 } })), ConfigError);
  assert.throws(() => parseConfig(withBrowser({ limits: { unknown: 1 } })), ConfigError);
  assert.throws(() => parseConfig(withBrowser({ localOk: true })), ConfigError, '未知のキー（localOk）は断る');
  assert.throws(() => parseConfig(withBrowser({ channel: 'firefox' })), ConfigError);
});

test('tools.browser.sites: 書き方の検査（example.com と =example.com は通る）', () => {
  for (const ok of ['example.com', '=example.com', 'a.b.example.co.jp', 'xn--n8jok5ay5dzabd5bym9f0cm5685rrjetr6pdxa.jp', '=www.example.com']) {
    assert.deepEqual(parseConfig(withBrowser({ sites: [ok] })).tools.browser.sites, [ok], ok);
    assert.match(ok, new RegExp(BROWSER_SITE_PATTERN, 'u'));
  }
  for (const bad of ['*.example.com', 'example.com/path', 'localhost', '1.2.3.4', 'EXAMPLE.com', 'example.com:8080', 'http://example.com', ' example.com', '', '==example.com', '-a.example.com', 'example..com', 'example.com.']) {
    assert.throws(() => parseConfig(withBrowser({ sites: [bad] })), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path.startsWith('tools.browser.sites')), JSON.stringify(bad));
  }
  assert.throws(() => parseConfig(withBrowser({ sites: ['a'.repeat(250) + '.com'] })), ConfigError, '254 文字まで');
  const many = Array.from({ length: 101 }, (_, i) => `s${i}.example.com`);
  assert.throws(() => parseConfig(withBrowser({ sites: many })), ConfigError, '100 件まで');
  assert.equal(parseConfig(withBrowser({ sites: many.slice(0, 100) })).tools.browser.sites.length, 100);
});

test('tools.browser.sites: 同じものの重なりは誤り（example.com と =example.com は別のもの）', () => {
  assert.throws(() => parseConfig(withBrowser({ sites: ['example.com', 'example.com'] })), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path.startsWith('tools.browser.sites')));
  assert.throws(() => parseConfig(withBrowser({ sites: ['=example.com', 'a.test.com', '=example.com'] })), ConfigError);
  assert.deepEqual(parseConfig(withBrowser({ sites: ['example.com', '=example.com'] })).tools.browser.sites, ['example.com', '=example.com']);
});

test('tools.browser: channel が path なのに executablePath が空なら誤り。executablePath は絶対パス', () => {
  assert.throws(() => parseConfig(withBrowser({ channel: 'path' })), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path.startsWith('tools.browser.executablePath')));
  assert.throws(() => parseConfig(withBrowser({ channel: 'path', executablePath: '' })), ConfigError);
  assert.throws(() => parseConfig(withBrowser({ channel: 'path', executablePath: 'chrome.exe' })), ConfigError);
  assert.throws(() => parseConfig(withBrowser({ executablePath: 'relative/chrome' })), ConfigError, 'path でなくても相対は誤り');
  const abs = process.platform === 'win32' ? 'C:\\Program Files\\Browser\\browser.exe' : '/usr/bin/browser';
  assert.equal(parseConfig(withBrowser({ channel: 'path', executablePath: abs })).tools.browser.executablePath, abs, 'ファイルが無くても保存は通る');
  assert.equal(parseConfig(withBrowser({ channel: 'msedge' })).tools.browser.channel, 'msedge');
});
