// ブラウザの実行ファイルの名前の判定。持ち主の決定により、beat は Edge でブラウザ操作をしない。
// フォルダ名は見ず、ファイル名だけで判定する（Windows の \ も POSIX の / も、大文字小文字も、末尾のドット・空白・.exe も吸収）。
// 種類つきの名前は、msedge-beta のようなハイフン区切りも、macOS の "Microsoft Edge Beta" のような空白区切りも Edge とみなす
const EDGE_NAME = /^(msedge|microsoft[- ]edge)([- ](stable|beta|dev|canary))?$/u;
const TAIL = /[.\s]+$/u;

export function isEdgeExecutable(path: string): boolean {
  const name = path.trim().split(/[\\/]+/u).pop() ?? '';
  // Windows は末尾のドット・空白を無視するので、「msedge.exe.」も msedge.exe として動く。先にそれを外してから .exe を外す
  const bare = name.toLowerCase().replace(TAIL, '').replace(/\.exe$/u, '').replace(TAIL, '');
  return EDGE_NAME.test(bare);
}
