import type { planText } from '../../../../src/shared/messages/plans.ts';
import type { JaTable } from './table.ts';

export const planJa = {
  'changed': "そのあいだに計画が変わりました。読み直して見てください",
  'too_long': "計画が長すぎます（{max} 文字まで）",
  'secret': "計画に秘密の鍵かトークンらしいものが入っています。外してからもう一度保存してください",
  'not_file': "この会話の計画のファイル（製品のフォルダの conversation-plans）が、ふつうのファイルではありません（フォルダかリンク）。ファイルに置き換えてください",
  'writing': "この会話はまだ動いていて、計画を変えるかもしれません。終わってから確かめ済みにしてください",
  'unknown_conversation': "計画は、この製品の会話のものです。計画を書くか Build するには、この製品の会話を開いてください",
  'archived': "この製品はしまってあります。計画を変える前に戻してください",
} satisfies JaTable<typeof planText>;
