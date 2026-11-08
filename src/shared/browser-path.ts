// ブラウザの実行ファイルの名前の判定。持ち主の決定により、Clive は Edge でブラウザ操作をしない。
// フォルダ名は見ず、ファイル名だけで判定する（Windows の \ も POSIX の / も、大文字小文字も、末尾の空白・.exe も吸収）
const EDGE_NAME = /^(msedge|microsoft[- ]edge)(-(stable|beta|dev|canary))?$/u;

export function isEdgeExecutable(path: string): boolean {
  const name = path.trim().split(/[\\/]+/u).pop() ?? '';
  return EDGE_NAME.test(name.trim().toLowerCase().replace(/\.exe$/u, ''));
}
