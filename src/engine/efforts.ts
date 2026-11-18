import type { ModelConfig } from '../config/schema.ts';
import type { ProbeResult } from '../providers/types.ts';

// そのモデルで選べる考える深さ。プロバイダの種類は問わない（OpenAI 互換は reasoning_effort、Anthropic は output_config.effort に送る）。
// 設定の efforts が先で、無ければ確認で分かった値（OpenAI 互換は supported_reasoning_efforts、Anthropic は Models API の capabilities.effort）。どちらも無ければ空 = 選ばせない・送らない
export function modelEfforts(model: ModelConfig, probe: Pick<ProbeResult, 'efforts'> | undefined): string[] {
  return [...(model.efforts?.length ? model.efforts : probe?.efforts ?? [])];
}
