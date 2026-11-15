import { Type, type Static } from '@sinclair/typebox';

export const ProviderKind = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai_compatible'),
]);

export const ServerKind = Type.Union([
  Type.Literal('lmstudio'),
  Type.Literal('llamacpp'),
  Type.Literal('vllm'),
  Type.Literal('tabbyapi'),
  Type.Literal('openrouter'),
  Type.Literal('openai'),
  Type.Literal('generic'),
]);

export const ProviderConfig = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' }),
  kind: ProviderKind,
  baseUrl: Type.Optional(Type.String({ maxLength: 2048 })),
  apiKeyEnv: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' })),
  server: Type.Optional(ServerKind),
  maxParallel: Type.Integer({ minimum: 1, maximum: 8, default: 1 }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 3_600_000, default: 600_000 }),
}, { additionalProperties: false });

export const ModelConfig = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' }),
  label: Type.Optional(Type.String({ maxLength: 80 })),
  provider: Type.String(),
  model: Type.String({ minLength: 1, maxLength: 200 }),
  contextLength: Type.Optional(Type.Integer({ minimum: 1024, maximum: 10_000_000 })),
  minContext: Type.Integer({ minimum: 1024, maximum: 10_000_000, default: 65536 }),
  maxOutputTokens: Type.Integer({ minimum: 256, maximum: 200_000, default: 8192 }),
  maxTools: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
  vision: Type.Boolean({ default: false }),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  // 考える深さとして選べる値（reasoning_effort に送る）。OpenAI 互換のプロバイダのモデルだけで使う。書かなければ、サーバーが supported_reasoning_efforts で知らせた値を使う
  efforts: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$' }), { maxItems: 8 })),
}, { additionalProperties: false });

export const ServerConfig = Type.Object({
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ minimum: 1, maximum: 65535, default: 4777 }),
  origins: Type.Array(Type.String({ maxLength: 300 }), { default: [] }),
  tailscaleLogins: Type.Array(Type.String({ maxLength: 256 }), { default: [] }),
}, { additionalProperties: false });

export const RoutingConfig = Type.Object({
  chat: Type.Array(Type.String(), { default: [] }),
  background: Type.Array(Type.String(), { default: [] }),
  judge: Type.Optional(Type.Array(Type.String())),
  retriesPerModel: Type.Integer({ minimum: 0, maximum: 5, default: 2 }),
}, { additionalProperties: false });

export const AVATAR_SHAPES = [
  'pebble', 'triangle', 'diamond', 'bean', 'cloud', 'droplet', 'heart', 'star', 'crescent', 'capsule',
  'square', 'puddle', 'ghost', 'bunny', 'cat', 'bear', 'mushroom', 'bell', 'peanut', 'comet',
] as const;

export const LANGUAGES = ['en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export const RootConfig = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
}, { additionalProperties: false });

export const CommandHookConfig = Type.Object({
  matcher: Type.String({ minLength: 1, maxLength: 200 }),
  command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  timeoutMs: Type.Integer({ minimum: 100, maximum: 120_000, default: 30_000 }),
  onError: Type.Union([Type.Literal('deny'), Type.Literal('ask')], { default: 'deny' }),
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const ProtectPatterns = Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 200 });

export const BuiltinHookConfig = Type.Object({
  matcher: Type.String({ minLength: 1, maxLength: 200 }),
  builtin: Type.Literal('protect-files'),
  always: ProtectPatterns,
  afterOutside: ProtectPatterns,
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const HookConfig = Type.Union([CommandHookConfig, BuiltinHookConfig]);

// tools.browser.sites の 1 件の書き方（小文字のホスト名。先頭の = は「そのホストだけ」）。画面の文（friendly.ts）も同じ式を使う
export const BROWSER_SITE_PATTERN = '^=?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9-]{2,63}$';

export function ToolsConfig() {
  return Type.Object({
    roots: Type.Array(RootConfig, { default: [{ path: 'workspace', mode: 'write' }] }),
    deny: Type.Array(Type.String({ minLength: 1 }), { default: ['~/.ssh', '~/.aws', '~/.gnupg'] }),
    outsideRoots: Type.Union([Type.Literal('ask'), Type.Literal('deny')], { default: 'ask' }),
    shell: Type.Object({
      enabled: Type.Boolean({ default: true }),
      shell: Type.Union([Type.Literal('auto'), Type.Literal('pwsh'), Type.Literal('powershell'), Type.Literal('bash'), Type.Literal('sh')], { default: 'auto' }),
      timeoutSec: Type.Integer({ minimum: 1, maximum: 3600, default: 120 }),
      maxTimeoutSec: Type.Integer({ minimum: 1, maximum: 3600, default: 600 }),
      outputCapBytes: Type.Integer({ minimum: 1024, maximum: 4 * 1024 * 1024, default: 65536 }),
      allow: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      ask: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      deny: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      envAllow: Type.Array(Type.String(), { default: [] }),
    }, { additionalProperties: false, default: {} }),
    hooks: Type.Object({
      preToolUse: Type.Array(HookConfig, { default: [] }),
      postToolUse: Type.Array(CommandHookConfig, { default: [] }),
    }, { additionalProperties: false, default: {} }),
    web: Type.Object({
      fetch: Type.Boolean({ default: true }),
      search: Type.Union([Type.Literal('duckduckgo'), Type.Literal('off')], { default: 'duckduckgo' }),
      region: Type.String({ default: 'jp-jp', maxLength: 10 }),
      maxSearchesPerHour: Type.Integer({ minimum: 1, maximum: 600, default: 30 }),
    }, { additionalProperties: false, default: {} }),
    // 道具ごとの方針（道具の名前 → allow / ask / block）。今の判定に厳しさを足すだけで、緩める道は無い。書かない道具は allow（src/tools/tool-policy.ts）
    policies: Type.Record(Type.String(), Type.Union([Type.Literal('allow'), Type.Literal('ask'), Type.Literal('block')]), { default: {} }),
    // 子の担当（agent_run）。既定は無効で、無効のあいだは今までと同じ（道具もモデルに渡らない）。深さは 1 で固定（設定にしない）
    agent: Type.Object({
      enabled: Type.Boolean({ default: false }),
      // タスクの実行からも使えるか（既定は会話だけ）
      inTasks: Type.Boolean({ default: false }),
      // 1 回の親の実行で始められる子の数
      maxPerRun: Type.Integer({ minimum: 1, maximum: 5, default: 3 }),
      // 子 1 本の時間の上限（秒）
      timeoutSec: Type.Integer({ minimum: 60, maximum: 3600, default: 600 }),
    }, { additionalProperties: false, default: {} }),
    // ブラウザの道具（browser_open など。src/tools/browser/）。既定は無効で、無効のあいだは今までと同じ（道具もモデルに渡らない）
    browser: Type.Object({
      enabled: Type.Boolean({ default: false }),
      // 使うブラウザ。auto は手元の Chrome。path は executablePath の実行ファイル（Chromium 系。Edge は使わない）
      channel: Type.Union([Type.Literal('auto'), Type.Literal('chrome'), Type.Literal('path')], { default: 'auto' }),
      executablePath: Type.String({ default: '', maxLength: 1024 }),
      headless: Type.Boolean({ default: true }),
      // 操作（クリック・入力）を許すサイト。example.com はサブドメインも、=example.com はそのホストだけ。空なら全部「読むだけ」
      sites: Type.Array(Type.String({ pattern: BROWSER_SITE_PATTERN, maxLength: 254 }), { maxItems: 100, default: [] }),
      limits: Type.Object({
        maxTabs: Type.Integer({ minimum: 1, maximum: 8, default: 3 }),
        navigationTimeoutSec: Type.Integer({ minimum: 5, maximum: 120, default: 30 }),
        actionTimeoutSec: Type.Integer({ minimum: 1, maximum: 60, default: 10 }),
        idleCloseMinutes: Type.Integer({ minimum: 1, maximum: 120, default: 10 }),
        pageChars: Type.Integer({ minimum: 2000, maximum: 100_000, default: 20_000 }),
        maxMbPerMinute: Type.Integer({ minimum: 1, maximum: 500, default: 50 }),
      }, { additionalProperties: false, default: {} }),
    }, { additionalProperties: false, default: {} }),
  }, { additionalProperties: false, default: {} });
}

// 通知の種類（src/notify/notifications.ts の NotificationKind と同じ 7 つ。tests/notify-config.test.ts が一致を確かめる）
export const NOTIFICATION_KINDS = ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'question_new', 'health_alert', 'info'] as const;
export const NotificationKindSchema = Type.Union(NOTIFICATION_KINDS.map(k => Type.Literal(k)));
// 外の送り先へ送る種類の既定（持ち主の手が要るもの）
export const DEFAULT_NOTIFY_KINDS = ['task_waiting', 'task_failed', 'approval_needed', 'health_alert'] as const;

// 外の送り先（webhook）。URL と token は設定に書かず、環境変数の名前（urlEnv・tokenEnv）だけを書く。値は .env に入れる（画面から入れられる）
export const NotifyChannelConfig = Type.Object({
  id: Type.String({ pattern: '^[a-z][a-z0-9-]{0,23}$' }),
  kind: Type.Union([Type.Literal('webhook')]),
  urlEnv: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }),
  tokenEnv: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' })),
  kinds: Type.Array(NotificationKindSchema, { minItems: 1, maxItems: NOTIFICATION_KINDS.length, uniqueItems: true, default: [...DEFAULT_NOTIFY_KINDS] }),
  enabled: Type.Boolean({ default: true }),
  includeBody: Type.Boolean({ default: false }),
}, { additionalProperties: false });

// 固定の歯止め。範囲の外は丸めずに、読み込みで断る（範囲の端が絶対の上限）
export const NotifyConfig = Type.Object({
  channels: Type.Array(NotifyChannelConfig, { default: [], maxItems: 8 }),
  publicBaseUrl: Type.String({ default: '', maxLength: 2048 }),
  limits: Type.Object({
    maxChannels: Type.Integer({ minimum: 1, maximum: 8, default: 4 }),
    maxSendsPerHour: Type.Integer({ minimum: 1, maximum: 120, default: 30 }),
    timeoutMs: Type.Integer({ minimum: 1000, maximum: 15_000, default: 5000 }),
    retries: Type.Integer({ minimum: 0, maximum: 2, default: 1 }),
    failsBeforeAlert: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
  }, { additionalProperties: false, default: {} }),
}, { additionalProperties: false, default: {} });

// 外の MCP サーバー（道具を足す、別のプログラム。F8）。URL と秘密は設定に書かず、環境変数の名前（env・headers の右側）だけを書く。値は .env に入れる（画面から入れられる）。
// 道具の方針（allow / ask / block）は tools.policies の「mcp_<id>_<道具>」で持つ。この設定は、どの道具を登録するか（tools）と、どう確かめるか（effect・sends・removes）だけを持つ
export const MCP_ID_PATTERN = '^[a-z][a-z0-9]{0,15}$';
// __proto__ / constructor / prototype は、オブジェクトの継承と紛れるので使えない
export const MCP_TOOL_KEY_PATTERN = '^(?!(?:__proto__|constructor|prototype)$)[A-Za-z0-9_.-]{1,64}$';
export const MCP_ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]{0,26}$';
export const MCP_HEADER_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9-]{0,26}$';
const ENV_VAR_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';

export const McpToolEntry = Type.Object({
  // 道具の on / off。書かなければ on。設定に名前が無い道具は、登録しない（off と同じ）。
  // （Record の中の値には、TypeBox の既定値が入らないので、既定は読む側が「false でなければ on」と決める）
  enabled: Type.Optional(Type.Boolean()),
  // 持ち主の申告。書かなければ「外へ出る（network）・送りうる」として確かめる
  effect: Type.Optional(Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('network')])),
  sends: Type.Optional(Type.Boolean()),
  removes: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

// 1 つの MCP サーバー。transport ごとに使う項目が違う（stdio: command・cwd・env / http: url・headers）。
// 使わない項目や必須の項目は、形の検査（TypeBox の Union は既定値を入れないため、1 つの形にしている）の後の内容の検査（config/store.ts の mcpFindings）が確かめる
export const McpServerConfig = Type.Object({
  id: Type.String({ pattern: MCP_ID_PATTERN }),
  transport: Type.Union([Type.Literal('stdio'), Type.Literal('http')]),
  enabled: Type.Boolean({ default: true }),
  tools: Type.Record(Type.String({ pattern: MCP_TOOL_KEY_PATTERN }), McpToolEntry, { default: {}, maxProperties: 64 }),
  // stdio: [プログラム, 引数…]。シェルは通さない
  command: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 32 })),
  // stdio: 絶対パスだけ
  cwd: Type.Optional(Type.String({ maxLength: 1024 })),
  // stdio: 子に渡す環境変数（子での名前 → .env の変数名）
  env: Type.Record(Type.String({ pattern: MCP_ENV_NAME_PATTERN }), Type.String({ pattern: ENV_VAR_PATTERN }), { default: {}, maxProperties: 16 }),
  // http: https、またはこの PC（loopback）の http
  url: Type.Optional(Type.String({ maxLength: 500 })),
  // http: 見出し（名前 → .env の変数名）
  headers: Type.Record(Type.String({ pattern: MCP_HEADER_NAME_PATTERN }), Type.String({ pattern: ENV_VAR_PATTERN }), { default: {}, maxProperties: 8 }),
}, { additionalProperties: false });
// 固定の歯止め。範囲の外は丸めずに、読み込みで断る（範囲の端が絶対の上限）
export const McpConfig = Type.Object({
  servers: Type.Array(McpServerConfig, { default: [], maxItems: 8 }),
  limits: Type.Object({
    maxServers: Type.Integer({ minimum: 1, maximum: 8, default: 4 }),
    maxToolsPerServer: Type.Integer({ minimum: 1, maximum: 64, default: 32 }),
    callTimeoutMs: Type.Integer({ minimum: 5000, maximum: 300_000, default: 60_000 }),
    connectTimeoutMs: Type.Integer({ minimum: 2000, maximum: 60_000, default: 15_000 }),
    restartsPerHour: Type.Integer({ minimum: 0, maximum: 10, default: 3 }),
    resultMaxChars: Type.Integer({ minimum: 1000, maximum: 50_000, default: 15_000 }),
  }, { additionalProperties: false, default: {} }),
}, { additionalProperties: false, default: {} });

export const AppConfig = Type.Object({
  $schema: Type.Optional(Type.String()),
  version: Type.Literal(1),
  timezone: Type.String({ default: 'Asia/Tokyo' }),
  server: ServerConfig,
  providers: Type.Array(ProviderConfig, { default: [] }),
  models: Type.Array(ModelConfig, { default: [] }),
  routing: RoutingConfig,
  tools: ToolsConfig(),
  profile: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 40, default: 'beat' }),
    shape: Type.Union(AVATAR_SHAPES.map(s => Type.Literal(s)), { default: 'pebble' }),
    color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$', default: '#61B8A5' }),
    motion: Type.Union([Type.Literal('auto'), Type.Literal('none'), Type.Literal('float'), Type.Literal('sway'), Type.Literal('pulse')], { default: 'auto' }),
  }, { additionalProperties: false, default: {} }),
  worker: Type.Object({
    enabled: Type.Boolean({ default: true }),
    autonomy: Type.Boolean({ default: false }),
    maxRunsPerHour: Type.Integer({ minimum: 1, maximum: 120, default: 6 }),
    maxParallel: Type.Integer({ minimum: 1, maximum: 4, default: 1 }),
    idleMinutes: Type.Integer({ minimum: 0, maximum: 1440, default: 5 }),
    quietStart: Type.String({ default: '', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$|^$' }),
    quietEnd: Type.String({ default: '', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$|^$' }),
    selfTasksNeedApproval: Type.Boolean({ default: false }),
    curiosityPerDay: Type.Integer({ minimum: 0, maximum: 48, default: 2 }),
  }, { additionalProperties: false, default: {} }),
  memory: Type.Object({
    userMaxChars: Type.Optional(Type.Integer()),
    notesMaxChars: Type.Optional(Type.Integer()),
    review: Type.Boolean({ default: true }),
    reviewIdleMinutes: Type.Integer({ minimum: 5, maximum: 1440, default: 30 }),
    reviewAfterToolCalls: Type.Integer({ minimum: 1, maximum: 200, default: 8 }),
  }, { additionalProperties: false, default: {} }),
  notify: NotifyConfig,
  mcp: McpConfig,
  skills: Type.Optional(Type.Object({
    askBeforeRegister: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export type ProviderConfig = Static<typeof ProviderConfig>;
export type ModelConfig = Static<typeof ModelConfig>;
export type AppConfig = Static<typeof AppConfig>;
export type ToolsConfig = Static<ReturnType<typeof ToolsConfig>>;
export type HookConfig = Static<typeof HookConfig>;
export type CommandHookConfig = Static<typeof CommandHookConfig>;
export type BuiltinHookConfig = Static<typeof BuiltinHookConfig>;
export type NotifyChannelConfig = Static<typeof NotifyChannelConfig>;
export type NotifyConfig = Static<typeof NotifyConfig>;
export type McpConfig = Static<typeof McpConfig>;
export type McpServerConfig = Static<typeof McpServerConfig>;
export type McpToolEntry = Static<typeof McpToolEntry>;
