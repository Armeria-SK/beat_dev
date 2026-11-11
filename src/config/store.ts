import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { configText } from '../shared/messages/config.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { parseAllowEntry } from '../tools/hooks/allow-entry.ts';
import { isEdgeExecutable } from '../shared/browser-path.ts';
import { checkBaseUrl, isSafeOutboundUrl } from '../shared/url.ts';
import { mcpToolName, MCP_NAME_MAX } from '../mcp/names.ts';
import { isSecretEnvName, takenKeyEnvs } from '../shared/provider-key.ts';
import { TOOL_NAME_PATTERN } from '../tools/tool-policy.ts';
import { friendlyIssue } from './friendly.ts';
import { dropLegacy } from './legacy.ts';
import { AppConfig, MCP_ENV_NAME_PATTERN, MCP_HEADER_NAME_PATTERN, MCP_TOOL_KEY_PATTERN, ToolsConfig as ToolsConfigSchema, type ModelConfig, type ProviderConfig, type ToolsConfig } from './schema.ts';

const ToolsSchema = ToolsConfigSchema();

// code / params は、形の誤り（パターン・長さ・数の範囲など）の文のコード（config.<キー>）と差し込みの値。画面は、これから画面の言語の文を作る（message は日本語の文）
export interface ConfigIssue { path: string; message: string; code?: string; params?: MessageParams }

// 文（場所: 内容）から場所と内容を取り出す。issues を渡されなかった ConfigError の代わり。場所が無い文は path が空になる
function issueOfText(text: string): ConfigIssue {
  const colon = text.indexOf(': ');
  return colon > 0 ? { path: text.slice(0, colon), message: text.slice(colon + 2) } : { path: '', message: text };
}

export class ConfigError extends Error {
  // problems は文（画面の古い読み取りと CLI 用）、issues は ID で書いた場所つきの同じ問題（同じ順・同じ数）
  readonly problems: readonly string[];
  readonly issues: readonly ConfigIssue[];
  constructor(message: string, problems: readonly string[] = [], issues: readonly ConfigIssue[] = problems.map(issueOfText)) {
    super(problems.length ? `${message}\n- ${problems.join('\n- ')}` : message);
    this.problems = problems;
    this.issues = issues;
  }
}

export const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    timezone: 'Asia/Tokyo',
    server: { host: '127.0.0.1', port: 4777, origins: [], tailscaleLogins: [] },
    providers: [
      { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
      { id: 'ollama', kind: 'ollama', baseUrl: OLLAMA_DEFAULT_URL, maxParallel: 1, timeoutMs: 600_000 },
    ],
    models: [],
    routing: { chat: [], background: [], retriesPerModel: 2 },
    tools: defaultTools(),
    profile: { name: 'Clive', shape: 'pebble', color: '#61B8A5', motion: 'auto' },
    worker: { enabled: true, autonomy: false, maxRunsPerHour: 6, maxParallel: 1, idleMinutes: 5, quietStart: '', quietEnd: '', selfTasksNeedApproval: false, remindAfterHours: 12, curiosityPerDay: 2 },
    memory: { review: true, reviewIdleMinutes: 30, reviewAfterToolCalls: 8 },
    notify: { channels: [], publicBaseUrl: '', limits: { maxChannels: 4, maxSendsPerHour: 30, timeoutMs: 5000, retries: 1, failsBeforeAlert: 3 } },
    mcp: { servers: [], limits: { maxServers: 4, maxToolsPerServer: 32, callTimeoutMs: 60_000, connectTimeoutMs: 15_000, restartsPerHour: 3, resultMaxChars: 15_000 } },
  };
}

export function defaultTools(): ToolsConfig {
  return Value.Default(ToolsSchema, {}) as ToolsConfig;
}

interface Finding extends ConfigIssue { text: string }

// 内容の問題。path は ID で書いた場所（画面が行に結ぶ）、text は今までどおりの文（場所: 内容）
function findings(config: AppConfig): Finding[] {
  const found: Finding[] = [];
  const add = (path: string, message: string, label = path): void => { found.push({ path, message, text: `${label}: ${message}` }); };
  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    if (providerIds.has(provider.id)) add(`providers.${provider.id}.id`, `ID「${provider.id}」が重複しています`, 'providers');
    providerIds.add(provider.id);
    if (provider.kind === 'openai_compatible' && !provider.baseUrl) add(`providers.${provider.id}.baseUrl`, 'OpenAI 互換には baseUrl が必要です', `providers.${provider.id}`);
    if (provider.baseUrl !== undefined) {
      const checked = checkBaseUrl(provider.baseUrl, Boolean(provider.apiKeyEnv));
      if ('problem' in checked) add(`providers.${provider.id}.baseUrl`, checked.problem);
    }
  }
  const modelIds = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) add(`models.${model.id}.id`, `ID「${model.id}」が重複しています`, 'models');
    modelIds.add(model.id);
    const provider = config.providers.find(p => p.id === model.provider);
    if (!provider) { add(`models.${model.id}.provider`, `プロバイダ「${model.provider}」がありません`, `models.${model.id}`); continue; }
    if (provider.kind !== 'anthropic' && model.contextLength === undefined) {
      add(`models.${model.id}.contextLength`, 'ローカル LLM や OpenAI 互換では contextLength が必須です（README の「ローカル LLM のコンテキスト長」を参照）', `models.${model.id}`);
    }
    // contextLength < minContext は保存を止めない（使う前の確認で「使えない」と知らせる）。
    // 起動や保存を拒否すると、メタデータの誤りで全体が止まってしまう
    if (model.contextLength !== undefined && model.maxOutputTokens >= model.contextLength) {
      add(`models.${model.id}.maxOutputTokens`, 'maxOutputTokens がコンテキスト長以上です', `models.${model.id}`);
    }
  }
  for (const route of ['chat', 'background'] as const) {
    for (const id of config.routing[route]) if (!modelIds.has(id)) add(`routing.${route}`, `モデル「${id}」がありません`);
  }
  config.tools.shell.allow.forEach((entry, i) => {
    if (!parseAllowEntry(entry)) add('tools.shell.allow', `${i + 1} 番目の「${entry}」は書けない形です。決まったコマンドだけ（引用符・変数・ワイルドカード・置換・リダイレクト・区切りを含まない、1 つの文）を書いてください`);
  });
  for (const name of Object.keys(config.tools.policies)) {
    if (!TOOL_NAME_PATTERN.test(name)) add('tools.policies', `「${name}」は道具の名前として書けません（英小文字で始まり、英小文字・数字・_ だけ、64 文字まで）`);
  }
  for (const origin of config.server.origins) {
    try { if (new URL(origin).origin !== origin) add('server.origins', `「${origin}」は origin（末尾の / やパスなし）で書いてください`); }
    catch { add('server.origins', `「${origin}」が URL として読めません`); }
  }
  browserFindings(config, add);
  notifyFindings(config, add);
  mcpFindings(config, add);
  return found;
}

// ブラウザの道具（tools.browser）の内容の検査。実行ファイルが在るかは見ない（無ければ道具が「見つからない」を返す。設定の保存は通す）
function browserFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { channel, executablePath, sites } = config.tools.browser;
  if (channel === 'path' && executablePath === '') add('tools.browser.executablePath', 'channel が path のときは、ブラウザの実行ファイルの場所（executablePath）が必要です');
  if (executablePath !== '' && !isAbsolute(executablePath)) add('tools.browser.executablePath', '実行ファイルの場所は絶対パスで書いてください');
  if (isEdgeExecutable(executablePath)) add('tools.browser.executablePath', 'Microsoft Edge ではブラウザの操作をしません。Google Chrome か、ほかの Chromium 系ブラウザの実行ファイルを指定してください');
  const seen = new Set<string>();
  for (const site of sites) {
    if (seen.has(site)) add('tools.browser.sites', `「${site}」が重複しています`);
    seen.add(site);
  }
}

// 外の送り先（notify）の内容の検査。値の入る環境変数がプロバイダの鍵と重なる設定は断る（鍵を外の送り先へ渡す形を作らせない）
function notifyFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { channels, publicBaseUrl, limits } = config.notify;
  if (channels.length > limits.maxChannels) add('notify.channels', `送り先は ${limits.maxChannels} 件までです（今は ${channels.length} 件。notify.limits.maxChannels で変えられます）`);
  if (publicBaseUrl !== '' && !isSafeOutboundUrl(publicBaseUrl)) add('notify.publicBaseUrl', 'https か、この PC の http（127.0.0.1 など）にしてください');
  const providerEnvs = new Set(takenKeyEnvs(config.providers, ''));
  providerEnvs.add('ANTHROPIC_API_KEY');
  const ids = new Set<string>();
  const used = new Map<string, string>();
  for (const channel of channels) {
    if (ids.has(channel.id)) add(`notify.channels.${channel.id}.id`, `ID「${channel.id}」が重複しています`, 'notify.channels');
    ids.add(channel.id);
    const envs: Array<[string, string | undefined]> = [['urlEnv', channel.urlEnv], ['tokenEnv', channel.tokenEnv]];
    for (const [field, name] of envs) {
      if (name === undefined) continue;
      const where = `notify.channels.${channel.id}.${field}`;
      if (providerEnvs.has(name)) add(where, `環境変数「${name}」はプロバイダの鍵に使われています。別の名前にしてください`);
      const other = used.get(name);
      if (other !== undefined) add(where, `環境変数「${name}」は ${other} でも使われています。欄ごとに別の名前にしてください`);
      else used.set(name, `${channel.id}.${field}`);
    }
  }
}

// 外の MCP サーバー（mcp）の内容の検査。値の入る環境変数がプロバイダの鍵・通知の欄・ほかの MCP の欄と重なる設定は断る（鍵を外のプログラムへ渡す形を作らせない）
function mcpFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { servers, limits } = config.mcp;
  if (servers.length > limits.maxServers) add('mcp.servers', `MCP サーバーは ${limits.maxServers} 件までです（今は ${servers.length} 件。mcp.limits.maxServers で変えられます）`);
  const taken = new Map<string, string>();
  for (const name of takenKeyEnvs(config.providers, '')) taken.set(name, 'プロバイダの鍵');
  taken.set('ANTHROPIC_API_KEY', 'プロバイダの鍵');
  for (const channel of config.notify.channels) {
    taken.set(channel.urlEnv, `通知の送り先「${channel.id}」`);
    if (channel.tokenEnv !== undefined) taken.set(channel.tokenEnv, `通知の送り先「${channel.id}」`);
  }
  const ids = new Set<string>();
  for (const server of servers) {
    const at = `mcp.servers.${server.id}`;
    if (ids.has(server.id)) add(`${at}.id`, `ID「${server.id}」が重複しています`, 'mcp.servers');
    ids.add(server.id);
    const names = Object.keys(server.tools);
    if (names.length > limits.maxToolsPerServer) add(`${at}.tools`, `道具は 1 サーバーに ${limits.maxToolsPerServer} 件までです（今は ${names.length} 件。mcp.limits.maxToolsPerServer で変えられます）`);
    // Record のキーの形は、型の検査では見られない（合わないキーは素通りする）ので、ここで確かめる
    for (const tool of names) {
      if (!new RegExp(MCP_TOOL_KEY_PATTERN, 'u').test(tool)) add(`${at}.tools`, `道具の名前「${tool.slice(0, 40)}」は、英数字・_・.・- で 64 文字までにしてください（__proto__ / constructor / prototype は使えません）`);
    }
    for (const name of Object.keys(server.env)) {
      if (!new RegExp(MCP_ENV_NAME_PATTERN, 'u').test(name)) add(`${at}.env`, `環境変数の名前「${name.slice(0, 40)}」は、英数字と _ で 27 文字までにしてください`);
    }
    for (const name of Object.keys(server.headers)) {
      if (!new RegExp(MCP_HEADER_NAME_PATTERN, 'u').test(name)) add(`${at}.headers`, `見出しの名前「${name.slice(0, 40)}」は、英数字と - で 27 文字までにしてください`);
    }
    const registered = new Map<string, string>();
    for (const tool of names) {
      const name = mcpToolName(server.id, tool);
      if (name.length > MCP_NAME_MAX) add(`${at}.tools.${tool}`, `道具「${tool}」は登録名が ${MCP_NAME_MAX} 文字を超えます（ID を短くするか、道具の名前が短いものにしてください）`);
      const other = registered.get(name);
      if (other !== undefined) add(`${at}.tools.${tool}`, `道具「${tool}」は「${other}」と、同じ登録名「${name}」になります`);
      else registered.set(name, tool);
    }
    const refs: Array<[string, string]> = [];
    if (server.transport === 'stdio') {
      if (server.command === undefined) add(`${at}.command`, 'この PC のプログラム（stdio）には command が必要です');
      if (server.cwd !== undefined && !isAbsolute(server.cwd)) add(`${at}.cwd`, '作業フォルダは絶対パスで書いてください');
      if (server.url !== undefined) add(`${at}.url`, 'stdio のサーバーには url を書けません');
      if (Object.keys(server.headers).length) add(`${at}.headers`, 'stdio のサーバーには headers を書けません');
      for (const [name, variable] of Object.entries(server.env)) refs.push([`${at}.env.${name}`, variable]);
    } else {
      if (server.url === undefined) add(`${at}.url`, 'URL（http）には url が必要です');
      else if (!isSafeOutboundUrl(server.url)) add(`${at}.url`, 'URL は https か、この PC の http（127.0.0.1 など）にしてください（user:pass@ は書けません）');
      if (server.command !== undefined) add(`${at}.command`, 'http のサーバーには command を書けません');
      if (server.cwd !== undefined) add(`${at}.cwd`, 'http のサーバーには cwd を書けません');
      if (Object.keys(server.env).length) add(`${at}.env`, 'http のサーバーには env を書けません');
      for (const [name, variable] of Object.entries(server.headers)) refs.push([`${at}.headers.${name}`, variable]);
    }
    for (const [where, variable] of refs) {
      // 子や相手に渡せるのは、鍵の名前（KEY・TOKEN・SECRET など）の変数だけ。DATABASE_URL のような、ほかの変数を指せないようにする
      if (!isSecretEnvName(variable)) add(where, `環境変数「${variable}」は、名前に KEY・TOKEN・SECRET・PASSWORD・CREDENTIAL のどれかを含めてください`);
      const other = taken.get(variable);
      if (other !== undefined) add(where, `環境変数「${variable}」は ${other} に使われています。欄ごとに別の名前にしてください`);
      else taken.set(variable, `MCP「${server.id}」の別の欄`);
    }
  }
}

export function semanticProblems(config: AppConfig): string[] {
  return findings(config).map(f => f.text);
}

// 形式の検査の場所（JSON Pointer。/models/0/contextLength）を、ID で書いた場所（models.<id>.contextLength）に直す。
// 番号が指す項目に id が無いとき、models と providers 以外の一覧は、番号のまま点で結ぶ
function issuePath(pointer: string, raw: unknown): string {
  const segments = pointer.split('/').filter(Boolean).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  const [root, index] = segments;
  if ((root === 'models' || root === 'providers') && index !== undefined && /^\d+$/u.test(index) && typeof raw === 'object' && raw !== null) {
    const list = (raw as Record<string, unknown>)[root];
    const id = Array.isArray(list) ? (list[Number(index)] as { id?: unknown } | null | undefined)?.id : undefined;
    if (typeof id === 'string' && id) segments[1] = id;
  }
  return segments.join('.');
}

export function parseConfig(raw: unknown): AppConfig {
  const withDefaults = Value.Default(AppConfig, Value.Clone(dropLegacy(raw).config));
  if (!Value.Check(AppConfig, withDefaults)) {
    // 正規表現や「Expected string to match …」はそのまま見せない。項目ごとの友好的な文（src/shared/messages/config.ts）にする
    const errors = [...Value.Errors(AppConfig, withDefaults)].slice(0, 20).map(e => { const friendly = friendlyIssue(e); return { e, friendly, message: friendly ? configText('ja', friendly.code, friendly.params) : e.message }; });
    throw new ConfigError('設定ファイルの形式が正しくありません',
      errors.map(x => `${x.e.path || '/'}: ${x.message}`),
      errors.map(x => ({ path: issuePath(x.e.path, withDefaults), message: x.message, ...(x.friendly ? { code: `config.${x.friendly.code}`, params: x.friendly.params } : {}) })));
  }
  const config = withDefaults as AppConfig;
  const found = findings(config);
  if (found.length) throw new ConfigError('設定の内容に問題があります', found.map(f => f.text), found.map(({ path, message }) => ({ path, message })));
  return config;
}

// mode: 作る一時ファイルの権限（POSIX。.env のような秘密のファイルを 0600 にするため）。置き換えたあとのファイルがそのまま持つ
export function atomicWriteFile(path: string, content: string | Uint8Array, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', ...(mode === undefined ? {} : { mode }) });
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, path); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      try { unlinkSync(tmp); } catch { }
      throw error;
    }
  }
}

function fileStamp(path: string): string {
  const s = statSync(path);
  return `${s.mtimeMs}:${s.size}`;
}

export class ConfigStore {
  #cache: AppConfig | undefined;
  #stamp = '';
  #lastError: ConfigError | undefined;
  #dropped: readonly string[] = [];
  readonly path: string;
  constructor(path: string) { this.path = path; }

  get lastError(): ConfigError | undefined { return this.#lastError; }

  get dropped(): readonly string[] { return this.#dropped; }

  current(): AppConfig {
    try {
      const config = this.load();
      this.#lastError = undefined;
      return config;
    } catch (error) {
      if (!(error instanceof ConfigError) || !this.#cache) throw error;
      this.#lastError = error;
      try { this.#stamp = fileStamp(this.path); } catch { }
      return structuredClone(this.#cache);
    }
  }

  load(): AppConfig {
    if (!existsSync(this.path)) {
      const config = defaultConfig();
      this.save(config);
      return structuredClone(config);
    }
    const stamp = fileStamp(this.path);
    if (this.#cache && stamp === this.#stamp) return structuredClone(this.#cache);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, 'utf8')); }
    catch {
      try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
      throw new ConfigError(`設定ファイル ${this.path} が JSON として壊れています。${this.path}.bak に退避しました。直してから起動し直してください`);
    }
    const config = parseConfig(raw);
    this.#dropped = dropLegacy(raw).dropped;
    this.#cache = config;
    this.#stamp = stamp;
    return structuredClone(config);
  }

  save(config: AppConfig): AppConfig {
    const parsed = parseConfig(config);
    if (existsSync(this.path)) {
      try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
    }
    atomicWriteFile(this.path, `${JSON.stringify(parsed, null, 2)}\n`);
    this.#cache = parsed;
    this.#dropped = [];
    this.#stamp = fileStamp(this.path);
    this.#lastError = undefined;
    return structuredClone(parsed);
  }
}

export function findModel(config: AppConfig, id: string): { model: ModelConfig; provider: ProviderConfig } | undefined {
  const model = config.models.find(m => m.id === id);
  const provider = model && config.providers.find(p => p.id === model.provider);
  return model && provider ? { model, provider } : undefined;
}
