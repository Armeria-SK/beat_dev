import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { attribute } from '../html-text.ts';
import { publicHostName } from '../public-page.ts';

export interface SearchHit { title: string; url: string; snippet: string }

// ok: 1 件以上 / empty: 0 件で「結果なし」の印がある / blocked: 0 件で止められた印がある / unknown: 0 件で、どの印も無い（頁の形が変わった疑い）
export type EngineState = 'ok' | 'empty' | 'blocked' | 'unknown';
export interface EngineRead { hits: SearchHit[]; state: EngineState }

export interface SearchEngine {
  readonly id: string;
  readonly label: string;
  // 同じ結果の出どころ（Yahoo は Bing の結果）。同じ provider の先は 1 つの組に入れず、送る間隔を共有する
  readonly provider: string;
  // 止められたときに一緒に休む先の名前（同じ仕組みで止める先。DuckDuckGo の html と lite）。無ければ id
  readonly restGroup?: string;
  hosts(region: string): string[];
  readonly minIntervalMs: number;
  readonly maxPerHour: number;
  // true: 普通のブラウザに似せた頭の行で頼む。false: userAgent で正直に名乗る
  readonly disguise: boolean;
  readonly userAgent?: string;
  readonly accept?: string;
  request(query: string, region: string): URL;
  // pageUrl: 返事を受け取った URL（転送のあと）。相対のリンクや、どの言語の頁かを読むのに使う
  read(body: string, contentType: string, limit: number, pageUrl: string): EngineRead;
}

// 読み方の中で何が起きても外へ投げない（壊れた頁・形の変わった頁は unknown）
export function readSafely(engine: SearchEngine, body: string, contentType: string, limit: number, pageUrl = ''): EngineRead {
  try {
    const result = engine.read(body, contentType, limit, pageUrl);
    return result.hits.length ? { hits: result.hits.slice(0, limit), state: 'ok' } : { hits: [], state: result.state === 'ok' ? 'unknown' : result.state };
  } catch {
    return { hits: [], state: 'unknown' };
  }
}

export const DEFAULT_INTERVAL_MS = 4_000;
export const DEFAULT_PER_HOUR = 30;

// 地域（DuckDuckGo の kl の形: 国-言語。jp-jp・us-en・wt-wt）を、国と言語の 2 文字に分ける。読めない形は undefined
const LANGUAGE_CODES: Record<string, string> = { jp: 'ja', kr: 'ko', tzh: 'zh', ct: 'ca' };
export function regionParts(region: string): { country: string | undefined; language: string | undefined } {
  const match = /^([a-z]{2})-([a-z]{2,3})$/u.exec(region.trim().toLowerCase());
  if (!match || match[1] === 'wt') return { country: undefined, language: undefined };
  const country = match[1] === 'uk' ? 'gb' : match[1];
  const code = LANGUAGE_CODES[match[2]!] ?? match[2]!;
  return { country, language: /^[a-z]{2}$/u.test(code) ? code : undefined };
}

// ── HTML の木をたどる小さな部品 ──

export const parseHtml = (html: string): Tree.Document => parse(html);

export function textOf(node: Tree.Node): string {
  const out: string[] = [];
  const stack: Tree.Node[] = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if ('value' in n && n.nodeName === '#text') out.push(n.value);
    else if ('childNodes' in n && !('tagName' in n && (n.tagName === 'script' || n.tagName === 'style'))) for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]!);
  }
  return out.join('').replace(/\s+/gu, ' ').trim();
}

export const classesOf = (node: Tree.Element): string[] => (attribute(node, 'class') ?? '').split(/\s+/u).filter(Boolean);
export const hasClass = (node: Tree.Element, name: string): boolean => classesOf(node).includes(name);
export const isElement = (node: Tree.Node): node is Tree.Element => 'tagName' in node;

// 木を前から順にたどり、visit が true を返した要素の中へは降りない
export function walk(root: Tree.Node, visit: (node: Tree.Element) => boolean | void): void {
  const stack: Tree.Node[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (isElement(node) && visit(node) === true) continue;
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
  }
}

export function find(root: Tree.Node, match: (node: Tree.Element) => boolean): Tree.Element | undefined {
  let found: Tree.Element | undefined;
  walk(root, node => { if (found) return true; if (match(node)) { found = node; return true; } return false; });
  return found;
}

export function findAll(root: Tree.Node, match: (node: Tree.Element) => boolean): Tree.Element[] {
  const out: Tree.Element[] = [];
  walk(root, node => { if (match(node)) { out.push(node); return true; } return false; });
  return out;
}

export { attribute };

// ── 結果の URL ──

function decodeBase64Url(text: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(text)) return undefined;
  const decoded = Buffer.from(text.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8');
  return decoded.includes('�') ? undefined : decoded;
}

// 検索先を通る転送のリンク（DuckDuckGo の /l/?uddg=・Bing の /ck/a?u=a1<base64>・Yahoo の /RU=<符号化>/）を、本当の行き先へ戻す。
// 転送の形なのに戻せないものは undefined（捨てる）。転送でないものはそのまま
export function unwrapRedirect(url: URL): string | undefined {
  const host = url.hostname.toLowerCase();
  if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && url.pathname === '/l/') return url.searchParams.get('uddg') ?? undefined;
  if ((host === 'bing.com' || host.endsWith('.bing.com')) && url.pathname === '/ck/a') {
    const u = url.searchParams.get('u');
    return u?.startsWith('a1') ? decodeBase64Url(u.slice(2)) : undefined;
  }
  if (host === 'r.search.yahoo.com' || (host.endsWith('.yahoo.com') && url.pathname.includes('/RU='))) {
    const match = /\/RU=([^/]+)\//u.exec(url.pathname);
    if (!match) return undefined;
    try { return decodeURIComponent(match[1]!); } catch { return undefined; }
  }
  return url.href;
}

// 結果のリンクを、行き先の公開の http(s) の URL にする。転送を戻せない・http 以外・公開でない名前・検索先自身の頁は undefined
export function resultUrl(href: string | undefined, base: string, ownHosts: readonly string[]): string | undefined {
  if (!href) return undefined;
  try {
    const first = new URL(href, base);
    const target = unwrapRedirect(first);
    if (!target) return undefined;
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !publicHostName(url.hostname)) return undefined;
    const host = url.hostname.toLowerCase();
    if (ownHosts.some(own => host === own || host.endsWith(`.${own}`))) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}

export function hit(title: string, url: string, snippet: string): SearchHit {
  return { title: title.slice(0, 300), url, snippet: snippet.slice(0, 500) };
}

const TRACKING = /^(utm_\w+|fbclid|gclid|msclkid|yclid|mc_cid|mc_eid|ref_src)$/iu;

// まとめるための URL の鍵: 小文字のホスト・# 以降と追跡の引数を外す・末尾の / をそろえる
export function normalizeUrl(href: string): string {
  try {
    const url = new URL(href);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, '');
    for (const name of [...url.searchParams.keys()]) if (TRACKING.test(name)) url.searchParams.delete(name);
    const path = url.pathname.replace(/\/+$/u, '') || '/';
    return `${url.hostname}${path}${url.search}`;
  } catch { return href; }
}
