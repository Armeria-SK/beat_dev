// ブラウザの要求の横取り（context.route）で使う判定。副の守り（本体は中継 egress-proxy.ts）。
// playwright に依存しない純関数にして、driver.ts の handler と試験が同じものを使う
import { pageUrl } from '../web/public-page.ts';

export interface RouteRequest {
  url: string;
  // ページの遷移の要求か（部品の読み込み・fetch・XHR は false）
  navigation: boolean;
  mainFrame: boolean;
  // いまの main frame の URL（まだ無ければ undefined）
  pageUrl: string | undefined;
}

// scheme: 許さない種類の URL / navigation: ページの遷移として許さない / downgrade: https のページから http への遷移
export type RouteRefusal = 'scheme' | 'navigation' | 'downgrade';
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
  try { pageUrl(request.url); } catch { return { allow: false, reason: 'navigation' }; }
  if (url.protocol === 'http:' && request.pageUrl !== undefined && /^https:/iu.test(request.pageUrl)) return { allow: false, reason: 'downgrade' };
  return { allow: true };
}
