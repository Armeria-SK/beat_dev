import { deepEqual } from './settings/merge.ts';
import type { Config } from './settings/model.ts';
import { addRuntimeModel, isRuntimeEntry, newAnthropicProvider, uniqueId, updateRuntime } from './settings/model.ts';

// はじめの設定の、画面を使わない部分: 手順・続きの位置・モデルの入力から設定への書き換え。

export type StepId = 'you' | 'identity' | 'style' | 'model' | 'greeting';
export const STEPS: readonly StepId[] = ['you', 'identity', 'style', 'model', 'greeting'];

export interface OnboardingSteps { user: boolean; identity: boolean; persona: boolean; model: boolean }
export interface OnboardingState { done: boolean; steps: OnboardingSteps }

// 左の一覧の「はじめの設定を続ける」から開いたとき、済んでいない最初の手順から始める。
export function resumeStep(steps: OnboardingSteps): StepId {
  if (!steps.user) return 'you';
  if (!steps.identity) return 'identity';
  if (!steps.persona) return 'style';
  if (!steps.model) return 'model';
  return 'greeting';
}

export const SERVER_KINDS = ['generic', 'lmstudio', 'llamacpp', 'tabbyapi', 'vllm', 'openrouter', 'openai'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];
export type ModelSource = 'anthropic' | 'openai';

export interface ModelForm { source: ModelSource; model: string; baseUrl: string; server: ServerKind; contextLength: string; apiKeyEnv: string }

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').replace(/-+$/u, '').slice(0, 40) || 'model';

type Entry = Record<string, unknown> & { id: string };

const defaultProvider = (config: Config): Entry => newAnthropicProvider(config) as Entry;

function reusableSlots(providers: readonly Entry[], models: readonly Entry[], baseUrl: string, existing: Entry | undefined): { own: number; spare: number } {
  const own = existing ? providers.findIndex(p => p.id === existing.provider && p.kind === 'openai_compatible') : -1;
  const spare = own >= 0 ? -1 : providers.findIndex(p => p.kind === 'openai_compatible' && p.baseUrl === baseUrl && !models.some(m => m.provider === p.id));
  return { own, spare };
}

function placeProvider(config: Config, providers: Entry[], models: readonly Entry[], form: ModelForm, existing: Entry | undefined): string {
  if (form.source === 'openai') {
    const fields = {
      kind: 'openai_compatible', baseUrl: form.baseUrl.trim(), server: form.server, maxParallel: 1, timeoutMs: 600_000,
      ...(form.apiKeyEnv.trim() ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}),
    };
    const { own, spare } = reusableSlots(providers, models, fields.baseUrl, existing);
    if (own >= 0) {
      const old = providers[own]!;
      providers[own] = { id: old.id, ...(old.baseUrl === fields.baseUrl && typeof old.apiKeyEnv === 'string' ? { apiKeyEnv: old.apiKeyEnv } : {}), ...fields };
      return old.id;
    }
    if (spare >= 0) { providers[spare] = { ...providers[spare]!, ...fields }; return providers[spare]!.id; }
    const id = uniqueId('local', providers.map(p => p.id));
    providers.push({ id, ...fields });
    return id;
  }
  const found = providers.find(p => p.kind === form.source);
  if (found) return found.id;
  const made = defaultProvider({ ...config, providers });
  providers.push(made);
  return made.id;
}

// 入力を設定に反映する。同じモデルをもう一度確かめるとき（modelId）は、その項目を直す。
// When both lists (chat, background) are empty, or there was no provider model yet, they get every provider model plus the added one (a runtime model may only be first in chat, so it is left out; one left by an abandoned runtime attempt goes too). Otherwise the added model goes last.
export function setupModelConfig(config: Config, form: ModelForm, modelId: string | null): { config: Config; modelId: string } {
  const providers = [...(config.providers as Entry[])];
  const models = [...(config.models as Entry[])];
  const existing = modelId ? models.find(m => m.id === modelId) : undefined;
  const providerId = placeProvider(config, providers, models, form, existing);

  const length = Number(form.contextLength);
  const model = {
    id: existing?.id ?? uniqueId(slug(form.model), models.map(m => m.id)),
    label: '', provider: providerId, model: form.model.trim(),
    ...(form.source === 'openai' && form.contextLength.trim() !== '' ? { contextLength: length } : {}),
    vision: false,
  };
  const at = existing ? models.findIndex(m => m.id === existing.id) : -1;
  const hadProvider = models.some(m => !isRuntimeEntry({ runtime: m.runtime }));
  if (at >= 0) models[at] = { ...existing, ...model }; else models.push(model);

  const routing = config.routing as { chat: string[]; background: string[] };
  const ids = models.filter(m => !isRuntimeEntry({ runtime: m.runtime })).map(m => m.id);
  const next = !hadProvider || (routing.chat.length === 0 && routing.background.length === 0)
    ? { ...routing, chat: ids, background: ids }
    : { ...routing, chat: routing.chat.includes(model.id) ? routing.chat : [...routing.chat, model.id], background: routing.background.includes(model.id) ? routing.background : [...routing.background, model.id] };
  return { config: { ...config, providers, models, routing: next }, modelId: model.id };
}

// 実行役（Claude Code・Codex）を、はじめの設定の「つなぐもの」にする（AR-10）。その種類の実行役を入れ、モデルを 1 つ足す（同じモデルがあれば足さない）。
// 確かめる前の保存（1 回目）: 実行役を入れてモデルを足すだけで、会話の順番には触らない（確かめが通る前に、会話の既定を替えない。提供元のモデルが 1 つも無いときも同じ: 前に通した実行役を順番から外さない。順番に無い実行役のモデルでも、確かめは通る）。
// 確かめが通ったあとの保存（2 回目）は putRuntimeFirst: 「最後に通ったものが会話の既定」
export type RuntimeKindId = 'claude-code' | 'codex';
export const runtimeIdOf = (config: Config, kind: RuntimeKindId): string => ((config.runtimes as Array<{ id: string; kind: string }> | undefined) ?? []).find(item => item.kind === kind)?.id ?? kind;

export function setupRuntimeConfig(config: Config, form: { kind: RuntimeKindId; model: string }): { config: Config; runtimeId: string; modelId: string } {
  const runtimeId = runtimeIdOf(config, form.kind);
  const entry = form.model.trim();
  const turnedOn = updateRuntime(config, { id: runtimeId, kind: form.kind }, { enabled: true });
  const same = (turnedOn.models as Entry[]).find(m => m.runtime === runtimeId && m.model === entry);
  const added = same ? { config: turnedOn, id: same.id } : addRuntimeModel(turnedOn, runtimeId, { id: entry, label: entry, efforts: [] });
  return { config: added.config, runtimeId, modelId: added.id };
}

// 確かめが通った実行役のモデルを、会話の順番の先頭に置く（実行役のモデルは先頭にだけ置ける）。前に通した実行役は外し、提供元のモデルが 1 つも無ければそれだけ、あれば後ろに提供元のモデルを続ける（順番が空だったときは全部）。裏の順番には触らない
export function putRuntimeFirst(config: Config, modelId: string): Config {
  const routing = config.routing as { chat: string[]; background: string[] };
  const models = config.models as Entry[];
  const runtimeIds = new Set(models.filter(m => isRuntimeEntry({ runtime: m.runtime })).map(m => m.id));
  if (!runtimeIds.has(modelId)) return config;
  const own = models.filter(m => !runtimeIds.has(m.id)).map(m => m.id);
  const rest = routing.chat.filter(id => !runtimeIds.has(id));
  const chat = [modelId, ...(own.length === 0 ? [] : rest.length > 0 ? rest : own)];
  return deepEqual(routing.chat, chat) ? config : { ...config, routing: { ...routing, chat } };
}

// 「モデルを読み込む」の前に、モデルの無いまま実行役だけを入れる（読み込みは入れた実行役にしか通らない）
export const turnOnRuntime = (config: Config, kind: RuntimeKindId): Config => updateRuntime(config, { id: runtimeIdOf(config, kind), kind }, { enabled: true });

export function setupProviderConfig(config: Config, form: ModelForm, modelId: string | null = null): { config: Config; providerId: string } {
  const providers = [...(config.providers as Entry[])];
  const models = config.models as Entry[];
  const providerId = placeProvider(config, providers, models, form, modelId ? models.find(m => m.id === modelId) : undefined);
  return deepEqual(providers, config.providers) ? { config, providerId } : { config: { ...config, providers }, providerId };
}

export function plannedProviderId(config: Config, form: ModelForm, modelId: string | null): string | null {
  const providers = config.providers as Entry[];
  if (form.source !== 'openai') return providers.find(p => p.kind === form.source)?.id ?? null;
  const models = config.models as Entry[];
  const { own, spare } = reusableSlots(providers, models, form.baseUrl.trim(), modelId ? models.find(m => m.id === modelId) : undefined);
  return providers[own >= 0 ? own : spare]?.id ?? null;
}

export function dropListed(config: Config, ids: ReadonlySet<string>, keep: string | null): Config {
  const models = config.models as Entry[];
  const providers = config.providers as Entry[];
  const kept = providers.filter(p => !ids.has(p.id) || p.id === keep || models.some(m => m.provider === p.id));
  return kept.length === providers.length ? config : { ...config, providers: kept };
}

export const keyEnvOf = (provider: Record<string, unknown>): string | undefined =>
  typeof provider.apiKeyEnv === 'string' ? provider.apiKeyEnv : provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined;

const SEEN_KEY = 'beat.onboardingSeen';
export function wasSetupShown(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try { return storage?.getItem(SEEN_KEY) === '1'; } catch { return false; }
}
export function markSetupShown(storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try { storage?.setItem(SEEN_KEY, '1'); } catch { }
}
function safeStorage(): Storage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
