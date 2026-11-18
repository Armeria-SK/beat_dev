// ブラウザが製品の開発サーバー（ループバック）を開く決まり。playwright にも、つなぎ（node:net）にも依存しない純関数。
// 中継（egress-proxy.ts）・要求の横取り（driver.ts / route.ts）・道具（builtin/browser.ts）が同じものを使う
import type { AppConfig } from '../../config/schema.ts';
import { guardText, type GuardMessageKey } from '../../shared/messages/guard.ts';
import { selfPortsOf } from '../hooks/self-port.ts';
import type { ToolContext } from '../types.ts';
import { pageUrl, RetrievalFailure } from '../web/public-page.ts';

// ブラウザを使う実行の許し。attended は持ち主が見ている会話（kind chat）。loopback は製品の作業フォルダを持つ実行（考える実行・振り返りでない）
export interface BrowserGrant {
  conversationId: string;
  runId: string;
  attended: boolean;
  loopback: boolean;
  productId?: string | undefined;
}

// 既定の beat のポート。試しの beat が別のポートで動くときも、本物の beat を守る
export const DEFAULT_BEAT_PORT = 4777;
const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

// 考える実行・振り返りはブラウザを使えない（undefined）
export function grantOf(ctx: Pick<ToolContext, 'conversationId' | 'runId' | 'kind' | 'scout' | 'project'>): BrowserGrant | undefined {
  if (ctx.scout === true || ctx.kind === 'review') return undefined;
  const loopback = typeof ctx.project?.root === 'string' && ctx.project.root !== '';
  return { conversationId: ctx.conversationId, runId: ctx.runId, attended: ctx.kind === 'chat', loopback, ...(ctx.project?.id ? { productId: ctx.project.id } : {}) };
}

const IPV4_LOOPBACK = /^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/u;

// WHATWG で正規化したあとのホスト（URL の hostname の形）がループバックの書き方なら、つなぐ番地の順。名前は引かない
export function loopbackHost(hostname: string): { connect: readonly string[] } | undefined {
  if (hostname === 'localhost' || hostname === 'localhost.') return { connect: ['127.0.0.1', '::1'] };
  if (IPV4_LOOPBACK.test(hostname) && hostname.split('.').every(part => Number(part) <= 255)) return { connect: [hostname] };
  if (hostname === '[::1]') return { connect: ['::1'] };
  return undefined;
}

// 正規化したホスト（hostname）。読めなければ undefined
export function normalHost(host: string): string | undefined {
  try { return new URL(`http://${host}/`).hostname.toLowerCase(); } catch { return undefined; }
}

export function portOf(url: URL): number | undefined {
  return url.port === '' ? DEFAULT_PORT[url.protocol] : Number(url.port);
}

// Origin の見出しがループバックの出どころ（http のループバックのページ）か
export function loopbackOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === 'null') return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return url.protocol === 'http:' && url.origin === origin && loopbackHost(url.hostname) !== undefined;
}

function loopbackPortOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (loopbackHost(url.hostname) === undefined) return undefined;
  return portOf(url) ?? 80;
}

// 断るポート: beat のポート（server.port と origins）・既定の 4777・この beat の中継すべて・設定の提供元と MCP の http のうちループバックの宛先。呼ぶたびに作る
export function deniedLoopbackPorts(config: AppConfig, proxyPorts: Iterable<number>): Set<number> {
  const denied = new Set<number>(selfPortsOf(config.server).ports);
  denied.add(DEFAULT_BEAT_PORT);
  for (const port of proxyPorts) denied.add(port);
  for (const provider of config.providers) { const port = loopbackPortOf(provider.baseUrl); if (port !== undefined) denied.add(port); }
  for (const server of config.mcp.servers) { const port = loopbackPortOf(server.transport === 'http' ? server.url : undefined); if (port !== undefined) denied.add(port); }
  return denied;
}

// 許されたループバックの URL か（http・ループバックの書き方・断るポートでない・名前と合言葉なし）
export function allowedLoopbackUrl(raw: string, denied: ReadonlySet<number>): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
  if (url.username || url.password || loopbackHost(url.hostname) === undefined) return false;
  const port = portOf(url);
  return port !== undefined && !denied.has(port);
}

// URL の行き先がループバックの書き方か（種類は問わない）
export function isLoopbackUrl(raw: string): boolean {
  try { return loopbackHost(new URL(raw).hostname) !== undefined; } catch { return false; }
}

const refusal = (key: GuardMessageKey, params: Record<string, string | number> = {}): RetrievalFailure =>
  new RetrievalFailure('policy_blocked', guardText('en', key, params));

// browser_open の URL の決まり。公開の URL は今までの pageUrl。許し（grant.loopback）があるときだけ、http の許されたループバックの URL を通す
export function browserPageUrl(raw: string, grant: BrowserGrant, denied: ReadonlySet<number>): { url: URL; kind: 'public' | 'loopback' } {
  let parsed: URL | undefined;
  try { parsed = new URL(raw); } catch { parsed = undefined; }
  if (parsed && raw.length <= 4096 && loopbackHost(parsed.hostname) !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    if (!grant.loopback) throw refusal('browser.loopback.not_product');
    if (parsed.protocol !== 'http:') throw refusal('browser.loopback.https');
    if (parsed.username || parsed.password) throw refusal('browser.loopback.not_product');
    const port = portOf(parsed)!;
    if (denied.has(port)) throw refusal('browser.loopback.denied_port', { port });
    parsed.hash = '';
    return { url: parsed, kind: 'loopback' };
  }
  return { url: pageUrl(raw), kind: 'public' };
}

// 中継の本体の守り（平の http）: ブラウザが付ける Sec-Fetch-Site / Origin で、公開のページから来た要求を断る（ページのスクリプトはこれらを書けない）
export function fetchSiteAllows(headers: { secFetchSite?: string | undefined; origin?: string | undefined }): boolean {
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site === 'none' || site === 'same-origin' || site === 'same-site') return true;
  if (site === 'cross-site') return loopbackOrigin(headers.origin);
  return false;
}

export const TUNNEL_HEAD_MAX = 16 * 1024;
const HEAD_END = Buffer.from('\r\n\r\n');

// 中継の本体の守り（WebSocket）: CONNECT のあとの始めの要求が、ループバックのページからの WebSocket の始まりか。more = まだ足りない
export function tunnelVerdict(head: Buffer): 'more' | 'ok' | 'refuse' {
  if (head.length === 0) return 'more';
  // TLS（https / wss）の始まり
  if (head[0] === 0x16) return 'refuse';
  const end = head.indexOf(HEAD_END);
  const text = head.subarray(0, end < 0 ? Math.min(head.length, TUNNEL_HEAD_MAX) : end).toString('latin1');
  const firstBreak = text.indexOf('\r\n');
  const requestLine = firstBreak < 0 ? text : text.slice(0, firstBreak);
  // HTTP の GET でないもの（届いた分だけで分かれば）は待たずに切る
  if (!(text.length < 4 ? 'GET '.startsWith(text) : text.startsWith('GET '))) return 'refuse';
  if (end < 0) return head.length >= TUNNEL_HEAD_MAX ? 'refuse' : 'more';
  if (end + HEAD_END.length > TUNNEL_HEAD_MAX) return 'refuse';
  if (!/^GET \S+ HTTP\/1\.[01]$/u.test(requestLine)) return 'refuse';
  if (/[^\t\x20-\x7e\r\n]/u.test(text)) return 'refuse';
  const headers = new Map<string, string[]>();
  for (const line of text.slice(firstBreak + 2).split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0 || /\s/u.test(line.slice(0, colon))) return 'refuse';
    const name = line.slice(0, colon).toLowerCase();
    headers.set(name, [...(headers.get(name) ?? []), line.slice(colon + 1).trim()]);
  }
  const upgrade = headers.get('upgrade');
  const origin = headers.get('origin');
  if (upgrade?.length !== 1 || upgrade[0]!.toLowerCase() !== 'websocket') return 'refuse';
  if (origin?.length !== 1 || !loopbackOrigin(origin[0])) return 'refuse';
  return 'ok';
}
