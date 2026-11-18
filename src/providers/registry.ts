import type { AppConfig, ProviderConfig } from '../config/schema.ts';
import { AnthropicAdapter } from './anthropic.ts';
import { OpenAiCompatibleAdapter } from './openai-compatible.ts';
import type { HeldValue } from '../tools/types.ts';
import { providerKeyName, providerSecrets } from './http.ts';
import type { Env, FetchLike, ProviderAdapter } from './types.ts';

export function createAdapter(provider: ProviderConfig, env: Env, fetchImpl?: FetchLike): ProviderAdapter {
  switch (provider.kind) {
    case 'anthropic': return new AnthropicAdapter(provider, env, fetchImpl);
    case 'openai_compatible': return new OpenAiCompatibleAdapter(provider, env, fetchImpl);
  }
}

const HELD_PROVIDER_MIN = 16;

export class ProviderRegistry {
  #adapters = new Map<string, ProviderAdapter>();
  readonly #env: Env;
  readonly #fetch: FetchLike | undefined;
  readonly #override: ((provider: ProviderConfig) => ProviderAdapter | undefined) | undefined;
  constructor(options: { env?: Env; fetch?: FetchLike; override?: (provider: ProviderConfig) => ProviderAdapter | undefined } = {}) {
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch;
    this.#override = options.override;
  }

  reload(config: AppConfig): void {
    this.#adapters = new Map(config.providers.map(p => [p.id, this.#override?.(p) ?? createAdapter(p, this.#env, this.#fetch)]));
  }

  get(providerId: string): ProviderAdapter | undefined { return this.#adapters.get(providerId); }

  // いま環境に入っている API キーの値。ログや実行の記録に書く文から、鍵そのものを伏せるために使う（相手のサーバーが鍵をそのまま返してきても、残さない）
  secrets(): string[] {
    return [...new Set([...this.#adapters.values()].flatMap(a => providerSecrets(a.provider, this.#env)))];
  }

  // 承認の札で印に替える鍵: 16 文字以上の値だけ（lm-studio のような仮の値は普通の語にも当たるので替えない）
  held(): HeldValue[] {
    const held = new Map<string, HeldValue>();
    for (const { provider } of this.#adapters.values()) {
      const name = providerKeyName(provider);
      const value = name ? this.#env[name]?.trim() : undefined;
      if (name && value && value.length >= HELD_PROVIDER_MIN && !held.has(value)) held.set(value, { source: `env ${name}`, value });
    }
    return [...held.values()];
  }
}
