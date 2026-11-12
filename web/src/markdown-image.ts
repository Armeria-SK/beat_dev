// 返事の中の画像は読み込まない。代わりに alt と、どこの画像か（ホスト）だけを文字で出す
export function imageHost(src: unknown): string | null {
  if (typeof src !== 'string' || !/^https?:\/\//iu.test(src)) return null;
  try { return new URL(src).host || null; } catch { return null; }
}
