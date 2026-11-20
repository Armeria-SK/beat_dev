import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { ValueError } from '@sinclair/typebox/errors';
import { Value } from '@sinclair/typebox/value';
import { configText } from '../shared/messages/config.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { parseAllowEntry } from '../tools/hooks/allow-entry.ts';
import { isEdgeExecutable } from '../shared/browser-path.ts';
import { checkBaseUrl, isSafeOutboundUrl } from '../shared/url.ts';
import { mcpToolName, MCP_NAME_MAX } from '../mcp/names.ts';
import { isSecretEnvName, takenKeyEnvs } from '../shared/provider-key.ts';
import { TOOL_NAME_PATTERN } from '../tools/tool-policy.ts';
import { DEFAULT_PROTECT_FILES } from '../tools/hooks/protect-files.ts';
import { friendlyIssue } from './friendly.ts';
import { dropLegacy } from './legacy.ts';
import { AppConfig, BuiltinHookConfig, CommandHookConfig, HookConfig as HookSchema, MCP_ENV_NAME_PATTERN, MCP_HEADER_NAME_PATTERN, MCP_TOOL_KEY_PATTERN, ToolsConfig as ToolsConfigSchema, type HookConfig, type ModelConfig, type ProviderConfig, type ToolsConfig } from './schema.ts';

const ToolsSchema = ToolsConfigSchema();

// code / params は、形の誤り（パターン・長さ・数の範囲など）の文のコード（config.<キー>）と差し込みの値。画面は、これから画面の言語の文を作る（message はサーバーが書いた文）
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

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    timezone: 'Asia/Tokyo',
    server: { host: '127.0.0.1', port: 4777, origins: [], tailscaleLogins: [] },
    providers: [
      { id: 'anthropic', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 2, timeoutMs: 600_000 },
    ],
    models: [],
    routing: { chat: [], background: [], retriesPerModel: 2 },
    tools: defaultTools(),
    profile: { name: 'beat', shape: 'pebble', color: '#61B8A5', motion: 'auto' },
    ui: { explainLanguage: 'auto' },
    worker: { enabled: true, maxRunsPerHour: 6, maxParallel: 1, curiosityPerDay: 2 },
    memory: { review: true, reviewIdleMinutes: 30 },
    notify: { channels: [], publicBaseUrl: '', limits: { maxChannels: 4, maxSendsPerHour: 30, timeoutMs: 5000, retries: 1, failsBeforeAlert: 3 } },
    mcp: { servers: [], limits: { maxServers: 4, maxToolsPerServer: 32, callTimeoutMs: 60_000, connectTimeoutMs: 15_000, restartsPerHour: 3, resultMaxChars: 15_000 } },
  };
}

export function defaultTools(): ToolsConfig {
  return Value.Default(ToolsSchema, {}) as ToolsConfig;
}

export function resetConfig(current: AppConfig): AppConfig {
  const next = defaultConfig();
  return { ...next, timezone: current.timezone, ui: structuredClone(current.ui), server: structuredClone(current.server), tools: { ...next.tools, roots: structuredClone(current.tools.roots), deny: [...current.tools.deny], hooks: { ...next.tools.hooks, preToolUse: [structuredClone(DEFAULT_PROTECT_FILES)] } } };
}

interface Finding extends ConfigIssue { text: string }

// 内容の問題。path は ID で書いた場所（画面が行に結ぶ）、text は今までどおりの文（場所: 内容）
function findings(config: AppConfig): Finding[] {
  const found: Finding[] = [];
  const add = (path: string, message: string, label = path): void => { found.push({ path, message, text: `${label}: ${message}` }); };
  const providerIds = new Set<string>();
  for (const provider of config.providers) {
    if (providerIds.has(provider.id)) add(`providers.${provider.id}.id`, `ID "${provider.id}" is duplicated`, 'providers');
    providerIds.add(provider.id);
    if (provider.kind === 'openai_compatible' && !provider.baseUrl) add(`providers.${provider.id}.baseUrl`, 'OpenAI-compatible providers need a baseUrl', `providers.${provider.id}`);
    if (provider.baseUrl !== undefined) {
      const checked = checkBaseUrl(provider.baseUrl, Boolean(provider.apiKeyEnv) || provider.kind === 'anthropic');
      if ('problem' in checked) add(`providers.${provider.id}.baseUrl`, checked.problem);
    }
  }
  const modelIds = new Set<string>();
  for (const model of config.models) {
    if (modelIds.has(model.id)) add(`models.${model.id}.id`, `ID "${model.id}" is duplicated`, 'models');
    modelIds.add(model.id);
    const provider = config.providers.find(p => p.id === model.provider);
    if (!provider) { add(`models.${model.id}.provider`, `Provider "${model.provider}" does not exist`, `models.${model.id}`); continue; }
    // 長さが足りないことは保存を止めない（使う前の確認で「使えない」と知らせる）。
    // 起動や保存を拒否すると、メタデータの誤りで全体が止まってしまう
    if (model.contextLength !== undefined && model.maxOutputTokens !== undefined && model.maxOutputTokens >= model.contextLength) {
      add(`models.${model.id}.maxOutputTokens`, 'maxOutputTokens is equal to or larger than the context length', `models.${model.id}`);
    }
  }
  for (const route of ['chat', 'background', 'judge', 'scout', 'research'] as const) {
    for (const id of config.routing[route] ?? []) if (!modelIds.has(id)) add(`routing.${route}`, `Model "${id}" does not exist`);
  }
  config.tools.shell.allow.forEach((entry, i) => {
    if (!parseAllowEntry(entry)) add('tools.shell.allow', `Entry ${i + 1} "${entry}" cannot be written this way. Write only a fixed command (a single statement with no quotes, variables, wildcards, substitutions, redirections or separators)`);
  });
  for (const name of Object.keys(config.tools.policies)) {
    if (!TOOL_NAME_PATTERN.test(name)) add('tools.policies', `"${name}" cannot be used as a tool name (it must start with a lowercase letter and contain only lowercase letters, digits and _, up to 64 characters)`);
  }
  for (const origin of config.server.origins) {
    try { if (new URL(origin).origin !== origin) add('server.origins', `Write "${origin}" as an origin (no trailing / or path)`); }
    catch { add('server.origins', `"${origin}" cannot be read as a URL`); }
  }
  browserFindings(config, add);
  notifyFindings(config, add);
  mcpFindings(config, add);
  return found;
}

// ブラウザの道具（tools.browser）の内容の検査。実行ファイルが在るかは見ない（無ければ道具が「見つからない」を返す。設定の保存は通す）
function browserFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { channel, executablePath, sites } = config.tools.browser;
  if (channel === 'path' && executablePath === '') add('tools.browser.executablePath', 'When channel is path, the location of the browser executable (executablePath) is required');
  if (executablePath !== '' && !isAbsolute(executablePath)) add('tools.browser.executablePath', 'Write the location of the executable as an absolute path');
  if (isEdgeExecutable(executablePath)) add('tools.browser.executablePath', 'Browser control does not work with Microsoft Edge. Specify the executable of Google Chrome or another Chromium-based browser');
  const seen = new Set<string>();
  for (const site of sites) {
    if (seen.has(site)) add('tools.browser.sites', `"${site}" is duplicated`);
    seen.add(site);
  }
}

// 外の送り先（notify）の内容の検査。値の入る環境変数がプロバイダの鍵と重なる設定は断る（鍵を外の送り先へ渡す形を作らせない）
function notifyFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { channels, publicBaseUrl, limits } = config.notify;
  if (channels.length > limits.maxChannels) add('notify.channels', `Up to ${limits.maxChannels} destinations are allowed (there are ${channels.length} now; change this with notify.limits.maxChannels)`);
  if (publicBaseUrl !== '' && !isSafeOutboundUrl(publicBaseUrl)) add('notify.publicBaseUrl', 'Use https, or http on this PC (127.0.0.1 and the like)');
  const providerEnvs = new Set(takenKeyEnvs(config.providers, ''));
  providerEnvs.add('ANTHROPIC_API_KEY');
  const ids = new Set<string>();
  const used = new Map<string, string>();
  for (const channel of channels) {
    if (ids.has(channel.id)) add(`notify.channels.${channel.id}.id`, `ID "${channel.id}" is duplicated`, 'notify.channels');
    ids.add(channel.id);
    const envs: Array<[string, string | undefined]> = [['urlEnv', channel.urlEnv], ['tokenEnv', channel.tokenEnv]];
    for (const [field, name] of envs) {
      if (name === undefined) continue;
      const where = `notify.channels.${channel.id}.${field}`;
      if (providerEnvs.has(name)) add(where, `Environment variable "${name}" is used for a provider key. Use a different name`);
      const other = used.get(name);
      if (other !== undefined) add(where, `Environment variable "${name}" is also used by ${other}. Use a different name for each field`);
      else used.set(name, `${channel.id}.${field}`);
    }
  }
}

// 外の MCP サーバー（mcp）の内容の検査。値の入る環境変数がプロバイダの鍵・通知の欄・ほかの MCP の欄と重なる設定は断る（鍵を外のプログラムへ渡す形を作らせない）
function mcpFindings(config: AppConfig, add: (path: string, message: string, label?: string) => void): void {
  const { servers, limits } = config.mcp;
  if (servers.length > limits.maxServers) add('mcp.servers', `Up to ${limits.maxServers} MCP servers are allowed (there are ${servers.length} now; change this with mcp.limits.maxServers)`);
  const taken = new Map<string, string>();
  for (const name of takenKeyEnvs(config.providers, '')) taken.set(name, 'a provider key');
  taken.set('ANTHROPIC_API_KEY', 'a provider key');
  for (const channel of config.notify.channels) {
    taken.set(channel.urlEnv, `notification destination "${channel.id}"`);
    if (channel.tokenEnv !== undefined) taken.set(channel.tokenEnv, `notification destination "${channel.id}"`);
  }
  const ids = new Set<string>();
  for (const server of servers) {
    const at = `mcp.servers.${server.id}`;
    if (ids.has(server.id)) add(`${at}.id`, `ID "${server.id}" is duplicated`, 'mcp.servers');
    ids.add(server.id);
    const names = Object.keys(server.tools);
    if (names.length > limits.maxToolsPerServer) add(`${at}.tools`, `Up to ${limits.maxToolsPerServer} tools are allowed per server (there are ${names.length} now; change this with mcp.limits.maxToolsPerServer)`);
    // Record のキーの形は、型の検査では見られない（合わないキーは素通りする）ので、ここで確かめる
    for (const tool of names) {
      if (!new RegExp(MCP_TOOL_KEY_PATTERN, 'u').test(tool)) add(`${at}.tools`, `Tool name "${tool.slice(0, 40)}" must use only letters, digits, _, . and -, up to 64 characters (__proto__ / constructor / prototype are not allowed)`);
    }
    for (const name of Object.keys(server.env)) {
      if (!new RegExp(MCP_ENV_NAME_PATTERN, 'u').test(name)) add(`${at}.env`, `Environment variable name "${name.slice(0, 40)}" must use only letters, digits and _, up to 27 characters`);
    }
    for (const name of Object.keys(server.headers)) {
      if (!new RegExp(MCP_HEADER_NAME_PATTERN, 'u').test(name)) add(`${at}.headers`, `Header name "${name.slice(0, 40)}" must use only letters, digits and -, up to 27 characters`);
    }
    const registered = new Map<string, string>();
    for (const tool of names) {
      const name = mcpToolName(server.id, tool);
      if (name.length > MCP_NAME_MAX) add(`${at}.tools.${tool}`, `The registered name of tool "${tool}" is longer than ${MCP_NAME_MAX} characters (shorten the ID, or use a tool with a shorter name)`);
      const other = registered.get(name);
      if (other !== undefined) add(`${at}.tools.${tool}`, `Tool "${tool}" gets the same registered name "${name}" as "${other}"`);
      else registered.set(name, tool);
    }
    const refs: Array<[string, string]> = [];
    if (server.transport === 'stdio') {
      if (server.command === undefined) add(`${at}.command`, 'A program on this PC (stdio) needs a command');
      if (server.cwd !== undefined && !isAbsolute(server.cwd)) add(`${at}.cwd`, 'Write the working folder as an absolute path');
      if (server.url !== undefined) add(`${at}.url`, 'A stdio server cannot have a url');
      if (Object.keys(server.headers).length) add(`${at}.headers`, 'A stdio server cannot have headers');
      for (const [name, variable] of Object.entries(server.env)) refs.push([`${at}.env.${name}`, variable]);
    } else {
      if (server.url === undefined) add(`${at}.url`, 'A URL (http) server needs a url');
      else if (!isSafeOutboundUrl(server.url)) add(`${at}.url`, 'Use https for the URL, or http on this PC (127.0.0.1 and the like) (user:pass@ is not allowed)');
      if (server.command !== undefined) add(`${at}.command`, 'An http server cannot have a command');
      if (server.cwd !== undefined) add(`${at}.cwd`, 'An http server cannot have a cwd');
      if (Object.keys(server.env).length) add(`${at}.env`, 'An http server cannot have env');
      for (const [name, variable] of Object.entries(server.headers)) refs.push([`${at}.headers.${name}`, variable]);
    }
    for (const [where, variable] of refs) {
      // 子や相手に渡せるのは、鍵の名前（KEY・TOKEN・SECRET など）の変数だけ。DATABASE_URL のような、ほかの変数を指せないようにする
      if (!isSecretEnvName(variable)) add(where, `The name of environment variable "${variable}" must contain one of KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL`);
      const other = taken.get(variable);
      if (other !== undefined) add(where, `Environment variable "${variable}" is used by ${other}. Use a different name for each field`);
      else taken.set(variable, `another field of MCP "${server.id}"`);
    }
  }
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

function hookRowErrors(errors: ValueError[]): ValueError[] {
  return errors.flatMap(e => {
    if (e.schema !== HookSchema || typeof e.value !== 'object' || e.value === null) return [e];
    const variant = 'builtin' in e.value ? BuiltinHookConfig : CommandHookConfig;
    const inner = [...Value.Errors(variant, Value.Default(variant, Value.Clone(e.value)))].map(x => ({ ...x, path: `${e.path}${x.path}` }));
    return inner.length ? inner : [e];
  });
}

export function parseConfig(raw: unknown): AppConfig {
  const withDefaults = Value.Default(AppConfig, Value.Clone(dropLegacy(raw).config));
  if (!Value.Check(AppConfig, withDefaults)) {
    // 正規表現や「Expected string to match …」はそのまま見せない。項目ごとの友好的な文（src/shared/messages/config.ts）にする
    const errors = hookRowErrors([...Value.Errors(AppConfig, withDefaults)]).slice(0, 20).map(e => { const friendly = friendlyIssue(e); return { e, friendly, message: friendly ? configText('en', friendly.code, friendly.params) : e.message }; });
    throw new ConfigError('The settings file is not in the right format',
      errors.map(x => `${x.e.path || '/'}: ${x.message}`),
      errors.map(x => ({ path: issuePath(x.e.path, withDefaults), message: x.message, ...(x.friendly ? { code: `config.${x.friendly.code}`, params: x.friendly.params } : {}) })));
  }
  const config = withDefaults as AppConfig;
  const found = findings(config);
  if (found.length) throw new ConfigError('There are problems in the settings', found.map(f => f.text), found.map(({ path, message }) => ({ path, message })));
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

export const JUDGE_OFF_BLOCKED = "routing.judgeMode: the judge cannot be turned off while beat's data folder is beat's own folder or holds it. Start beat with a data folder elsewhere (--data-dir) first";

export class ConfigStore {
  #cache: AppConfig | undefined;
  #stamp = '';
  #lastError: ConfigError | undefined;
  #dropped: readonly string[] = [];
  #rewritten: readonly string[] = [];
  #judgeOffRefused = false;
  #startedOff = false;
  #offBlocked = false;
  readonly #offAllowed: boolean;
  readonly path: string;
  constructor(path: string, options: { judgeOffAllowed?: boolean } = {}) { this.path = path; this.#offAllowed = options.judgeOffAllowed ?? true; }

  get lastError(): ConfigError | undefined { return this.#lastError; }

  get dropped(): readonly string[] { return this.#dropped; }

  get rewritten(): readonly string[] { return this.#rewritten; }

  takeStartedOff(): boolean {
    const started = this.#startedOff;
    this.#startedOff = false;
    return started;
  }

  takeJudgeOffBlocked(): boolean {
    const blocked = this.#offBlocked;
    this.#offBlocked = false;
    return blocked;
  }

  takeJudgeOffRefused(): boolean {
    const refused = this.#judgeOffRefused;
    this.#judgeOffRefused = false;
    return refused;
  }

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
      throw new ConfigError(`The settings file ${this.path} is not valid JSON. It was copied to ${this.path}.bak. Fix it, then start again`);
    }
    const config = parseConfig(raw);
    if (!this.#offAllowed && config.routing.judgeMode === 'off') {
      delete config.routing.judgeMode;
      this.#offBlocked = true;
    }
    if (!this.#cache && config.routing.judgeMode === 'off') this.#startedOff = true;
    if (this.#cache && this.#cache.routing.judgeMode !== 'off' && config.routing.judgeMode === 'off') {
      if (this.#cache.routing.judgeMode === undefined) delete config.routing.judgeMode;
      else config.routing.judgeMode = this.#cache.routing.judgeMode;
      this.#judgeOffRefused = true;
    }
    ({ dropped: this.#dropped, rewritten: this.#rewritten } = dropLegacy(raw));
    this.#cache = config;
    this.#stamp = stamp;
    return structuredClone(config);
  }

  backup(dir: string, now = Date.now()): string {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `${basename(this.path)}.reset-${new Date(now).toISOString().replace(/[:.]/gu, '-')}.bak`);
    copyFileSync(this.path, target, constants.COPYFILE_EXCL);
    return target;
  }

  appendPreToolHook(hook: HookConfig): void {
    const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, any>;
    const tools = (raw.tools ??= {}) as Record<string, any>;
    const hooks = (tools.hooks ??= {}) as Record<string, any>;
    hooks.preToolUse = [...(Array.isArray(hooks.preToolUse) ? hooks.preToolUse : []), hook];
    parseConfig(raw);
    try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
    atomicWriteFile(this.path, `${JSON.stringify(raw, null, 2)}\n`);
    this.#stamp = '';
    this.load();
  }

  save(config: AppConfig): AppConfig {
    const parsed = parseConfig(config);
    if (!this.#offAllowed && parsed.routing.judgeMode === 'off') throw new ConfigError('The settings were not saved', [JUDGE_OFF_BLOCKED]);
    if (existsSync(this.path)) {
      try { copyFileSync(this.path, `${this.path}.bak`); } catch { }
    }
    atomicWriteFile(this.path, `${JSON.stringify(parsed, null, 2)}\n`);
    this.#cache = parsed;
    this.#dropped = [];
    this.#rewritten = [];
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
