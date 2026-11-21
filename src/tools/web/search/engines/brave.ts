import { attribute, classesOf, DEFAULT_INTERVAL_MS, DEFAULT_PER_HOUR, find, findAll, hit, parseHtml, resultUrl, textOf, type SearchEngine, type SearchHit } from '../engine.ts';

const OWN = ['brave.com'];
const classPart = (node: Parameters<typeof classesOf>[0], part: string) => classesOf(node).some(name => name.includes(part));

// 結果は data-type="web" の塊。リンクは行き先へ直に向く
export const brave: SearchEngine = {
  id: 'brave',
  label: 'Brave',
  provider: 'brave',
  hosts: () => ['search.brave.com'],
  minIntervalMs: DEFAULT_INTERVAL_MS,
  maxPerHour: DEFAULT_PER_HOUR,
  disguise: true,
  request(query) {
    const url = new URL('https://search.brave.com/search');
    url.searchParams.set('q', query);
    url.searchParams.set('source', 'web');
    return url;
  },
  read(body, _contentType, limit) {
    const document = parseHtml(body);
    const hits: SearchHit[] = [];
    for (const result of findAll(document, node => attribute(node, 'data-type') === 'web')) {
      if (hits.length >= limit) break;
      const link = find(result, node => node.tagName === 'a' && /^https?:/u.test(attribute(node, 'href') ?? ''));
      if (!link) continue;
      const url = resultUrl(attribute(link, 'href'), 'https://search.brave.com/', OWN);
      const titleNode = find(result, node => classPart(node, 'title'));
      const snippet = find(result, node => classPart(node, 'description') || classPart(node, 'snippet-content'));
      const title = titleNode ? textOf(titleNode) : textOf(link);
      if (title && url) hits.push(hit(title, url, snippet ? textOf(snippet) : ''));
    }
    if (hits.length) return { hits, state: 'ok' };
    if (/captcha|unusual traffic/iu.test(body)) return { hits, state: 'blocked' };
    if (/Not many great matches|No results found/iu.test(body)) return { hits, state: 'empty' };
    return { hits, state: 'unknown' };
  },
};
