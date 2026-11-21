import { attribute, classesOf, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hasClass, hit, parseHtml, regionParts, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['startpage.com'];
const LANGUAGES: Record<string, string> = { ja: 'japanese', en: 'english' };

// 中身は Google の結果（Google を直接使わない代わり）。結果は div.result、リンクは行き先へ直に向く
export const startpage: SearchEngine = {
  id: 'startpage',
  label: 'Startpage',
  provider: 'startpage',
  hosts: () => ['www.startpage.com', 'startpage.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query, region) {
    const url = new URL('https://www.startpage.com/sp/search');
    url.searchParams.set('query', query);
    url.searchParams.set('cat', 'web');
    const language = LANGUAGES[regionParts(region).language ?? ''];
    if (language) url.searchParams.set('language', language);
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const result of findAll(document, node => node.tagName === 'div' && hasClass(node, 'result'))) {
      if (hits.length >= limit) break;
      const link = find(result, node => node.tagName === 'a' && classesOf(node).some(name => name.startsWith('result-title') || name === 'result-link'));
      if (!link) continue;
      const url = resultUrl(attribute(link, 'href'), 'https://www.startpage.com/', OWN);
      const snippet = find(result, node => node.tagName === 'p' && hasClass(node, 'description'));
      const title = textOf(link);
      if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
    }
    if (hits.length) return { hits, state: 'ok' };
    // 2026-11-21 に見た止め方: JavaScript で計算させる確かめ（script#anubis_challenge）の頁
    if (find(document, node => node.tagName === 'script' && /challenge/iu.test(attribute(node, 'id') ?? '')) || /captcha/iu.test(body)) return { hits, state: 'blocked' };
    if (/did not match any (documents|results)|No results found/iu.test(body)) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
