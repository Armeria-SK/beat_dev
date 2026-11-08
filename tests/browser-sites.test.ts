import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSiteHost, siteAllows } from '../src/tools/browser/sites.ts';

// T-06: tools.browser.sites の照合。判定は main frame の URL のホストで行う

test('example.com はサブドメインも、=example.com はそのホストだけ（T-06）', () => {
  const sites = ['example.com'];
  assert.equal(siteAllows(sites, 'https://example.com/a'), true);
  assert.equal(siteAllows(sites, 'https://www.example.com/'), true);
  assert.equal(siteAllows(sites, 'https://a.b.example.com/x?y=1'), true);
  const exact = ['=example.com'];
  assert.equal(siteAllows(exact, 'https://example.com/'), true);
  assert.equal(siteAllows(exact, 'https://www.example.com/'), false);
  assert.equal(siteAllows(['=www.example.com'], 'https://www.example.com/'), true);
});

test('部分一致では当たらない（badexample.com・example.com.evil.com）', () => {
  const sites = ['example.com'];
  assert.equal(siteAllows(sites, 'https://badexample.com/'), false);
  assert.equal(siteAllows(sites, 'https://example.com.evil.com/'), false);
  assert.equal(siteAllows(sites, 'https://evil.com/example.com'), false);
  assert.equal(siteAllows(sites, 'https://evil.com/?u=https://example.com'), false);
  assert.equal(siteAllows(sites, 'https://user@evil.com/@example.com'), false);
  assert.equal(siteAllows(sites, 'https://example.com@evil.com/'), false);
  assert.equal(siteAllows(['=example.com'], 'https://xexample.com/'), false);
});

test('大文字小文字・末尾のドット・punycode をそろえて比べる', () => {
  assert.equal(siteAllows(['example.com'], 'https://EXAMPLE.com/'), true);
  assert.equal(siteAllows(['example.com'], 'https://Www.Example.COM./'), true);
  assert.equal(siteAllows(['=example.com'], 'https://example.com./'), true);
  const idn = '日本語.jp';
  const puny = new URL(`https://${idn}/`).hostname;
  assert.match(puny, /^xn--/u);
  assert.equal(siteAllows([puny], `https://${idn}/`), true);
  assert.equal(siteAllows([puny], `https://${puny}/`), true);
  assert.equal(siteAllows([`=${puny}`], `https://www.${puny}/`), false);
  assert.equal(normalizeSiteHost('EXAMPLE.com.'), 'example.com');
  assert.equal(normalizeSiteHost(idn), puny);
});

test('一覧が空なら全部「読むだけ」。URL でないもの・ホストの無いものは当たらない', () => {
  assert.equal(siteAllows([], 'https://example.com/'), false);
  assert.equal(siteAllows(['example.com'], 'not a url'), false);
  assert.equal(siteAllows(['example.com'], ''), false);
  assert.equal(siteAllows(['example.com'], 'about:blank'), false);
  assert.equal(siteAllows(['example.com'], 'data:text/html,example.com'), false);
  assert.equal(siteAllows(['example.com'], 'file:///example.com/x'), false);
  assert.equal(siteAllows(['example.com'], new URL('https://example.com/')), true);
});

test('一覧の中身が壊れていても、当たらない方に倒れる（* や空の項目）', () => {
  assert.equal(siteAllows(['*.example.com'], 'https://www.example.com/'), false);
  assert.equal(siteAllows([''], 'https://example.com/'), false);
  assert.equal(siteAllows(['='], 'https://example.com/'), false);
  assert.equal(siteAllows(['com'], 'https://example.com/'), false, '1 ラベルだけの項目は当たらない');
});
