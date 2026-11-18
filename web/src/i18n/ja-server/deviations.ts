import type { deviationText } from '../../../../src/shared/messages/deviations.ts';
import type { JaTable } from './table.ts';

export const deviationJa = {
  'not_in_task': "deviation_add は製品のタスクの中でだけ使えます",
  'no_items': "この製品にはまだ受け入れの一覧が無いので、item は渡せません。item を外してください",
  'items_unreadable': "この製品の受け入れの一覧が今は読めないので、item を確かめられません。item を外すか、あとでもう一度試してください",
  'bad_item': "今の一覧に受け入れの項目 \"{item}\" はありません。項目: {items}。違いが 1 つの項目の話でなければ、item を外してください",
  'empty': "{field} を短い 1 文で渡してください",
  'too_long': "{field} が長すぎます（{length} 文字、{max} 文字まで）",
  'duplicate': "この違いはもう記録されています（{item}）",
  'full': "deviations.md にはもう {max} 件あります。これ以上記録する前に持ち主に聞いてください",
  'file_unusable': "製品のデータの deviations.md がふつうのファイルではないので、そのままにしています",
  'no_item': "項目なし",
  'saved': "deviations.md に記録しました（{item}）。作業を続けてください",
  'saved_external': "deviations.md に記録しました（{item}）。この実行はほかから文を読んでいるので、その印を付けました。作業を続けてください",
  'saved_hidden': "秘密の鍵かトークンらしい部分は伏せました",
} satisfies JaTable<typeof deviationText>;
