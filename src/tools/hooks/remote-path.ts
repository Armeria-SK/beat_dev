const WINDOWS = process.platform === 'win32';

// ネットワークのパス（UNC: \\サーバー\共有）か、デバイスのパス（\\?\ \\.\ \??\）か。Windows は / を \ と同じに読む。
// ネットワークの先は、このPCの中で確かめられず（管理共有 \\localhost\C$ は同じ PC のファイルを指す）、デバイスのパスは * や ? などの書き方の決まりを避けられるので、どれも扱わない
export function isRemotePath(p: string): boolean {
  if (!WINDOWS) return false;
  const normalized = p.replaceAll('/', '\\');
  return normalized.startsWith('\\\\') || normalized.startsWith('\\??\\');
}
