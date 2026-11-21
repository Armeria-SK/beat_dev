import { parseFragment } from 'parse5';
import { DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, hit, regionParts, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

// Wikipedia へはふりをせず正直に名乗る（Wikimedia の案内: 出どころの分かる User-Agent）。
// 連絡先は仮の名前（持ち主の決め 2026-11-21 Q3）。配る先のリポジトリが決まったら、ここ 1 か所を差し替える
const CONTACT = 'beat-provisional';
export const WIKIPEDIA_USER_AGENT = `beat/0.1 (personal agent; contact: ${CONTACT})`;

const languageOf = (region: string) => regionParts(region).language ?? 'en';

// 公式の検索 API（action=query&list=search）。結果は JSON
export const wikipedia: SearchEngine = {
  id: 'wikipedia',
  label: 'Wikipedia',
  provider: 'wikipedia',
  hosts: region => [`${languageOf(region)}.wikipedia.org`],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: false,
  userAgent: WIKIPEDIA_USER_AGENT,
  accept: 'application/json',
  request(query, region) {
    const url = new URL(`https://${languageOf(region)}.wikipedia.org/w/api.php`);
    const params: Record<string, string> = { action: 'query', list: 'search', srsearch: query, srprop: 'snippet', srlimit: '10', format: 'json', utf8: '1' };
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  },
  read(body, _contentType, limit, pageUrl) {
    const host = new URL(pageUrl || 'https://en.wikipedia.org/').hostname;
    if (!/^[a-z-]{2,12}\.wikipedia\.org$/u.test(host)) return { hits: [], state: 'unknown' };
    const data = JSON.parse(body) as { query?: { search?: Array<{ title?: unknown; snippet?: unknown }> }; error?: { code?: unknown } };
    const list = data.query?.search;
    if (!Array.isArray(list)) return { hits: [], state: data.error?.code === 'ratelimited' ? 'blocked' : 'unknown' };
    const hits: SearchHit[] = [];
    for (const item of list.slice(0, limit)) {
      if (typeof item.title !== 'string' || !item.title) continue;
      const url = `https://${host}/wiki/${encodeURIComponent(item.title.replace(/ /gu, '_'))}`;
      hits.push(hit(item.title, url, typeof item.snippet === 'string' ? textOf(parseFragment(item.snippet)) : ''));
    }
    return { hits, state: hits.length ? 'ok' : 'empty' };
  },
};
