// tools.browser.sites の照合。example.com はサブドメインも、=example.com はそのホストだけ。
// 比べるのは URL のホスト名だけ（パス・クエリ・ユーザー情報は見ない）。小文字・末尾のドットなし・punycode にそろえる。
// 迷ったら当たらない（操作できない = 読むだけ）側に倒す

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/u;

// ホスト名を、比べる形（小文字・punycode・末尾のドットなし）にする。ホスト名として読めなければ空
export function normalizeSiteHost(host: string): string {
  const trimmed = host.trim().replace(/\.+$/u, '');
  if (!trimmed || /[\s/\\@:?#%[\]]/u.test(trimmed)) return '';
  let ascii: string;
  try { ascii = new URL(`http://${trimmed}/`).hostname; } catch { return ''; }
  ascii = ascii.replace(/\.+$/u, '').toLowerCase();
  return HOST.test(ascii) ? ascii : '';
}

export function siteAllows(sites: readonly string[], url: string | URL): boolean {
  if (sites.length === 0) return false;
  let parsed: URL;
  try { parsed = typeof url === 'string' ? new URL(url) : url; } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = normalizeSiteHost(parsed.hostname);
  if (!host) return false;
  for (const entry of sites) {
    const exact = entry.startsWith('=');
    const name = normalizeSiteHost(exact ? entry.slice(1) : entry);
    if (!name || name !== (exact ? entry.slice(1) : entry)) continue;
    if (host === name || (!exact && host.endsWith(`.${name}`))) return true;
  }
  return false;
}

const OWNER_URL = /https?:\/\/[^\s<>"'`()[\]{}]+/giu;

// 持ち主が書いた文（会話の持ち主の発言・タスクの持ち主の頼み）にある http(s):// の URL のどれかと、url のホストがちょうど同じか（D-7）。
// 下のドメインは含めない。スキームの無い書き方（example.com だけ）は拾わない。ホストとして読めないもの（IP の直書きなど）は当たらない
export function ownerHostAllows(ownerTexts: readonly string[], url: string | URL): boolean {
  let parsed: URL;
  try { parsed = typeof url === 'string' ? new URL(url) : url; } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = normalizeSiteHost(parsed.hostname);
  if (!host) return false;
  for (const text of ownerTexts) {
    for (const match of text.matchAll(OWNER_URL)) {
      let written: URL;
      try { written = new URL(match[0]); } catch { continue; }
      if (normalizeSiteHost(written.hostname) === host) return true;
    }
  }
  return false;
}

const OWNER_LOOPBACK = /(?<![\w.-])(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})(?!\d)/giu;

// 持ち主が書いた文にある localhost:<port> / 127.0.0.1:<port> / [::1]:<port>（http:// は有っても無くても）のポート（9-1b の R-8 の (a)）
export function ownerLoopbackPorts(ownerTexts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const text of ownerTexts) {
    for (const match of text.matchAll(OWNER_LOOPBACK)) {
      const port = Number(match[1]);
      if (port > 0 && port < 65536) out.add(port);
    }
  }
  return out;
}
