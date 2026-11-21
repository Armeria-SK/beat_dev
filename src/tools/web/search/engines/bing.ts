import { attribute, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, regionParts, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['bing.com', 'msn.com'];

// 結果は li.b_algo。リンクは bing.com/ck/a?…&u=a1<base64> の転送の形が多く、engine.ts の resultUrl が行き先へ戻す
export const bing: SearchEngine = {
  id: 'bing',
  label: 'Bing',
  provider: 'bing',
  hosts: () => ['www.bing.com', 'bing.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query, region) {
    const url = new URL('https://www.bing.com/search');
    url.searchParams.set('q', query);
    const { country, language } = regionParts(region);
    if (language) url.searchParams.set('setlang', language);
    if (language && country) url.searchParams.set('mkt', `${language}-${country.toUpperCase()}`);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const result of findAll(document, node => node.tagName === 'li' && hasClass(node, 'b_algo'))) {
      if (hits.length >= limit) break;
      const heading = find(result, node => node.tagName === 'h2');
      const link = heading && find(heading, node => node.tagName === 'a');
      if (!link) continue;
      const url = resultUrl(attribute(link, 'href'), 'https://www.bing.com/', OWN);
      const caption = find(result, node => hasClass(node, 'b_caption'));
      const paragraph = caption && (find(caption, node => node.tagName === 'p') ?? caption);
      const more = paragraph && find(paragraph, node => hasClass(node, 'b_algoReadMore'));
      let snippet = paragraph ? textOf(paragraph) : '';
      const tail = more ? textOf(more) : '';
      if (tail && snippet.endsWith(tail)) snippet = snippet.slice(0, -tail.length).trim();
      const title = textOf(link);
      if (title && url) hits.push(hit(title, url, snippet));
    }
    if (hits.length) return { hits, state: 'ok' };
    if (find(document, node => hasClass(node, 'b_captcha') || attribute(node, 'id') === 'b_captcha')) return { hits, state: 'blocked' };
    if (find(document, node => node.tagName === 'li' && hasClass(node, 'b_no'))) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
