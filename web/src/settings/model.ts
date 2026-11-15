import type { PlainKey } from '../i18n/index.ts';
import { getLanguage, type Lang } from '../i18n/state.ts';
import { serverText } from '../server-text.ts';
import { derivedKeyEnv, isSecretEnvName, keyEnvName, takenKeyEnvs } from '../../../src/shared/provider-key.ts';

// 設定の画面の、画面を使わない部分。節の一覧・変更の数え方・保存に失敗したときの問題の読み取り・設定の書き換え。

export type Config = Record<string, any>;

export type SettingsSection = 'models' | 'providers' | 'keys' | 'tools' | 'notify' | 'mcp' | 'browser' | 'worker' | 'memory' | 'about' | 'look' | 'server' | 'file';

export const SECTION_GROUPS: ReadonlyArray<{ label: PlainKey; items: ReadonlyArray<{ id: SettingsSection; label: PlainKey; desc: PlainKey }> }> = [
  { label: 'settings.group.model', items: [
    { id: 'models', label: 'settings.section.models', desc: 'settings.desc.models' },
    { id: 'providers', label: 'settings.section.providers', desc: 'settings.desc.providers' },
    { id: 'keys', label: 'settings.section.keys', desc: 'settings.desc.keys' },
  ] },
  { label: 'settings.group.behavior', items: [
    { id: 'tools', label: 'settings.section.tools', desc: 'settings.desc.tools' },
    { id: 'notify', label: 'settings.section.notify', desc: 'settings.desc.notify' },
  { id: 'mcp', label: 'settings.section.mcp', desc: 'settings.desc.mcp' },
    { id: 'browser', label: 'settings.section.browser', desc: 'settings.desc.browser' },
    { id: 'worker', label: 'settings.section.worker', desc: 'settings.desc.worker' },
    { id: 'memory', label: 'settings.section.memory', desc: 'settings.desc.memory' },
  ] },
  { label: 'settings.group.beat', items: [
    { id: 'about', label: 'settings.section.about', desc: 'settings.desc.about' },
    { id: 'look', label: 'settings.section.look', desc: 'settings.desc.look' },
  ] },
  { label: 'settings.group.system', items: [
    { id: 'server', label: 'settings.section.server', desc: 'settings.desc.server' },
    { id: 'file', label: 'settings.section.file', desc: 'settings.desc.file' },
  ] },
];

export const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const hasIds = (list: unknown[]): list is Array<Record<string, unknown> & { id: string }> => list.every(item => isPlain(item) && typeof item.id === 'string');

// 保存していない変更の数。項目ごとに 1 件。id を持つ一覧（models / providers）は id で突き合わせ、追加・削除は 1 件。
export function countChanges(saved: unknown, draft: unknown): number {
  if (JSON.stringify(saved) === JSON.stringify(draft)) return 0;
  if (isPlain(saved) && isPlain(draft)) {
    let n = 0;
    for (const key of new Set([...Object.keys(saved), ...Object.keys(draft)])) n += countChanges(saved[key], draft[key]);
    return n;
  }
  if (Array.isArray(saved) && Array.isArray(draft) && hasIds(saved) && hasIds(draft)) {
    const before = new Map(saved.map(item => [item.id, item]));
    let n = 0;
    for (const item of draft) n += before.has(item.id) ? countChanges(before.get(item.id), item) : 1;
    for (const item of saved) if (!draft.some(d => d.id === item.id)) n += 1;
    return n;
  }
  return 1;
}

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
export const issueMessage = (issue: ServerIssue, language: Lang = getLanguage()): string => serverText(issue.code, issue.params, language) ?? issue.message;

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
export function problemsOf(body: unknown, fallback: string, config: Config, language: Lang = getLanguage()): Problem[] {
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

export function updateListItem(config: Config, root: 'models' | 'providers', id: string, patch: Record<string, unknown>): Config {
  const full = root === 'providers' && typeof patch.kind === 'string' && !patch.apiKeyEnv ? { ...patch, ...kindPatch(config, id, patch.kind) } : patch;
  return { ...config, [root]: (config[root] as Array<Record<string, unknown>>).map(item => (item.id === id ? pruned({ ...item, ...full }) : item)) };
}

export function uniqueId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

export function addModel(config: Config): { config: Config; id: string } {
  const providers = config.providers as Array<{ id: string }>;
  const id = uniqueId('new-model', (config.models as Array<{ id: string }>).map(m => m.id));
  const model = { id, label: '', provider: providers[0]?.id ?? '', model: '', contextLength: 32768, minContext: 8192, maxOutputTokens: 4096, vision: false };
  const ids = (config.models as Array<{ id: string }>).map(m => m.id);
  const routing = config.routing as { chat: string[]; background: string[] };
  // チャットも裏方も順番が空のときは、サーバーが設定のモデル全部を候補にする。足したモデルが他のモデルを押しのけないよう、今の候補に足した順番にする
  const filled = routing.chat.length === 0 && routing.background.length === 0 ? { ...routing, chat: [...ids, id], background: [...ids, id] } : routing;
  return { config: { ...config, models: [...config.models, model], routing: filled }, id };
}

export function removeModel(config: Config, id: string): Config {
  const routing = config.routing as { chat: string[]; background: string[]; judge?: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).filter(m => m.id !== id),
    routing: { ...routing, chat: routing.chat.filter(m => m !== id), background: routing.background.filter(m => m !== id), ...(routing.judge ? { judge: routing.judge.filter(m => m !== id) } : {}) },
  };
}

export function newAnthropicProvider(config: Config): Record<string, unknown> {
  const providers = providerRows(config);
  const id = uniqueId('anthropic', providers.map(p => p.id));
  const taken = takenKeyEnvs(providers, id);
  const apiKeyEnv = taken.has('ANTHROPIC_API_KEY') ? derivedKeyEnv(id, taken) : 'ANTHROPIC_API_KEY';
  return { id, kind: 'anthropic', apiKeyEnv, maxParallel: 2, timeoutMs: 600_000 };
}

export function kindPatch(config: Config, id: string, kind: string): { kind: string; apiKeyEnv?: string } {
  const providers = providerRows(config);
  const provider = providers.find(p => p.id === id);
  if (kind !== 'anthropic' || !provider || provider.apiKeyEnv) return { kind };
  const taken = takenKeyEnvs(providers, id);
  return taken.has('ANTHROPIC_API_KEY') ? { kind, apiKeyEnv: derivedKeyEnv(id, taken) } : { kind };
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
  const routing = config.routing as { chat: string[]; background: string[]; judge?: string[] };
  return {
    ...config,
    models: (config.models as Array<{ id: string }>).map(m => (m.id === from ? { ...m, id: to } : m)),
    routing: { ...routing, chat: routing.chat.map(swap), background: routing.background.map(swap), ...(routing.judge ? { judge: routing.judge.map(swap) } : {}) },
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
