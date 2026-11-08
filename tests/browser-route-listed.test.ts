import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { BrowserFailure, PlaywrightBrowser } from '../src/tools/browser/driver.ts';
import { listedNavigationVerdict } from '../src/tools/browser/route.ts';

// R6 追補 3: browser_open の確かめは入口の URL しか見ない。リダイレクト・location 代入・meta refresh で
// 一覧のサイトの操作になりうる URL へ飛ばされるのを、確かめを出せない遷移として断る。本物のブラウザは起動しない

const SITES = ['example.com'];
const verdict = (over: { url: string; redirectedFrom?: string | undefined; sourceUrl?: string | undefined; entryUrl?: string | undefined; sites?: readonly string[] }) =>
  listedNavigationVerdict({ url: over.url, redirectedFrom: over.redirectedFrom, sourceUrl: over.sourceUrl, entryUrl: over.entryUrl, sites: over.sites ?? SITES });
const refused = (over: Parameters<typeof verdict>[0]): boolean => { const v = verdict(over); return !v.allow && v.reason === 'listed'; };

test('純関数: 一覧外のサイトが 302 で一覧のサイトの操作になりうる URL へ飛ばすと断る（クエリ付き・根ページ以外のパス）', () => {
  assert.equal(refused({ url: 'https://example.com/account/delete?id=1', redirectedFrom: 'https://other.example.org/go' }), true);
  assert.equal(refused({ url: 'https://example.com/account/delete', redirectedFrom: 'https://other.example.org/go' }), true);
  assert.equal(refused({ url: 'https://www.example.com/?x=1', redirectedFrom: 'https://other.example.org/go' }), true);
  // 入口が行き先と同じ URL でも、リダイレクトで来たものは入口ではない
  assert.equal(refused({ url: 'https://example.com/a?x=1', redirectedFrom: 'https://other.example.org/go', entryUrl: 'https://example.com/a?x=1' }), true);
  // 一覧のサイトから別の一覧のサイトへのリダイレクトも、確かめを出せないので断る
  assert.equal(refused({ url: 'https://example.com/a?x=1', redirectedFrom: 'https://sso.example.net/x', sites: ['example.com', 'example.net'] }), true);
});

test('純関数: 一覧外のページからの location 代入・meta refresh（リダイレクトでない遷移）は、遷移元が一覧外なら断る。読めない・空の遷移元も断る', () => {
  assert.equal(refused({ url: 'https://example.com/account/delete?id=1', sourceUrl: 'https://other.example.org/page' }), true);
  assert.equal(refused({ url: 'https://example.com/a', sourceUrl: 'http://other.example.org/' }), true);
  assert.equal(refused({ url: 'https://example.com/a', sourceUrl: undefined }), true);
  assert.equal(refused({ url: 'https://example.com/a', sourceUrl: '' }), true);
  assert.equal(refused({ url: 'https://example.com/a', sourceUrl: 'about:blank' }), true);
  // 入口の URL とは別の URL（入口が一覧外のサイトで、そこから飛ぶ）
  assert.equal(refused({ url: 'https://example.com/a?x=1', sourceUrl: 'https://other.example.org/', entryUrl: 'https://other.example.org/' }), true);
});

test('純関数: 妨げないもの（同じサイトの中・根ページ・確かめ済みの入口・一覧のサイトのページからの移動・一覧外への移動・守りなし）', () => {
  // 同じホスト内のリダイレクト（ログインへ、など）
  assert.equal(verdict({ url: 'https://example.com/login?next=%2Fa', redirectedFrom: 'https://example.com/a' }).allow, true);
  // 同じ一覧の項目に当たる別のホスト（www 付きなど）
  assert.equal(verdict({ url: 'https://www.example.com/a?x=1', redirectedFrom: 'https://example.com/a?x=1' }).allow, true);
  // 一覧のサイトの根ページ（クエリなし）
  assert.equal(verdict({ url: 'https://example.com/', redirectedFrom: 'https://other.example.org/go' }).allow, true);
  assert.equal(verdict({ url: 'https://example.com', sourceUrl: 'https://other.example.org/' }).allow, true);
  // browser_open の入口そのもの（確かめは preCheck で済み）。# 以降の違いは見ない
  assert.equal(verdict({ url: 'https://example.com/a?x=1', entryUrl: 'https://example.com/a?x=1#top', sourceUrl: 'about:blank' }).allow, true);
  assert.equal(verdict({ url: 'https://example.com/a?x=1', entryUrl: 'https://example.com/a?x=1', sourceUrl: undefined }).allow, true);
  // 一覧のサイトのページからの移動（同じサイト・別の一覧のサイト。押す承認を得たクリックの遷移も、ここに入る）
  assert.equal(verdict({ url: 'https://example.com/b?x=1', sourceUrl: 'https://example.com/a' }).allow, true);
  assert.equal(verdict({ url: 'https://example.com/b?x=1', sourceUrl: 'https://example.net/a', sites: ['example.com', 'example.net'] }).allow, true);
  // 行き先が一覧外のサイトなら見ない
  assert.equal(verdict({ url: 'https://other.example.org/a?x=1', redirectedFrom: 'https://example.com/a' }).allow, true);
  // 一覧が空なら守りは働かない
  assert.equal(verdict({ url: 'https://example.com/a?x=1', redirectedFrom: 'https://other.example.org/go', sites: [] }).allow, true);
  // 一覧の =完全一致 は、サブドメインに当たらない
  assert.equal(verdict({ url: 'https://www.example.com/a?x=1', redirectedFrom: 'https://other.example.org/go', sites: ['=example.com'] }).allow, true);
  assert.equal(refused({ url: 'https://example.com/a?x=1', redirectedFrom: 'https://other.example.org/go', sites: ['=example.com'] }), true);
});

// ---- driver の #intercept（偽の Route / Request / Frame / Page） ----

interface FakePage { on: () => void; url: () => string; opener: () => Promise<FakePage | null>; goto?: (url: string) => Promise<null> }
type Handler = (route: Route) => Promise<void>;

function rig(sites: () => readonly string[]) {
  let handler: Handler | undefined;
  const context = {
    on: () => {},
    route: async (_pattern: string, fn: Handler) => { handler = fn; },
    pages: () => [] as Page[],
  } as unknown as BrowserContext;
  const browser = new PlaywrightBrowser(context, sites);
  const log: string[] = [];
  const page = (url: string, opener: FakePage | null = null): FakePage => ({ on: () => {}, url: () => url, opener: async () => opener });
  const route = (target: FakePage, url: string, over: { redirectedFrom?: string; navigation?: boolean; main?: boolean } = {}): Route => {
    const frame = { parentFrame: () => (over.main === false ? {} : null), page: () => target };
    const request = {
      url: () => url, isNavigationRequest: () => over.navigation !== false, frame: () => frame,
      redirectedFrom: () => (over.redirectedFrom === undefined ? null : { url: () => over.redirectedFrom }),
    };
    return { request: () => request, continue: async () => { log.push('continue'); }, abort: async (code?: string) => { log.push(`abort:${code}`); } } as unknown as Route;
  };
  const fire = async (target: FakePage, url: string, over: Parameters<typeof route>[2] = {}) => { await handler!(route(target, url, over)); const last = log.at(-1); log.length = 0; return last; };
  return { browser, page, fire, install: () => browser.install() };
}

test('driver: 一覧外のページからのリダイレクト・location 代入は abort し、そのページの refusal に listed が入る', async () => {
  const r = rig(() => SITES);
  await r.install();
  const tab = r.page('https://other.example.org/page');
  const wrapper = r.browser.wrap(tab as unknown as Page);
  // location 代入・meta refresh（遷移元 = いまのページ）
  assert.equal(await r.fire(tab, 'https://example.com/account/delete?id=1'), 'abort:blockedbyclient');
  assert.equal(wrapper.lastRefusal(), 'listed');
  // リダイレクト（手前の URL がある）
  wrapper.refusal = undefined;
  assert.equal(await r.fire(tab, 'https://example.com/account/delete?id=1', { redirectedFrom: 'https://other.example.org/go' }), 'abort:blockedbyclient');
  assert.equal(wrapper.lastRefusal(), 'listed');
});

test('driver: 妨げないもの（同じサイトの中・一覧のサイトからの移動・根ページ・部品の読み込み・一覧外への移動）は通す', async () => {
  const r = rig(() => SITES);
  await r.install();
  const onListed = r.page('https://example.com/a');
  const onOther = r.page('https://other.example.org/page');
  r.browser.wrap(onListed as unknown as Page);
  r.browser.wrap(onOther as unknown as Page);
  assert.equal(await r.fire(onListed, 'https://example.com/b?x=1'), 'continue');
  assert.equal(await r.fire(onListed, 'https://example.com/login?next=%2Fa', { redirectedFrom: 'https://example.com/a' }), 'continue');
  assert.equal(await r.fire(onOther, 'https://example.com/'), 'continue');
  assert.equal(await r.fire(onOther, 'https://example.com/img.png?x=1', { navigation: false }), 'continue');
  assert.equal(await r.fire(onOther, 'https://example.com/frame?x=1', { main: false }), 'continue');
  assert.equal(await r.fire(onListed, 'https://third.example.org/a?x=1'), 'continue');
  // 一覧が空（ログイン用の窓など）なら守りは働かない
  const off = rig(() => []);
  await off.install();
  const tab = off.page('https://other.example.org/page');
  off.browser.wrap(tab as unknown as Page);
  assert.equal(await off.fire(tab, 'https://example.com/account/delete?id=1'), 'continue');
});

test('driver: 一覧は遷移のたびに読む（設定を変えるとすぐ効く）。一覧が読めずに例外なら断る', async () => {
  let sites: readonly string[] = [];
  const r = rig(() => sites);
  await r.install();
  const tab = r.page('https://other.example.org/page');
  r.browser.wrap(tab as unknown as Page);
  assert.equal(await r.fire(tab, 'https://example.com/a?x=1'), 'continue');
  sites = SITES;
  assert.equal(await r.fire(tab, 'https://example.com/a?x=1'), 'abort:blockedbyclient');
  const broken = rig(() => { throw new Error('config'); });
  await broken.install();
  const tab2 = broken.page('https://other.example.org/page');
  broken.browser.wrap(tab2 as unknown as Page);
  assert.equal(await broken.fire(tab2, 'https://example.com/a?x=1'), 'abort:blockedbyclient');
});

test('driver: 開いたばかりの窓（空）は、開いた元のページを遷移元にする', async () => {
  const r = rig(() => SITES);
  await r.install();
  const parentListed = r.page('https://example.com/a');
  const parentOther = r.page('https://other.example.org/');
  const fromListed = r.page('about:blank', parentListed);
  const fromOther = r.page('', parentOther);
  const orphan = r.page('about:blank');
  for (const p of [parentListed, parentOther, fromListed, fromOther, orphan]) r.browser.wrap(p as unknown as Page);
  assert.equal(await r.fire(fromListed, 'https://example.com/b?x=1'), 'continue');
  assert.equal(await r.fire(fromOther, 'https://example.com/b?x=1'), 'abort:blockedbyclient');
  assert.equal(await r.fire(orphan, 'https://example.com/b?x=1'), 'abort:blockedbyclient');
});

test('driver: goto の入口は断らない（goto の最中だけ）。入口がリダイレクトで一覧のサイトの別 URL へ行くと断り、blocked_listed の失敗になる', async () => {
  const r = rig(() => SITES);
  await r.install();
  const results: string[] = [];
  const tab = r.page('about:blank');
  const wrapper = r.browser.wrap(tab as unknown as Page);
  // 入口（一覧のサイトのクエリ付き URL。確かめは preCheck で済んでいる）
  tab.goto = async url => { results.push((await r.fire(tab, url)) ?? ''); return null; };
  await wrapper.goto('https://example.com/a?x=1', 1000);
  assert.deepEqual(results, ['continue']);
  // 入口が一覧外 → リダイレクトで一覧のサイトの別 URL（goto の失敗として blocked_listed が出る）
  tab.goto = async url => {
    assert.equal(await r.fire(tab, url), 'continue');
    assert.equal(await r.fire(tab, 'https://example.com/account/delete?id=1', { redirectedFrom: url }), 'abort:blockedbyclient');
    throw new Error('net::ERR_BLOCKED_BY_CLIENT');
  };
  await assert.rejects(wrapper.goto('https://other.example.org/go', 1000), (e: unknown) => e instanceof BrowserFailure && e.code === 'blocked' && e.key === 'browser.blocked_listed');
  // goto が終わったら入口は残らない: そのあとの同じ URL への遷移は、遷移元で決まる（一覧外のページからは断る）
  tab.url = () => 'https://other.example.org/go';
  assert.equal(await r.fire(tab, 'https://example.com/a?x=1'), 'abort:blockedbyclient');
});
