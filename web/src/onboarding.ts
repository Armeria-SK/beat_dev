import type { Config } from './settings/model.ts';
import { newAnthropicProvider, uniqueId } from './settings/model.ts';

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

// 入力を設定に反映する。同じモデルをもう一度確かめるとき（modelId）は、その項目を直す。
// 順番（チャット・裏方）が両方空なら、設定のモデル全部と足したモデルを入れる。すでに順番があれば、足したモデルを最後に足す。
export function setupModelConfig(config: Config, form: ModelForm, modelId: string | null): { config: Config; modelId: string } {
  const providers = [...(config.providers as Entry[])];
  const models = [...(config.models as Entry[])];
  const existing = modelId ? models.find(m => m.id === modelId) : undefined;

  let providerId: string;
  if (form.source === 'openai') {
    const fields = {
      kind: 'openai_compatible', baseUrl: form.baseUrl.trim(), server: form.server, maxParallel: 1, timeoutMs: 600_000,
      ...(form.apiKeyEnv.trim() ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}),
    };
    const own = existing ? providers.findIndex(p => p.id === existing.provider && p.kind === 'openai_compatible') : -1;
    const spare = own >= 0 ? -1 : providers.findIndex(p => p.kind === 'openai_compatible' && p.baseUrl === fields.baseUrl && !models.some(m => m.provider === p.id));
    if (own >= 0) {
      const old = providers[own]!;
      providerId = old.id;
      providers[own] = { id: providerId, ...(old.baseUrl === fields.baseUrl && typeof old.apiKeyEnv === 'string' ? { apiKeyEnv: old.apiKeyEnv } : {}), ...fields };
    }
    else if (spare >= 0) { providerId = providers[spare]!.id; providers[spare] = { ...providers[spare]!, ...fields }; }
    else { providerId = uniqueId('local', providers.map(p => p.id)); providers.push({ id: providerId, ...fields }); }
  } else {
    const kind = form.source;
    const found = providers.find(p => p.kind === kind);
    if (found) providerId = found.id;
    else { const made = defaultProvider({ ...config, providers }); providerId = made.id; providers.push(made); }
  }

  const length = Number(form.contextLength);
  const model = {
    id: existing?.id ?? uniqueId(slug(form.model), models.map(m => m.id)),
    label: '', provider: providerId, model: form.model.trim(),
    ...(form.source === 'openai' && form.contextLength.trim() !== '' ? { contextLength: length } : {}),
    vision: false,
  };
  const at = existing ? models.findIndex(m => m.id === existing.id) : -1;
  if (at >= 0) models[at] = { ...existing, ...model }; else models.push(model);

  const routing = config.routing as { chat: string[]; background: string[] };
  const ids = models.map(m => m.id);
  const next = routing.chat.length === 0 && routing.background.length === 0
    ? { ...routing, chat: ids, background: ids }
    : { ...routing, chat: routing.chat.includes(model.id) ? routing.chat : [...routing.chat, model.id], background: routing.background.includes(model.id) ? routing.background : [...routing.background, model.id] };
  return { config: { ...config, providers, models, routing: next }, modelId: model.id };
}

export function setupProviderConfig(config: Config, form: ModelForm): { config: Config; providerId: string } {
  const providers = config.providers as Entry[];
  const url = form.baseUrl.trim();
  const found = form.source === 'openai' ? providers.find(p => p.kind === 'openai_compatible' && p.baseUrl === url) : providers.find(p => p.kind === form.source);
  if (found) return { config, providerId: found.id };
  const made: Entry = form.source === 'openai'
    ? { id: uniqueId('local', providers.map(p => p.id)), kind: 'openai_compatible', baseUrl: url, server: form.server, maxParallel: 1, timeoutMs: 600_000 }
    : defaultProvider(config);
  return { config: { ...config, providers: [...providers, made] }, providerId: made.id };
}

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
