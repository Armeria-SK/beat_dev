import { networkFor, type PageNetwork } from '../public-page.ts';
import { regionParts, type SearchEngine } from './engine.ts';

// 検索の頼みだけに使う頭の行（持ち主の決め 2026-11-21: 普通のブラウザに似せてよい。captcha を解く・JavaScript の確かめを通る・
// 止められた同じ先へ頭の行を変えてすぐ送り直す、はしない）。web_fetch・ブラウザ・ダウンロードの名乗りは beat/0.1 のまま。
// Accept-Encoding は送らない（圧縮された返事は今の取得の決まりどおり断る）

const CHROME_AGENTS: readonly string[] = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
];

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
export const SEARCH_TYPES = /^(text\/html|application\/xhtml\+xml|application\/json)(;|$)/iu;
export const SEARCH_MAX_BYTES = 512 * 1024;

export interface SearchRequestHeaders { accept: string; headers: Record<string, string> }

export function acceptLanguage(region: string): string {
  const { country, language } = regionParts(region);
  if (!language) return 'en-US,en;q=0.9';
  if (language === 'en') return country && country !== 'us' ? `en-${country.toUpperCase()},en;q=0.9` : 'en-US,en;q=0.9';
  return `${language}${country ? `-${country.toUpperCase()}` : ''},${language};q=0.9,en;q=0.8`;
}

// turn: 検索ごとに進む位置。User-Agent を乱数ではなく順に回す
export function searchHeaders(engine: SearchEngine, region: string, turn: number): SearchRequestHeaders {
  if (!engine.disguise) {
    return { accept: engine.accept ?? 'application/json', headers: { ...(engine.userAgent ? { 'user-agent': engine.userAgent } : {}) } };
  }
  return {
    accept: engine.accept ?? HTML_ACCEPT,
    headers: {
      'user-agent': CHROME_AGENTS[turn % CHROME_AGENTS.length]!,
      'accept-language': acceptLanguage(region),
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
    },
  };
}

// 検索用の PageNetwork（public-page.ts の networkFor をそのまま使う。LAN 拒否・アドレス固定・転送の確かめは今の道のまま）
export const searchNetworkFor = (request: SearchRequestHeaders): PageNetwork => networkFor(request.accept, SEARCH_TYPES, SEARCH_MAX_BYTES, request.headers);
