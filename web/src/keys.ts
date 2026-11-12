// 日本語の変換中のキーは、変換のためのもの。Esc も Enter も、画面の操作として扱わない。
export function isComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return e.isComposing === true || e.keyCode === 229;
}
