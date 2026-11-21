import { attribute, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['search.yahoo.com'];

// 中身は Bing の結果なので provider は bing（同じ組に Bing と並べない）。
// 結果は div.algo、リンクは r.search.yahoo.com/…/RU=<符号化>/… の転送の形で、engine.ts の resultUrl が行き先へ戻す
export const yahoo: SearchEngine = {
  id: 'yahoo',
  label: 'Yahoo',
  provider: 'bing',
  hosts: () => ['search.yahoo.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query) {
    const url = new URL('https://search.yahoo.com/search');
    url.searchParams.set('p', query);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const result of findAll(document, node => node.tagName === 'div' && hasClass(node, 'algo'))) {
      if (hits.length >= limit) break;
      const heading = find(result, node => node.tagName === 'h3');
      const link = heading && find(heading, node => node.tagName === 'a');
      if (!heading || !link) continue;
      const url = resultUrl(attribute(link, 'href'), 'https://search.yahoo.com/', OWN);
      const snippet = find(result, node => hasClass(node, 'compText'));
      const title = textOf(heading);
      if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
    }
    if (hits.length) return { hits, state: 'ok' };
    if (/captcha|unusual traffic/iu.test(body)) return { hits, state: 'blocked' };
    if (find(document, node => hasClass(node, 'zrp')) || /We did not find results/iu.test(body)) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
