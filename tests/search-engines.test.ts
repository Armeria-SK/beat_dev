import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUrl, readSafely, regionParts, resultUrl, type SearchEngine } from '../src/tools/web/search/engine.ts';
import { duckduckgoHtml } from '../src/tools/web/search/engines/duckduckgo-html.ts';

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
