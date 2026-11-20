import type { ModelConfig } from '../config/schema.ts';
import { SAFETY_MARGIN } from './tokens.ts';

// 古い発言を削り始める境目は、モデルのコンテキストの 95%（から最大出力を引いた量）。
export const CONTEXT_FILL_RATIO = 0.95;
// 会話の最初に固定する system に入れる記憶の量の上限は、そのモデルの「古い発言を削り始める境目」の 12%。
export const MEMORY_BUDGET_RATIO = 0.12;
// 固定する system に入る SOUL.md と USER.md の大きさの目安（超えても保存は止めず、画面で注意を出す）。
export const PERSONA_BUDGET_RATIO = 0.1;

// 道具の結果 1 つが取ってよい量は、そのとき残っている余裕のこの割合。余裕は、モデルの「古い発言を削り始める境目」（available）から、
// 古い発言を外しても残る分（system・道具の仕様・いまのやり取り。fit.ts の irreducibleEstimate）を引いたもの。結果は次のモデル呼び出しに全部積まれ、
// 同じやり取りの中の分は外せない。境目に対する固定の割合（以前は 2 割）だと、固定の分（道具の仕様が増える・日本語の本文）を考えないので、
// 小さなコンテキストでは結果が 3 つ（日本語なら 1 つ）で入りきらなくなる。残りに対する割合なら、結果が積まれるほど次の結果は小さくなり、最低の量に達するまでは入りきる。
// 4 分の 1 は、結果の文字数の上限（16,000 文字）に届くコンテキストの大きさが、以前の固定の 2 割のときとおおよそ同じになるよう、そのときの道具の仕様の量に合わせて決めた値。
// 道具の仕様の量が変わると届く大きさは動くが、結果が入りきる性質（余裕に対する割合であること）は変わらない
export const TOOL_RESULT_RATIO = 0.25;
// タスクの実行を区切る境目: いまのやり取りが、使える量から固定の分（system・道具の仕様）を引いた余裕のこの割合を超えたら、新しい実行で続ける
export const SPLIT_EXCHANGE_RATIO = 0.6;
// 余裕がほとんど無くても、結果にはこれだけは許す（見積もりのトークン。英数字なら約 2,000 文字）
const MIN_TOOL_RESULT_TOKENS = 600;

// 道具の結果 1 つに許す量（見積もりのトークン。estimateTextTokens の単位）。irreducible は、いまのやり取りまで含めた、削れない送信量の見積もり
// （estimateRequest の tokens。補正 factor と安全率を掛けた後の値なので、ここで割り戻して、結果の文字の見積もりと同じ単位にする）
export function toolResultTokens(available: number, irreducible: number, factor = 1): number {
  const room = Math.max(0, available - irreducible);
  return Math.max(MIN_TOOL_RESULT_TOKENS, Math.floor((room * TOOL_RESULT_RATIO) / (factor * SAFETY_MARGIN)));
}

export const AUTO_MAX_OUTPUT = 32_000;
export const MIN_AUTO_OUTPUT = 1_024;

export function maxOutputFor(model: Pick<ModelConfig, 'maxOutputTokens'>, capacity: number, providerMax?: number): number {
  const cap = providerMax ?? Infinity;
  if (model.maxOutputTokens !== undefined) return Math.min(model.maxOutputTokens, cap);
  return Math.min(cap, Math.max(MIN_AUTO_OUTPUT, Math.min(AUTO_MAX_OUTPUT, Math.floor(capacity / 4))));
}

// 考えるだけで返事の上限に達し、文も道具の呼び出しも無かった返事を呼び直すときの上限（planned はふだんの上限 maxOutputFor）。
// planned だけから決まるので、何度呼んでも同じ値になり、上げるのは 1 段だけ。書いた値（maxOutputTokens）は超えない。
// 提供元の上限が分かればそこまで、分からなければ planned の 2 倍。どちらもコンテキストの半分まで。planned より大きくならなければ planned
export function raisedOutputFor(model: Pick<ModelConfig, 'maxOutputTokens'>, capacity: number, planned: number, providerMax?: number): number {
  if (model.maxOutputTokens !== undefined) return planned;
  return Math.max(planned, Math.min(providerMax ?? planned * 2, Math.floor(capacity / 2)));
}

export const contextAvailable = (capacity: number, maxOutput: number): number => Math.floor(capacity * CONTEXT_FILL_RATIO) - maxOutput;

// TE-4: 送る量が available を超えたら、まず古い道具の結果を短い印に替え（モデルを呼ばない）、それでも目標（available のこの割合）を超えるなら古いやり取りを目標まで外して要約する。
// どちらも「どこまで」を会話に覚え、次に超えるまで動かさない（その間、前半はバイト単位で同じ）。0.7 は持ち主の決め（Q3）の出発点で、場面 (C) と実機の数字で 0.6〜0.8 の間で決め直す
export const CONTEXT_TARGET_RATIO = 0.7;
// 消すと決めた時点で、新しい方から残す道具の結果の数
export const KEEP_TOOL_RESULTS = 6;
// 消して減る量がこれ未満なら消さない（消すたびに後ろが書き直しになるので、小さく何度も消さない）
export const clearFloor = (available: number): number => Math.max(2_000, Math.floor(available * 0.1));
