// 検索先の実地の確かめ（手で回す。npm test には入れない）。
// 各先へ 1 回ずつ、本物の検索の頼み（ふりの頭の行・Wikipedia は beat の名乗り）を送り、先ごとに 1 行で結果を出す:
//   ok <件数> / empty / blocked / unknown / error（通信の失敗）
// DuckDuckGo の html と lite は続けて送る（html が止められた直後に lite も止められるか = 一緒に休ませるべきかを見る）。
// 使い方: node --import ./tests/helpers/tsx-loader.mjs scripts/search-smoke.ts [--query "<問い>"] [--region jp-jp] [--only bing,wikipedia]
import { decodeText, fetchPublic, RetrievalFailure } from '../src/tools/web/public-page.ts';
import { searchHeaders, searchNetworkFor } from '../src/tools/web/search/disguise.ts';
import { readSafely } from '../src/tools/web/search/engine.ts';
import { ENGINES } from '../src/tools/web/search/engines/index.ts';

const QUERIES = ['sqlite', 'typescript test runner'];
const GAP_MS = 3_000;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const region = option('region') ?? 'jp-jp';
const only = option('only')?.split(',');
const fixedQuery = option('query');
const engines = ENGINES.filter(engine => !only || only.includes(engine.id));

for (const [index, engine] of engines.entries()) {
  if (index) await new Promise(resolve => setTimeout(resolve, GAP_MS));
  const query = fixedQuery ?? QUERIES[index % QUERIES.length]!;
  const url = engine.request(query, region);
  let line: string;
  try {
    const page = await fetchPublic(url.href, undefined, searchNetworkFor(searchHeaders(engine, region, index)), 15_000);
    const read = readSafely(engine, decodeText(page.body, page.contentType), page.contentType, 10, page.url);
    line = read.state === 'ok' ? `ok ${read.hits.length} (first: ${read.hits[0]!.url})` : read.state;
  } catch (error) {
    const status = error instanceof RetrievalFailure ? error.status : undefined;
    const blocked = error instanceof RetrievalFailure && (error.code === 'refused' || (status !== undefined && [202, 401, 403, 429].includes(status)));
    line = blocked ? `blocked (HTTP ${status})` : `error (${error instanceof RetrievalFailure ? `${error.code}${status ? ` HTTP ${status}` : ''}: ` : ''}${(error as Error).message})`;
  }
  const out = `${engine.id.padEnd(16)} ${JSON.stringify(query).padEnd(26)} ${line}`;
  console.log(out);
}
console.log(`\n${new Date().toISOString()} region=${region} engines=${engines.length}`);
