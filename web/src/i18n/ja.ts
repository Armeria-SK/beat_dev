import type { ExplainKey } from './explain.ts';
import type { Dict } from './types.ts';

// 説明の文の日本語。鍵は explain.ts の EXPLAIN_KEYS の中だけ。画面の名前（Settings・Pending・Ask など）は英語のまま書く。
export const ja = {
  'ui.set.look.explainDesc': '説明・ヒント・メッセージをこの言語で表示します。メニュー・ボタン・見出しは英語のままです',
  'ui.set.look.reduceDesc': 'オフのときは OS の設定に従います',
  'ui.set.provider.addDesc': 'Anthropic・OpenAI、または OpenAI 互換の URL',
  'ui.set.model.addDesc': 'プロバイダーが知っているモデル名',
  'ui.set.models.checkDesc': '各モデルに context length を問い合わせます',
  'ui.set.models.conversationDesc': '新しい会話で最初に使うモデルです',
  'ui.set.models.judgeDesc': '実行してよいかを判定します。別のプロバイダーのモデルを選ぶと、あなたの最後のメッセージと各操作がそのモデルに送られます',
  'ui.set.models.judgeOffDesc': 'オフ: 判定に回るはずの操作を、確認なしで実行します。拒否される操作は拒否のままです。送信・削除・保護されたファイル・Ask に設定したツールは、コマンドの書き方から beat が見分けられる範囲で、引き続き Pending で止まります',
  'ui.set.models.judgeBackups': (names: string) => `続いてこの順に使います（設定ファイルで指定）: ${names}`,
  'ui.set.models.fallbackDesc': 'モデルにつながらないとき、この順に使います',
  'ui.set.models.backgroundDesc': 'タスクと振り返りが、この順に使います',
  'ui.set.models.scoutDesc': 'Research モードの製品について考え続け、作業を提案します。モデルを選ぶまではオフです',
} satisfies { [K in ExplainKey]?: Dict[K] };
