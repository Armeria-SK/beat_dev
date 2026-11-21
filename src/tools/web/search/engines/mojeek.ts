import { attribute, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, regionParts, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['mojeek.com'];

// 結果は ul.results-standard の li。題のリンクは a.title、抜き書きは p.s
export const mojeek: SearchEngine = {
  id: 'mojeek',
  label: 'Mojeek',
  provider: 'mojeek',
  hosts: () => ['www.mojeek.com', 'mojeek.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query, region) {
    const url = new URL('https://www.mojeek.com/search');
    url.searchParams.set('q', query);
    const { language } = regionParts(region);
    if (language) url.searchParams.set('lb', language);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const list of findAll(document, node => node.tagName === 'ul' && hasClass(node, 'results-standard'))) {
      for (const item of findAll(list, node => node.tagName === 'li')) {
        if (hits.length >= limit) break;
        const link = find(item, node => node.tagName === 'a' && hasClass(node, 'title'));
        if (!link) continue;
        const url = resultUrl(attribute(link, 'href'), 'https://www.mojeek.com/', OWN);
        const snippet = find(item, node => node.tagName === 'p' && hasClass(node, 's'));
        const title = textOf(link);
        if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
      }
    }
    if (hits.length) return { hits, state: 'ok' };
    // 2026-11-21 に見た止め方: 題が Captcha で、JavaScript の確かめを求める頁
    const title = find(document, node => node.tagName === 'title');
    if ((title && /captcha/iu.test(textOf(title))) || /complete this challenge/iu.test(body)) return { hits, state: 'blocked' };
    if (/No pages found/iu.test(body)) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
