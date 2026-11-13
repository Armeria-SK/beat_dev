// 道具ごとの方針（設定の tools.policies）。画面（web/src）からも読むので、Node の部品は使わない。
//
// 決まり（いちばん大事な点）: 方針は、今の判定に「厳しさを足す」ことしかできない。
//   allow（既定。書かないときもこれ）: 何も足さない。事前の判定・外から読んだ内容のあとの確かめ・実行前フック・振り返りでの禁止は、どれも外れない
//   ask: 毎回、承認を求める（拒否はそのまま拒否。「この会話では許可」では済まない）
//   block: 使わせない（モデルに渡す一覧から外し、パイプラインでも拒否する）
// 段 8b の会話ごとのモード（計画など）は、道具の一覧とパイプラインの二重の拒否を、ここと同じ形（chat.ts の #toolsFor と pipeline.ts の runToolCall）で足す。

export type ToolPolicy = 'allow' | 'ask' | 'block';

export const TOOL_POLICIES: readonly ToolPolicy[] = ['allow', 'ask', 'block'];

// 設定の鍵として書ける道具の名前の形（組み込みの道具はすべてこの形）
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

// 方針を持てない道具: タスクの進め方の道具。止めるとワーカーが終われなくなる。設定に書かれていても無視する
export const POLICYLESS_TOOLS: ReadonlySet<string> = new Set(['task_complete', 'task_checkpoint', 'ask_user']);

export const isPolicyable = (name: string): boolean => !POLICYLESS_TOOLS.has(name);

// 設定に書かないときの方針が allow ではない道具（いまは無い）
export const DEFAULT_POLICIES: Readonly<Record<string, ToolPolicy>> = {};

export const ASK_MEANS_BLOCK: ReadonlySet<string> = new Set(['agent_run']);

export function askReadAsBlock(config: HasPolicies): string[] {
  const policies = config.tools.policies ?? {};
  return Object.keys(policies).filter(name => ASK_MEANS_BLOCK.has(name) && policies[name] === 'ask');
}

export const defaultPolicy = (name: string): ToolPolicy => (Object.hasOwn(DEFAULT_POLICIES, name) ? DEFAULT_POLICIES[name]! : 'allow');

const STRICTNESS: Record<ToolPolicy, number> = { allow: 0, ask: 1, block: 2 };

export const isToolPolicy = (value: unknown): value is ToolPolicy => typeof value === 'string' && Object.hasOwn(STRICTNESS, value);

// どちらか厳しい方
export const stricterPolicy = (a: ToolPolicy, b: ToolPolicy): ToolPolicy => (STRICTNESS[b] > STRICTNESS[a] ? b : a);

// a より b のほうが緩い（広がる）か
export const isLooser = (from: ToolPolicy, to: ToolPolicy): boolean => STRICTNESS[to] < STRICTNESS[from];

export interface HasPolicies { tools: { policies?: Record<string, string> | undefined } }

// 設定に書かれた、その道具の方針。書いていない・読めない値は、その道具の既定（defaultPolicy。ほとんどは allow）。方針を持てない道具は allow
export function toolPolicy(config: HasPolicies, name: string): ToolPolicy {
  const policies = config.tools.policies;
  if (!isPolicyable(name)) return 'allow';
  if (!policies || !Object.hasOwn(policies, name)) return defaultPolicy(name);
  const value = policies[name];
  if (value === 'ask' && ASK_MEANS_BLOCK.has(name)) return 'block';
  return isToolPolicy(value) ? value : defaultPolicy(name);
}

// 実行に効く方針: 実行を始めたときの設定と、いまの設定の厳しい方。途中で厳しくした分はその場から効き、緩めた分は次の実行から。
// パイプライン（runToolCall）と、モデルに渡す道具の一覧（ChatEngine の #toolsFor）が、同じこの決めを使う。started が無ければ（実行の外）、now だけで決める
export const effectivePolicy = (name: string, now: HasPolicies, started?: HasPolicies): ToolPolicy => (started ? stricterPolicy(toolPolicy(now, name), toolPolicy(started, name)) : toolPolicy(now, name));

// 設定に block・ask と書かれているのに、方針を持てない道具のため無視する名前（ログに出す）
export function ignoredPolicyNames(config: HasPolicies): string[] {
  const policies = config.tools.policies ?? {};
  return Object.keys(policies).filter(name => !isPolicyable(name) && policies[name] !== 'allow');
}
