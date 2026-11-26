import { getExplainLanguage, type Lang } from '../i18n/state.ts';
import { serverText } from '../server-text.ts';
import { slugId, uniqueSlug } from './ids.ts';
import { derivedKeyEnv, isSecretEnvName, keyEnvName, takenKeyEnvs } from '../../../src/shared/provider-key.ts';

// 設定の画面の、画面を使わない部分。保存に失敗したときの問題の読み取り・設定の書き換え。

export type Config = Record<string, any>;

export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export type SettingsSection = 'models' | 'providers' | 'keys' | 'tools' | 'notify' | 'mcp' | 'browser' | 'worker' | 'memory' | 'about' | 'look' | 'server' | 'file';

export const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const hasIds = (list: unknown[]): list is Array<Record<string, unknown> & { id: string }> => list.every(item => isPlain(item) && typeof item.id === 'string');

export interface Problem {
  text: string;
  path: string;
  message: string;
  section: SettingsSection | null;
  modelId?: string;
  providerId?: string;
}

const SECTION_OF_ROOT: Record<string, SettingsSection> = {
  models: 'models', routing: 'models', providers: 'providers', tools: 'tools', notify: 'notify', mcp: 'mcp', worker: 'worker', memory: 'memory', profile: 'look', server: 'server',
};

// サーバーの問題は文字列で返る。「/models/0/contextLength: Expected…」（形の検査。0 は一覧の位置）か
// 「models.local: …」「providers.x.baseUrl: …」「routing.chat: …」（内容の検査）。読み取れなければ section は null（一覧に出すだけ）。
export function parseProblem(text: string, config: Config): Problem {
  const colon = text.indexOf(': ');
  const rawPath = colon > 0 ? text.slice(0, colon) : '';
  const message = colon > 0 ? text.slice(colon + 2) : text;
  let segments: string[];
  if (rawPath.startsWith('/')) segments = rawPath.split('/').filter(Boolean);
  else segments = rawPath.split('.').filter(Boolean);
  if (rawPath.startsWith('/')) {
    const [root, index] = segments;
    const list = root === 'models' || root === 'providers' ? config[root] : undefined;
    if (Array.isArray(list) && index !== undefined && /^\d+$/u.test(index)) {
      const id = list[Number(index)]?.id;
      if (typeof id === 'string') segments = [root!, id, ...segments.slice(2)];
    }
  }
  const root = segments[0] ?? '';
  const section = root === 'tools' && segments[1] === 'browser' ? 'browser' : SECTION_OF_ROOT[root] ?? null;
  const problem: Problem = { text, path: segments.join('.'), message, section };
  if (root === 'models' && segments[1]) problem.modelId = segments[1];
  if (root === 'providers' && segments[1]) problem.providerId = segments[1];
  return problem;
}

// code / params: 形の誤り（パターン・長さ・数の範囲など）の文のコード（config.<キー>）と差し込みの値。message はサーバーの英語の文
export interface ServerIssue { path: string; message: string; code?: string; params?: Record<string, unknown> }
const isIssue = (value: unknown): value is ServerIssue =>
  isPlain(value) && typeof value.path === 'string' && typeof value.message === 'string';

// 画面の言語の文。コードが表に無い・差し込みの値が足りないときは、サーバーの文のまま
export const issueMessage = (issue: ServerIssue, language: Lang = getExplainLanguage()): string => serverText(issue.code, issue.params, language) ?? issue.message;

// サーバーが ID で書いた場所つきで返した問題（issues）を、そのまま行と節に結ぶ。モデルの ID に点があっても取り違えないよう、設定の ID と突き合わせる
function problemOfIssue(issue: ServerIssue, config: Config, language: Lang): Problem {
  const segments = issue.path.split('.').filter(Boolean);
  const root = segments[0] ?? '';
  const message = issueMessage(issue, language);
  const problem: Problem = { text: issue.path ? `${issue.path}: ${message}` : message, path: issue.path, message, section: SECTION_OF_ROOT[root] ?? null };
  if (root === 'models' || root === 'providers') {
    const list = config[root];
    const ids = Array.isArray(list) ? list.map(item => item?.id).filter((id): id is string => typeof id === 'string').sort((a, b) => b.length - a.length) : [];
    const id = ids.find(candidate => issue.path === `${root}.${candidate}` || issue.path.startsWith(`${root}.${candidate}.`));
    if (id !== undefined) problem[root === 'models' ? 'modelId' : 'providerId'] = id;
  }
  return problem;
}

// 保存を断られたときの応答から、画面に出す問題の一覧を作る。issues があればそれを使い、無い・読めない古い応答は文（problems）を今までの読み取りで読む。
export function problemsOf(body: unknown, fallback: string, config: Config, language: Lang = getExplainLanguage()): Problem[] {
  const record = isPlain(body) ? body : {};
  if (Array.isArray(record.issues) && record.issues.length > 0 && record.issues.every(isIssue)) return record.issues.map(issue => problemOfIssue(issue, config, language));
  const texts = Array.isArray(record.problems) ? record.problems.filter((text): text is string => typeof text === 'string') : [];
  return (texts.length ? texts : [fallback]).map(text => parseProblem(text, config));
}

// ---- 設定の書き換え（元の設定は書き換えず、新しい設定を返す）----

export function updateAt(config: Config, root: string, patch: Record<string, unknown>): Config {
  return { ...config, [root]: { ...(config[root] ?? {}), ...patch } };
}

// 値が undefined（空欄）のキーは、設定から外す。
export function pruned<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

// 鍵の名前が空の Anthropic になる編集（種類を Anthropic に変える・名前の欄を空にする）は、鍵を共有させない。ほかの編集は触らない
function providerPatch(config: Config, id: string, patch: Record<string, unknown>): Record<string, unknown> {
  if (!('apiKeyEnv' in patch)) return typeof patch.kind === 'string' ? { ...patch, ...kindPatch(config, id, patch.kind) } : patch;
  if (patch.apiKeyEnv) return patch;
  const provider = providerRows(config).find(p => p.id === id);
  const apiKeyEnv = provider ? ownKeyEnv(config, id, typeof patch.kind === 'string' ? patch.kind : provider.kind) : undefined;
  return apiKeyEnv ? { ...patch, apiKeyEnv } : patch;
}

export function updateListItem(config: Config, root: 'models' | 'providers', id: string, patch: Record<string, unknown>): Config {
  const full = root === 'providers' ? providerPatch(config, id, patch) : patch;
  return { ...config, [root]: (config[root] as Array<Record<string, unknown>>).map(item => (item.id === id ? pruned({ ...item, ...full }) : item)) };
}

export function uniqueId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

// 外の実行役を指すモデルか（設定の 1 件に runtime があれば）。実行役のモデルは、会話の先頭にだけ置ける
export const isRuntimeEntry = (model: { runtime?: unknown }): boolean => typeof model.runtime === 'string';

export function addModel(config: Config): { config: Config; id: string } {
  const providers = config.providers as Array<{ id: string }>;
  const id = uniqueId('new-model', (config.models as Array<{ id: string }>).map(m => m.id));
  const model = { id, label: '', provider: providers[0]?.id ?? '', model: '', vision: false };
  // 候補を全部入れる形（下）には、提供元のモデルだけを入れる（実行役のモデルは会話の先頭にだけ置ける）
  const ids = (config.models as Array<{ id: string; runtime?: unknown }>).filter(m => !isRuntimeEntry(m)).map(m => m.id);
  const routing = config.routing as { chat: string[]; background: string[] };
  // チャットも裏方も順番が空のときは、サーバーが設定のモデル全部を候補にする。足したモデルが他のモデルを押しのけないよう、今の候補に足した順番にする
  const filled = routing.chat.length === 0 && routing.background.length === 0 ? { ...routing, chat: [...ids, id], background: [...ids, id] } : routing;
  return { config: { ...config, models: [...config.models, model], routing: filled }, id };
}

// 実行役の 1 行（設定の runtimes）を足す・直す。設定にまだ無い種類は、切った状態の 1 行として足してから patch を重ねる
export function updateRuntime(config: Config, runtime: { id: string; kind: string }, patch: Record<string, unknown>): Config {
  const list = (config.runtimes as Array<Record<string, unknown>> | undefined) ?? [];
  const next = list.some(item => item.id === runtime.id)
    ? list.map(item => (item.id === runtime.id ? pruned({ ...item, ...patch }) : item))
    : [...list, pruned({ id: runtime.id, kind: runtime.kind, enabled: false, ...patch })];
  return { ...config, runtimes: next };
}

// 実行役自身の一覧から選んだモデルを、設定のモデルに足す（会話の先頭にするかは、持ち主が役の行で選ぶ）
export function addRuntimeModel(config: Config, runtimeId: string, entry: { id: string; label: string; efforts: readonly string[] }): { config: Config; id: string } {
  const taken = (config.models as Array<{ id: string }>).map(m => m.id);
  const id = uniqueSlug(slugId(`${runtimeId}-${entry.id}`, 'model'), taken, 'model');
  const model = { id, label: entry.label, runtime: runtimeId, model: entry.id, vision: false, ...(entry.efforts.length > 0 ? { efforts: [...entry.efforts] } : {}) };
  return { config: { ...config, models: [...config.models, model] }, id };
}

export function removeModel(config: Config, id: string): Config {
  const routing = config.routing as { chat: string[]; background: string[]; judge?: string[]; scout?: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).filter(m => m.id !== id),
    routing: { ...routing, chat: routing.chat.filter(m => m !== id), background: routing.background.filter(m => m !== id), ...(routing.judge ? { judge: routing.judge.filter(m => m !== id) } : {}), ...(routing.scout ? { scout: routing.scout.filter(m => m !== id) } : {}) },
  };
}

export function newAnthropicProvider(config: Config): Record<string, unknown> {
  const providers = providerRows(config);
  const id = uniqueId('anthropic', providers.map(p => p.id));
  const taken = takenKeyEnvs(providers, id);
  const apiKeyEnv = taken.has('ANTHROPIC_API_KEY') ? derivedKeyEnv(id, taken) : 'ANTHROPIC_API_KEY';
  return { id, kind: 'anthropic', apiKeyEnv, maxParallel: 2, timeoutMs: 600_000 };
}

// 鍵の名前が空の Anthropic は ANTHROPIC_API_KEY を使う。それをほかの提供元がすでに使っているなら、ID から作った名前（鍵を共有しない）。共有にならなければ undefined
function ownKeyEnv(config: Config, id: string, kind: string): string | undefined {
  if (kind !== 'anthropic') return undefined;
  const taken = takenKeyEnvs(providerRows(config), id);
  return taken.has('ANTHROPIC_API_KEY') ? derivedKeyEnv(id, taken) : undefined;
}

export function kindPatch(config: Config, id: string, kind: string): { kind: string; apiKeyEnv?: string } {
  const provider = providerRows(config).find(p => p.id === id);
  if (!provider || provider.apiKeyEnv) return { kind };
  const apiKeyEnv = ownKeyEnv(config, id, kind);
  return apiKeyEnv ? { kind, apiKeyEnv } : { kind };
}

export const providerInUse = (config: Config, id: string): boolean => (config.models as Array<{ provider: string }>).some(m => m.provider === id);

export function removeProvider(config: Config, id: string): Config {
  return { ...config, providers: (config.providers as Array<{ id: string }>).filter(p => p.id !== id) };
}

export const openAfterRename = (open: string | null, from: string, to: string): string | null => (open === from ? to : open);

export const secondsOf = (ms: unknown): number | undefined => (typeof ms === 'number' ? Math.round(ms / 1000) : undefined);

const KEY_ENV = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const isEnvName = (value: string): boolean => KEY_ENV.test(value);

export const keyEnvProblem = (value: string): 'pattern' | 'unsafe' | null => (value === '' ? null : !isEnvName(value) ? 'pattern' : isSecretEnvName(value) ? null : 'unsafe');

export type KeyEnvEdit = { patch: { apiKeyEnv: string | undefined } } | { fail: { key: 'ui.set.provider.envUnsafe' } | { code: 'config.pattern.key_env' } };

export function keyEnvEdit(value: string): KeyEnvEdit {
  const problem = keyEnvProblem(value);
  if (problem === 'unsafe') return { fail: { key: 'ui.set.provider.envUnsafe' } };
  if (problem === 'pattern') return { fail: { code: 'config.pattern.key_env' } };
  return { patch: { apiKeyEnv: value || undefined } };
}

type ProviderRow = { id: string; kind: string; apiKeyEnv?: string };
const providerRows = (config: Config): ProviderRow[] => (Array.isArray(config.providers) ? config.providers as ProviderRow[] : []);

// プロバイダに鍵を入れる環境変数の名前。書かれていればそれ、Anthropic は ANTHROPIC_API_KEY、ほかはサーバーが付ける名前（BEAT_<ID>_API_KEY）
export function providerKeyEnv(config: Config, id: string): string | undefined {
  const providers = providerRows(config);
  const provider = providers.find(p => p.id === id);
  return provider ? keyEnvName(provider, takenKeyEnvs(providers, id)) : undefined;
}

// 鍵の環境変数の名前が、鍵の名前として使えない（KEY・TOKEN・SECRET・PASSWORD・CREDENTIAL を含まない）ときの、その名前。サーバーはこの名前に鍵を書かない（409）ので、画面は鍵の欄を出さない
export function keyEnvUnsafe(config: Config, id: string): string | undefined {
  const name = providerKeyEnv(config, id);
  return name !== undefined && !isSecretEnvName(name) ? name : undefined;
}

// 貼り付けた鍵の前後の空白・改行を取り除く（途中は触らない）
export const trimKey = (raw: string): string => raw.trim();

// ID を付け替える。参照している所（チャット・裏方の順番、モデルのプロバイダ）も合わせる。
export function renameModel(config: Config, from: string, to: string): Config {
  if (!to || from === to) return config;
  const swap = (id: string) => (id === from ? to : id);
  const routing = config.routing as { chat: string[]; background: string[]; judge?: string[]; scout?: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).map(m => (m.id === from ? { ...m, id: to } : m)),
    routing: { ...routing, chat: routing.chat.map(swap), background: routing.background.map(swap), ...(routing.judge ? { judge: routing.judge.map(swap) } : {}), ...(routing.scout ? { scout: routing.scout.map(swap) } : {}) },
  };
}

export function renameProvider(config: Config, from: string, to: string): Config {
  if (!to || from === to) return config;
  return {
    ...config,
    providers: (config.providers as Array<{ id: string }>).map(p => (p.id === from ? { ...p, id: to } : p)),
    models: (config.models as Array<{ provider: string }>).map(m => (m.provider === from ? { ...m, provider: to } : m)),
  };
}
