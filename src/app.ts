import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig, ProviderConfig } from './config/schema.ts';
import { ConfigStore } from './config/store.ts';
import { Conversations } from './db/conversations.ts';
import { openDatabase } from './db/database.ts';
import { KV } from './db/kv.ts';
import { MIGRATIONS } from './db/migrations.ts';
import { Runs } from './db/runs.ts';
import { RunBus } from './engine/bus.ts';
import { ChatEngine } from './engine/chat.ts';
import { HealthMonitor } from './engine/health.ts';
import { ModelStatus } from './engine/status.ts';
import { estimateTextTokens, estimateToolTokens } from './engine/tokens.ts';
import { buildDynamic, buildSnapshot, ensureWorkspace } from './engine/workspace.ts';
import type { AppPaths } from './paths.ts';
import { languageOf } from './shared/language.ts';
import { engineText } from './shared/messages/engine.ts';
import { taskText } from './shared/messages/tasks.ts';
import { EndpointLimiter } from './providers/limiter.ts';
import { ProviderRegistry } from './providers/registry.ts';
import type { Env, FetchLike, ProviderAdapter } from './providers/types.ts';
import { ApprovalBroker, approvalPublic, approvalShownIn } from './tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from './tools/builtin/files.ts';
import { historyRead, historySearch, memoryForget, memorySave, memorySearch, memoryUpdate } from './tools/builtin/memory.ts';
import { shellRun } from './tools/builtin/shell.ts';
import { askUser, taskCheckpoint, taskComplete, taskCreate, taskList, taskUpdate } from './tools/builtin/tasks.ts';
import { sdkConnect } from './mcp/connect.ts';
import { McpManager, type McpConnect } from './mcp/manager.ts';
import { NotifyChannels } from './notify/channels.ts';
import { Notifications, type Notification, type NotifyEvent } from './notify/notifications.ts';
import { CuriosityStore } from './curiosity/store.ts';
import { ReviewJobs } from './memory/review.ts';
import { curiosityAdd, curiosityList, curiosityUpdate } from './tools/builtin/curiosity.ts';
import { skillDraft, skillView } from './tools/builtin/skills.ts';
import { webFetch, webSearch } from './tools/builtin/web.ts';
import { fileSearch } from './tools/builtin/file-search.ts';
import { calculate, dateCalc } from './tools/builtin/calc.ts';
import { checklistWrite } from './tools/builtin/checklist.ts';
import { notifyOwner } from './tools/builtin/notify.ts';
import { docRead } from './tools/builtin/docs.ts';
import { tableWrite } from './tools/builtin/tables.ts';
import { imageView } from './tools/builtin/image.ts';
import { webDownload } from './tools/builtin/download.ts';
import { BROWSER_TOOLS } from './tools/builtin/browser.ts';
import { BrowserSession } from './tools/browser/session.ts';
import { PlaywrightDriver, type BrowserDriver } from './tools/browser/driver.ts';
import { isBrowserTool } from './tools/browser/names.ts';
import { agentRun } from './tools/builtin/agent.ts';
import type { DownloadNetwork, PageNetwork } from './tools/web/public-page.ts';
import { SearchThrottle } from './tools/web/search.ts';
import { askBeforeRegister, SkillStore } from './tools/skills/store.ts';
import { TaskStore, taskView } from './tasks/store.ts';
import { ProjectStore } from './projects/store.ts';
import { Worker } from './tasks/worker.ts';
import { Uploads } from './uploads/store.ts';
import { ToolRegistry } from './tools/registry.ts';
import { ignoredPolicyNames } from './tools/tool-policy.ts';
import type { ToolDef } from './tools/types.ts';
import { redactSecrets } from './shared/redaction.ts';
import { MemoryStore, renderBooks } from './memory/store.ts';

export function builtinTools(): ToolDef[] {
  return [
    taskComplete, taskCheckpoint, askUser,
    memorySave, historySearch, webSearch, webFetch, fileRead, fileList, fileWrite, fileEdit, shellRun,
    taskCreate, taskList, taskUpdate,
    memoryUpdate, memoryForget, memorySearch, historyRead,
    skillView, skillDraft, curiosityAdd, curiosityList, curiosityUpdate,
    fileSearch, calculate, dateCalc,
    checklistWrite, notifyOwner, docRead, tableWrite,
    imageView, webDownload,
    agentRun,
    ...BROWSER_TOOLS,
  ];
}

export interface AppOptions {
  paths: AppPaths;
  env?: Env;
  fetch?: FetchLike;
  adapterOverride?: (provider: ProviderConfig) => ProviderAdapter | undefined;
  log?: (line: string) => void;
  databasePath?: string;
  tools?: ToolDef[];
  now?: () => number;
  workerTimers?: boolean;
  webNetwork?: PageNetwork;
  downloadNetwork?: DownloadNetwork;
  // 試験用: 子の担当（agent_run）の時間切れ（ミリ秒）。設定 tools.agent.timeoutSec の最小は 60 秒なので、試験だけがこれで縮める。書かなければ設定の値
  agentTimeoutMs?: number;
  // 試験用: 外の MCP サーバーへのつなぎ方（書かなければ SDK でつなぐ）
  mcpConnect?: McpConnect;
  // 試験用: ブラウザの動かし方（書かなければ playwright-core で、手元の Chrome（か path 指定の Chromium 系）を動かす）
  browserDriver?: BrowserDriver;
  // 試験用: ログイン用の窓（見えるブラウザ）を出せる環境か（書かなければ、この計算機の環境から決める）
  browserDisplay?: boolean;
  projectFolderExempt?: readonly string[];
}

export class App {
  readonly paths: AppPaths;
  // 提供元が鍵を読む環境変数（ふだんは process.env）。画面から入れた鍵はここにも入れ、起動し直さなくても効かせる
  readonly env: Record<string, string | undefined>;
  readonly configStore: ConfigStore;
  readonly db: DatabaseSync;
  readonly conversations: Conversations;
  readonly runs: Runs;
  readonly kv: KV;
  readonly registry: ProviderRegistry;
  readonly status: ModelStatus;
  readonly bus: RunBus;
  readonly limiter: EndpointLimiter;
  readonly tools: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly memory: MemoryStore;
  readonly tasks: TaskStore;
  readonly projects: ProjectStore;
  readonly projectFolderExempt: readonly string[];
  readonly notifications: Notifications;
  readonly channels: NotifyChannels;
  readonly mcp: McpManager;
  readonly reviews: ReviewJobs;
  readonly curiosity: CuriosityStore;
  readonly skills: SkillStore;
  readonly uploads: Uploads;
  readonly browser: BrowserSession;
  readonly engine: ChatEngine;
  readonly worker: Worker;
  readonly health: HealthMonitor;
  readonly log: (line: string) => void;
  // いま動いている Web サーバーの設定（起動したとき、または画面から反映したときの値）。設定ファイルの server がこれと違えば、反映が要る
  bootServer: AppConfig['server'];

  constructor(options: AppOptions) {
    this.paths = options.paths;
    this.env = (options.env ?? process.env) as Record<string, string | undefined>;
    this.log = options.log ?? (line => process.stdout.write(`${line}\n`));
    this.configStore = new ConfigStore(this.paths.config);
    const config = this.configStore.load();
    this.#reportDropped();
    ensureWorkspace(this.paths);
    this.bootServer = structuredClone(config.server);
    this.#warnIgnoredPolicies(config);
    this.db = openDatabase(options.databasePath ?? this.paths.database, MIGRATIONS, { backupDir: this.paths.backups });
    const now = options.now ?? Date.now;
    this.conversations = new Conversations(this.db, now, this.log);
    this.runs = new Runs(this.db, now);
    this.kv = new KV(this.db, now);
    const dangling = this.runs.closeDangling(engineText(languageOf(config), 'run.restart_interrupted'));
    if (dangling) this.log(`[INFO] Marked ${dangling} run(s) left unfinished at the last shutdown as interrupted`);
    this.registry = new ProviderRegistry({
      env: this.env,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.adapterOverride ? { override: options.adapterOverride } : {}),
    });
    this.registry.reload(config);
    this.status = new ModelStatus({ registry: this.registry, kv: this.kv, baseTokens: () => this.baseTokens(), memoryTokens: () => this.memoryTokens(), log: this.log });
    this.bus = new RunBus();
    this.limiter = new EndpointLimiter();
    this.tools = new ToolRegistry();
    for (const tool of options.tools ?? builtinTools()) this.tools.register(tool);
    this.approvals = new ApprovalBroker(this.db, event => {
      const v = event.view;
      if (event.type === 'requested') {
        this.bus.publish({ type: 'approval.requested', runId: v.runId, conversationId: approvalShownIn(v), approval: approvalPublic(v) });
        // タスクの実行中は画面を見ていないことが多いので、通知でも知らせる
        const task = this.tasks.byConversation(approvalShownIn(v));
        if (task) {
          this.notifications.notify({ kind: 'approval_needed', title: taskText(languageOf(this.config()), 'notify.approval_needed', { title: task.title }), body: redactSecrets(`${v.title}\n${v.body}`), link: `#/tasks/${task.id}`, dedupKey: `approval:${v.id}`, localOnly: task.local_only === 1 });
        }
      } else {
        this.bus.publish({ type: 'approval.resolved', runId: v.runId, conversationId: approvalShownIn(v), approvalId: v.id, outcome: event.outcome });
        this.notifications.settle('approval_needed', { dedupKey: `approval:${v.id}` });
      }
    });
    this.memory = new MemoryStore(this.db, undefined, () => languageOf(this.config()));
    this.tasks = new TaskStore(this.db, now, () => languageOf(this.config()));
    this.projects = new ProjectStore(this.db, this.paths.projects, now);
    this.projectFolderExempt = [...(options.projectFolderExempt ?? [])];
    this.notifications = new Notifications(this.db, now, this.log);
    this.reviews = new ReviewJobs(this.db, now);
    this.curiosity = new CuriosityStore(this.db, now);
    this.skills = new SkillStore(this.db, join(this.paths.workspace, 'skills'), now, () => languageOf(this.config()), this.log, join(this.paths.backups, 'skills'));
    this.skills.autoRegister = () => !askBeforeRegister(this.config());
    this.#importCuriosity();
    this.#registerExistingSkills();
    this.uploads = new Uploads(this.db, this.paths.uploads, now);
    // ブラウザ 1 つ（全会話で共有）。無効なら何も起動しない。起動は最初の browser_* の呼び出しのとき
    this.browser = new BrowserSession({
      driver: options.browserDriver ?? new PlaywrightDriver(), config: () => this.config(), paths: this.paths, log: this.log,
      notify: input => this.notifications.notify(input), secrets: () => this.registry.secrets(), now,
      ...(options.browserDisplay !== undefined ? { canShowWindow: () => options.browserDisplay === true } : {}),
    });
    // 会話を消したら、その会話のタブを閉じる
    this.conversations.onDeleted = ids => { void this.browser.closeConversation(ids).catch(() => undefined); };
    this.engine = new ChatEngine({
      config: () => this.config(), conversations: this.conversations, runs: this.runs, kv: this.kv,
      registry: this.registry, status: this.status, bus: this.bus, limiter: this.limiter, paths: this.paths,
      tools: { registry: this.tools, approvals: this.approvals }, memory: this.memory, tasks: this.tasks,
      curiosity: this.curiosity, skills: this.skills, log: this.log,
      web: { network: options.webNetwork, download: options.downloadNetwork, throttle: new SearchThrottle(now) },
      notify: input => this.notifications.notify(input),
      mcpCut: (modelId, names) => this.mcp.cut(modelId, names), browser: this.browser,
      ...(options.now ? { now: () => new Date(now()) } : {}),
      ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
    });
    this.worker = new Worker({
      db: this.db, tasks: this.tasks, engine: this.engine, conversations: this.conversations, notifications: this.notifications,
      kv: this.kv, config: () => this.config(), log: this.log, now, autoSchedule: options.workerTimers ?? true,
      reviews: this.reviews, memory: this.memory, curiosity: this.curiosity, memoryBudget: () => this.engine.memoryBudget(),
    });
    this.tasks.onChange = task => {
      this.bus.publish({ type: 'task.changed', task: taskView(task, languageOf(this.config())) });
      // 返事待ち・失敗でなくなったタスクの、返事や確認を求める通知は、もう答えることが無い
      if (task.status !== 'waiting') this.notifications.settle('task_waiting', { link: `#/tasks/${task.id}` });
      if (task.status !== 'failed') this.notifications.settle('task_failed', { link: `#/tasks/${task.id}` });
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        this.curiosity.onTaskFinished(task);
        // 実行したタスクが終わったら振り返る（実行の記録があるものだけ）
        if (task.status !== 'cancelled' && task.conversation_id && this.config().memory.review) {
          this.reviews.enqueue('task', `task:${task.id}`, { taskId: task.id, conversationId: task.conversation_id });
        }
      }
      this.worker.poke();
    };
    this.tasks.onUncancelled = task => this.curiosity.onTaskRestored(task);
    this.tasks.onDeleted = removed => {
      const title = removed.title.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, ' ').replace(/[\\"]/gu, '\\$&');
      this.log(`[INFO] Deleted task "${title}" (${removed.id})`);
      this.bus.publish({ type: 'task.deleted', id: removed.id });
    };
    this.notifications.listen(event => {
      // 画面（SSE）へは、外へ送らない印（noForward）を載せずに流す
      const notification: Notification = { ...event };
      delete (notification as NotifyEvent).noForward;
      this.bus.publish({ type: 'notification', notification });
    });
    // 外の送り先（webhook）へも送る。2 本目の聞き手（待たない。送り先が無ければ何もしない）。外へ送らない通知（noForward）は channels 側で除く
    this.channels = new NotifyChannels({
      config: () => this.config(), env: this.env, fetch: options.fetch, now, log: this.log, kv: this.kv,
      alert: input => { this.notifications.notify(input); },
    });
    this.notifications.listen(event => { void this.channels.deliver(event); });
    // 外の MCP サーバー（start() はふだん main.ts が呼ぶ。呼ぶまでは何もつながない）
    this.mcp = new McpManager({
      config: () => this.config(), env: this.env, tools: this.tools, kv: this.kv, log: this.log,
      notify: input => { this.notifications.notify(input); }, connect: options.mcpConnect ?? sdkConnect, now,
    });
    this.notifications.onSettled = ids => this.bus.publish({ type: 'notification.read', ids, unread: this.notifications.unread() });
    this.health = new HealthMonitor({ status: this.status, runs: this.runs, notifications: this.notifications, now, log: this.log, language: () => languageOf(this.config()) });
    this.bus.subscribe(entry => this.health.observe(entry.event));
    this.skills.onDraft = draft => {
      if (draft.status === 'approved') {
        this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_auto'), body: draft.name, link: `#/skills/${encodeURIComponent(draft.name)}`, dedupKey: `skill-auto:${draft.id}`, localOnly: true, noForward: true });
        return;
      }
      this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_draft', { name: draft.name }), body: draft.reason ?? undefined, link: `#/skills/draft/${encodeURIComponent(draft.name)}`, dedupKey: `skill-draft:${draft.id}`, localOnly: true });
    };
    this.engine.onRunEnd = run => {
      // 道具を多く使った重い会話の後に振り返る
      const config = this.config();
      if (run.kind === 'chat' && config.memory.review) {
        const row = this.runs.get(run.runId);
        if (row && row.ok && row.tool_calls >= config.memory.reviewAfterToolCalls) {
          this.reviews.enqueue('heavy_run', `run:${run.runId}`, { conversationId: run.conversationId });
        }
      }
      this.worker.poke();
    };
  }

  // Web サーバーを起動するときに呼ぶ（動いているサーバーと同じ DB を開くだけの使い方では呼ばない。呼ぶと動いている承認待ちの通知まで既読になる）。
  // もう答えようのない大事な未読を既読にする（片づいたときに既読にする仕組みの前からあった通知と、落ちて承認の札ごと消えた通知）。
  // 起動直後は承認の札がひとつも無いので、承認待ちは全部。返事待ち・失敗は、タスクが無いか、今その状態でないものだけ既読にする
  settleStaleNotifications(): void {
    const stale = this.notifications.list(0).filter(n => {
      if (n.kind === 'approval_needed') return true;
      if (!n.link?.startsWith('#/tasks/')) return false;
      const task = this.tasks.get(n.link.slice('#/tasks/'.length));
      return task === undefined || task.status !== (n.kind === 'task_waiting' ? 'waiting' : 'failed');
    });
    if (stale.length) this.notifications.settleIds(stale.map(n => n.id));
  }

  #applied = '';
  #droppedReported = '';
  #rewrittenReported = '';

  // tools.policies に書かれていても、方針を持てない道具（task_complete など）の分は効かない。気づけるよう 1 行ログに出す
  #warnIgnoredPolicies(config: AppConfig): void {
    for (const name of ignoredPolicyNames(config)) this.log(`[WARN] Ignoring "${name}" in tools.policies: this tool cannot have a policy (it is needed to run tasks)`);
  }

  // 更新の時点で既にあるスキルは、持ち主が置いたものとして全部登録する（1 回だけ。以後に直接置かれたものは、画面で登録するまで使わない）
  #registerExistingSkills(): void {
    this.skills.pruneMissing();
    if (this.kv.get('skills:registry-seeded')) return;
    const added = this.skills.registerExisting();
    this.kv.set('skills:registry-seeded', String(Date.now()));
    if (added) this.log(`[INFO] Registered ${added} existing skill(s) (skills placed directly in the folder from now on are not used until you press "Register" on the screen)`);
  }

  #importCuriosity(): void {
    if (this.kv.get('curiosity:imported')) return;
    const path = join(this.paths.workspace, 'CURIOSITY.md');
    let added = 0;
    try { if (existsSync(path)) added = this.curiosity.importMarkdown(readFileSync(path, 'utf8')); }
    catch (error) { this.log(`[WARN] Could not read CURIOSITY.md: ${(error as Error).message}`); }
    this.kv.set('curiosity:imported', String(Date.now()));
    if (added) this.log(`[INFO] Imported ${added} item(s) from CURIOSITY.md into the curiosity list (from now on, edit them under "Curiosities" on the screen)`);
  }

  config(): AppConfig {
    const config = this.configStore.current();
    const json = JSON.stringify(config);
    if (this.#applied && json !== this.#applied) {
      this.#applied = json;
      this.registry.reload(config);
      void this.browser?.applyConfig(config).catch(() => undefined);
      void this.mcp?.reload().catch(error => this.log(`[ERROR] Failed to reload MCP: ${(error as Error).message}`));
      void this.status.probeAll(config).catch(error => this.log(`[ERROR] Failed to check the models after reloading the settings: ${(error as Error).message}`));
      this.log('[INFO] Loaded the changes to the settings file');
      this.#warnIgnoredPolicies(config);
      this.worker?.poke();
    }
    this.#applied ||= json;
    this.#reportDropped();
    return config;
  }

  #reportDropped(): void {
    const dropped = this.configStore.dropped.join(', ');
    if (dropped && dropped !== this.#droppedReported) this.log(`[INFO] Ignored settings that are no longer used: ${dropped}`);
    this.#droppedReported = dropped;
    const rewritten = this.configStore.rewritten.join(', ');
    if (rewritten && rewritten !== this.#rewrittenReported) this.log(`[INFO] Read old settings in their new form: ${rewritten}`);
    this.#rewrittenReported = rewritten;
  }

  baseTokens(): number {
    const config = this.config();
    // probeAll はコンストラクタの途中（記憶やツールを作る前）からも呼ばれうるので、無ければ 0 として扱う
    const language = languageOf(config);
    // agent_run は設定で有効なときだけモデルに渡る（無効なら数えない。#toolsFor と同じ）
    const tools = this.tools ? estimateToolTokens(ToolRegistry.specs(this.tools.forRun('chat', { exclude: tool => (tool.name === 'agent_run' && !config.tools.agent.enabled) || (isBrowserTool(tool.name) && !config.tools.browser.enabled) }), config)) : 0;
    return estimateTextTokens(buildSnapshot(this.paths, { skills: this.skills?.index(language) ?? '' }, language).text) + tools
      + estimateTextTokens(buildDynamic(config.timezone, language)) + 64;
  }

  // 記憶を全部入れたときの見積もり。必要な長さには、各モデルの available の 12% までだけが数えられる（requiredContext）
  memoryTokens(): number {
    return this.memory ? estimateTextTokens(renderBooks(this.memory.list(), languageOf(this.config()))) : 0;
  }

  // probe: false は、モデルやプロバイダに関わらない変更（道具の方針など）で、モデルの確認の通信をしない
  async applyConfig(next: AppConfig, options: { probe?: boolean } = {}): Promise<AppConfig> {
    const saved = this.configStore.save(next);
    this.#applied = JSON.stringify(saved);
    this.registry.reload(saved);
    void this.browser.applyConfig(saved).catch(() => undefined);
    void this.mcp?.reload().catch(error => this.log(`[ERROR] Failed to reload MCP: ${(error as Error).message}`));
    if (options.probe !== false) await this.status.probeAll(saved);
    this.worker.poke();
    return saved;
  }

  // 画面から反映した server の設定を、「いま動いているもの」として覚える（restartRequired の比べ先）
  markServerApplied(server: AppConfig['server']): void { this.bootServer = structuredClone(server); }

  restartRequired(): boolean {
    return JSON.stringify(this.config().server) !== JSON.stringify(this.bootServer);
  }

  close(): void {
    void this.mcp.stop().catch(() => undefined);
    void this.browser.close().catch(() => undefined);
    this.worker.stop();
    this.engine.saveQueued();
    this.engine.stopAll();
    this.approvals.cancelAll();
    this.db.close();
  }
}
