// ブラウザの要求の横取り（context.route）で使う判定。副の守り（本体は中継 egress-proxy.ts）。
// playwright に依存しない純関数にして、driver.ts の handler と試験が同じものを使う
import { pageUrl } from '../web/public-page.ts';
import { isLoopbackUrl } from './loopback.ts';
import { siteAllows } from './sites.ts';

export interface RouteRequest {
  url: string;
  // ページの遷移の要求か（部品の読み込み・fetch・XHR は false）
  navigation: boolean;
  mainFrame: boolean;
  // いまの main frame の URL（まだ無ければ undefined）
  pageUrl: string | undefined;
  // 許されたループバックの URL か（作業用の文脈で許しがあるときだけ。無ければループバックは全部断る）
  allowed?: ((url: string) => boolean) | undefined;
}

// scheme: 許さない種類の URL / navigation: ページの遷移として許さない / downgrade: https のページから http への遷移 /
// listed: 操作の一覧のサイトの（クエリ付き・根ページでない）URL への、確かめを出せない遷移（リダイレクト・一覧外のページからの移動） /
// loopback: 許されていないループバック、または公開のページから来たループバックへの要求
export type RouteRefusal = 'scheme' | 'navigation' | 'downgrade' | 'listed' | 'loopback';
export type RouteVerdict = { allow: true } | { allow: false; reason: RouteRefusal };

const PARTS = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:']);

export function routeVerdict(request: RouteRequest): RouteVerdict {
  let url: URL;
  try { url = new URL(request.url); } catch { return { allow: false, reason: 'scheme' }; }
  if (!PARTS.has(url.protocol)) return { allow: false, reason: 'scheme' };
  if (!request.navigation) return { allow: true };
  // ページの遷移としての data: / blob: は断る（画像などの部品としては上で通している）
  if (url.protocol === 'data:' || url.protocol === 'blob:') return { allow: false, reason: 'navigation' };
  if (!request.mainFrame) return { allow: true };
  if (isLoopbackUrl(request.url)) {
    // ループバックの遷移は、公開の決まり（pageUrl）の代わりに許し（allowed）で決める
    if (!(request.allowed?.(request.url) ?? false)) return { allow: false, reason: 'loopback' };
  } else {
    try { pageUrl(request.url); } catch { return { allow: false, reason: 'navigation' }; }
  }
  if (url.protocol === 'http:' && request.pageUrl !== undefined && /^https:/iu.test(request.pageUrl)) return { allow: false, reason: 'downgrade' };
  return { allow: true };
}

export interface ListedNavigation {
  // 遷移の行き先（main frame の要求の URL）
  url: string;
  // リダイレクトのとき、その手前の要求の URL（リダイレクトでなければ undefined）
  redirectedFrom: string | undefined;
  // リダイレクトでないときの遷移元: いまのページの URL（まだ空なら、開いた元のページの URL）。読めなければ undefined
  sourceUrl: string | undefined;
  // browser_open が確かめ（または一覧外の判定）を済ませた入口の URL。goto の最中だけ入る
  entryUrl: string | undefined;
  // tools.browser.sites（操作の一覧）
  sites: readonly string[];
}

// 同じサイトか: ホストが同じ、または一覧の同じ 1 つの項目に両方が当たる（example.com と www.example.com など）
function sameSite(sites: readonly string[], a: string, b: string): boolean {
  let hostA: string; let hostB: string;
  try { hostA = new URL(a).hostname.toLowerCase(); hostB = new URL(b).hostname.toLowerCase(); } catch { return false; }
  if (hostA !== '' && hostA === hostB) return true;
  return sites.some(entry => siteAllows([entry], a) && siteAllows([entry], b));
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

// 一覧のサイトで、開くだけの GET が操作になりうる URL か（クエリ付き、またはパスが根ページ以外）
function isActionLike(url: URL): boolean {
  return url.search !== '' || url.pathname !== '/';
}

// browser_open の確かめは、入口の URL しか見ない。ページが勝手に別の URL へ飛ばす（リダイレクト・location 代入・meta refresh）と、
// 一覧のサイトへ Cookie 付きの GET が確かめなしで走るので、確かめを出せない遷移は断る。
// 断るのは、行き先が一覧のサイトの「操作になりうる URL」で、次のどれか:
//  - リダイレクトで、手前の URL が別のサイトのとき
//  - リダイレクトでなく、遷移元が一覧外のサイト（読めない・空のページを含む）のとき
// 妨げないもの: 一覧のサイトの根ページ（クエリなし）への移動 / 同じサイトの中の移動 / 一覧のサイトのページからの移動 /
// 確かめ済みの入口の URL そのもの（リダイレクトでない最初の要求）
export function listedNavigationVerdict(nav: ListedNavigation): RouteVerdict {
  if (nav.sites.length === 0) return { allow: true };
  let target: URL;
  try { target = new URL(nav.url); } catch { return { allow: true }; }
  if (!siteAllows(nav.sites, target) || !isActionLike(target)) return { allow: true };
  const refuse: RouteVerdict = { allow: false, reason: 'listed' };
  if (nav.redirectedFrom !== undefined) return sameSite(nav.sites, nav.redirectedFrom, nav.url) ? { allow: true } : refuse;
  if (nav.entryUrl !== undefined) {
    // 要求の URL に # 以降は載らないので、# 以降を除いて比べる
    try { if (withoutHash(new URL(nav.entryUrl)) === withoutHash(target)) return { allow: true }; } catch { /* 入口が読めなければ、遷移元で決める */ }
  }
  const source = nav.sourceUrl;
  if (source === undefined || source === '' || !/^https?:/iu.test(source)) return refuse;
  if (sameSite(nav.sites, source, nav.url) || siteAllows(nav.sites, source)) return { allow: true };
  return refuse;
}

export interface LoopbackRequest {
  // 要求の URL（行き先がループバックの書き方のものだけをここで見る）
  url: string;
  navigation: boolean;
  // 要求を出した枠の URL（空の枠は親の枠、空の窓は開いた元のページの URL）。読めなければ undefined
  frameUrl: string | undefined;
  // 遷移がリダイレクトなら、その手前の URL
  redirectedFrom: string | undefined;
  // リダイレクトでない遷移の遷移元（枠のいまの URL。空なら親・開いた元）
  sourceUrl: string | undefined;
  // browser_open の goto の最中だけ入る、入口の URL
  entryUrl: string | undefined;
  allowed: (url: string) => boolean;
}

function sameUrl(a: string, b: string): boolean {
  try { return withoutHash(new URL(a)) === withoutHash(new URL(b)); } catch { return false; }
}

// 公開のページからループバックへ行かせない（副の守り。本体は中継の Sec-Fetch-Site / Origin の確かめ）。
// 通すのは、行き先が許されたループバックで、出どころも許されたループバックのとき（遷移はリダイレクトの手前・遷移元）、または入口の URL そのもの
export function loopbackVerdict(request: LoopbackRequest): RouteVerdict {
  const refuse: RouteVerdict = { allow: false, reason: 'loopback' };
  if (!isLoopbackUrl(request.url)) return { allow: true };
  if (!request.allowed(request.url)) return refuse;
  const from = (source: string | undefined): RouteVerdict => (source !== undefined && request.allowed(source) ? { allow: true } : refuse);
  if (!request.navigation) return from(request.frameUrl);
  if (request.redirectedFrom !== undefined) return from(request.redirectedFrom);
  if (request.entryUrl !== undefined && sameUrl(request.entryUrl, request.url)) return { allow: true };
  return from(request.sourceUrl);
}