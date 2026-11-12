export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
}

// server.host の検査。この PC の外には待ち受けない（ほかの端末からは Tailscale Serve 経由）。問題が無ければ undefined。起動（main.ts）と、画面からの反映（src/web/server-host.ts）が同じ検査を使う
export function serverHostProblem(host: string): string | undefined {
  return isLoopbackHost(host) ? undefined : `Set server.host to a loopback address such as 127.0.0.1 (it is ${host} now). Other devices open beat through Tailscale Serve (see the README section on using beat from other devices)`;
}

export function checkBaseUrl(value: string, usesApiKey: boolean): { url: string } | { problem: string } {
  let url: URL;
  try { url = new URL(value); } catch { return { problem: 'Cannot be read as a URL' }; }
  if (url.username || url.password || url.search || url.hash) return { problem: 'Do not include credentials, a query or #' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { problem: 'Use http or https' };
  if (url.protocol === 'http:' && usesApiKey && !isLoopbackHost(url.hostname)) {
    return { problem: 'Use https for connections that use an API key (http only for servers on this PC)' };
  }
  return { url: url.href.replace(/\/+$/u, '') };
}

// 外へ送る先（通知の webhook・リンクの頭）として使える URL か。https か、この PC（ループバック）の http だけ。認証情報（user:pass@）は書けない
export function isSafeOutboundUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}