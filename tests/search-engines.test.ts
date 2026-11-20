import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalizeUrl, readSafely, regionParts, resultUrl, type SearchEngine } from '../src/tools/web/search/engine.ts';
import { bing } from '../src/tools/web/search/engines/bing.ts';
import { brave } from '../src/tools/web/search/engines/brave.ts';
import { duckduckgoHtml } from '../src/tools/web/search/engines/duckduckgo-html.ts';
import { duckduckgoLite } from '../src/tools/web/search/engines/duckduckgo-lite.ts';
import { mojeek } from '../src/tools/web/search/engines/mojeek.ts';
import { startpage } from '../src/tools/web/search/engines/startpage.ts';
import { wikipedia } from '../src/tools/web/search/engines/wikipedia.ts';
import { yahoo } from '../src/tools/web/search/engines/yahoo.ts';

const DDG_OK = `<html><body><div id="links" class="results">
  <div class="result results_links results_links_deep result--ad"><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2></div>
  <div class="result results_links results_links_deep web-result"><div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsqlite.org%2Ffts5.html&amp;rut=abc">SQLite FTS5 <b>Extension</b></a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsqlite.org%2Ffts5.html">The <b>trigram</b> tokenizer ...</a>
  </div></div>
  <div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">bad</a></h2></div>
  <div class="result results_links web-result"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2Frouter.local%2F">lan</a></h2></div>
</div></body></html>`;

test('DuckDuckGo html: 結果は ok、challenge の頁は blocked、no-results は empty、関係ない HTML は unknown', () => {
  const ok = readSafely(duckduckgoHtml, DDG_OK, 'text/html', 10);
  assert.deepEqual(ok, { state: 'ok', hits: [{ title: 'SQLite FTS5 Extension', url: 'https://sqlite.org/fts5.html', snippet: 'The trigram tokenizer ...' }] });
  assert.equal(readSafely(duckduckgoHtml, '<html><body><form id="challenge-form"></form>anomaly</body></html>', 'text/html', 5).state, 'blocked');
  assert.equal(readSafely(duckduckgoHtml, '<html><body><div class="no-results">No results.</div></body></html>', 'text/html', 5).state, 'empty');
  assert.equal(readSafely(duckduckgoHtml, '<html><body><p>hello</p></body></html>', 'text/html', 5).state, 'unknown');
});

test('読み方の中の例外は外へ投げず unknown。壊れた HTML でも投げない', () => {
  const broken: SearchEngine = { ...duckduckgoHtml, read: () => { throw new Error('boom'); } };
  assert.deepEqual(readSafely(broken, '<html>', 'text/html', 5), { hits: [], state: 'unknown' });
  for (const body of ['', '<<<>>>', '<div class="result"><a class="result__a" href="%%%">', '\u0000\u0001']) {
    assert.doesNotThrow(() => readSafely(duckduckgoHtml, body, 'text/html', 5), body);
  }
});

test('結果の URL: 転送を戻し、http(s) と公開の名前だけ。検索先自身の頁は捨てる', () => {
  assert.equal(resultUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example.org%2Fx%23frag', 'https://duckduckgo.com/', ['duckduckgo.com']), 'https://a.example.org/x');
  assert.equal(resultUrl('https://duckduckgo.com/l/', 'https://duckduckgo.com/', ['duckduckgo.com']), undefined, '戻せない転送');
  assert.equal(resultUrl('javascript:alert(1)', 'https://duckduckgo.com/', []), undefined);
  assert.equal(resultUrl('http://192.168.1.1/', 'https://duckduckgo.com/', []), undefined);
  assert.equal(resultUrl('https://duckduckgo.com/about', 'https://duckduckgo.com/', ['duckduckgo.com']), undefined);
  assert.equal(resultUrl('https://user:pw@a.example.org/', 'https://duckduckgo.com/', []), undefined);
});

test('URL の正規化: ホストの大小・www・# ・追跡の引数・末尾の / をそろえる', () => {
  assert.equal(normalizeUrl('https://WWW.Example.org/a/?utm_source=x&id=1#top'), normalizeUrl('http://example.org/a?id=1'));
  assert.notEqual(normalizeUrl('https://example.org/a?id=1'), normalizeUrl('https://example.org/a?id=2'));
});

test('地域の読み替え: 国と言語', () => {
  assert.deepEqual(regionParts('jp-jp'), { country: 'jp', language: 'ja' });
  assert.deepEqual(regionParts('us-en'), { country: 'us', language: 'en' });
  assert.deepEqual(regionParts('wt-wt'), { country: undefined, language: undefined });
  assert.deepEqual(regionParts('nonsense'), { country: undefined, language: undefined });
});

// ── 段階 3: 先ごとの見本（tests/fixtures/search/。各 HTML の先頭に、取った日と問い、または手で書いた理由。
// Wikipedia の 2 つの JSON は 2026-11-21 に ja.wikipedia.org の API へ beat の名乗りで「sqlite」と「zqxjvkwplm qhrtzynbvx」を問うて取ったもの） ──

const fixture = (name: string) => readFileSync(new URL(`./fixtures/search/${name}`, import.meta.url), 'utf8');
const UNRELATED = '<html><head><title>Welcome</title></head><body><main><p>Something else entirely.</p></main></body></html>';
const WIKI_AT = 'https://ja.wikipedia.org/w/api.php?action=query';

const cases: Array<{ engine: SearchEngine; ok: string; first: { title: string; url: string }; empty: string; blocked?: string }> = [
  { engine: duckduckgoHtml, ok: 'duckduckgo-html-ok.html', first: { title: 'Official site', url: 'https://sqlite.org/' }, empty: 'duckduckgo-html-empty.html', blocked: 'duckduckgo-html-blocked.html' },
  { engine: duckduckgoLite, ok: 'duckduckgo-lite-ok.html', first: { title: 'SQLite Home Page', url: 'https://sqlite.org/' }, empty: 'duckduckgo-lite-empty.html', blocked: 'duckduckgo-lite-blocked.html' },
  { engine: bing, ok: 'bing-ok.html', first: { title: 'SQLiteとは？特徴・メリット・使い方・他のDBとの違いを解説 ...', url: 'https://techmania.jp/blog/sqlite/' }, empty: 'bing-empty.html' },
  { engine: brave, ok: 'brave-ok.html', first: { title: 'SQLite Home Page', url: 'https://sqlite.org/' }, empty: 'brave-empty.html' },
  { engine: startpage, ok: 'startpage-ok.html', first: { title: 'SQLite Home Page', url: 'https://sqlite.org/' }, empty: 'startpage-empty.html', blocked: 'startpage-blocked.html' },
  { engine: mojeek, ok: 'mojeek-ok.html', first: { title: 'SQLite Home Page', url: 'https://sqlite.org/' }, empty: 'mojeek-empty.html', blocked: 'mojeek-blocked.html' },
  { engine: yahoo, ok: 'yahoo-ok.html', first: { title: 'sqlite.orgSQLite Home Page', url: 'https://sqlite.org/' }, empty: 'yahoo-empty.html' },
  { engine: wikipedia, ok: 'wikipedia-ok.json', first: { title: 'SQLite', url: 'https://ja.wikipedia.org/wiki/SQLite' }, empty: 'wikipedia-empty.json' },
];

for (const c of cases) {
  test(`${c.engine.id}: 見本の ok / empty${c.blocked ? ' / blocked' : ''} / 関係ない頁は unknown`, () => {
    const at = c.engine === wikipedia ? WIKI_AT : c.engine.request('sqlite', 'jp-jp').href;
    const ok = readSafely(c.engine, fixture(c.ok), 'text/html', 10, at);
    assert.equal(ok.state, 'ok');
    assert.deepEqual({ title: ok.hits[0]!.title, url: ok.hits[0]!.url }, c.first);
    const own = c.engine.hosts('jp-jp')[0]!;
    assert.ok(ok.hits.every(h => /^https?:\/\//u.test(h.url) && (c.engine === wikipedia || !h.url.includes(own))), JSON.stringify(ok.hits));
    assert.equal(readSafely(c.engine, fixture(c.ok), 'text/html', 1, at).hits.length, 1, 'limit で切る');
    assert.equal(readSafely(c.engine, fixture(c.empty), 'text/html', 10, at).state, 'empty');
    if (c.blocked) assert.equal(readSafely(c.engine, fixture(c.blocked), 'text/html', 10, at).state, 'blocked');
    assert.equal(readSafely(c.engine, UNRELATED, 'text/html', 10, at).state, 'unknown');
  });
}

test('Wikipedia: ratelimited は blocked、知らない JSON は unknown、Wikipedia でない所から来た返事は読まない', () => {
  assert.equal(readSafely(wikipedia, '{"error":{"code":"ratelimited"}}', 'application/json', 5, WIKI_AT).state, 'blocked');
  assert.equal(readSafely(wikipedia, '{"what":1}', 'application/json', 5, WIKI_AT).state, 'unknown');
  assert.equal(readSafely(wikipedia, fixture('wikipedia-ok.json'), 'application/json', 5, 'https://evil.example.org/').state, 'unknown');
});

test('Bing の ck/a と Yahoo の RU= を行き先へ戻す。戻せないもの・javascript: ・LAN の名前は捨てる', () => {
  const ck = (target: string) => `https://www.bing.com/ck/a?!&&p=abc&ptn=3&ver=2&u=a1${Buffer.from(target).toString('base64url')}&ntb=1`;
  assert.equal(resultUrl(ck('https://sqlite.org/docs.html'), 'https://www.bing.com/', ['bing.com']), 'https://sqlite.org/docs.html');
  assert.equal(resultUrl(ck('javascript:alert(1)'), 'https://www.bing.com/', ['bing.com']), undefined);
  assert.equal(resultUrl(ck('http://printer.local/'), 'https://www.bing.com/', ['bing.com']), undefined);
  assert.equal(resultUrl('https://www.bing.com/ck/a?!&&p=abc&u=zz', 'https://www.bing.com/', ['bing.com']), undefined, 'a1 の形でない');
  assert.equal(resultUrl('https://www.bing.com/ck/a?!&&p=abc&u=a1%25%25', 'https://www.bing.com/', ['bing.com']), undefined, 'base64 でない');
  assert.equal(resultUrl('https://www.bing.com/aclk?ld=ad', 'https://www.bing.com/', ['bing.com']), undefined, '広告（Bing 自身の頁）');
  const ru = (inner: string) => `https://r.search.yahoo.com/_ylt=A/RV=2/RE=1/RO=10/${inner}/RK=2/RS=x-`;
  assert.equal(resultUrl(ru('RU=https%3a%2f%2fexample.org%2fa%3fb%3d1'), 'https://search.yahoo.com/', ['search.yahoo.com']), 'https://example.org/a?b=1');
  assert.equal(resultUrl(ru('RX=1'), 'https://search.yahoo.com/', ['search.yahoo.com']), undefined, 'RU= の無い転送');
  assert.equal(resultUrl(ru('RU=%E0%A4%A'), 'https://search.yahoo.com/', ['search.yahoo.com']), undefined, '戻せない符号');
  assert.equal(resultUrl(ru('RU=http%3a%2f%2f10.0.0.1%2f'), 'https://search.yahoo.com/', ['search.yahoo.com']), undefined, 'LAN');
  const yahooHits = readSafely(yahoo, fixture('yahoo-ok.html'), 'text/html', 10, 'https://search.yahoo.com/search?p=sqlite').hits;
  assert.deepEqual(yahooHits.map(h => h.url), ['https://sqlite.org/', 'https://www.sqlitetutorial.net/'], '戻せない RU= の結果は捨てる');
  const bingHits = readSafely(bing, fixture('bing-ok.html'), 'text/html', 10, 'https://www.bing.com/search?q=sqlite').hits;
  assert.ok(bingHits.length >= 3 && bingHits.every(h => !h.url.includes('bing.com')), JSON.stringify(bingHits.map(h => h.url)));
  assert.ok(bingHits.every(h => !h.snippet.endsWith('詳細を表示')), '「詳細を表示」のリンクの文字は抜き書きに入れない');
});

test('地域の読み替え（先ごと）', () => {
  const params = (engine: SearchEngine, region: string) => Object.fromEntries(engine.request('q', region).searchParams);
  assert.equal(params(duckduckgoHtml, 'jp-jp').kl, 'jp-jp');
  assert.equal(params(duckduckgoLite, 'us-en').kl, 'us-en');
  assert.deepEqual([params(bing, 'jp-jp').mkt, params(bing, 'jp-jp').setlang], ['ja-JP', 'ja']);
  assert.deepEqual([params(bing, 'wt-wt').mkt, params(bing, 'wt-wt').setlang], [undefined, undefined]);
  assert.equal(params(startpage, 'jp-jp').language, 'japanese');
  assert.equal(params(startpage, 'de-de').language, undefined, '知らない言語は付けない');
  assert.equal(params(mojeek, 'jp-jp').lb, 'ja');
  assert.equal(wikipedia.request('q', 'jp-jp').hostname, 'ja.wikipedia.org');
  assert.equal(wikipedia.request('q', 'wt-wt').hostname, 'en.wikipedia.org');
  assert.deepEqual(wikipedia.hosts('us-en'), ['en.wikipedia.org']);
  assert.equal(wikipedia.disguise, false);
  assert.match(wikipedia.userAgent!, /^beat\/0\.1 \(personal agent; contact: /u);
});
