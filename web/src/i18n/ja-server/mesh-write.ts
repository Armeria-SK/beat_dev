import type { meshWriteText } from '../../../../src/shared/messages/mesh-write.ts';
import type { JaTable } from './table.ts';

export const meshWriteJa = {
  'file_unusable': "mesh のフォルダの {file} がふつうのファイルではないので、そのままにしています",
  'decision_empty': "決めたことを短い英語の 1 行で渡してください",
  'decision_marks': "決めたことには角かっこを入れられません",
  'decision_too_long': "決めたことが長すぎます（{length} 文字、{max} 文字まで）。短くして、詳しいことはメモに書いてください",
  'decision_closed': "この製品はしまってあるので、決めたことは記録していません",
  'decision_saved': "DECISIONS.md に 1 行足し、AI が記録したものと印を付けました",
  'decision_saved_external': "DECISIONS.md に 1 行足し、AI が記録したものと印を付けました。この実行はほかから文を読んでいるので、その印も付け、Mesh では数えません",
  'decision_saved_old': "DECISIONS.md は持ち主の決めたことでいっぱいなので、この行は DECISIONS-old.md に入れました。mesh_search で見つかります",
  'decision_external_note': "この実行はほかから文を読んでいるので、行にその印を付けました",
  'decision_hidden': "一部が秘密の鍵かトークンらしかったので、伏せました",
} satisfies JaTable<typeof meshWriteText>;
