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
import { ApprovalBroker } from './tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from './tools/builtin/files.ts';
import { memoryFileTools } from './tools/builtin/memory-files.ts';
import { ProductMemory } from './memory/files.ts';
import { historyRead, historySearch, MEMORY_TOOL_NAMES, memoryForget, memorySave, memorySearch, memoryUpdate } from './tools/builtin/memory.ts';
import { droppedGitEnv, shellRun } from './tools/builtin/shell.ts';
import { shellOutput, shellStop } from './tools/builtin/shell-bg.ts';
import { BackgroundJobs, type JobOwner } from './tools/shell/background.ts';
import { planWrite } from './tools/builtin/plan.ts';
import { acceptanceChange, acceptanceWrite } from './tools/builtin/acceptance.ts';
import { meshRead, meshSearch, meshStateSet } from './tools/builtin/mesh.ts';
import { meshDecisionAdd } from './tools/builtin/mesh-write.ts';
import { questionAdd, questionList } from './tools/builtin/questions.ts';
import { deviationAdd } from './tools/builtin/deviations.ts';
import { taskCheckpoint, taskComplete, taskCreate, taskList, taskUpdate } from './tools/builtin/tasks.ts';
import { sdkConnect } from './mcp/connect.ts';
import { McpManager, type McpConnect } from './mcp/manager.ts';
import { NotifyChannels } from './notify/channels.ts';
import { Notifications, type Notification, type NotifyEvent } from './notify/notifications.ts';
import { CuriosityStore } from './curiosity/store.ts';
import { ReviewJobs, reviewWindowLimits } from './memory/review.ts';
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
import { FolderDialog, type FolderDialogOptions } from './projects/folder-dialog.ts';
import { PlaywrightDriver, type BrowserDriver } from './tools/browser/driver.ts';
import { isBrowserTool } from './tools/browser/names.ts';
import { agentRun } from './tools/builtin/agent.ts';
import { ledgerRecord } from './tools/builtin/ledger.ts';
import { proposalAdd } from './tools/builtin/proposal.ts';
import { scoutState } from './scout/run.ts';
import { deferredSection, toolSearch } from './tools/builtin/tool-search.ts';
import { DEFAULT_PROTECT_FILES, hasProtectFiles, PROTECT_FILES_OFFERED } from './tools/hooks/protect-files.ts';
import type { DownloadNetwork, PageNetwork } from './tools/web/public-page.ts';
import { SearchThrottle } from './tools/web/search.ts';
import { askBeforeRegister, growSkills, SkillStore } from './tools/skills/store.ts';
import { isScoutRun, TaskStore } from './tasks/store.ts';
import { maskedTaskView } from './web/task-view.ts';
import { ProjectStore } from './projects/store.ts';
import { PlanStore } from './projects/plan.ts';
import { adoptLegacyPlans } from './projects/plan-adopt.ts';
import { setGitNotice } from './mesh/folders.ts';
import { Mesh } from './mesh/index.ts';
import { AcceptanceStore } from './projects/acceptance.ts';
import { Worker } from './tasks/worker.ts';
import { pendingDecided, sweepPendingWaits, type PendingWakeDeps } from './tasks/pending-wake.ts';
import { QuestionStore, type QuestionChange, type QuestionRow } from './questions/store.ts';
import { Uploads } from './uploads/store.ts';
import { PendingStore, type PendingChange, type PendingRow } from './pending/store.ts';
import { pendingNote } from './pending/notes.ts';
import { parentOf, replayAction } from './pending/replay.ts';
import { pendingText } from './shared/messages/pending.ts';
import { notifyText } from './shared/messages/notify.ts';
import { BLOCKING_QUESTION_KEY } from './shared/notification-list.ts';
import { isCore, ToolRegistry } from './tools/registry.ts';
import { askReadAsBlock, ignoredPolicyNames } from './tools/tool-policy.ts';
import { dataHoldsInstall } from './tools/policy.ts';
import type { ToolDef } from './tools/types.ts';
import type { JudgeLimitSet } from './tools/pipeline.ts';
import { redactSecrets } from './shared/redaction.ts';
import { MemoryStore, renderBooks } from './memory/store.ts';

export function builtinTools(): ToolDef[] {
  return [
    taskComplete, taskCheckpoint, questionAdd, toolSearch,
    memorySave, historySearch, webSearch, webFetch, fileRead, fileList, fileWrite, fileEdit, shellRun, shellOutput, shellStop,
    planWrite, acceptanceWrite, acceptanceChange, meshSearch, meshRead, meshStateSet,
    taskCreate, taskList, taskUpdate,
    memoryUpdate, memoryForget, memorySearch, historyRead,
    skillView, skillDraft, curiosityAdd, curiosityList, curiosityUpdate,
    fileSearch, calculate, dateCalc,
    checklistWrite, notifyOwner, docRead, tableWrite,
    imageView, webDownload,
    agentRun,
    questionList, deviationAdd, meshDecisionAdd,
    ledgerRecord, proposalAdd,
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
  judgeLimits?: JudgeLimitSet;
  // 試験用: 外の MCP サーバーへのつなぎ方（書かなければ SDK でつなぐ）
  mcpConnect?: McpConnect;
  // 試験用: ブラウザの動かし方（書かなければ playwright-core で、手元の Chrome（か path 指定の Chromium 系）を動かす）
  browserDriver?: BrowserDriver;
  // 試験用: ログイン用の窓（見えるブラウザ）を出せる環境か（書かなければ、この計算機の環境から決める）
  browserDisplay?: boolean;
  projectFolderExempt?: readonly string[];
  botMemory?: boolean;
  folderDialog?: FolderDialogOptions;
}

export class App {
  readonly paths: AppPaths;
  // 提供元が鍵を読む環境変数（ふだんは process.env）。画面から入れた鍵はここにも入れ、起動し直さなくても効かせる
  readonly env: Record<string, string | undefined>;
  readonly fetch: FetchLike;
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
  readonly pending: PendingStore;
  readonly #replayStop = new AbortController();
  readonly #gitNoticeOff: () => void;
  readonly memory: MemoryStore;
  readonly tasks: TaskStore;
  readonly projects: ProjectStore;
  readonly plans: PlanStore;
  readonly acceptance: AcceptanceStore;
  readonly questions: QuestionStore;
  readonly now: () => number;
  readonly mesh: Mesh;
  readonly memoryFiles: ProductMemory;
  readonly projectFolderExempt: readonly string[];
  readonly botMemory: boolean;
  readonly notifications: Notifications;
  readonly channels: NotifyChannels;
  readonly mcp: McpManager;
  readonly reviews: ReviewJobs;
  readonly curiosity: CuriosityStore;
  readonly skills: SkillStore;
  readonly uploads: Uploads;
  readonly browser: BrowserSession;
  readonly background: BackgroundJobs;
  readonly folderDialog: FolderDialog;
  readonly engine: ChatEngine;
  readonly worker: Worker;
  readonly health: HealthMonitor;
  readonly log: (line: string) => void;
  // いま動いている Web サーバーの設定（起動したとき、または画面から反映したときの値）。設定ファイルの server がこれと違えば、反映が要る
  bootServer: AppConfig['server'];

  constructor(options: AppOptions) {
    this.paths = options.paths;
    this.env = (options.env ?? process.env) as Record<string, string | undefined>;
    this.fetch = options.fetch ?? fetch;
    this.log = options.log ?? (line => process.stdout.write(`${line}\n`));
    this.#gitNoticeOff = setGitNotice(this.log);
    this.configStore = new ConfigStore(this.paths.config, { judgeOffAllowed: !dataHoldsInstall(this.paths) });
    const config = this.configStore.load();
    this.#reportDropped();
    ensureWorkspace(this.paths);
    this.bootServer = structuredClone(config.server);
    this.#warnIgnoredPolicies(config);
    this.db = openDatabase(options.databasePath ?? this.paths.database, MIGRATIONS, { backupDir: this.paths.backups });
    const now = options.now ?? Date.now;
    this.now = now;
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
    this.botMemory = options.botMemory === true;
    this.status = new ModelStatus({ registry: this.registry, kv: this.kv, baseTokens: () => this.baseTokens(), memoryTokens: () => this.memoryTokens(), log: this.log });
    this.bus = new RunBus();
    this.limiter = new EndpointLimiter();
    this.tools = new ToolRegistry();
    for (const tool of options.tools ?? builtinTools()) if (this.botMemory || !MEMORY_TOOL_NAMES.includes(tool.name)) this.tools.register(tool);
    if (!this.botMemory && !options.tools) for (const tool of memoryFileTools) this.tools.register(tool);
    this.approvals = new ApprovalBroker(this.db);
    this.pending = new PendingStore(this.db, { tools: this.tools, dataDir: this.paths.data, now, onChange: change => { this.bus.publish({ type: 'pendingAction.changed', ...change }); this.#pendingChanged(change.id); this.#pendingWake(change); } });
    const interrupted = this.pending.closeInterrupted();
    if (interrupted) this.log(`[INFO] Marked ${interrupted} pending item(s) that were running at the last shutdown as failed`);
    this.memory = new MemoryStore(this.db, undefined, () => languageOf(this.config()));
    this.tasks = new TaskStore(this.db, now, () => languageOf(this.config()));
    this.projects = new ProjectStore(this.db, this.paths.projects, now);
    this.plans = new PlanStore(this.kv, { projects: this.paths.projects, backups: this.paths.backups }, now, { archived: id => (this.projects.get(id)?.archived_at ?? null) !== null });
    this.acceptance = new AcceptanceStore(this.db, this.paths.projects, {
      archived: id => (this.projects.get(id)?.archived_at ?? null) !== null, log: this.log, now, languages: this.projects,
    });
    this.acceptance.repairAll(this.log);
    adoptLegacyPlans({ kv: this.kv, projectsDir: this.paths.projects, backupsDir: this.paths.backups, log: this.log, now });
    this.questions = new QuestionStore(this.db, { now, onChange: change => { this.bus.publish({ type: 'question.changed', ...change }); this.#questionChanged(change); }, tasks: this.tasks, projects: this.projects, acceptance: this.acceptance });
    this.memoryFiles = new ProductMemory({ db: this.db, projectsDir: this.paths.projects, projects: this.projects, now });
    this.mesh = new Mesh({ projectsDir: this.paths.projects, backupsDir: this.paths.backups, plans: this.plans, acceptance: this.acceptance, projects: this.projects, tasks: this.tasks, memory: this.memoryFiles, timezone: () => this.config().timezone, now, log: this.log, scoutStale: id => scoutState(this.kv, id).stale });
    for (const project of [...this.projects.list(), ...this.projects.list({ archived: true })]) this.mesh.persist(project.id);
    this.projectFolderExempt = [...(options.projectFolderExempt ?? [])];
    this.notifications = new Notifications(this.db, now, this.log, () => this.registry.secrets());
    this.reviews = new ReviewJobs(this.db, now);
    this.curiosity = new CuriosityStore(this.db, now);
    this.skills = new SkillStore(this.db, join(this.paths.workspace, 'skills'), now, () => languageOf(this.config()), this.log, join(this.paths.backups, 'skills'), () => growSkills(this.config()));
    this.skills.autoRegister = () => !askBeforeRegister(this.config());
    this.skills.secrets = () => this.registry.secrets();
    this.#importCuriosity();
    this.#copyLegacyWaits();
    this.#registerExistingSkills();
    this.#offerProtectFiles();
    this.uploads = new Uploads(this.db, this.paths.uploads, now);
    this.folderDialog = new FolderDialog({ log: this.log, ...options.folderDialog });
    // ブラウザ 1 つ（全会話で共有）。無効なら何も起動しない。起動は最初の browser_* の呼び出しのとき
    this.browser = new BrowserSession({
      driver: options.browserDriver ?? new PlaywrightDriver(), config: () => this.config(), paths: this.paths, log: this.log,
      notify: input => this.notifications.notify(input), secrets: () => this.registry.secrets(), now,
      ...(options.browserDisplay !== undefined ? { canShowWindow: () => options.browserDisplay === true } : {}),
    });
    this.background = new BackgroundJobs({ logDir: join(this.paths.data, 'tool_outputs'), now, isOpen: owner => this.#backgroundOpen(owner) });
    this.background.onChange(view => this.bus.publish({ type: 'background.changed', projectId: view.projectId, conversationId: view.conversationId, id: view.id, state: view.state }));
    this.bus.subscribe(({ event }) => {
      const stop = event.type === 'conversation.changed' && (event.change === 'archived' || event.change === 'deleted') ? { conversationId: event.conversationId }
        : event.type === 'project.changed' && event.change === 'archived' ? { projectId: event.projectId }
          : event.type === 'task.changed' && TASK_ENDED.has(event.task.status) ? { taskId: event.task.id }
            : undefined;
      if (stop) void this.background.stopWhere(stop).catch(error => this.log(`[ERROR] Failed to stop background commands: ${(error as Error).message}`));
    });
    // 会話を消したら、その会話のタブを閉じる
    this.conversations.onDeleted = ids => { void this.browser.closeConversation(ids).catch(() => undefined); this.pending.cancelConversations(ids); };
    this.engine = new ChatEngine({
      config: () => this.config(), conversations: this.conversations, runs: this.runs, kv: this.kv,
      registry: this.registry, status: this.status, bus: this.bus, limiter: this.limiter, paths: this.paths,
      tools: { registry: this.tools, approvals: this.approvals, pending: this.pending }, memory: this.memory, memoryFiles: this.memoryFiles, botMemory: this.botMemory, tasks: this.tasks,
      curiosity: this.curiosity, skills: this.skills, projects: this.projects, plans: this.plans, acceptance: this.acceptance, mesh: this.mesh, questions: this.questions, log: this.log,
      web: { network: options.webNetwork, download: options.downloadNetwork, throttle: new SearchThrottle(now) },
      notify: input => this.notifications.notify(input),
      browser: this.browser,
      background: this.background,
      ...(options.now ? { now: () => new Date(now()) } : {}),
      ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
      ...(options.judgeLimits ? { judgeLimits: options.judgeLimits } : {}),
    });
    this.worker = new Worker({
      db: this.db, tasks: this.tasks, engine: this.engine, conversations: this.conversations, notifications: this.notifications,
      kv: this.kv, config: () => this.config(), log: this.log, now, autoSchedule: options.workerTimers ?? true,
      reviews: this.reviews, memory: this.memory, botMemory: this.botMemory, memoryFiles: this.memoryFiles, curiosity: this.curiosity, memoryBudget: () => this.engine.memoryBudget(), backgroundAvailable: () => this.engine.backgroundAvailable(), secrets: () => this.registry.secrets(), projects: this.projects,
      questions: this.questions, pendingWake: () => sweepPendingWaits(this.#wakeDeps()), plans: this.plans,
      onScoutChange: projectId => this.bus.publish({ type: 'scout.changed', projectId }),
    });
    this.tasks.onChange = task => {
      if (isScoutRun(task)) { this.worker.poke(); return; }
      this.bus.publish({ type: 'task.changed', task: maskedTaskView(this, task) });
      // 返事待ち・失敗でなくなったタスクの、返事や確認を求める通知は、もう答えることが無い
      if (task.status !== 'waiting') this.notifications.settle('task_waiting', { link: `#/tasks/${task.id}` });
      if (task.status !== 'failed') this.notifications.settle('task_failed', { link: `#/tasks/${task.id}` });
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        this.curiosity.onTaskFinished(task);
        // 実行したタスクが終わったら振り返る（実行の記録があるものだけ）
        if (task.status !== 'cancelled' && task.conversation_id && this.worker.memoryReviewsOn({ taskId: task.id, conversationId: task.conversation_id })) {
          this.reviews.enqueue('task', `task:${task.id}`, { taskId: task.id, conversationId: task.conversation_id });
        }
      }
      this.worker.poke();
    };
    this.tasks.onFinished = task => { if (!isScoutRun(task) && this.worker.skillReviewsOn()) this.reviews.enqueueSkillForTask(task); };
    this.tasks.onUncancelled = task => { this.curiosity.onTaskRestored(task); this.questions.resumeAnswered(task); };
    this.tasks.onDeleted = removed => {
      const title = removed.title.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, ' ').replace(/[\\"]/gu, '\\$&');
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
      secrets: () => this.registry.secrets(),
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
        this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_auto'), body: draft.change_summary ? `${draft.name}: ${draft.change_summary}` : draft.name, link: `#/skills/${encodeURIComponent(draft.name)}`, dedupKey: `skill-auto:${draft.id}`, noForward: true });
        return;
      }
      this.notifications.notify({ kind: 'info', title: taskText(languageOf(this.config()), 'notify.skill_draft', { name: draft.name }), body: draft.change_summary ?? draft.reason ?? undefined, link: `#/skills/draft/${encodeURIComponent(draft.name)}`, dedupKey: `skill-draft:${draft.id}` });
    };
    this.engine.onRunEnd = run => {
      if (run.kind === 'chat') {
        if (this.worker.memoryReviewsOn({ conversationId: run.conversationId })) this.reviews.enqueueIfPiled(run.conversationId, reviewWindowLimits(this.engine.backgroundAvailable()));
        if (this.worker.skillReviewsOn()) this.reviews.enqueueSkillIfDue(run.conversationId);
        else this.reviews.skipSkillReading(run.conversationId);
      }
      this.worker.poke();
    };
  }

  // Web サーバーを起動するときに呼ぶ（動いているサーバーと同じ DB を開くだけの使い方では呼ばない。呼ぶと動いている承認待ちの通知まで既読になる）。
  // もう答えようのない大事な未読を既読にする（片づいたときに既読にする仕組みの前からあった通知と、落ちて承認の札ごと消えた通知）。
  // 起動直後は承認の札がひとつも無いので、承認待ちは全部。返事待ち・失敗は、タスクが無いか、今その状態でないものだけ既読にする
  settleStaleNotifications(): void {
    const stale = [...this.notifications.list(0).filter(n => n.kind !== 'question_new'), ...this.notifications.unreadOf('question_new')].filter(n => {
      if (n.kind === 'approval_needed') return !n.dedup_key?.startsWith('pending:') || !this.#pendingScopeWaits(n.dedup_key);
      if (n.kind === 'question_new') return this.questions.get(questionIdOf(n.dedup_key))?.status !== 'open';
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
    for (const name of askReadAsBlock(config)) this.log(`[WARN] ${name} is set to Ask in tools.policies, but it cannot wait in Pending, so it is treated as Block. Set it to Allow or Block in Settings`);
    for (const name of droppedGitEnv(config)) this.log(`[WARN] Ignoring "${name}" in tools.shell.envAllow: GIT_* variables are never passed to commands`);
  }

  // 更新の時点で既にあるスキルは、持ち主が置いたものとして全部登録する（1 回だけ。以後に直接置かれたものは、画面で登録するまで使わない）
  #registerExistingSkills(): void {
    this.skills.pruneMissing();
    if (this.kv.get('skills:registry-seeded')) return;
    const added = this.skills.registerExisting();
    this.kv.set('skills:registry-seeded', String(Date.now()));
    if (added) this.log(`[INFO] Registered ${added} existing skill(s) (skills placed directly in the folder from now on are not used until you press "Register" on the screen)`);
  }

  #offerProtectFiles(): void {
    if (this.kv.get(PROTECT_FILES_OFFERED)) return;
    if (!hasProtectFiles(this.configStore.current())) {
      try { this.configStore.appendPreToolHook(DEFAULT_PROTECT_FILES); }
      catch (error) { this.log(`[WARN] Could not add the built-in protect-files hook to the settings: ${(error as Error).message}`); return; }
      this.log('[INFO] Added the built-in protect-files hook (writes to .github/workflows, and to package.json after reading text from outside, are checked with you). Change or remove it in Settings › Hooks; it will not be added again');
    }
    this.kv.set(PROTECT_FILES_OFFERED, String(Date.now()));
  }

  #copyLegacyWaits(): void {
    if (this.kv.get(LEGACY_WAITS_COPIED)) return;
    let copied: number;
    try {
      copied = this.questions.copyLegacyWaits(this.log);
    } catch (error) {
      this.log(`[WARN] Could not copy tasks waiting for an answer into Questions: ${(error as Error).message}`);
      return;
    }
    this.kv.set(LEGACY_WAITS_COPIED, String(Date.now()));
    this.log(`[INFO] Copied ${copied} task(s) waiting for an answer into Questions (answer them there)`);
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
      const previous = this.#applied;
      this.#applied = json;
      this.registry.reload(config);
      void this.browser?.applyConfig(config).catch(() => undefined);
      void this.mcp?.reload().catch(error => this.log(`[ERROR] Failed to reload MCP: ${(error as Error).message}`));
      void this.status.probeAll(config).catch(error => this.log(`[ERROR] Failed to check the models after reloading the settings: ${(error as Error).message}`));
      this.log('[INFO] Loaded the changes to the settings file');
      this.#warnIgnoredPolicies(config);
      this.#scoutSettingsChanged(JSON.parse(previous) as AppConfig, config);
      this.worker?.poke();
    }
    this.#applied ||= json;
    this.#reportDropped();
    if (this.notifications && this.configStore.takeJudgeOffBlocked()) {
      const language = languageOf(config);
      this.log("[WARN] The settings file says to run without the judge (routing.judgeMode: off), but beat's data folder is beat's own folder or holds it, so the judge stays on. Start beat with a data folder elsewhere (--data-dir) to use it");
      this.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.judge_off_blocked.title'), body: taskText(language, 'notify.judge_off_blocked.body'), link: '#/settings', dedupKey: `judge-off-blocked:${this.bus.bootId}` });
    }
    if (this.notifications && this.configStore.takeStartedOff()) {
      const language = languageOf(config);
      this.log('[WARN] Started without the judge (routing.judgeMode: off in the settings file). Actions that would go to the judge run without a check. Turn the judge on in Settings › Models if you did not choose this');
      this.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.judge_off_start.title'), body: taskText(language, 'notify.judge_off_start.body'), link: '#/settings', dedupKey: `judge-off-start:${this.bus.bootId}` });
    }
    if (this.notifications && this.configStore.takeJudgeOffRefused()) {
      const language = languageOf(config);
      this.log('[WARN] The settings file was changed to run without the judge (routing.judgeMode: off), but the change did not come from beat. Kept the judge on. Turn it off in Settings, or restart beat to use the file as written');
      this.notifications.notify({ kind: 'health_alert', title: taskText(language, 'notify.judge_off_file.title'), body: taskText(language, 'notify.judge_off_file.body'), link: '#/settings', dedupKey: `judge-off-file:${this.bus.bootId}` });
    }
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
    const exclude = (tool: ToolDef) => (tool.name === 'agent_run' && !config.tools.agent.enabled) || (isBrowserTool(tool.name) && !config.tools.browser.enabled) || tool.acceptanceState === 'frozen';
    const all = this.tools?.forRun('chat', { exclude }) ?? [];
    const defers = all.some(tool => tool.name === 'tool_search' && tool.mcp === undefined);
    const full = this.tools?.forRun('chat', { exclude: tool => exclude(tool) || tool.name === 'tool_search' }) ?? [];
    const tools = !all.length ? 0 : defers ? estimateToolTokens(ToolRegistry.specs(all.filter(isCore), config)) + estimateTextTokens(deferredSection(all.filter(tool => !isCore(tool)), config)) : full.length ? estimateToolTokens(ToolRegistry.specs(full, config)) : 0;
    return estimateTextTokens(buildSnapshot(this.paths, { skills: this.skills?.index(language) ?? '' }, language).text) + tools
      + estimateTextTokens(buildDynamic(config.timezone, language)) + 64;
  }

  // 記憶を全部入れたときの見積もり。必要な長さには、各モデルの available の 12% までだけが数えられる（requiredContext）
  memoryTokens(): number {
    return this.botMemory && this.memory ? estimateTextTokens(renderBooks(this.memory.list(), languageOf(this.config()))) : 0;
  }

  // probe: false は、モデルやプロバイダに関わらない変更（道具の方針など）で、モデルの確認の通信をしない
  async applyConfig(next: AppConfig, options: { probe?: boolean } = {}): Promise<AppConfig> {
    const before = this.configStore.current();
    const saved = this.configStore.save(next);
    this.#scoutSettingsChanged(before, saved);
    this.#applied = JSON.stringify(saved);
    this.registry.reload(saved);
    void this.browser.applyConfig(saved).catch(() => undefined);
    void this.mcp?.reload().catch(error => this.log(`[ERROR] Failed to reload MCP: ${(error as Error).message}`));
    if (options.probe !== false) await this.status.probeAll(saved);
    this.worker.poke();
    return saved;
  }

  // 考える役のモデル・回数の設定が変わったら、どの製品の状態（off / resting など）も変わりうるので知らせる
  #scoutSettingsChanged(before: AppConfig, after: AppConfig): void {
    const scoutOf = (c: AppConfig): string => JSON.stringify([c.routing.scout ?? [], c.scout ?? null]);
    if (scoutOf(before) === scoutOf(after)) return;
    for (const project of this.projects.list({ archived: false })) this.bus.publish({ type: 'scout.changed', projectId: project.id });
  }

  // 画面から反映した server の設定を、「いま動いているもの」として覚える（restartRequired の比べ先）
  markServerApplied(server: AppConfig['server']): void { this.bootServer = structuredClone(server); }

  restartRequired(): boolean {
    return JSON.stringify(this.config().server) !== JSON.stringify(this.bootServer);
  }

  #pendingScope(row: PendingRow): { conversationId: string; taskId: string | null; key: string } {
    const parent = parentOf(this.db, row);
    const conversationId = parent?.conversationId ?? row.conversation_id;
    const taskId = row.task_id ?? parent?.taskId ?? this.tasks?.byConversation(conversationId)?.id ?? null;
    return { conversationId, taskId, key: taskId ? `pending:task:${taskId}` : `pending:conv:${conversationId}` };
  }

  #pendingScopeWaits(key: string): boolean {
    const taskId = key.startsWith('pending:task:') ? key.slice('pending:task:'.length) : null;
    const conversationId = taskId ? this.tasks.get(taskId)?.conversation_id ?? null : key.startsWith('pending:conv:') ? key.slice('pending:conv:'.length) : null;
    return this.pending.waitingAround(conversationId, taskId).some(row => this.#pendingScope(row).key === key);
  }

  #pendingChanged(id: number): void {
    try {
      const row = this.pending.row(id);
      const view = this.pending.view(id);
      if (!row || !view || row.status === 'running') return;
      const scope = this.#pendingScope(row);
      const language = languageOf(this.config());
      const task = scope.taskId ? this.tasks.get(scope.taskId) : undefined;
      if (row.status === 'waiting') {
        const projectId = row.project_id ?? task?.project_id ?? this.conversations.projectOf(scope.conversationId);
        this.notifications.notify({
          kind: 'approval_needed', title: task ? pendingText(language, 'notify_title_task', { title: task.title }) : pendingText(language, 'notify_title_conversation'),
          body: redactSecrets(`#${row.id} ${row.reason}`), link: projectId ? `#/pending/${projectId}` : '#/pending', dedupKey: scope.key, projectId,
        });
        return;
      }
      if (!this.#pendingScopeWaits(scope.key)) this.notifications.settle('approval_needed', { dedupKey: scope.key });
      const note = pendingNote(row, view);
      if (!note) return;
      if (task) this.tasks.event(task.id, 'pending', 'owner', note.event);
      this.engine.addNote(scope.conversationId, note.text, note.fetched);
    } catch (error) { this.log(`[ERROR] Failed to record the result of pending item #${id}: ${(error as Error).message}`); }
  }

  #questionChanged(change: QuestionChange): void {
    try {
      const row = this.questions.get(change.id);
      if (!row) return;
      const dedupKey = questionKey(row);
      if (change.status === 'answered') { this.notifications.settle('question_new', { dedupKey }); return; }
      const language = languageOf(this.config());
      const task = row.blocking === 1 && row.task_id ? this.tasks.get(row.task_id) : undefined;
      this.notifications.notify({
        kind: 'question_new', title: task ? taskText(language, 'notify.task_question', { title: task.title }) : notifyText(language, row.blocking === 1 ? 'question_new_blocking' : 'question_new'), body: row.question,
        link: row.project_id ? `#/questions/${row.project_id}` : '#/questions', dedupKey, projectId: row.project_id,
      });
    } catch (error) { this.log(`[ERROR] Failed to notify about question #${change.id}: ${(error as Error).message}`); }
  }

  #wakeDeps(): PendingWakeDeps {
    return { db: this.db, tasks: this.tasks, pending: this.pending, now: this.now, language: () => languageOf(this.config()), log: this.log };
  }

  #pendingWake(change: PendingChange): void {
    if (!this.tasks) return;
    try { pendingDecided(this.#wakeDeps(), change); } catch (error) { this.log(`[ERROR] Failed to wake the task of pending item #${change.id}: ${(error as Error).message}`); }
  }

  replayPending(row: PendingRow): void {
    void replayAction(row, {
      db: this.db, store: this.pending, registry: this.tools, config: () => this.config(), paths: this.paths, projects: this.projects,
      conversationExists: id => this.conversations.get(id) !== undefined, conversationTainted: id => this.conversations.everTainted(id), signal: this.#replayStop.signal, log: this.log,
      services: () => this.engine.toolServices(),
    }).catch(error => this.log(`[ERROR] Failed to run pending item #${row.id}: ${(error as Error).message}`));
  }

  #backgroundOpen(owner: JobOwner): boolean {
    const conversation = this.conversations.get(owner.conversationId);
    if (!conversation || conversation.archived === 1) return false;
    const project = this.projects.get(owner.projectId);
    if (!project || project.archived_at !== null) return false;
    if (owner.taskId !== undefined) {
      const task = this.tasks.get(owner.taskId);
      if (!task || TASK_ENDED.has(task.status)) return false;
    }
    return conversation.parent_run_id === null || this.engine.activeRuns().some(run => run.conversationId === owner.conversationId);
  }

  close(): void {
    this.#gitNoticeOff();
    this.#replayStop.abort();
    this.background.closeAll();
    void this.mcp.stop().catch(() => undefined);
    void this.browser.close().catch(() => undefined);
    this.folderDialog.stop();
    this.worker.stop();
    this.engine.saveQueued();
    this.engine.stopAll();
    this.db.close();
  }
}

const LEGACY_WAITS_COPIED = 'questions:legacy-waits-copied';
const TASK_ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

const questionKey = (row: Pick<QuestionRow, 'id' | 'blocking'>): string => `${row.blocking === 1 ? BLOCKING_QUESTION_KEY : 'question:'}${row.id}`;

function questionIdOf(key: string | null): number {
  const id = Number(key?.slice(key.lastIndexOf(':') + 1));
  return Number.isSafeInteger(id) ? id : 0;
}
