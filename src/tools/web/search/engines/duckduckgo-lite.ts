import { attribute, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['duckduckgo.com'];

// 結果は表の行: a.result-link のある行の次の行に td.result-snippet。止め方は html と同じ仕組みなので一緒に休む（restGroup）
export const duckduckgoLite: SearchEngine = {
  id: 'duckduckgo-lite',
  label: 'DuckDuckGo Lite',
  provider: 'duckduckgo',
  restGroup: 'duckduckgo',
  hosts: () => ['lite.duckduckgo.com', 'duckduckgo.com', 'html.duckduckgo.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query, region) {
    const url = new URL('https://lite.duckduckgo.com/lite/');
    url.searchParams.set('q', query);
    if (region) url.searchParams.set('kl', region);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    const rows = findAll(document, node => node.tagName === 'tr');
    rows.forEach((row, index) => {
      if (hits.length >= limit) return;
      const link = find(row, node => node.tagName === 'a' && hasClass(node, 'result-link'));
      if (!link || hasClass(row, 'result-sponsored')) return;
      const url = resultUrl(attribute(link, 'href'), 'https://lite.duckduckgo.com/', OWN);
      const next = rows[index + 1];
      const snippet = next ? find(next, node => hasClass(node, 'result-snippet')) : undefined;
      const title = textOf(link);
      if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
    });
    if (hits.length) return { hits, state: 'ok' };
    if (find(document, node => node.tagName === 'form' && /challenge/iu.test(attribute(node, 'id') ?? '')) || /anomaly|unusual traffic|bots use DuckDuckGo/iu.test(body)) return { hits, state: 'blocked' };
    if (/No (more )?results\./u.test(body)) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
