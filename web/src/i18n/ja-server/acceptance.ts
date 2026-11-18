import type { acceptanceText } from '../../../../src/shared/messages/acceptance.ts';
import type { JaTable } from './table.ts';

export const acceptanceJa = {
  'frozen': "受け入れの一覧はもう固定されています（版 {version}）。書き直さず、acceptance_change で変更を提案してください",
  'too_many': "受け入れの一覧の項目は {max} 個まで、やらないことも {max} 個までです",
  'too_many_total': "受け入れの一覧に持てる項目は、外したものも含めて {max} 個までです",
  'too_long': "受け入れの項目が長すぎます（{field}: {max} 文字まで）",
  'bad_command': "確かめのコマンドは制御文字の無い 1 行で、{max} 文字までにしてください",
  'bad_source': "source が {kind} の項目には {fields} が要ります",
  'secret': "受け入れの一覧に秘密の鍵かトークンらしいものが入っています。外してからもう一度書いてください",
  'not_file': "製品のフォルダの acceptance.json（または conversation-plans の中のこの会話の下書き）が、ふつうのファイルではありません（フォルダかリンク）。ファイルに置き換えてください",
  'unknown_conversation': "受け入れの一覧の下書きは、この製品の会話のものです。書くには、この製品の会話を開いてください",
  'archived': "この製品はしまってあります。受け入れの一覧を変える前に戻してください",
  'not_frozen': "受け入れの一覧はまだ固定されていません。下書きは acceptance_write で書いてください",
  'bad_change': "変更が正しくありません: {detail}",
  'no_change': "この製品に、その変更の提案はありません",
  'not_pending': "この変更の提案はもう決まっています（{status}）",
  'stale': "提案の元にした受け入れの一覧が変わりました（今は版 {version}）。今の一覧を見て、もう一度提案してください",
} satisfies JaTable<typeof acceptanceText>;
