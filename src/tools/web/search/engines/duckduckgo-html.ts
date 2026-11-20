import { attribute, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['duckduckgo.com'];

export const duckduckgoHtml: SearchEngine = {
  id: 'duckduckgo-html',
  label: 'DuckDuckGo',
  provider: 'duckduckgo',
  hosts: () => ['html.duckduckgo.com', 'duckduckgo.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query, region) {
    const url = new URL('https://html.duckduckgo.com/html/');
    url.searchParams.set('q', query);
    if (region) url.searchParams.set('kl', region);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const result of findAll(document, node => node.tagName === 'div' && hasClass(node, 'result'))) {
      if (hits.length >= limit) break;
      if (hasClass(result, 'result--ad')) continue;
      const link = find(result, node => node.tagName === 'a' && hasClass(node, 'result__a'));
      if (!link) continue;
      const title = textOf(link);
      const url = resultUrl(attribute(link, 'href'), 'https://duckduckgo.com/', OWN);
      const snippet = find(result, node => hasClass(node, 'result__snippet'));
      if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
    }
    if (hits.length) return { hits, state: 'ok' };
    if (find(document, node => node.tagName === 'form' && /challenge/iu.test(attribute(node, 'id') ?? '')) || /anomaly|unusual traffic|bots use DuckDuckGo/iu.test(body)) return { hits, state: 'blocked' };
    if (find(document, node => hasClass(node, 'no-results'))) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
