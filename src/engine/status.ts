import { isRuntimeModel, providerModels, type AppConfig, type ModelConfig, type RuntimeModelConfig } from '../config/schema.ts';
import type { KV } from '../db/kv.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { ProbeResult } from '../providers/types.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { RuntimeChecks } from '../runtimes/checks.ts';
import { startBlocked } from '../runtimes/types.ts';
import { providerText } from '../shared/messages/providers.ts';
import { contextAvailable, maxOutputFor, MEMORY_BUDGET_RATIO } from './context-budget.ts';

export const HISTORY_RESERVE = 8192;

// 必要な長さ。記憶の分は、そのモデル自身の「古い発言を削り始める境目」の 12% までしか数えない（会話に入れる記憶の予算が、実行のときもそれ以下になるため）。
// 長さが分からないと予算が決まらず、予算が決まらないと必要な長さが決まらない、という堂々巡りを避けるため、
// 「その長さで足りる」いちばん短い長さを二分探索で求める（長さが増えるほど足りないものは減るので、答えは 1 つに決まる）。
export function requiredContext(model: ModelConfig, baseTokens: number, memoryTokens = 0): number {
  const fixed = baseTokens + HISTORY_RESERVE;
  const needAt = (capacity: number) => {
    const maxOutput = maxOutputFor(model, capacity);
    return fixed + maxOutput + Math.min(memoryTokens, Math.floor(MEMORY_BUDGET_RATIO * Math.max(0, contextAvailable(capacity, maxOutput))));
  };
  let low = 0;
  let high = fixed + maxOutputFor(model, Infinity) + memoryTokens;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (middle >= needAt(middle)) high = middle; else low = middle + 1;
  }
  return high;
}

export interface ModelStatusDeps {
  registry: ProviderRegistry;
  kv: KV;
  baseTokens: (model: ModelConfig) => number;
  memoryTokens?: (() => number) | undefined;
  // 外の実行役の確かめの結果。無ければ、実行役のモデルは「確かめていない」になる
  runtimes?: RuntimeChecks | undefined;
  log?: (line: string) => void;
}

export class ModelStatus {
  #results = new Map<string, ProbeResult>();
  #cooldowns = new Map<string, { until: number; reason: string }>();
  readonly #deps: ModelStatusDeps;
  constructor(deps: ModelStatusDeps) { this.#deps = deps; }

  async probeAll(config: AppConfig): Promise<ProbeResult[]> {
    const memory = this.#deps.memoryTokens?.() ?? 0;
    const language = languageOf(config);
    // 外の実行役を指すモデルは提供元で確かめない（実行役の確かめの結果を、下で状態にする）
    this.#deps.runtimes?.prune(config);
    const results = await Promise.all(providerModels(config).map(async model => {
      const required = requiredContext(model, this.#deps.baseTokens(model), memory);
      const adapter = this.#deps.registry.get(model.provider);
      if (!adapter) {
        return { modelId: model.id, status: 'error', server: '?', required, message: providerText(language, 'probe.no_provider', { id: model.provider }), messageCode: 'provider.probe.no_provider', messageParams: { id: model.provider }, checkedAt: Date.now() } satisfies ProbeResult;
      }
      try { return await adapter.probe(model, required, language); }
      catch (error) {
        const detail = redactSecrets((error as Error).message, this.#deps.registry.secrets());
        return { modelId: model.id, status: 'error', server: adapter.provider.kind, required, message: providerText(language, 'probe.check_failed', { detail }), messageCode: 'provider.probe.check_failed', messageParams: { detail }, checkedAt: Date.now() } satisfies ProbeResult;
      }
    }));
    const runtimeResults = this.#runtimeResults(config);
    this.#results = new Map([...results, ...runtimeResults].map(r => [r.modelId, r]));
    this.#cooldowns.clear();
    for (const r of [...results, ...runtimeResults]) this.#deps.kv.delete(`truncation:${r.modelId}`);
    for (const r of results) {
      if (r.status !== 'ok') this.#deps.log?.(`[ERROR] model ${r.modelId}: ${r.message}${r.hint ? ` / ${r.hint}` : ''}`);
    }
    return [...results, ...runtimeResults];
  }

  // 実行役のモデルの状態だけ作り直す（確かめを押したあと。提供元には触れない）
  refreshRuntimes(config: AppConfig): ProbeResult[] {
    this.#deps.runtimes?.prune(config);
    const fresh = this.#runtimeResults(config);
    const ids = new Set(config.models.filter(isRuntimeModel).map(model => model.id));
    for (const id of [...this.#results.keys()]) if (ids.has(id)) this.#results.delete(id);
    for (const r of fresh) this.#results.set(r.modelId, r);
    return fresh;
  }

  #runtimeResults(config: AppConfig): ProbeResult[] {
    const language = languageOf(config);
    return config.models.filter(isRuntimeModel).map(model => this.#runtimeResult(config, model, language));
  }

  // 実行役のモデルの状態は、その実行役の確かめの結果から決める（モデルの枠は測らない）。使える = 入っていて・ログイン済みで・会話を始められない注意が無い
  #runtimeResult(config: AppConfig, model: RuntimeModelConfig, language: ReturnType<typeof languageOf>): ProbeResult {
    const runtime = config.runtimes?.find(candidate => candidate.id === model.runtime);
    const checked = this.#deps.runtimes?.get(model.runtime);
    const make = (status: ProbeResult['status'], code: 'no_runtime' | 'runtime_off' | 'runtime_unchecked' | 'runtime_missing' | 'runtime_login' | 'runtime_unknown' | 'runtime_blocked' | 'runtime_ok'): ProbeResult => {
      const params = { id: model.runtime };
      const efforts = this.#deps.runtimes?.models(model.runtime)?.find(entry => entry.id === model.model)?.efforts;
      return {
        modelId: model.id, status, server: runtime?.kind ?? '?', required: 0, message: providerText(language, `probe.${code}`, params), messageCode: `provider.probe.${code}`, messageParams: params,
        ...(efforts && efforts.length > 0 ? { efforts: [...efforts] } : {}), checkedAt: checked?.checkedAt ?? Date.now(),
      };
    };
    if (!runtime) return make('error', 'no_runtime');
    if (!runtime.enabled) return make('unreachable', 'runtime_off');
    if (!checked) return make('unreachable', 'runtime_unchecked');
    const { status } = checked;
    if (!status.installed) return make('not_found', 'runtime_missing');
    if (status.auth === 'login_required') return make('error', 'runtime_login');
    if (startBlocked(status)) return make('error', 'runtime_blocked');
    return status.auth === 'ok' ? make('ok', 'runtime_ok') : make('unreachable', 'runtime_unknown');
  }

  get(modelId: string): ProbeResult | undefined { return this.#results.get(modelId); }
  all(): ProbeResult[] { return [...this.#results.values()]; }
  usable(modelId: string): boolean { return this.#results.get(modelId)?.status === 'ok'; }

  limits(model: ModelConfig): { capacity: number; maxOutput: number } {
    const probe = this.#results.get(model.id);
    const capacity = probe?.effective ?? model.contextLength ?? 0;
    return { capacity, maxOutput: maxOutputFor(model, capacity, probe?.maxOutput) };
  }

  cooldown(modelId: string, until: number, reason: string): void { this.#cooldowns.set(modelId, { until, reason }); }
  endCooldown(modelId: string): void { this.#cooldowns.delete(modelId); }
  coolingDown(modelId: string, now = Date.now()): { until: number; reason: string } | undefined {
    const c = this.#cooldowns.get(modelId);
    if (c && c.until <= now) { this.#cooldowns.delete(modelId); return undefined; }
    return c;
  }

  disable(modelId: string, message: string, hint?: string): void {
    const current = this.#results.get(modelId);
    if (!current) return;
    this.#results.set(modelId, { ...current, status: 'error', message, ...(hint === undefined ? {} : { hint }), checkedAt: Date.now() });
    this.#deps.log?.(`[ERROR] model ${modelId}: ${message}`);
  }
}
