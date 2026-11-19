import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, type AppConfig, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { Conversations, StoredMessage } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import type { Runs } from '../db/runs.ts';
import { conversationSawOutside } from '../db/outside.ts';
import type { AppPaths } from '../paths.ts';
import { redactExact, redactSecrets } from '../shared/redaction.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { EndpointLimiter } from '../providers/limiter.ts';
import { UPSTREAM_KEEP, upstreamText } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, providerError, type ModelRequest, type ProviderAdapter } from '../providers/types.ts';
import { stripsThinkingOnText } from '../providers/anthropic.ts';
import { renderBooks, type MemoryStore } from '../memory/store.ts';
import type { ProductMemory } from '../memory/files.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import { NoJudge, TruncatedReply, USER_REQUEST_LIMIT, type ClassifierPrompt, type JudgeCall, type JudgeReply } from '../tools/auto-approve.ts';
import { checklistInjects, checklistSection, readChecklist } from '../tools/builtin/checklist-core.ts';
import { acceptanceAllows, planAllows, reviewAllows, runToolCall, type JudgeLimitSet } from '../tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { PlanStore } from '../projects/plan.ts';
import { meshIndexLimit, wrapMeshIndex, type Mesh } from '../mesh/index.ts';
import { makeFence, newNonce, PLACEHOLDER_NONCE } from '../shared/fence.ts';
import type { AcceptanceStore } from '../projects/acceptance.ts';
import type { QuestionStore } from '../questions/store.ts';
import { rootsLister, runProject, type RunWorktree } from '../projects/run.ts';
import { isCore, projectAllows, ToolRegistry } from '../tools/registry.ts';
import { deferredSection } from '../tools/builtin/tool-search.ts';
import { backgroundSection } from '../tools/builtin/shell-bg.ts';
import type { BackgroundJobs } from '../tools/shell/background.ts';
import { effectivePolicy } from '../tools/tool-policy.ts';
import { stricterMode } from '../shared/permission-mode.ts';
import { isLoopbackHost } from '../shared/url.ts';
import type { BrowserSession } from '../tools/browser/session.ts';
import { isBrowserTool } from '../tools/browser/names.ts';
import type { AgentRunInput, RunKind, RunPlace, TaskControl, ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import { growSkills, type SkillStore } from '../tools/skills/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import { CreatedFiles } from '../projects/created.ts';
import type { PendingStore } from '../pending/store.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { gateText } from '../shared/messages/gate.ts';
import type { RunBus } from './bus.ts';
import { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, PERSONA_BUDGET_RATIO, SPLIT_EXCHANGE_RATIO, contextAvailable, raisedOutputFor, toolResultTokens } from './context-budget.ts';
import { modelEfforts } from './efforts.ts';
import { ContextOverflow, fitMessages, irreducibleEstimate } from './fit.ts';
import type { ModelStatus } from './status.ts';
import { extractToolCalls, looksLikeTextToolCall } from './toolcall-parse.ts';
import type { AttachmentMeta, ChatMessage, ContextDetail, EngineErrorKind, EngineResult, ImageRef, StopReason, ThinkingBlock, ThinkingRecord, ToolCall, Usage } from './types.ts';
import { estimateMessageTokens, estimateRequest, estimateTextTokens, prefixLength } from './tokens.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../shared/messages/tools.ts';
import { plainLine } from '../shared/plain-text.ts';
import { compactPrompt, compactSpeaker, compactSystem, summarySection } from './prompts.ts';
import { buildDynamic, buildSnapshot, buildTail, fenceTail, nextTail, recordFileVersions, requirementsText, type TailSent } from './workspace.ts';
import { instructionsBudget, instructionsSection, readInstructions } from '../projects/instructions.ts';
import { ownWords, stripAttachments } from '../uploads/store.ts';

export { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, contextAvailable };
export const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 2048;
const TRUNCATION_STRIKES = 2;
const CALIBRATION_ALPHA = 0.3;
const MAX_BACKOFF_MS = 30_000;
const MAX_INVALID_STREAK = 3;
export const MAX_CONTINUATIONS = 3;
const RESUME_WORD_MAX = 40;

export function resumePoint(text: string): string {
  const at = text.search(/\s\S*$/u);
  if (at < 0) return text;
  const tail = text.slice(at + 1);
  return tail.length <= RESUME_WORD_MAX && !/[\u3000-\u9fff\uff00-\uffef]/u.test(tail) ? text.slice(0, at + 1) : text;
}

// 考える部分（thinking）を、target と同じ提供元・モデルが書いたときだけ残す。target が無ければ外す
function withThinkingFor(message: ChatMessage, target?: { provider: string; model: string }): ChatMessage {
  if (message.role !== 'assistant' || !message.thinking) return message;
  if (target && message.thinking.provider === target.provider && message.thinking.model === target.model) return message;
  const { thinking: _thinking, ...rest } = message;
  return rest;
}

// 見積もりに数える system の文（固定・実行のあいだ同じ部分）。tail は、発言に付けた分を発言として、まだ付けていない次の分を #assemble の pending として数える
const systemText = (system: ModelRequest['system']): string => `${system.frozen}\n${system.dynamic}`;

function forModel(message: ChatMessage): ChatMessage {
  if (message.role !== 'tool' || !message.gate) return message;
  const copy = { ...message };
  delete copy.gate;
  return copy;
}
const clean = (message: ChatMessage, fence: ReturnType<typeof makeFence> | undefined): ChatMessage =>
  (fence && message.role !== 'assistant' && message.content.includes(fence.nonce) ? { ...message, content: fence.clean(message.content) } : message);
// 人のいない実行（タスク・振り返り・子の担当）を区切る回数
export const UNATTENDED_ITERATION_CEILING = 100;
// アプリ全体で同時に動かせる子の担当の数（これを越えたら待たずに busy を返す）
export const MAX_LIVE_AGENTS = 2;
const AGENT_CHILD_TITLE_MAX = 80;
// 子の担当の答えとして親に返す文字数の上限
// 道具の結果の上限（pipeline の TOOL_OUTPUT_LIMIT 16000）に、区切りと打ち切りの注記を足しても収まるよう、少し小さくする（閉じの区切りが切り落とされないため）
export const AGENT_RESULT_MAX_CHARS = 15000;

// 区切りの文字を全角にする（子の答えの中の区切りを、区切りとして読ませないため）。半角が 1 つも無い文は変わらないので、その場合は 2 文字目の前に幅の無い文字を入れて、同じ並びにならないようにする
export function toFullWidth(text: string): string {
  const wide = text.replace(/[ -~]/gu, ch => ch === ' ' ? '\u3000' : String.fromCharCode(ch.charCodeAt(0) + 0xFEE0));
  return wide !== text || text.length < 2 ? wide : `${text[0]}\u200B${text.slice(1)}`;
}

// 子の担当を任せる道具が、いまの設定で使えないか（モデルに渡す道具の一覧と、#runAgent の入口で同じ判定にする）
function agentOff(config: AppConfig, kind: RunKind): boolean {
  return !config.tools.agent.enabled || (kind === 'task' && !config.tools.agent.inTasks);
}

class AllBut extends Set<string> {
  readonly #allowed: ReadonlySet<string>;
  readonly #forbidden: ReadonlySet<string>;
  constructor(allowed: ReadonlySet<string>, forbidden: readonly string[]) { super(); this.#allowed = allowed; this.#forbidden = new Set(forbidden); }
  override has(name: string): boolean { return !this.#allowed.has(name) || this.#forbidden.has(name); }
  override get size(): number { return unlisted(); }
  override [Symbol.iterator](): ReturnType<Set<string>['values']> { return unlisted(); }
  override values(): ReturnType<Set<string>['values']> { return unlisted(); }
  override keys(): ReturnType<Set<string>['values']> { return unlisted(); }
  override entries(): ReturnType<Set<string>['entries']> { return unlisted(); }
  override forEach(): void { unlisted(); }
}

function unlisted(): never { throw new Error('An allow-list of tools cannot be listed, only checked with has()'); }

class ScoutAllow extends AllBut {}

export const SCOUT_TOOLS: ReadonlySet<string> = new Set(['file_read', 'file_list', 'file_search', 'mesh_read', 'mesh_search', 'web_search', 'web_fetch', 'agent_run', 'ledger_record', 'proposal_add', 'calculate', 'date_calc']);
export const SCOUT_AGENT_TIMEOUT_MS = 1_800_000;
export type ScoutEnd = 'agents_busy' | 'agents_used';
export interface ScoutRoute { modelId: string; providerId: string; local: boolean; room: boolean; available: number | undefined }

const COMPACT_MIN_MESSAGES = 4;
// 1 回の実行で要約を重ねられる回数。外す発言が増えるたびに要約し直すが、無限には繰り返さない
const MAX_COMPACTIONS_PER_RUN = 5;
// 1 つの会話で、実行中に待たせておける発言の数
const MAX_PENDING_MESSAGES = 10;
const COMPACT_TRANSCRIPT_CHARS = 60_000;
const COMPACT_NOTE_CHARS = 300;
// 実行を始めるとき、添付の有無を見るために読み戻す発言の数（最後の返事がこの中に無ければ、確かめきれないので承認制の側に倒す）
const TAINT_SCAN_LIMIT = 500;

export interface ChatEngineDeps {
  config: () => AppConfig;
  conversations: Conversations;
  runs: Runs;
  kv: KV;
  registry: ProviderRegistry;
  status: ModelStatus;
  bus: RunBus;
  limiter: EndpointLimiter;
  paths: AppPaths;
  tools?: { registry: ToolRegistry; approvals: ApprovalBroker; pending?: PendingStore | undefined };
  memory?: MemoryStore;
  botMemory?: boolean | undefined;
  tasks?: TaskStore;
  curiosity?: CuriosityStore;
  skills?: SkillStore;
  projects?: ProjectStore | undefined;
  // beat 8-2: タスクが動く作業コピー（無ければ本体）
  places?: { runPlace: (taskId: string) => RunWorktree | undefined } | undefined;
  plans?: PlanStore | undefined;
  mesh?: Mesh | undefined;
  memoryFiles?: ProductMemory | undefined;
  acceptance?: AcceptanceStore | undefined;
  questions?: QuestionStore | undefined;
  web?: NonNullable<ToolContext['services']>['web'];
  notify?: NonNullable<ToolContext['services']>['notify'];
  log?: (line: string) => void;
  now?: () => Date;
  // 子の担当の時間切れ（ミリ秒）。試験で短くするためだけの上書き。ふつうは設定 tools.agent.timeoutSec（秒）を使う
  agentTimeoutMs?: number | undefined;
  judgeLimits?: JudgeLimitSet | undefined;
  // ブラウザ 1 つ（全会話で共有）。無ければ browser_* は動かない（ToolContext.services.browser）
  browser?: BrowserSession | undefined;
  background?: BackgroundJobs | undefined;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retriesPerModel?: number;
}


// messageCode / messageParams は、モデルの確認（probe）の messageCode / messageParams と同じ（確認していない・設定に無いときは engine.problem.*）。画面が自分の言語で組み立てられるように添える。
export interface ModelProblem { modelId: string; status: string; message: string; hint?: string | undefined; messageCode?: string | undefined; messageParams?: MessageParams | undefined }

// 送信と一緒に渡す、会話で選ぶモデルと考える深さ・権限モード。渡さなかったものは会話に覚えているもの。モデルと考える深さの null は自動・モデルの既定
export interface SendChoice { modelId?: string | null | undefined; effort?: string | null | undefined; permissionMode?: PermissionMode | undefined }
const hasChoice = (choice: SendChoice): boolean => choice.modelId !== undefined || choice.effort !== undefined || choice.permissionMode !== undefined;

export type SendOutcome =
  // queued: 実行中だったので待たせた（runId は今の実行。差し込まれる前なら pendingId で取り消せる）
  | { ok: true; runId: string; messageId?: number; queued?: boolean; pendingId?: string }
  | { ok: false; httpStatus: number; errorKind: EngineErrorKind | 'busy' | 'not_found'; errorMessage: string; errorCode?: string; errorParams?: MessageParams; detail?: ContextDetail; problems?: ModelProblem[] };

type Route = { model: ModelConfig; provider: ProviderConfig; backup?: boolean };

interface ChatItem { content: string; images: ImageRef[]; attachments: AttachmentMeta[]; generated?: true; askAnswer?: true }

const userMessage = ({ content, images, attachments, generated, askAnswer }: ChatItem): ChatMessage => ({ role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}), ...(generated ? { generated } : {}), ...(askAnswer ? { askAnswer } : {}) });
// held: 実行が始まったあとに会話のモデルか権限モードが替わり、そのあとに送られた発言。今の実行（古いモデルの鎖・古いモードの実行）へは差し込まず、実行が終わってから新しいモデル・新しいモードの実行で読ませる
// afterStop: 今の実行を止めたあとに送られた発言。止めた実行が終わるのを待って、新しい実行を始める（止める前に待たせた発言は、保存だけ）
interface PendingMessage extends ChatItem { id: string; interrupt: boolean; createdAt: number; held: boolean; afterStop: boolean }

export type ContextUsageOutcome =
  | { ok: true; modelId: string; tokens: number; available: number; capacity: number; ratio: number }
  | (Extract<SendOutcome, { ok: false }> & { errorParams?: MessageParams });

// 会話（チャット）や裏の作業が、どのモデルを順に試すか。順番が空なら設定のモデル全部（モデルが 0 個なら空）。
// 送信の画像の可否の確かめも、これを使う（エンジンと確かめの候補を食い違わせない）。
export function candidateModelIds(config: AppConfig, route: 'chat' | 'background'): string[] {
  const preferred = route === 'background' && config.routing.background.length ? config.routing.background : config.routing.chat;
  return preferred.length ? [...preferred] : config.models.map(m => m.id);
}

// 1 回の実行の要約の状態: 要約した回数・失敗したか（失敗したら外すだけ）・要約した発言の合計・「外しました」で最後に知らせた件数
interface CompactionState { count: number; failed: boolean; summarized: number; trimmedShown: number }

type Failure = { kind: EngineErrorKind; message: string; code?: string; params?: MessageParams; retryable: boolean; detail?: ContextDetail; route?: Route; upstream?: string };

type CallResult =
  | { ok: true; index: number; text: string; toolCalls: ToolCall[]; usage: Usage; stop: StopReason; truncated: boolean; estimate: number; thinking?: ThinkingRecord }
  | { ok: false; cancelled: boolean; partial: string; failure: Failure; route?: Route; usage?: Usage };

function addUsageTo(into: Usage, u: Usage): Usage {
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (typeof u[key] === 'number') into[key] = (into[key] ?? 0) + u[key]!;
  }
  return into;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface Active { runId: string; conversationId: string; kind: RunKind; taskId?: string; providers: Set<string>; primary: string; controller: AbortController; done: Promise<EngineResult> }

// 子の担当を始めるときに親から渡すもの（親の実行の ctx と、親の権限モード）
interface AgentLink { parent: ToolContext; mode: PermissionMode }

export class ChatEngine {
  readonly #d: ChatEngineDeps;
  #active = new Map<string, Active>();
  #byConversation = new Map<string, string>();
  #preempted = new Set<string>();
  // 会話の実行が止めたタスク（会話の実行が終わるとき、会話で進んだ分をこのタスクに引き継ぐ）
  #preemptedTasks = new Map<string, string[]>();
  #initialTaint = new Map<string, string[]>();
  #reviewEvidence = new Map<string, NonNullable<ToolContext['reviewEvidence']>>();
  #scoutEnds = new Map<string, ScoutEnd>();
  #scoutChildren = new Map<string, { spawned: number; ok: number; area?: string }>();
  // 会話のチャットの実行が始まったときに選ばれていたモデル（null は自動）。待たせる発言が、そのあとのモデルの変更より後かを見分けるのに使う
  #runModel = new Map<string, string | null>();
  // 会話のチャットの実行が始まったときの権限モード。待たせる発言が、そのあとのモードの変更より後かを見分けるのに使う（モデルと同じ決まり）
  #runMode = new Map<string, PermissionMode>();
  #runFence = new Map<string, string>();
  #runIndex = new Map<string, string>();
  // 実行ごとの tail: 付けて送った発言（保存した発言の id → 文）と、最後に送った節と時刻（S1。前に送った tail は以後も同じ文で送る）。
  // carriers: 時刻・各節のいまの文を載せている発言の id（要約・削りでその発言が送る範囲から外れたら、全部を付け直す）
  #runTail = new Map<string, { attached: Map<number, string>; sent?: TailSent; carriers: Partial<Record<'time' | 'checklist' | 'background', number>> }>();
  #loaded = new Map<string, { loaded: Set<string>; sent: Set<string> }>();
  // 考えるだけで上限に達したあと、その実行で上げた返事の上限（実行 → モデルの ID → 上限。上げたモデルにだけ、#assemble がそのモデルの許す範囲で使う）
  #outputCap = new Map<string, Map<string, number>>();
  // 止める操作（stop）を受けた実行
  #stopped = new Set<string>();
  #hardStops = new Map<string, AbortController>();
  // 子の担当の会話 → それを任せた親の会話（親がチャットのときだけ。子の権限モードは、親の会話のいまのモードに従う）
  #modeHost = new Map<string, string>();
  // 実行（親）ごとに、これまでに任せた子の数
  #agentSpawned = new Map<string, number>();
  // 実行中に送られて、まだ履歴に入っていない発言（会話ごと。再起動で消える）
  #pending = new Map<string, PendingMessage[]>();
  #notes = new Map<string, Array<{ content: string; fetched: boolean }>>();
  lastUserActivity = 0;
  onRunEnd: ((run: { runId: string; conversationId: string; kind: RunKind }) => void) | undefined;

  readonly created: CreatedFiles;

  constructor(deps: ChatEngineDeps) { this.#d = deps; this.created = new CreatedFiles({ kv: deps.kv, dataDir: deps.paths.data, ...(deps.log ? { log: deps.log } : {}) }); }

  #busy(key: EngineMessageKey): SendOutcome {
    return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), key), errorCode: `engine.${key}` };
  }

  // 実行中の会話に送った発言は、新しい実行にせず待たせる（待ちの発言）。今の実行が次の区切り（道具の結果を返して、次にモデルを呼ぶ前）に来たら
  // 履歴に入れ、実行が先に終わったら、その発言で新しい実行を始める。interrupt なら、今の実行を止めて、待っていた発言と一緒に新しい実行を始める
  send(conversationId: string, text: string, images: ImageRef[] = [], attachments: AttachmentMeta[] = [], choice: SendChoice = {}, options: { interrupt?: boolean; projectId?: string | undefined; generated?: boolean } = {}): SendOutcome {
    // ask_owner の札が開いているあいだに届いた発言は、札の答えとして印を付ける（サーバー側で決める。発言の文では決めない）
    const item: ChatItem = { content: text, images, attachments, ...(options.generated ? { generated: true as const } : {}), ...(this.#askOpen(conversationId) ? { askAnswer: true as const } : {}) };
    const running = this.#byConversation.get(conversationId);
    if (running === undefined) return this.#beginChat(conversationId, [item], choice, options.projectId);
    if (this.#active.get(running)?.kind !== 'chat') return this.#busy('send.busy_chat');
    const queue = this.#pending.get(conversationId) ?? [];
    if (queue.length >= MAX_PENDING_MESSAGES) {
      return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), 'send.queue_full', { max: MAX_PENDING_MESSAGES }), errorCode: 'engine.send.queue_full', errorParams: { max: MAX_PENDING_MESSAGES } };
    }
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    // 選んだモデルと考える深さは、次の実行から効く（今の実行の鎖は変えない）。権限モードは、厳しくなる向きはその場から、緩む向きは次の実行から効く（pipeline.ts）
    if (hasChoice(choice)) this.#d.conversations.setChoice(conversationId, choice);
    // 実行が始まってから会話のモデルや権限モードが替わっていたら（PATCH でも、この送信の modelId・permissionMode でも）、この発言は古いモデル・古いモードの実行に読ませない。
    // 一度保留した発言があれば、あとの発言も順番を守るため保留する
    const held = queue.some(p => p.held) || (this.#d.conversations.get(conversationId)?.model_id ?? null) !== (this.#runModel.get(running) ?? null)
      || this.#d.conversations.modeOf(conversationId) !== (this.#runMode.get(running) ?? 'auto');
    const pending: PendingMessage = { id: randomUUID(), ...item, interrupt: options.interrupt === true, createdAt: this.#d.now?.().getTime() ?? Date.now(), held, afterStop: this.#stopped.has(running) };
    this.#pending.set(conversationId, [...queue, pending]);
    this.#d.bus.publish({ type: 'pending.changed', conversationId });
    if (pending.interrupt) this.stop(running);
    return { ok: true, runId: running, queued: true, pendingId: pending.id };
  }

  // 待っている発言（画面に出す形）
  pending(conversationId: string): Array<{ id: string; text: string; attachments: AttachmentMeta[]; interrupt: boolean; createdAt: number }> {
    return (this.#pending.get(conversationId) ?? []).map(p => ({ id: p.id, text: stripAttachments(p.content), attachments: p.attachments, interrupt: p.interrupt, createdAt: p.createdAt }));
  }

  // 差し込まれる前の待ちの発言を取り消す。もう差し込まれた・無いときは false
  cancelPending(conversationId: string, pendingId: string): boolean {
    const queue = this.#pending.get(conversationId);
    if (!queue?.some(p => p.id === pendingId)) return false;
    const rest = queue.filter(p => p.id !== pendingId);
    if (rest.length) this.#pending.set(conversationId, rest); else this.#pending.delete(conversationId);
    this.#d.bus.publish({ type: 'pending.changed', conversationId });
    return true;
  }

  // 発言を保存して、チャットの実行を始める（1 つ以上の発言を順に保存し、1 つの実行で読ませる）。使えるモデルが無ければ、何も保存せずに断る
  #beginChat(conversationId: string, items: ChatItem[], choice: SendChoice, projectId?: string): SendOutcome {
    const existing = this.#d.conversations.get(conversationId);
    const pinned = choice.modelId !== undefined ? choice.modelId : existing?.model_id ?? null;
    const effort = choice.effort !== undefined ? choice.effort : existing?.effort ?? null;
    const chain = this.#chain('chat', pinned);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    // ユーザーが同じ id へ新しく送ったときは、消したばかりの会話の覚えを外す（動いていた実行の遅れた書き込みだけを見送るため）
    this.#d.conversations.reopen(conversationId);
    if (existing) {
      if (hasChoice(choice)) this.#d.conversations.setChoice(conversationId, choice);
    } else {
      const permissionMode = choice.permissionMode ?? (projectId !== undefined && this.#d.plans?.has(projectId) === false ? 'plan' : 'auto');
      this.#d.conversations.ensure(conversationId, { projectId, modelId: choice.modelId, effort: choice.effort, permissionMode });
    }
    const runId = randomUUID();
    if (preempted.length) this.#preemptedTasks.set(runId, preempted);
    let firstId: number | undefined;
    for (const item of items) {
      const { content, attachments } = item;
      const saved = this.#d.conversations.append(conversationId, userMessage(item));
      firstId ??= saved.id;
      // 添付の中身はタイトルにしない（本文が無ければ添付の名前にする）
      this.#d.conversations.autoTitle(conversationId, attachments.length ? ownWords(content) || attachments[0]!.name : content);
      this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    this.#taintFromHistory(runId, conversationId);
    this.#start(runId, conversationId, chain.usable, 'chat', undefined, undefined, effort);
    return { ok: true, runId, messageId: firstId! };
  }

  // 外から読んだ内容が残ったまま始まる実行は、シェルと書き込みを承認制にする（taint）。次のどれかなら、始まる実行も「外から読んだ」扱いにする:
  // - 最後の返事（道具の呼び出しだけではない assistant の発言）より後のユーザーの発言に添付がある。今送った発言・保存だけになった待ちの発言・やり直す発言のどれでも数え、道具を呼んだ assistant の発言は返事ではないので、またいで見る
  // - 最後の返事を、読み出す発言の数（TAINT_SCAN_LIMIT）の中に見つけられない。添付の有無を確かめきれないので、承認制の側に倒す
  // - 前のチャットの実行が、外から読んだまま、最後まで返事を書かずに終わった（止めた・失敗・取り消し・道具の上限のまとめ）。Web を読んだ分もこれで持ち越す。やり直し・続きは、その実行のやり直し・続きとみなす
  // - 外から読んだ実行が書いた作業の一覧が残っている（一覧は毎回の system に入るため、一覧を空にするまで、その会話の実行は「外から読んだ」で始める）
  #sinceReply(conversationId: string): { after: ChatMessage[]; unknown: boolean } {
    const stored = this.#d.conversations.messages(conversationId, TAINT_SCAN_LIMIT);
    const after: ChatMessage[] = [];
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'assistant' && !message.toolCalls?.length) return { after, unknown: false };
      after.unshift(message);
    }
    return { after, unknown: stored.length >= TAINT_SCAN_LIMIT };
  }

  #taintFromHistory(runId: string, conversationId: string): void {
    const language = languageOf(this.#d.config());
    const sources: string[] = [];
    const since = this.#sinceReply(conversationId);
    for (const message of since.after) {
      if (message.role !== 'user') continue;
      sources.push(...(message.attachments ?? []).map(a => engineText(language, 'attachment.taint', { name: a.name })));
      if (message.note && message.fetched) sources.push(pendingText(language, 'taint_note'));
    }
    if (since.unknown) sources.push(engineText(language, 'taint.unknown'));
    if (this.#previousRunCarriesTaint(conversationId)) sources.push(engineText(language, 'taint.carried'));
    if (this.#checklistCarriesTaint(conversationId)) sources.push(engineText(language, 'taint.checklist'));
    if (this.#backgroundCarriesTaint(conversationId)) sources.push(engineText(language, 'taint.background'));
    if (sources.length) this.#initialTaint.set(runId, sources);
  }

  // 道具に渡す店の一式。実行の中と、Pending の承認のあとの実行（app.ts の replayPending）で同じものを使う
  toolServices(): ToolContext['services'] {
    const d = this.#d;
    return d.memory ? { db: d.conversations.db, memory: d.memory, tasks: d.tasks, curiosity: d.curiosity, skills: d.skills, plans: d.plans, acceptance: d.acceptance, projects: d.projects, mesh: d.mesh, questions: d.questions, memoryFiles: d.memoryFiles, web: d.web, notify: d.notify, browser: d.browser, background: d.background, emit: e => d.bus.publish(e) } : undefined;
  }

  addNote(conversationId: string, content: string, fetched: boolean): void {
    if (!this.#d.conversations.get(conversationId)) return;
    if (this.#byConversation.has(conversationId)) {
      const queue = this.#notes.get(conversationId) ?? [];
      queue.push({ content, fetched });
      this.#notes.set(conversationId, queue);
      return;
    }
    this.#saveNote(conversationId, { content, fetched });
  }

  #saveNote(conversationId: string, note: { content: string; fetched: boolean }, runId?: string): void {
    if (note.fetched) this.#d.conversations.markTainted(conversationId);
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: note.content, generated: true, note: 'pending', ...(note.fetched ? { fetched: true as const } : {}) }, runId);
    this.#d.bus.publish({ type: 'message.saved', runId: runId ?? '', conversationId, messageId: saved.id, role: 'user' });
  }

  #injectNotes(runId: string, conversationId: string, ctx: ToolContext): void {
    const queue = this.#notes.get(conversationId);
    if (!queue?.length) return;
    this.#notes.delete(conversationId);
    for (const note of queue) {
      this.#saveNote(conversationId, note, runId);
      if (note.fetched) {
        ctx.taint.tainted = true;
        ctx.taint.sources.push(pendingText(languageOf(this.#d.config()), 'taint_note'));
      }
    }
  }

  #flushNotes(conversationId: string, runId: string): void {
    const queue = this.#notes.get(conversationId);
    if (!queue?.length) return;
    this.#notes.delete(conversationId);
    try { for (const note of queue) this.#saveNote(conversationId, note); } catch (error) { this.#d.log?.(`[ERROR] run ${runId}: failed to save a Pending note: ${(error as Error).message}`); }
  }

  #noteSinceReply(conversationId: string): boolean {
    return this.#sinceReply(conversationId).after.some(m => m.role === 'user' && m.note !== undefined && m.fetched === true);
  }

  #backgroundCarriesTaint(conversationId: string): boolean {
    return this.#d.background?.list({ conversationId }).some(job => job.tainted === true) ?? false;
  }

  #checklistCarriesTaint(conversationId: string): boolean {
    const list = readChecklist(this.#d.kv, conversationId);
    return list?.tainted === true && checklistInjects(list);
  }

  // 前のチャットの実行が、外から読んだ印（taint）を持ったまま、最後まで返事を書かずに終わったか。最後まで返事を書いて終わった実行（ok で、前からある実行の記録の道具の上限の印でも、出力の上限で切れた返事でもない）の印は持ち越さない
  #previousRunCarriesTaint(conversationId: string): boolean {
    const last = this.#d.runs.latestChat(conversationId);
    if (!last || last.tainted !== 1) return false;
    let wrappedUp = true;
    try { const found = JSON.parse(last.flags) as string[]; wrappedUp = found.includes('max_iterations') || found.includes('output_truncated') || found.includes('asked_owner'); } catch { }
    return !(last.ok === 1 && !wrappedUp);
  }

  // 実行の区切りで、待っている発言を履歴に入れる。
  // 添付つきの発言は外から来た文なので、この実行の残りも「外から読んだ」扱いにする。
  // 実行が始まったあとにモデルか権限モードを替えて送られた発言（held）は入れない（古いモデル・古いモードの実行へ渡さない）。実行が終わってから新しい実行で読ませる
  #injectPending(runId: string, conversationId: string, ctx: ToolContext): void {
    const d = this.#d;
    const queue = this.#pending.get(conversationId);
    if (!queue?.length) return;
    const injectable = queue.filter(p => !p.held);
    if (!injectable.length) return;
    const held = queue.filter(p => p.held);
    if (held.length) this.#pending.set(conversationId, held); else this.#pending.delete(conversationId);
    const language = languageOf(d.config());
    for (const item of injectable) {
      const { attachments } = item;
      const saved = d.conversations.append(conversationId, userMessage(item), runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
      if (attachments.length) {
        ctx.taint.tainted = true;
        ctx.taint.sources.push(...attachments.map(a => engineText(language, 'attachment.taint', { name: a.name })));
      }
    }
    d.bus.publish({ type: 'pending.changed', conversationId });
  }

  // 実行が終わったとき、まだ待っている発言があれば: 実行が成功で終わった（または止めて送る）なら、その発言で新しい実行を始める。
  // 失敗・取り消しで終わったときは、発言を保存だけして（新しい実行は始めない）、そのことを知らせる
  #drainPending(conversationId: string, endedRunId: string, ended: EngineResult | undefined): void {
    const d = this.#d;
    const queue = this.#pending.get(conversationId);
    if (!queue?.length) return;
    this.#pending.delete(conversationId);
    // 成功で終わった（または止めて送る）なら、待っていた発言を全部まとめて新しい実行で読ませる。
    // 失敗・取り消しで終わったときは、新しい実行を求めた発言（モデルを替えたあと・止めたあとに送られたもの）だけが新しい実行を始め、ほかは保存だけにする
    const startAll = ended?.ok === true || queue.some(p => p.interrupt);
    const wantsRun = (p: PendingMessage) => p.held || p.afterStop;
    const starters = startAll ? queue : queue.filter(wantsRun);
    const saveOnly = startAll ? [] : queue.filter(p => !wantsRun(p));
    if (saveOnly.length) this.#saveQueued(conversationId, saveOnly, endedRunId, 'stopped');
    if (starters.length && !this.#beginChat(conversationId, starters, {}).ok) this.#saveQueued(conversationId, starters, endedRunId, 'not_started');
    d.bus.publish({ type: 'pending.changed', conversationId });
  }

  // 待っていた発言を、ふつうのユーザーの発言として保存だけする（新しい実行は始めない）。保存したことを警告で知らせる。
  // 理由: stopped = 返事が止まった（失敗・取り消し・終了）、not_started = 返事を始められなかった（使えるモデルが無い）
  #saveQueued(conversationId: string, messages: PendingMessage[], runId: string, reason: 'stopped' | 'not_started'): void {
    const d = this.#d;
    for (const item of messages) {
      const saved = d.conversations.append(conversationId, userMessage(item));
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    const language = languageOf(d.config());
    const [code, key] = reason === 'stopped' ? ['queued_saved', 'warn.queued_saved'] as const : ['queued_not_started', 'warn.queued_not_started'] as const;
    d.bus.publish({ type: 'warning', runId, conversationId, code, message: engineText(language, key, { count: messages.length }), params: { count: messages.length } });
  }

  // 終了するとき（DB を閉じる前に呼ぶ）、待たせている発言を全部、保存だけして残す。待ちはメモリの中だけなので、これをしないと再起動で消える
  saveQueued(): number {
    let count = 0;
    for (const [conversationId, queue] of [...this.#pending]) {
      this.#pending.delete(conversationId);
      this.#saveQueued(conversationId, queue, this.#byConversation.get(conversationId) ?? '', 'stopped');
      this.#d.bus.publish({ type: 'pending.changed', conversationId });
      count += queue.length;
    }
    return count;
  }

  retry(conversationId: string): SendOutcome {
    if (this.#byConversation.has(conversationId)) return this.#busy('send.busy');
    const last = this.#d.conversations.messages(conversationId, 1).at(-1);
    if (!last || last.role === 'assistant') return { ok: false, httpStatus: 409, errorKind: 'not_found', errorMessage: engineText(languageOf(this.#d.config()), 'send.nothing_to_retry'), errorCode: 'engine.send.nothing_to_retry' };
    const conversation = this.#d.conversations.get(conversationId);
    const chain = this.#chain('chat', conversation?.model_id ?? null);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    const runId = randomUUID();
    if (preempted.length) this.#preemptedTasks.set(runId, preempted);
    this.#taintFromHistory(runId, conversationId);
    this.#start(runId, conversationId, chain.usable, 'chat', undefined, undefined, conversation?.effort ?? null);
    return { ok: true, runId };
  }

  // options.place: ワーカーが決めた置き場（作業コピーの行の id、本体なら null）。渡されたら、始める時点でもそのままかを確かめ、違えば動かさない
  runTask(task: Task, conversationId: string, prompt: string, options: { place?: string | null } = {}): { ok: true; runId: string; control: { value: TaskControl }; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const chain = this.#chain('background');
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    const control = { value: { outcome: 'none' } as TaskControl };
    const language = languageOf(this.#d.config());
    const sources = [
      ...(this.#d.runs.anyTaintedTask(conversationId) || this.#d.tasks?.textTainted(task.id) ? [engineText(language, 'taint.carried')] : []),
      ...(this.#checklistCarriesTaint(conversationId) ? [engineText(language, 'taint.checklist')] : []),
      ...(this.#backgroundCarriesTaint(conversationId) ? [engineText(language, 'taint.background')] : []),
      ...(this.#noteSinceReply(conversationId) ? [pendingText(language, 'taint_note')] : []),
    ];
    if (sources.length) this.#initialTaint.set(runId, sources);
    this.#start(runId, conversationId, chain.usable, 'task', { task, control, ...(options.place !== undefined ? { place: options.place } : {}) });
    return { ok: true, runId, control, done: this.#active.get(runId)!.done };
  }

  runReview(conversationId: string, prompt: string, options: { forbidTools?: readonly string[]; onlyTools?: ReadonlySet<string>; evidence?: ToolContext['reviewEvidence'] } = {}): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.review_running') };
    const chain = this.#chain('background');
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    const forbid = options.onlyTools ? new AllBut(options.onlyTools, options.forbidTools ?? []) : options.forbidTools?.length ? new Set(options.forbidTools) : undefined;
    if (this.#reviewSawOutside(conversationId)) this.#initialTaint.set(runId, [engineText(languageOf(this.#d.config()), 'taint.review_material')]);
    if (options.evidence) this.#reviewEvidence.set(runId, options.evidence);
    this.#start(runId, conversationId, chain.usable, 'review', undefined, forbid);
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  // 振り返りの材料が外を読んでいたか（振り返りの実行を「外を読んだ」で始める）。会話: 材料の会話が一度でも外を読んだ。タスク: タスクの実行のどれかが外を読んだ、またはタスクの文が外を読んだ実行から書かれた（次のタスクの実行の始め方と同じ）。
  // 材料の無い振り返り（整理の振り返り）は今のまま。材料の会話・タスクが見つからなければ「読んだ」側
  #reviewSawOutside(reviewConversationId: string): boolean {
    const d = this.#d;
    const review = d.conversations.get(reviewConversationId);
    if (!review) return true;
    if (review.source_task_id) {
      const task = d.tasks?.get(review.source_task_id);
      if (!task) return true;
      return d.tasks!.textTainted(task.id) || (task.conversation_id !== null && d.runs.anyTaintedTask(task.conversation_id));
    }
    if (review.source_conversation_id) return conversationSawOutside(d.conversations.db, review.source_conversation_id);
    return false;
  }

  // 考える実行が使う 1 本（routing.scout の使える先頭。鎖の後ろへは落ちない）。空・使えるものが無ければ null
  scoutRoute(): ScoutRoute | null {
    const first = this.#chain('scout').usable[0];
    if (!first) return null;
    let host = '';
    try { host = first.provider.baseUrl ? new URL(first.provider.baseUrl).hostname : ''; } catch { host = ''; }
    let running = 0;
    for (const active of this.#active.values()) if (active.kind !== 'chat' && active.primary === first.provider.id) running += 1;
    const { capacity, maxOutput } = this.#d.status.limits(first.model);
    return { modelId: first.model.id, providerId: first.provider.id, local: host !== '' && isLoopbackHost(host), room: running < first.provider.maxParallel, available: capacity > 0 ? contextAvailable(capacity, maxOutput) : undefined };
  }

  runScout(task: Task, conversationId: string, prompt: string, modelId: string, materials: string): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const route = this.#chain('scout').usable.find(r => r.model.id === modelId);
    if (!route) {
      const outcome = this.#noUsableModel(this.#chain('scout').problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    this.#initialTaint.set(runId, [materials]);
    this.#start(runId, conversationId, [{ model: route.model, provider: route.provider }], 'task', { task, control: { value: { outcome: 'none' } } }, new ScoutAllow(SCOUT_TOOLS, []), this.#d.config().scout?.effort ?? null);
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  scoutEnd(runId: string): ScoutEnd | undefined { return this.#scoutEnds.get(runId); }

  scoutArea(runId: string): string | null { return this.#scoutChildren.get(runId)?.area ?? null; }

  scoutChildrenAllFailed(runId: string): boolean { const kids = this.#scoutChildren.get(runId); return kids !== undefined && kids.spawned > 0 && kids.ok === 0; }

  wasPreempted(runId: string): boolean { return this.#preempted.has(runId); }

  // 裏の振り分けに使えるモデルが無いときの理由の文（runReview が断るのと同じ文）。使えるなら undefined
  backgroundBlocked(): string | undefined {
    const chain = this.#chain('background');
    return chain.usable.length ? undefined : this.#noUsableModel(chain.problems).errorMessage;
  }

  // 裏の実行（タスク・振り返り）をもう 1 本始めても、先に使う提供元の maxParallel を越えないか。
  // 数えるのは、動いている裏の実行の「最初に使う提供元」（道具を動かしている最中で limiter の枠を返しているものも含む）。使えるモデルが無いときは true（始めて、いつもの失敗の道に任せる）
  backgroundHasRoom(): boolean {
    const first = this.#chain('background').usable[0];
    if (!first) return true;
    let running = 0;
    for (const active of this.#active.values()) if (active.kind !== 'chat' && active.primary === first.provider.id) running += 1;
    return running < first.provider.maxParallel;
  }

  // 会話の最初に固定する system に入れる記憶の予算（トークン）。チャットと裏方で使える（確認が通った）モデルのうち、
  // 容量が分かるものの available のいちばん小さい値の 12%。容量が分かるモデルが無ければ undefined（予算なし = 全部入れる。0 にはしない）。
  memoryBudget(): number | undefined {
    const smallest = this.#smallestAvailable();
    return smallest === undefined ? undefined : Math.floor(smallest * MEMORY_BUDGET_RATIO);
  }

  // SOUL.md と USER.md（固定する system に入る）の大きさの目安。いちばん小さい使えるモデルの available の 10%（記憶の予算とは別）。
  personaBudget(): number | undefined {
    const smallest = this.#smallestAvailable();
    return smallest === undefined ? undefined : Math.floor(smallest * PERSONA_BUDGET_RATIO);
  }

  // 会話で使うモデル（選んでいればそれ。自動なら使える先頭、使えるものが無ければ候補の先頭）で選べる考える深さ。画面の検査と一覧に使う
  effortChoices(pinned: string | null): { modelId: string | undefined; efforts: string[] } {
    const config = this.#d.config();
    const id = pinned ?? this.#chain('chat').usable[0]?.model.id ?? candidateModelIds(config, 'chat')[0];
    const model = config.models.find(m => m.id === id);
    return { modelId: model?.id, efforts: model ? modelEfforts(model, this.#d.status.get(model.id)) : [] };
  }

  backgroundAvailable(): number | undefined {
    return this.#smallestAvailable(['background']);
  }

  #smallestAvailable(routes: ReadonlyArray<'chat' | 'background'> = ['chat', 'background']): number | undefined {
    const config = this.#d.config();
    const ids = new Set(routes.flatMap(route => candidateModelIds(config, route)));
    let smallest: number | undefined;
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      if (!model || !this.#d.status.usable(id)) continue;
      const { capacity, maxOutput } = this.#d.status.limits(model);
      if (!(capacity > 0)) continue;
      const available = contextAvailable(capacity, maxOutput);
      if (available > 0) smallest = smallest === undefined ? available : Math.min(smallest, available);
    }
    return smallest;
  }

  // 会話の実行が使うプロバイダを使っている裏の実行を止める。止めたタスクの id を返す
  #preemptFor(routes: Route[]): string[] {
    const providers = new Set(routes.map(r => r.provider.id));
    const tasks: string[] = [];
    for (const active of this.#active.values()) {
      if (active.kind === 'chat' || active.kind === 'agent' || ![...active.providers].some(p => providers.has(p))) continue;
      this.#preempted.add(active.runId);
      if (active.taskId) tasks.push(active.taskId);
      active.controller.abort(new ProviderError('cancelled', engineText(DEFAULT_LANGUAGE, 'run.preempted'), { retryable: false }));
    }
    return tasks;
  }

  stop(runId: string): boolean {
    const active = this.#active.get(runId);
    if (!active) return false;
    this.#stopped.add(runId);
    const reason = providerError('cancelled', 'cancelled', {}, { retryable: false });
    this.#hardStops.get(runId)?.abort(reason);
    active.controller.abort(reason);
    return true;
  }

  stopAll(): void { for (const runId of this.#active.keys()) this.stop(runId); }

  wait(runId: string): Promise<EngineResult> | undefined { return this.#active.get(runId)?.done; }
  get chatting(): boolean { return [...this.#active.values()].some(a => a.kind === 'chat'); }
  activeRuns(): Array<{ runId: string; conversationId: string; kind: RunKind; mode?: PermissionMode }> {
    return [...this.#active.values()].map(a => ({
      runId: a.runId, conversationId: a.conversationId, kind: a.kind,
      ...(a.kind === 'chat' ? { mode: stricterMode(this.#runMode.get(a.runId) ?? 'auto', this.#d.conversations.modeOf(a.conversationId)) } : {}),
    }));
  }

  // 会話で選んだモデルがあれば（pinned）、そのモデルだけで鎖を作る。使えなければ、ほかのモデルへ切り替えずに、そのモデルの問題だけを返す
  #chain(route: 'chat' | 'background' | 'scout', pinned: string | null = null): { usable: Route[]; problems: ModelProblem[] } {
    const config = this.#d.config();
    const language = languageOf(config);
    const ids = pinned ? [pinned] : route === 'scout' ? [...(config.routing.scout ?? [])] : candidateModelIds(config, route);
    const usable: Route[] = [];
    const cooling: Route[] = [];
    const problems: ModelProblem[] = [];
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      const provider = model && config.providers.find(p => p.id === model.provider);
      if (!model || !provider) { problems.push({ modelId: id, status: 'error', message: engineText(language, 'problem.not_in_config'), messageCode: 'engine.problem.not_in_config' }); continue; }
      const probe = this.#d.status.get(id);
      if (probe?.status === 'ok') (this.#d.status.coolingDown(id, this.#d.now?.().getTime()) ? cooling : usable).push({ model, provider });
      else problems.push({
        modelId: id, status: probe?.status ?? 'unknown', message: probe?.message ?? engineText(language, 'problem.unchecked'), hint: probe?.hint,
        ...(probe ? (probe.messageCode ? { messageCode: probe.messageCode, ...(probe.messageParams ? { messageParams: probe.messageParams } : {}) } : {}) : { messageCode: 'engine.problem.unchecked' }),
      });
    }
    return { usable: [...usable, ...cooling].map(route => (route.model.id === ids[0] ? route : { ...route, backup: true })), problems };
  }

  #noUsableModel(problems: ModelProblem[]): Extract<SendOutcome, { ok: false }> {
    const contextProblem = problems.find(p => p.status === 'too_small' || p.status === 'exceeds_model' || p.status === 'unknown');
    const language = languageOf(this.#d.config());
    const lines = problems.map(p => engineText(language, 'problem.line', { id: p.modelId, message: p.message, hintPart: p.hint ? engineText(language, 'problem.hint_suffix', { hint: p.hint }) : '' }));
    return {
      ok: false, httpStatus: 409,
      errorKind: contextProblem ? 'context_overflow' : 'provider_error',
      errorMessage: engineText(language, 'no_usable', { lines: lines.join('\n') || engineText(language, 'problem.none') }),
      errorCode: 'engine.no_usable',
      ...(contextProblem ? { detail: { reason: contextProblem.status === 'unknown' ? 'context_unknown' : contextProblem.status === 'exceeds_model' ? 'exceeds_model_limit' : 'server_ctx_too_small', ...(contextProblem.hint ? { hint: contextProblem.hint } : {}) } } : {}),
      problems,
    };
  }

  #start(runId: string, conversationId: string, chain: Route[], kind: RunKind, task?: { task: Task; control: { value: TaskControl }; place?: string | null }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): void {
    const controller = new AbortController();
    this.#hardStops.set(runId, new AbortController());
    this.#byConversation.set(conversationId, runId);
    if (kind === 'chat') { this.#runModel.set(runId, this.#d.conversations.get(conversationId)?.model_id ?? null); this.#runMode.set(runId, this.#d.conversations.modeOf(conversationId)); }
    let ended: EngineResult | undefined;
    const done = this.#execute(runId, conversationId, chain, controller.signal, kind, task, forbid, effort, agent)
      .catch((error): EngineResult => {
        const detail = redactSecrets((error as Error).message, this.#d.registry.secrets());
        this.#d.log?.(`[ERROR] run ${runId}: ${redactSecrets(String((error as Error).stack ?? error), this.#d.registry.secrets())}`);
        this.#d.runs.finish(runId, { ok: false, attempts: 0, errorKind: 'internal', errorMessage: detail });
        const language = languageOf(this.#d.config());
        const internal = engineText(language, 'run.internal', { detail });
        this.#d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail } });
        return { ok: false, runId, text: '', errorKind: 'internal', errorMessage: internal, errorCode: 'engine.run.internal', errorParams: { detail }, retryable: false };
      })
      .then(result => { ended = result; return result; })
      .finally(() => {
        this.#active.delete(runId);
        this.created.end(runId).catch(() => {});
        this.#byConversation.delete(conversationId);
        this.#preemptedTasks.delete(runId);
        this.#runModel.delete(runId);
        this.#runMode.delete(runId);
        this.#runFence.delete(runId);
        this.#runIndex.delete(runId);
        this.#runTail.delete(runId);
        this.#loaded.delete(runId);
        this.#outputCap.delete(runId);
        this.#reviewEvidence.delete(runId);
        this.#stopped.delete(runId);
        this.#hardStops.delete(runId);
        this.#modeHost.delete(conversationId);
        this.#agentSpawned.delete(runId);
        setTimeout(() => { this.#preempted.delete(runId); this.#scoutEnds.delete(runId); this.#scoutChildren.delete(runId); }, 60_000).unref?.();
        // 待っている発言の引き取り（会話の実行の鎖が途切れないよう、ロックを外した直後に、同じ呼び出しの中で次の実行を始める）
        this.#flushNotes(conversationId, runId);
        if (kind === 'chat') {
          try { this.#drainPending(conversationId, runId, ended); } catch (error) { this.#d.log?.(`[ERROR] Failed to pick up the waiting messages: ${(error as Error).stack ?? error}`); }
        }
        try { this.onRunEnd?.({ runId, conversationId, kind }); } catch (error) { this.#d.log?.(`[ERROR] onRunEnd: ${(error as Error).message}`); }
      });
    this.#active.set(runId, { runId, conversationId, kind, ...(task ? { taskId: task.task.id } : {}), providers: new Set(chain.map(r => r.provider.id)), primary: chain[0]!.provider.id, controller, done });
  }

  #frozen(projectId: string | undefined): boolean {
    return Boolean(projectId && this.#d.acceptance?.latest(projectId));
  }

  // モデルに渡す道具の一覧。外す条件はここだけ: 振り返りで禁止の道具（reviewAllows: 効果が write・exec・network のもの、ファイルも書く道具）・この実行で禁止された道具・持ち主が「止める」にした道具（tools.policies）。
  // 「止める」は、パイプラインと同じく、実行を始めたときの設定（started）といまの設定の厳しい方。始めたときに止めていた道具は、途中で緩めても、その実行のあいだは戻らない。
  // 計画モード（plan）の会話では、planAllows を通る道具だけを渡す: 効果が読む（read）か Web の読み取り（network）で、ファイルも書く道具（writesFiles）でないもの（パイプラインの二重の拒否は runToolCall）。
  // 実行に効くモードは、実行を始めたときのモード（#assemble の startedMode）と会話のいまのモードの厳しい方。始めたときが計画なら、途中でふつうに戻しても、その実行のあいだは計画のまま
  #excluded(kind: RunKind, forbid?: ReadonlySet<string>, started?: AppConfig, mode: PermissionMode = 'auto', inProject = false, frozen = false): (t: ToolDef) => boolean {
    const config = this.#d.config();
    const scout = forbid instanceof ScoutAllow;
    return (t: ToolDef) => (kind === 'review' && !reviewAllows(t)) || (t.scoutOnly === true && !scout) || (t.name === 'agent_run' && !scout && (agentOff(config, kind) || (started !== undefined && agentOff(started, kind)))) || (isBrowserTool(t.name) && (!config.tools.browser.enabled || started?.tools.browser.enabled === false)) || (t.name === 'skill_draft' && (!growSkills(config) || (started !== undefined && !growSkills(started)))) || forbid?.has(t.name) === true || effectivePolicy(t.name, config, started) === 'block'
      || (mode === 'plan' && !planAllows(t)) || !projectAllows(t, { kind, project: inProject, memoryProject: inProject }) || !acceptanceAllows(t, frozen);
  }

  #deferred(kind: RunKind, forbid: ReadonlySet<string> | undefined, started: AppConfig | undefined, mode: PermissionMode, inProject: boolean, frozen: boolean): ToolDef[] {
    if (!this.#d.tools) return [];
    const excluded = this.#excluded(kind, forbid, started, mode, inProject, frozen);
    return this.#d.tools.registry.forRun(kind, { exclude: t => excluded(t) || isCore(t) });
  }

  #reachable(kind: RunKind, forbid: ReadonlySet<string> | undefined, started: AppConfig | undefined, mode: PermissionMode, inProject: boolean, frozen: boolean): ToolDef[] {
    return this.#d.tools?.registry.forRun(kind, { exclude: this.#excluded(kind, forbid, started, mode, inProject, frozen) }) ?? [];
  }

  #toolsFor(kind: RunKind, forbid?: ReadonlySet<string>, started?: AppConfig, mode: PermissionMode = 'auto', inProject = false, frozen = false, loaded?: ReadonlySet<string>): ToolDef[] {
    if (!this.#d.tools) return [];
    const excluded = this.#excluded(kind, forbid, started, mode, inProject, frozen);
    const exclude = loaded ? (t: ToolDef) => excluded(t) || !(isCore(t) || loaded.has(t.name)) : (t: ToolDef) => excluded(t) || t.name === 'tool_search';
    return this.#d.tools.registry.forRun(kind, { exclude });
  }

  async #execute(runId: string, conversationId: string, chain: Route[], signal: AbortSignal, kind: RunKind, task?: { task: Task; control: { value: TaskControl }; place?: string | null }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): Promise<EngineResult> {
    const d = this.#d;
    // 子の担当は、親が始めたときの設定で動く（親と同じ決まり。途中で緩めても広がらない）
    const config = agent?.parent.config ?? d.config();
    d.runs.start(runId, kind, conversationId, agent?.parent.runId);
    const worktree = !agent && task && kind === 'task' ? d.places?.runPlace(task.task.id) : undefined;
    if (!agent && task && task.place !== undefined && (worktree?.id ?? null) !== task.place) throw new Error(engineText(languageOf(config), 'run.place_changed'));
    const own = agent ? undefined : runProject(d.projects, d.conversations.projectOf(conversationId), worktree);
    const resolved = agent ? agent.parent.project : own;
    const place: RunPlace | undefined = agent ? agent.parent.place
      : own?.worktree && own.productRoot ? { kind: 'worktree', id: own.worktree.id, productRoot: own.productRoot, branch: own.worktree.branch, base: own.worktree.base, ceiling: own.worktree.ceiling } : undefined;
    const scout = agent ? agent.parent.scout === true : forbid instanceof ScoutAllow;
    const snapshot = this.#snapshot(conversationId, resolved, scout);
    d.bus.publish({ type: 'run.start', runId, conversationId, modelId: chain[0]!.model.id });
    const flags: string[] = chain[0]!.backup ? ['fallback'] : [];
    const usage: Usage = {};
    const counters = { attempts: 0, iterations: 0, toolCalls: 0, workCalls: 0, workDone: 0, changeDone: 0 };
    let index = 0;
    let invalidStreak = 0;
    // 切れた呼び出しが続けて何回目か（invalidStreak とは別に数える）
    let truncatedStreak = 0;
    // 文だけの返事が上限で切れたとき、beat が続きを頼んだ回数（1 回の実行の合計）と、それまでの切れた文
    let continuations = 0;
    const cutTexts: string[] = [];
    let cutTail = '';
    let warnedToolCut = false;
    let lastEstimate = 0;
    let lastRoute: Route = chain[0]!;
    const project = kind === 'review' ? undefined : resolved;
    if (project) d.mesh?.persist(project.id);
    if (project && !project.root && !agent) d.log?.(`[WARN] The folder of product ${project.id} could not be confirmed, so run ${runId} does not get it as a writable folder`);
    const allRoots = rootsLister(d.projects);
    allRoots();
    const productRoots = agent || kind === 'review' ? [] : allRoots;
    const reach: AppConfig = scout ? { ...config, tools: { ...config.tools, roots: project?.root ? [{ path: project.root, mode: 'read' }] : [] } } : config;
    const base = agent ? undefined : buildPolicy(reach, d.paths, undefined, productRoots);
    const policy = agent?.parent.policy ?? (project?.root ? buildPolicy(reach, d.paths, { root: project.root }, productRoots) : base!);
    const home = agent ? agent.parent.home ?? agent.parent.workspace : defaultWorkspace(base!, d.paths);
    // 道具が書き込む「どう終えるか」の印は、ワーカーが読む control.value と同じ入れ物にする
    const taskSlot = task ? { id: task.task.id, get control() { return task.control.value; }, set control(v: TaskControl) { task.control.value = v; } } : undefined;
    const touchedTasks = new Set<string>();
    const ctx: ToolContext = {
      runId, conversationId, kind, signal, stopSignal: this.#hardStops.get(runId)?.signal, config, paths: d.paths, policy, workspace: agent?.parent.workspace ?? (project ? project.root ?? d.projects?.get(project.id)?.root ?? d.paths.projects : home), home, ...(project ? { project } : {}), ...(project && place ? { place } : {}), ...(kind === 'review' && resolved ? { memoryProject: resolved.id } : {}),
      ...(() => { const evidence = this.#reviewEvidence.get(runId); this.#reviewEvidence.delete(runId); return kind === 'review' && evidence ? { reviewEvidence: evidence } : {}; })(),
      taint: (() => { const sources = this.#initialTaint.get(runId) ?? []; this.#initialTaint.delete(runId); return { tainted: sources.length > 0, sources }; })(),
      conversationTainted: () => d.conversations.everTainted(conversationId),
      // 持ち主が自分で書いた文（9-1b の D-7）: タスクは持ち主の頼み、子の担当は親のもの、会話は持ち主の発言
      ownerText: () => {
        if (task) { const text = d.tasks?.ownerRequestText(task.task.id); return text ? [text] : []; }
        if (agent) return agent.parent.ownerText?.() ?? [];
        return this.#ownerTexts(conversationId);
      },
      log: d.log ?? (() => undefined),
      services: this.toolServices(),
      task: taskSlot,
      touchedTasks,
      ...(forbid ? { forbiddenTools: forbid } : {}),
      ...(kind === 'chat' ? { permissionMode: this.#runMode.get(runId) ?? 'auto' } : kind === 'task' ? { permissionMode: 'auto' as const } : agent ? { permissionMode: agent.mode } : {}),
      ...(agent ? { parent: { runId: agent.parent.runId, conversationId: agent.parent.conversationId, kind: agent.parent.kind, title: d.conversations.get(conversationId)?.title ?? '', ...(agent.parent.task ? { taskId: agent.parent.task.id } : {}) } } : {}),
      ...(scout ? { scout: true as const, scoutFetches: agent?.parent.scoutFetches ?? { n: 0 } } : {}),
    };
    ctx.noteCreated = abs => this.created.note(ctx, abs);
    ctx.isCreated = abs => this.created.isCreated(abs, ctx);
    ctx.toolWindow = () => this.created.open(ctx);
    ctx.reachable = () => this.#reachable(kind, forbid, config, this.#modeFor(kind, conversationId, ctx.permissionMode), ctx.project !== undefined || ctx.memoryProject !== undefined, this.#frozen(ctx.project?.id));
    if (this.#defers(kind, forbid, config)) {
      const loaded = new Set<string>();
      const sent = new Set<string>();
      this.#loaded.set(runId, { loaded, sent });
      ctx.deferred = {
        loaded,
        sent,
        list: () => this.#deferred(kind, forbid, config, this.#modeFor(kind, conversationId, ctx.permissionMode), ctx.project !== undefined || ctx.memoryProject !== undefined, this.#frozen(ctx.project?.id)),
        load: names => { for (const name of names) loaded.add(name); },
      };
    }
    if (project?.root && !agent) await this.created.begin(runId, task ? { kind: 'task', id: task.task.id } : { kind: 'conv', id: conversationId }, project.root);
    // 子の担当を任せる道具の入口（設定で有効のときだけ。子は孫を作れない。タスクは tools.agent.inTasks で許したときだけ）
    if (kind !== 'agent' && (scout || (config.tools.agent.enabled && (kind === 'chat' || (kind === 'task' && config.tools.agent.inTasks))))) {
      ctx.agent = (input, callId) => this.#runAgent({ ctx, routes: chain.slice(index), forbid }, input, callId);
    }
    // 外から読んだ印は、実行の記録に読んだ時点で書く（途中で止まる・落ちる実行でも、やり直し・続きが引き継げるように）
    let taintRecorded = false;
    // 会話にも「外から読んだことがある」印を付ける（自動承認の判定役には、この会話は「よそから来た文を読んだ」と伝わる）
    const recordTaint = () => { if (taintRecorded || !ctx.taint.tainted) return; taintRecorded = true; d.runs.markTainted(runId); if (kind === 'chat' || kind === 'agent') d.conversations.markTainted(conversationId); };
    const addUsage = (u: Usage) => addUsageTo(usage, u);
    const finishOk = (text: string, stop: StopReason, split?: 'max_iterations' | 'context'): EngineResult => {
      if (kind === 'chat') this.#handOver(runId, text, { workCalls: counters.workCalls, touched: touchedTasks, tainted: ctx.taint.tainted || d.conversations.everTainted(conversationId), projectId: ctx.project?.id ?? null });
      d.runs.finish(runId, { ok: true, modelId: lastRoute.model.id, providerId: lastRoute.provider.id, model: lastRoute.model.model, attempts: counters.attempts, stop, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, estPromptTokens: lastEstimate, flags });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: true });
      return { ok: true, runId, text, modelId: lastRoute.model.id, usage, stop, workDone: counters.workDone, changeDone: counters.changeDone, iterations: counters.iterations, ...(stop === 'max_tokens' ? { truncated: true as const } : {}), ...(split ? { split } : {}) };
    };
    const finishFail = (f: Failure): EngineResult => {
      const route = f.route ?? lastRoute;
      // 実行ログには、相手のサーバーの本文も残す（画面に届く出来事・結果には入れない）
      d.runs.finish(runId, { ok: false, attempts: counters.attempts, errorKind: f.kind, errorMessage: f.upstream ? `${f.message}: ${upstreamText(f.upstream, d.registry.secrets())}` : f.message, flags, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, modelId: route.model.id, model: route.model.model, providerId: route.provider.id });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), ...(f.detail ? { detail: f.detail } : {}) });
      return { ok: false, runId, text: '', errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), retryable: f.retryable, ...(f.detail ? { detail: f.detail } : {}) };
    };

    const tools = d.tools;
    const callTool = (toolCall: ToolCall, truncated?: { message: string; raw: string }) => runToolCall(toolCall, ctx, {
      registry: tools!.registry, approvals: tools!.approvals, pending: tools!.pending, productRoots: allRoots, db: d.conversations.db, emit: e => d.bus.publish(e), config: d.config,
      permissionMode: () => this.#modeOf(conversationId),
      autoClassify: (prompt, classifierSignal, judgeCall) => this.#autoAsk(lastRoute, prompt, classifierSignal, judgeCall),
      lastUserRequest: () => (task ? d.tasks?.judgeRequest(task.task.id) ?? ''
        : agent ? (agent.parent.task ? d.tasks?.judgeRequest(agent.parent.task.id) ?? '' : this.#lastUserRequest(agent.parent.conversationId))
        : this.#lastUserRequest(conversationId)),
      judgeLimits: d.judgeLimits,
      conversationTainted: () => d.conversations.everTainted(conversationId),
    }, truncated);
    // 実際に動いた道具の呼び出しを「仕事」に数える（結果が誤りでも数える。Pending に預けた・断られた・引数の誤り・task_ / tool_search / question_add は数えない）。
    // そのうち書き換え・実行の仕事（changeDone）に数えるのは、効果が write の道具（結果を問わない）・誤りなく終わった exec の道具・子の担当（agent_run）
    const countDone = (name: string, outcome: { output: { isError?: boolean }; decision: string; invalidArguments?: boolean }) => {
      if (outcome.decision !== 'allow' || outcome.invalidArguments || name.startsWith('task_') || name === 'tool_search' || name === 'question_add') return;
      counters.workDone++;
      const effect = tools?.registry.get(name)?.effect;
      if (effect === 'write' || (effect === 'exec' && !outcome.output.isError) || name === 'agent_run') counters.changeDone++;
    };
    if (kind === 'task' && tools) {
      let inner = false;
      ctx.runTool = async (name, input) => {
        if (inner) return { output: { content: gateText(languageOf(config), 'run_tool.nested'), isError: true }, decision: 'deny', decidedBy: 'run_tool' };
        inner = true;
        try {
          counters.toolCalls++;
          if (!name.startsWith('task_')) counters.workCalls++;
          const outcome = await callTool({ id: `code_${randomUUID()}`, name, arguments: input });
          const { output, decision, decidedBy, gate } = outcome;
          countDone(name, outcome);
          recordTaint();
          return { output, decision, decidedBy, ...(gate ? { gate } : {}) };
        } finally { inner = false; }
      };
    }

    const ceiling = kind === 'chat' ? Infinity : UNATTENDED_ITERATION_CEILING;
    // 長さの区切りは、この実行の中でやり取りが育ったときだけ。始めから超えていた実行は区切らず、縮める・あふれるの今の道に任せる（区切っても同じ始まりを繰り返すだけ）。
    // 見るのは 3 往復目の頭から（モデルは、最初の道具の結果を見たあと必ず 1 回は動ける）
    const splits = Boolean(task) && kind === 'task' && !scout;
    let startedOver = false;
    const compaction: CompactionState = { count: 0, failed: false, summarized: 0, trimmedShown: -1 };
    for (counters.iterations = 1; counters.iterations <= ceiling; counters.iterations++) {
      if (kind === 'chat') this.#injectPending(runId, conversationId, ctx);
      this.#injectNotes(runId, conversationId, ctx);
      recordTaint();
      const budgetArgs = { runId, conversationId, snapshot, model: lastRoute.model, kind, forbid, started: config, startedMode: ctx.permissionMode, project: ctx.project, memoryProject: ctx.memoryProject };
      if (splits && counters.iterations === 1) startedOver = this.#exchangeTooLong(budgetArgs);
      else if (splits && counters.iterations >= 3 && !startedOver && this.#exchangeTooLong(budgetArgs)) {
        flags.push('context_split');
        return finishOk('', 'other', 'context');
      }
      const call = await this.#callModel({ runId, conversationId, chain, start: index, snapshot, signal, counters, flags, compaction, kind, forbid, effort, started: config, startedMode: ctx.permissionMode, project: ctx.project, memoryProject: ctx.memoryProject });
      if (!call.ok) {
        if (call.cancelled) return this.#finishCancelled(runId, conversationId, counters, call.route ?? lastRoute, call.partial);
        if (call.usage) addUsage(call.usage);
        return finishFail(call.failure);
      }
      index = call.index;
      lastRoute = chain[index]!;
      lastEstimate = call.estimate;
      addUsage(call.usage);
      // 考える部分を別に返すモデル（Qwen3 など）は、答えの頭に空行が付く。保存する前に落とす
      const lead = /^\s*/u.exec(call.text)![0];
      const space = cutTexts.length > 0 && /[ \t]/u.test(lead) && !/\s$/u.test(cutTexts.at(-1)!);
      const rest = call.text.slice(lead.length);
      call.text = space && rest ? ` ${rest}` : rest;

      // 出力の上限で切れた返事: 黙って成功にしない。お知らせと実行の印を残し、付いていたツール呼び出しは動かさない
      // （切れた元の文字は記録の入力欄にだけ残し、会話には {} で保存する。次の呼び出しにも、提供元に断られる切れた文字を送らない）
      const cutRaw = new Map<string, string>();
      if (call.truncated) {
        if (!flags.includes('output_truncated')) flags.push('output_truncated');
        if (call.toolCalls.length && !warnedToolCut) {
          warnedToolCut = true;
          d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_truncated', message: engineText(languageOf(config), 'warn.output_truncated') });
        }
        for (const c of call.toolCalls) cutRaw.set(c.id, c.raw ?? JSON.stringify(c.arguments ?? null));
        call.toolCalls = call.toolCalls.map(c => ({ id: c.id, name: c.name, arguments: {} }));
      }
      const language = languageOf(config);
      const ask: ChatMessage = { role: 'user', content: engineText(language, 'message.continue'), generated: true, note: 'continue' };
      // 文の無い返事は続けようがない（考えるだけで上限に達した返事は、#callModel が上げられるところまで上限を上げてやり直した残り）
      const empty = !call.toolCalls.length && cutTexts.length > 0 && !call.text;
      if (!call.toolCalls.length && call.truncated && !call.text && !cutTexts.length) {
        d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_thinking_only', message: engineText(language, 'warn.output_thinking_only') });
        return finishOk('', 'max_tokens');
      }
      const room = !call.toolCalls.length && call.truncated && continuations < MAX_CONTINUATIONS
        && this.#continuationFits({ runId, conversationId, snapshot, model: lastRoute.model, kind, forbid, started: config, startedMode: ctx.permissionMode, project: ctx.project, memoryProject: ctx.memoryProject }, [{ role: 'assistant', content: resumePoint(call.text) }, ask]);
      if (room) {
        const kept = resumePoint(call.text);
        cutTail = call.text.slice(kept.length);
        call.text = kept;
      }
      if (empty) call.text = cutTail;
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: call.text, ...(call.toolCalls.length ? { toolCalls: call.toolCalls } : {}), ...(call.thinking ? { thinking: call.thinking } : {}) }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
      if (!call.toolCalls.length) {
        if (empty) {
          d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_continue_empty', message: engineText(language, 'warn.output_continue_empty') });
          return finishOk(cutTexts.join('') + call.text, 'max_tokens');
        }
        if (room) {
          continuations++;
          cutTexts.push(call.text);
          if (continuations === 1) d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_continued', message: engineText(language, 'warn.output_continued') });
          const asked = d.conversations.append(conversationId, ask, runId);
          d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: asked.id, role: 'user' });
          continue;
        }
        if (call.truncated && continuations < MAX_CONTINUATIONS) {
          d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_continue_no_room', message: engineText(language, 'warn.output_continue_no_room') });
        } else if (call.truncated) {
          d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_continue_limit', message: engineText(language, 'warn.output_continue_limit', { count: MAX_CONTINUATIONS }), params: { count: MAX_CONTINUATIONS } });
        }
        return finishOk(cutTexts.join('') + call.text, call.stop);
      }
      cutTexts.length = 0;
      if (!d.tools) return finishOk(call.text, call.stop);

      let invalidThisRound = 0;
      let askedOwner = false;
      for (const toolCall of call.toolCalls) {
        if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
        counters.toolCalls++;
        if (!toolCall.name.startsWith('task_') && toolCall.name !== 'tool_search') counters.workCalls++;
        // この結果に許す量は、次のモデル呼び出しの残りの余裕から決める（結果が積まれるほど小さくなる）
        const budget = this.#toolResultTokens({ runId, conversationId, snapshot, model: lastRoute.model, kind, forbid, started: config, startedMode: ctx.permissionMode, project: ctx.project, memoryProject: ctx.memoryProject });
        ctx.outputTokens = budget.tokens;
        ctx.contextAvailable = budget.available;
        ctx.model = { id: lastRoute.model.id, vision: lastRoute.model.vision };
        const outcome = await callTool(toolCall, cutRaw.has(toolCall.id) ? { message: engineText(languageOf(config), toolCall.name === 'skill_draft' ? 'tool.truncated_skill_draft' : 'tool.truncated_call'), raw: cutRaw.get(toolCall.id)! } : undefined);
        recordTaint();
        countDone(toolCall.name, outcome);
        if (outcome.invalidArguments) invalidThisRound++;
        if (toolCall.name === 'ask_owner' && !outcome.output.isError) askedOwner = true;
        const toolSaved = d.conversations.append(conversationId, {
          role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: outcome.output.content, ...(outcome.output.isError ? { isError: true } : {}), ...(outcome.gate ? { gate: outcome.gate } : {}),
          ...(!outcome.output.isError && outcome.output.images?.length ? { images: outcome.output.images } : {}),
        }, runId);
        d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: toolSaved.id, role: 'tool' });
      }
      if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
      // タスクの終え方（完了・途中経過・質問）が決まったら、モデルを呼び直さずに終える
      if (task && task.control.value.outcome !== 'none') return finishOk(call.text, 'end_turn');
      if (kind === 'chat' && askedOwner) {
        flags.push('asked_owner');
        return finishOk(call.text, 'end_turn');
      }
      invalidStreak = invalidThisRound === call.toolCalls.length ? invalidStreak + 1 : 0;
      if (invalidStreak >= MAX_INVALID_STREAK) {
        const language = languageOf(config);
        return finishFail({ kind: 'provider_error', message: engineText(language, 'tool.invalid_streak', { count: MAX_INVALID_STREAK }), code: 'engine.tool.invalid_streak', params: { count: MAX_INVALID_STREAK }, retryable: false, detail: { reason: 'prompt_exceeds', hint: engineText(language, 'tool.invalid_streak_hint') } });
      }
      // 切れが続くなら、同じことを繰り返させず止める（上限を大きくする案内。invalid_streak の案内は出さない）
      truncatedStreak = cutRaw.size ? truncatedStreak + 1 : 0;
      if (truncatedStreak >= MAX_INVALID_STREAK) {
        return finishFail({ kind: 'provider_error', message: engineText(languageOf(config), 'tool.truncated_streak', { count: MAX_INVALID_STREAK }), code: 'engine.tool.truncated_streak', params: { count: MAX_INVALID_STREAK }, retryable: false });
      }
    }
    flags.push('max_iterations');
    counters.iterations = ceiling;
    return finishOk('', 'other', 'max_iterations');
  }

  // 自動承認の判定役に見せる、会話の利用者の最後の発言（添付の中身は除く）。無ければ空（判定役には回らず、確かめる）
  #lastUserRequest(conversationId: string): string {
    const stored = this.#d.conversations.messages(conversationId, 50);
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'user' && !message.generated && !message.note) return stripAttachments(message.content).slice(0, USER_REQUEST_LIMIT);
    }
    return '';
  }

  // 会話の持ち主の発言（最後の 50 行のうち、generated でも note でもない user の行。添付の中身は除く）
  #ownerTexts(conversationId: string): string[] {
    return this.#d.conversations.messages(conversationId, 50)
      .filter(({ message }) => message.role === 'user' && !message.generated && !message.note && !message.askAnswer)
      .map(({ message }) => stripAttachments(message.content));
  }

  // いちばん新しい持ち主の発言より後に、ask_owner の札（誤りでない結果）があるか。読めなければ「ある」側（持ち主の文に数えない）
  #askOpen(conversationId: string): boolean {
    try {
      const messages = this.#d.conversations.messages(conversationId, 50);
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!.message;
        if (message.role === 'user' && !message.note) return false;
        if (message.role === 'tool' && message.name === 'ask_owner' && !message.isError) return true;
      }
      return false;
    } catch { return true; }
  }

  // 自動承認の判定役（モデル）を 1 回呼び、返事の文字を返す。呼べなければ投げる（呼ぶ側は確かめる側に倒す）。
  // 使うのは、この実行がいま使っているモデル（route）だけで、ほかのモデルは探さない。道具は渡さない。
  // 判定役の呼び出しは engine_runs に入れず、会話も作らない
  async #autoAsk(route: Route, prompt: ClassifierPrompt, signal: AbortSignal, call?: JudgeCall): Promise<string | JudgeReply> {
    const config = this.#d.config();
    const named = config.routing.judge ?? [];
    const routes: Route[] = named.length
      ? named.flatMap(id => {
        const model = config.models.find(m => m.id === id);
        const provider = model && config.providers.find(p => p.id === model.provider);
        return model && provider ? [{ model, provider }] : [];
      })
      : [route];
    if (!routes.length) throw new NoJudge('no judge model is set up');
    let failure: unknown = new NoJudge('no judge model could be called');
    for (const [index, candidate] of routes.entries()) {
      const own = index < routes.length - 1 && call ? new AbortController() : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => own?.abort(signal.reason);
      if (own) signal.addEventListener('abort', stop, { once: true });
      const step: JudgeCall | undefined = own && call ? {
        answerMs: call.answerMs, slotWaitMs: call.slotWaitMs, queued: () => call.queued(), used: (id, usage) => call.used?.(id, usage),
        started: () => { timer = setTimeout(() => { call.queued(); own.abort(new Error('the judge model did not answer in time')); }, call.answerMs); call.started(); },
      } : call;
      try {
        const answer = await this.#askJudge(candidate, prompt, own?.signal ?? signal, step);
        if (own?.signal.aborted) throw own.signal.reason;
        return answer;
      } catch (error) {
        if (signal.aborted || error instanceof TruncatedReply) throw error;
        failure = error;
      } finally {
        clearTimeout(timer);
        if (own) signal.removeEventListener('abort', stop);
      }
    }
    throw failure;
  }

  async #askJudge(route: Route, prompt: ClassifierPrompt, signal: AbortSignal, call?: JudgeCall): Promise<JudgeReply> {
    const d = this.#d;
    const { model, provider } = route;
    const adapter = d.registry.get(provider.id);
    if (!adapter) throw new Error('no adapter for the classifier model');
    let release: (() => void) | undefined;
    try {
      call?.queued();
      release = await d.limiter.acquire(provider.id, () => provider.maxParallel, signal, true);
      call?.started();
      let text = '';
      let usage: Usage = {};
      for await (const event of adapter.stream({
        model, system: { frozen: prompt.system, dynamic: '', tail: '' }, messages: [{ role: 'user', content: prompt.user }], tools: [], maxOutputTokens: Math.min(400, d.status.limits(model).maxOutput), signal,
      })) {
        if (event.type === 'text') text += event.delta;
        else if (event.type === 'usage') { usage = { ...usage, ...event.usage }; call?.used?.(model.id, usage); }
        else if (event.type === 'done' && event.stop === 'max_tokens') throw new TruncatedReply();
      }
      // 返事の短い理由は承認の記録・画面の出来事・実行ログの API に出るので、API キーそのものは、読む前に伏せる
      return { text: redactExact(text, d.registry.secrets()), model: model.id, usage };
    } finally { release?.(); }
  }

  // 会話の実行が終わるとき、会話で進んだ分をタスクの経過（メモ）に書く。書く先は次のとおりで、何にも触っていなければ何も書かない:
  // - この実行で作った・task_update で触ったタスク（作る以外の道具を使った実行だけ。作っただけの確認の返事はメモにしない）
  // この実行が止めたタスク（preempted）は、止めただけでは書かない（止めるのは、同じモデルの提供元を使っているだけで、別の会話のタスクかもしれない）。触ったときだけ書き、そのとき実行中のままの状態（running）も許す
  // 外から読んだ実行（taint）は書かない: メモはタスクの詳細に入り、外を読んでいないタスクの実行が指示として読むため
  #handOver(runId: string, text: string, run: { workCalls: number; touched: ReadonlySet<string>; tainted: boolean; projectId: string | null }): void {
    const d = this.#d;
    const note = text.trim();
    if (!d.tasks || !note || run.tainted) return;
    const preempted = new Set(this.#preemptedTasks.get(runId) ?? []);
    const targets = new Set<string>();
    if (run.workCalls > 0) for (const id of run.touched) targets.add(id);
    if (!targets.size) return;
    const language = languageOf(d.config());
    for (const id of targets) {
      const task = d.tasks.get(id);
      if (!task || (task.project_id ?? null) !== run.projectId) continue;
      const open = preempted.has(id) ? ['ready', 'running', 'waiting'] : ['ready', 'waiting'];
      if (!open.includes(task.status)) continue;
      d.tasks.update(id, { appendNote: engineText(language, 'handover.note', { text: note.slice(0, 1500) }) }, 'beat', runId);
    }
  }

  async #callModel(p: { runId: string; conversationId: string; chain: Route[]; start: number; snapshot: string; signal: AbortSignal; counters: { attempts: number }; flags: string[]; compaction: CompactionState; kind: RunKind; forbid?: ReadonlySet<string> | undefined; effort?: string | null | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }): Promise<CallResult> {
    const d = this.#d;
    const sleep = d.sleep ?? abortableSleep;
    // 考えるだけで上限に達して捨てた呼び出しの使用量（成功でも失敗でも実行の使用量に足す）。上限を上げるのは 1 回の呼び出しで 1 度だけ
    const spent: Usage = {};
    let raisedOnce = false;
    const retries = d.retriesPerModel ?? d.config().routing.retriesPerModel;
    const language = languageOf(d.config());
    let last: Failure = { kind: 'internal', message: engineText(language, 'run.no_model'), code: 'engine.run.no_model', retryable: false };
    for (let index = p.start; index < p.chain.length; index++) {
      const route = p.chain[index]!;
      const { model, provider } = route;
      if (index > p.start) {
        d.bus.publish({ type: 'model.switch', runId: p.runId, conversationId: p.conversationId, from: p.chain[index - 1]!.model.id, to: model.id, reason: last.message });
        if (!p.flags.includes('fallback')) p.flags.push('fallback');
        d.log?.(`[WARN] model ${p.chain[index - 1]!.model.id} was not available, switching to ${model.id}: ${last.message.split('\n')[0]}`);
      }
      const adapter = d.registry.get(provider.id);
      if (!adapter) { last = { kind: 'internal', message: engineText(language, 'run.no_provider', { id: provider.id }), code: 'engine.run.no_provider', params: { id: provider.id }, retryable: false, route }; continue; }

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (p.signal.aborted) return { ok: false, cancelled: true, partial: '', failure: last, route };
        p.counters.attempts++;
        const { toolDefs, listed, system, pending, history, replay, stored, conversation, apiTools, capacity, available, maxOutput, planned, factor } = this.#assemble({ runId: p.runId, conversationId: p.conversationId, snapshot: p.snapshot, model, kind: p.kind, forbid: p.forbid, started: p.started, startedMode: p.startedMode, project: p.project, memoryProject: p.memoryProject, sendTail: true });
        const run = this.#loaded.get(p.runId);
        if (run) {
          run.sent.clear();
          for (const tool of toolDefs) run.sent.add(tool.name);
        }
        const toolNames = new Set([...toolDefs.map(t => t.name), ...listed.map(t => t.name), ...(run?.loaded ?? [])]);
        // 考える深さは、そのモデルが受け付ける値のときだけ送る（鎖の途中で別のモデルに替わったとき、受け付けない値を送らない）
        const effort = p.effort && modelEfforts(model, d.status.get(model.id)).includes(p.effort) ? p.effort : undefined;
        let fitted;
        try {
          fitted = fitMessages({ system: systemText(system), messages: history, tools: apiTools, available, factor, tail: pending });
        } catch (error) {
          if (!(error instanceof ContextOverflow)) throw error;
          last = { kind: 'context_overflow', message: engineText(language, 'fit.overflow', { required: error.required.toLocaleString('en-US'), available: error.available.toLocaleString('en-US') }), code: 'engine.fit.overflow', params: { required: error.required, available: error.available }, retryable: false, route,
            detail: { reason: 'prompt_exceeds', measured: available, required: error.required, hint: engineText(language, 'hint.prompt_exceeds') } };
          break;
        }
        // 外す発言が多ければ、外す部分を前の要約に足して要約し直してから組み立て直す（同じ実行の中でも、外す発言が増えたらまた。
        // 1 回の実行で MAX_COMPACTIONS_PER_RUN 回まで。要約に失敗したら、その実行は外すだけにして、要約を呼び続けない）
        if (fitted.removed >= COMPACT_MIN_MESSAGES && !p.compaction.failed && p.compaction.count < MAX_COMPACTIONS_PER_RUN) {
          p.compaction.count++;
          const removed = stored.slice(0, fitted.removed);
          const ok = await this.#compact({ route, adapter, runId: p.runId, conversationId: p.conversationId, removed, previous: conversation?.summary ?? null, capacity, signal: p.signal });
          if (ok) {
            // お知らせは 1 回の実行で 1 回ずつ。件数は、この実行で要約した発言の合計に更新する（画面は同じお知らせを置き換える）
            p.compaction.summarized += removed.length;
            d.bus.publish({ type: 'compaction', runId: p.runId, conversationId: p.conversationId, summarized: p.compaction.summarized });
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'compacted', message: engineText(language, 'warn.compacted', { count: p.compaction.summarized }), params: { count: p.compaction.summarized } });
            if (!p.flags.includes('compacted')) p.flags.push('compacted');
            attempt--; continue;
          }
          p.compaction.failed = true;
        }
        if (fitted.removed > 0) {
          if (p.compaction.trimmedShown !== fitted.removed) {
            p.compaction.trimmedShown = fitted.removed;
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'context_trimmed', message: engineText(language, 'warn.context_trimmed', { count: fitted.removed }), params: { count: fitted.removed } });
          }
          if (!p.flags.includes('context_trimmed')) p.flags.push('context_trimmed');
        }

        let text = '';
        let usage: Usage = {};
        let stop: StopReason = 'other';
        const toolCalls: ToolCall[] = [];
        const thoughts: ThinkingBlock[] = [];
        let release: (() => void) | undefined;
        try {
          release = await d.limiter.acquire(provider.id, () => provider.maxParallel, p.signal);
          for await (const event of adapter.stream({ model, system, messages: fitted.messages, tools: apiTools, maxOutputTokens: maxOutput, ...(effort ? { effort } : {}), signal: p.signal })) {
            if (event.type === 'text') { text += event.delta; d.bus.publish({ type: 'text.delta', runId: p.runId, conversationId: p.conversationId, text: event.delta }); }
            else if (event.type === 'usage') usage = { ...usage, ...event.usage };
            else if (event.type === 'tool_call') toolCalls.push(event.call);
            else if (event.type === 'thinking') thoughts.push(event.block);
            else if (event.type === 'done') stop = event.stop;
          }
        } catch (error) {
          const e = error instanceof ProviderError ? error
            : p.signal.aborted ? providerError('cancelled', 'cancelled', {}, { retryable: false })
            : providerError('internal', 'unexpected', {}, { retryable: false, upstream: redactSecrets((error as Error).message, d.registry.secrets()).slice(0, UPSTREAM_KEEP) });
          if (e.kind === 'cancelled' || p.signal.aborted) return { ok: false, cancelled: true, partial: text, failure: last, route };
          last = { kind: e.kind, message: e.text(language), ...(e.code ? { code: `provider.${e.code}`, params: e.params } : {}), retryable: e.retryable, route, ...(e.detail ? { detail: e.detail } : {}), ...(e.upstream ? { upstream: e.upstream } : {}) };
          if (text) {
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'partial_discarded', message: engineText(language, 'warn.partial_discarded') });
            break;
          }
          if (e.retryable && attempt < retries) {
            const wait = Math.min(e.retryAfterMs ?? 1000 * 2 ** attempt, MAX_BACKOFF_MS);
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'retrying', message: engineText(language, 'warn.retrying', { message: e.text(language), seconds: Math.ceil(wait / 1000), attempt: attempt + 1, retries }), params: { seconds: Math.ceil(wait / 1000), attempt: attempt + 1, retries, ...(e.code ? { errorCode: `provider.${e.code}`, errorParams: e.params } : { detail: e.message }) } });
            try { await sleep(wait, p.signal); } catch { return { ok: false, cancelled: true, partial: '', failure: last, route }; }
            continue;
          }
          break;
        } finally { release?.(); }

        // 考えるだけで上限に達し、文も呼び出しも無い返事は、続きを頼んでも続ける元が無い（切れた考える部分は保存も送り返しもしない）。
        // 上げられるなら、捨てて同じ呼び出しを上げた上限でやり直す。上げるのは 1 回の呼び出しで 1 度、上限は planned だけから決まる頭打ち
        // （raisedOutputFor）までで、いまのやり取り（古い発言を外しても残る分）が入りきる量を超えない
        if (stop === 'max_tokens' && !text.trim() && !toolCalls.length && !raisedOnce && capacity > 0) {
          const room = Math.floor(capacity * CONTEXT_FILL_RATIO) - irreducibleEstimate({ system: systemText(system), messages: fitted.messages, tools: apiTools, factor, tail: pending }).tokens;
          const raised = Math.min(raisedOutputFor(model, capacity, planned, d.status.get(model.id)?.maxOutput), room);
          if (raised > maxOutput) {
            raisedOnce = true;
            const caps = this.#outputCap.get(p.runId) ?? new Map<string, number>();
            caps.set(model.id, raised);
            this.#outputCap.set(p.runId, caps);
            addUsageTo(spent, usage);
            if (!p.flags.includes('output_raised')) p.flags.push('output_raised');
            d.log?.(`[INFO] model ${model.id} used the whole output limit (${maxOutput}) on thinking; retrying the call with ${raised}`);
            attempt--; continue;
          }
        }

        // 本文に書かれたツール呼び出しを拾う（tool_calls を使わずに本文に書いたモデル）
        if (!toolCalls.length && toolNames.size && looksLikeTextToolCall(text)) {
          const parsed = extractToolCalls(text, toolNames);
          if (parsed.calls.length) {
            toolCalls.push(...parsed.calls);
            text = parsed.text;
            if (!p.flags.includes('text_tool_calls')) p.flags.push('text_tool_calls');
          }
        }
        // 送り返した考える部分の量は見積もりでしかない（API の数え方と合うとは限らない）ので、その呼び出しでは切り捨ての疑いも補正の学習もしない
        if (!replay) this.#checkTruncation(p.runId, p.conversationId, model, fitted.estimate, usage, capacity, p.flags);
        if (effort && !p.flags.includes(`effort:${effort}`)) p.flags.push(`effort:${effort}`);
        // 考える部分は、上限で切れていない返事の、署名のあるブロックだけ持つ（上限で切れたブロックにも署名は付くが、途中で切れた考えを次の呼び出しに送り返さない）
        const signed = stop === 'max_tokens' ? [] : thoughts.filter(b => b.type === 'redacted_thinking' || b.signature);
        const thinking: ThinkingRecord | undefined = signed.length
          ? { provider: provider.id, model: model.model, blocks: signed, tokens: Math.max(0, (usage.outputTokens ?? 0) - estimateMessageTokens({ role: 'assistant', content: text, toolCalls })) }
          : undefined;
        // truncated は書き換える前の停止理由で決める（ツール呼び出しが付いても、出力の上限で切れた返事は切れたまま）
        return { ok: true, index, text, toolCalls, usage: addUsageTo({ ...spent }, usage), stop: toolCalls.length ? 'tool_use' : stop, truncated: stop === 'max_tokens', estimate: fitted.estimate.tokens, ...(thinking ? { thinking } : {}) };
      }
    }
    return { ok: false, cancelled: false, partial: '', failure: last, usage: spent };
  }

  // モデルへ送る 1 回分の組み立て（system・履歴・道具の仕様・見積もりの補正）。実行（#callModel）と使用量（contextUsage）の両方がここを通るので、数がずれない。
  // 何も書かない。固定の system（snapshot）は呼ぶ側が渡す
  // startedMode: 実行を始めたときの権限モード（実行の中でだけ渡す。使用量の数え方は次の実行のためなので、会話のいまのモードで数える）
  #assemble(p: { runId?: string | undefined; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined; sendTail?: boolean }) {
    const d = this.#d;
    const { model } = p;
    const config = d.config();
    const language = languageOf(config);
    const mode = this.#modeFor(p.kind, p.conversationId, p.startedMode);
    const frozen = this.#frozen(p.project?.id);
    const loaded = p.runId ? this.#loaded.get(p.runId)?.loaded : this.#defers(p.kind, p.forbid, p.started) ? new Set<string>() : undefined;
    const toolDefs = this.#toolsFor(p.kind, p.forbid, p.started, mode, p.project !== undefined || p.memoryProject !== undefined, frozen, loaded);
    const listed = loaded && toolDefs.some(t => t.name === 'tool_search') ? this.#deferred(p.kind, p.forbid, p.started, mode, p.project !== undefined || p.memoryProject !== undefined, frozen) : [];
    const deferred = deferredSection(listed, config);
    const specs = ToolRegistry.specs(toolDefs, config);
    const { capacity, maxOutput: planned } = d.status.limits(model);
    // 考えるだけで上限に達してこの実行で上げた上限は、上げたそのモデルにだけ（予備のモデルに替わったら引き継がない）、使える量の見積もりすべてに効かせる
    const raisedCap = p.runId ? this.#outputCap.get(p.runId)?.get(model.id) : undefined;
    const maxOutput = raisedCap ? Math.min(raisedOutputFor(model, capacity, planned, d.status.get(model.id)?.maxOutput), Math.max(planned, raisedCap)) : planned;
    const available = contextAvailable(capacity, maxOutput);
    const conversation = d.conversations.get(p.conversationId);
    const upto = conversation?.summary_upto ?? 0;
    const stored = d.conversations.messages(p.conversationId).filter(m => m.id > upto);
    const summary = summarySection(conversation?.summary ?? '', language);
    const checklist = checklistSection(readChecklist(d.kv, p.conversationId), language);
    const background = backgroundSection(d.background?.list({ conversationId: p.conversationId }) ?? [], language);
    const row = p.project?.root ? d.projects?.get(p.project.id) : undefined;
    const planMemory = p.kind === 'chat' && mode === 'plan' && row?.archived_at === null && !d.botMemory && d.memoryFiles ? (config.memory.review ? 'review' as const : 'off' as const) : undefined;
    const worktree = p.project?.worktree && p.project.productRoot ? { branch: p.project.worktree.branch, productRoot: p.project.productRoot } : undefined;
    const product = row && p.project?.root ? { name: row.name, root: p.project.root, docLanguage: row.doc_language, memory: planMemory, worktree } : undefined;
    const mesh = this.#meshIndex(p.runId, p.project, available, p.conversationId);
    const requirements = p.kind === 'chat' && product && mode === 'plan' ? requirementsText(d.paths, available) : '';
    // dynamic は実行のあいだ変わらない部分だけ（日付まで）。時刻・Checklist・裏のコマンドは tail へ（S1。dynamic が変わると後ろの履歴が全部書き直しになる）
    const now = d.now?.() ?? new Date();
    const fence = this.#fence(p.runId);
    const dynamic = [buildDynamic(config.timezone, language, now, mode, product, requirements), deferred, mesh, p.runId ? fence.clean(summary) : summary].filter(Boolean).join('\n\n');
    const sections = { checklist, background };
    const system = { frozen: p.snapshot, dynamic, tail: fenceTail(buildTail(config.timezone, language, now, sections), fence.nonce) };
    const apiTools = specs;
    const factor = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
    // 考える部分を送り返すかはここだけで決め、呼び出し・道具の結果の量・続きの見積もり・使用量の表示が同じ履歴を使う。
    // 送り返すのは、それを書いた提供元・モデルへ送り、要約の無い会話で、考える部分の量も数えて古い発言を 1 つも外さずに入りきるときだけ（前の発言が変わると API が断る）
    // 実行の中では、道具の結果・発言から実行の nonce を消す（tail の印を装えないように）
    let history = stored.map(m => withThinkingFor(clean(forModel(m.message), p.runId ? fence : undefined), conversation?.summary ? undefined : { provider: model.provider, model: model.model }));
    // この実行で発言に付けて送った tail は、同じ発言に同じ文で付け直す。モデルを呼ぶとき（sendTail）だけ、変わった分を最後の user / tool の発言に付けて覚える
    const tails = p.runId ? this.#runTail.get(p.runId) ?? { attached: new Map<number, string>(), carriers: {} } : undefined;
    const withTails = (list: ChatMessage[]) => (tails?.attached.size ? list.map((m, i) => { const tail = tails.attached.get(stored[i]!.id); return tail !== undefined && m.role !== 'assistant' ? { ...m, tail } : m; }) : list);
    history = withTails(history);
    if (tails && p.sendTail) {
      const last = stored.at(-1);
      if (last && last.message.role !== 'assistant' && !tails.attached.has(last.id)) {
        // いまの文を載せた発言が、要約で消えたか、削られて送る範囲から外れるなら、前に送ったことにしないで全部を付け直す（削る量は全体の tail を足した多めの見積もり）
        const carried = Object.values(tails.carriers);
        let lost = false;
        if (carried.length) {
          let removed = 0;
          try { removed = fitMessages({ system: systemText(system), messages: history, tools: apiTools, available, factor, tail: system.tail }).removed; } catch (error) { if (!(error instanceof ContextOverflow)) throw error; }
          const window = new Set(stored.slice(removed).map(m => m.id));
          lost = carried.some(id => !window.has(id));
        }
        const next = nextTail(lost ? undefined : tails.sent, config.timezone, language, now, sections);
        if (next) {
          if (lost) tails.carriers = {};
          tails.carriers.time = last.id;
          for (const key of ['checklist', 'background'] as const) {
            if (lost || (tails.sent?.[key] ?? '') !== sections[key]) { if (sections[key]) tails.carriers[key] = last.id; else delete tails.carriers[key]; }
          }
          tails.attached.set(last.id, fenceTail(next.text, fence.nonce)); tails.sent = next.sent; this.#runTail.set(p.runId!, tails);
          history = withTails(history);
        }
      }
    }
    // 古い Anthropic の考えるモデル（stripsThinkingOnText）に考える部分を送り返すとき、adapter は tail を全部 system の後ろに置く。
    // 送り返すかは adapter が最後に決めるので、ここでは送り返しうるとき全体の tail も数える（多めの見積もり）
    const oldThinking = config.providers.find(x => x.id === model.provider)?.kind === 'anthropic' && stripsThinkingOnText(model.model) && history.some(m => m.role === 'assistant' && m.thinking);
    // まだ発言に付けていない、次に送る tail（見積もり用）。モデルを呼ぶときは、付けた分は発言が数えるので、system の後ろに置くとき（最後が assistant）だけ。
    // それ以外（使用量・道具の結果の量・続きの見積もり）は、次の呼び出しで付きうる全体
    const pending = !p.sendTail || oldThinking || stored.at(-1)?.message.role === 'assistant' ? system.tail : '';
    let replay = false;
    if (history.some(m => m.role === 'assistant' && m.thinking)) {
      try { replay = fitMessages({ system: systemText(system), messages: history, tools: apiTools, available, factor, tail: pending }).removed === 0; } catch (error) { if (!(error instanceof ContextOverflow)) throw error; }
      if (!replay) history = history.map(m => withThinkingFor(m));
    }
    return { toolDefs, listed, system, pending, history, replay, stored, conversation, apiTools, capacity, available, maxOutput, planned, factor };
  }

  // 道具の結果 1 つに許す量（見積もりのトークン）。次の呼び出しで古い発言を全部外しても残る分（system・道具の仕様・いまのやり取り）を、
  // そのモデルの available から引いた余裕の一部（context-budget.ts の toolResultTokens）。モデルの容量が分からなければ undefined（文字数の上限だけ）。何も書かない
  #toolResultTokens(p: { runId: string; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }): { tokens: number | undefined; available: number | undefined } {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return { tokens: undefined, available: undefined };
    const { tokens } = irreducibleEstimate({ system: systemText(built.system), messages: built.history, tools: built.apiTools, factor: built.factor, tail: built.pending });
    return { tokens: toolResultTokens(built.available, tokens, built.factor), available: built.available };
  }

  // タスクの実行を区切るか: いまのやり取り（固定の分を除く）が、使える量から固定の分を引いた余裕の SPLIT_EXCHANGE_RATIO を超えた。容量が分からなければ区切らない
  #exchangeTooLong(p: { runId: string; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }): boolean {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return false;
    const system = `${built.system.frozen}\n${built.system.dynamic}`;
    const fixed = estimateRequest(system, [], built.apiTools, built.factor).tokens;
    const exchange = irreducibleEstimate({ system, messages: built.history, tools: built.apiTools, factor: built.factor }).tokens - fixed;
    return exchange > SPLIT_EXCHANGE_RATIO * (built.available - fixed);
  }

  #continuationFits(p: { runId: string; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }, pending: ChatMessage[]): boolean {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return true;
    const { tokens } = irreducibleEstimate({ system: systemText(built.system), messages: [...built.history, ...pending], tools: built.apiTools, factor: built.factor, tail: built.pending });
    return tokens <= built.available;
  }

  #meshIndex(runId: string | undefined, project: ToolContext['project'], available: number, conversationId: string): string {
    const mesh = this.#d.mesh;
    if (!mesh || !project) return '';
    let body = runId ? this.#runIndex.get(runId) : undefined;
    if (body === undefined) {
      body = '';
      try { body = mesh.indexBody(project.id, meshIndexLimit(available), conversationId); } catch (error) { this.#d.log?.(`[WARN] Could not build the mesh index of product ${project.id}: ${(error as Error).message}`); }
      if (runId) this.#runIndex.set(runId, body);
    }
    if (!body) return '';
    return wrapMeshIndex(body, this.#fence(runId).nonce);
  }

  // 実行ごとの印（mesh の索引と tail が同じ nonce を使う）。実行の外（使用量）は同じ長さの仮の nonce
  #fence(runId: string | undefined): ReturnType<typeof makeFence> {
    if (!runId) return makeFence(PLACEHOLDER_NONCE);
    let nonce = this.#runFence.get(runId);
    if (!nonce) { nonce = newNonce(); this.#runFence.set(runId, nonce); }
    return makeFence(nonce);
  }

  // いまの会話を次に送るとき、モデルへ送る量（トークンの見積もり）。古い発言を削る前の全体で、available（削り始める境目）に対する割合 ratio は 1 を超えうる。
  // 副作用を持たない: 無い会話を作らず、固定の system が無い会話は固定せず（そのとき作るはずの文で数える）、ファイルの版も書かない。
  contextUsage(conversationId: string, modelId?: string): ContextUsageOutcome {
    const d = this.#d;
    const config = d.config();
    const language = languageOf(config);
    let model: ModelConfig | undefined;
    const existing = d.conversations.get(conversationId);
    // 数えるモデル: 指定されたもの → 会話で選んだもの → 設定の順番の先頭の使えるもの。選んだモデルが使えなくても、ほかのモデルで数えない
    const wanted = modelId ?? existing?.model_id ?? undefined;
    if (wanted !== undefined) {
      model = config.models.find(m => m.id === wanted);
      if (!model) {
        if (modelId === undefined) return this.#noUsableModel(this.#chain('chat', wanted).problems);
        return { ok: false, httpStatus: 404, errorKind: 'not_found', errorMessage: engineText(language, 'usage.model_missing', { id: wanted }), errorCode: 'engine.usage.model_missing', errorParams: { id: wanted } };
      }
      if (!(d.status.limits(model).capacity > 0)) {
        return this.#noUsableModel([{ modelId: model.id, status: 'unknown', message: engineText(language, 'problem.unchecked'), messageCode: 'engine.problem.unchecked' }]);
      }
    } else {
      const chain = this.#chain('chat');
      model = chain.usable.map(r => r.model).find(m => d.status.limits(m).capacity > 0);
      if (!model) return this.#noUsableModel(chain.problems);
    }
    const project = runProject(d.projects, d.conversations.projectOf(conversationId));
    const snapshot = existing?.snapshot ?? this.#buildSnapshotText(language, conversationId, project).text;
    const built = this.#assemble({ conversationId, snapshot, model, kind: 'chat', project });
    const { tokens } = estimateRequest(systemText(built.system), built.history, built.apiTools, built.factor, built.pending);
    return { ok: true, modelId: model.id, tokens, available: built.available, capacity: built.capacity, ratio: tokens / built.available };
  }

  // 子の担当（agent_run）を 1 本動かして、答えを親の道具の結果として返す。親はここで待つ（親が待つあいだ limiter の枠は持たない: 枠は #callModel の中だけで取る）。
  // 失敗・止め・時間切れは、親を止めずに、エラーの結果として返す。子の担当は孫を作れない（ctx.agent は子に渡さず、childForbid に agent_run を入れる）
  async #runAgent(p: { ctx: ToolContext; routes: Route[]; forbid: ReadonlySet<string> | undefined }, input: AgentRunInput, callId: string | undefined): Promise<ToolOutput> {
    const d = this.#d;
    const parent = p.ctx;
    const config = parent.config;
    const language = languageOf(config);
    const fail = (key: ToolMessageKey, params?: MessageParams, fetched = false): ToolOutput => ({ content: toolText(language, key, params), isError: true, ...(fetched ? { fetched: true } : {}) });
    // 親が始めたあとに設定で切られていても、子は始めない（入口は実行の開始時に決まるので、ここでいまの設定を確かめ直す）
    const scout = parent.scout === true;
    if (!d.tools || !p.routes.length || (!scout && agentOff(d.config(), parent.kind))) return fail('agent.unavailable');
    const endScout = (why: ScoutEnd): void => { if (!scout) return; this.#scoutEnds.set(parent.runId, why); this.stop(parent.runId); };
    // 数の歯止め（どちらも、始めずにエラーで返す。待たない）
    const spawned = this.#agentSpawned.get(parent.runId) ?? 0;
    if (spawned >= config.tools.agent.maxPerRun) { endScout('agents_used'); return fail('agent.too_many', { max: config.tools.agent.maxPerRun }); }
    let live = 0;
    for (const active of this.#active.values()) if (active.kind === 'agent') live += 1;
    if (live >= MAX_LIVE_AGENTS) { endScout('agents_busy'); return fail('agent.busy'); }
    // 子に渡せる道具 = 親に渡りうる道具（tool_search で読み込んだかに関わらない）∩ allowedIn に 'agent' を明示した道具 ∩ 入力の tools（狭めるだけ）
    const mode: PermissionMode = parent.kind === 'chat' ? stricterMode(parent.permissionMode ?? 'auto', this.#modeOf(parent.conversationId)) : 'auto';
    const givable = this.#toolsFor(parent.kind, p.forbid, config, mode, parent.project !== undefined, this.#frozen(parent.project?.id)).filter(t => t.allowedIn.includes('agent'));
    const givableNames = new Set(givable.map(t => t.name));
    if (input.tools) {
      const unknown = [...new Set(input.tools)].filter(name => !givableNames.has(name));
      if (unknown.length) return fail('agent.unknown_tools', { names: unknown.join(', ') });
    }
    const granted = new Set(input.tools ?? [...givableNames]);
    const childForbid = scout ? new ScoutAllow(granted, ['agent_run']) : new Set<string>([...(p.forbid ?? []), 'agent_run']);
    if (!scout) for (const name of d.tools.registry.names()) if (!granted.has(name)) childForbid.add(name);

    const title = plainLine(input.title ?? input.task, AGENT_CHILD_TITLE_MAX) || plainLine(input.task, AGENT_CHILD_TITLE_MAX) || 'agent';
    const childRunId = randomUUID();
    const child = d.conversations.create({ title, kind: 'task', source: { conversationId: parent.conversationId }, parentRunId: parent.runId, projectId: d.conversations.projectOf(parent.conversationId) });
    const saved = d.conversations.append(child.id, { role: 'user', content: `${engineText(language, 'agent.preamble')}\n\n${input.task}` });
    d.bus.publish({ type: 'message.saved', runId: childRunId, conversationId: child.id, messageId: saved.id, role: 'user' });
    // 親が外から読んでいたら、子もその状態で始める
    if (parent.taint.tainted || d.conversations.everTainted(parent.conversationId)) this.#initialTaint.set(childRunId, [engineText(language, 'taint.parent')]);
    if (parent.kind === 'chat') this.#modeHost.set(child.id, parent.conversationId);
    this.#agentSpawned.set(parent.runId, spawned + 1);
    const kids = scout ? this.#scoutChildren.get(parent.runId) ?? { spawned: 0, ok: 0 } : undefined;
    if (kids) { kids.spawned += 1; kids.area = title; this.#scoutChildren.set(parent.runId, kids); }

    const emit = (state: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout', toolCalls = 0) => d.bus.publish({
      type: 'agent.state', runId: parent.runId, conversationId: parent.conversationId, callId: callId ?? '', childRunId, childConversationId: child.id, state, toolCalls,
    });
    this.#start(childRunId, child.id, p.routes, 'agent', undefined, childForbid, scout ? config.scout?.effort ?? null : null, { parent, mode });
    emit('running');
    const why: { value?: 'timeout' | 'parent' } = {};
    const timeoutMs = d.agentTimeoutMs ?? (scout ? SCOUT_AGENT_TIMEOUT_MS : config.tools.agent.timeoutSec * 1000);
    const timer = setTimeout(() => { why.value ??= 'timeout'; this.stop(childRunId); }, timeoutMs);
    const onParentAbort = () => { why.value ??= 'parent'; this.stop(childRunId); };
    parent.signal.addEventListener('abort', onParentAbort, { once: true });
    if (parent.signal.aborted) onParentAbort();
    let result: EngineResult;
    try { result = await this.#active.get(childRunId)!.done; } finally { clearTimeout(timer); parent.signal.removeEventListener('abort', onParentAbort); }
    await d.background?.stopWhere({ conversationId: child.id }).catch(() => 0);

    const row = d.runs.get(childRunId);
    const toolCalls = row?.tool_calls ?? 0;
    // 子が外から読んでいたら、親も外から読んだことにする（結果に fetched を付ける。pipeline が tool 名を sources に足す）
    const fetched = row?.tainted === 1;
    if (why.value === 'timeout') { emit('timeout', toolCalls); return fail('agent.timeout', { sec: Math.round(timeoutMs / 1000) }, fetched); }
    if (why.value === 'parent' || (!result.ok && result.errorKind === 'cancelled')) { emit('cancelled', toolCalls); return fail('agent.stopped', undefined, fetched); }
    if (!result.ok) { emit('failed', toolCalls); return fail('agent.failed', { reason: result.errorMessage }, fetched); }
    const flags = (() => { try { return JSON.parse(row?.flags ?? '[]') as string[]; } catch { return []; } })();
    if (flags.includes('max_iterations')) { emit('failed', toolCalls); return fail('agent.max_iterations', { max: UNATTENDED_ITERATION_CEILING }, fetched); }
    const open = toolText(language, 'agent.result_open');
    const close = toolText(language, 'agent.result_close');
    // 子の答えに区切りの文字が入っていても、親には区切りとして読ませない（全角にする）
    let body = result.text.trim().replaceAll(open, toFullWidth(open)).replaceAll(close, toFullWidth(close));
    if (!body) body = toolText(language, 'agent.empty');
    // 文字数の上限と、親に残っている余裕（トークン）の、先に達した方で切る。区切りと注記の分は先に引く
    // （パイプラインの切りに閉じの区切りが巻き込まれないよう、ここで包みの中に収める）
    const truncated = toolText(language, 'agent.truncated');
    // 子の最後の返事が出力の上限で切れていたら、完了した答えに見えないよう、包みの頭に決まった注を足し、親の会話にも知らせる
    const cutNote = result.truncated ? `${toolText(language, 'agent.output_truncated')}\n` : '';
    const room = Math.max(0, (parent.outputTokens ?? Infinity) - estimateTextTokens(`${open}\n${cutNote}\n${truncated}\n${close}`) - 16);
    const shown = prefixLength(body, AGENT_RESULT_MAX_CHARS, room);
    if (shown < body.length) body = `${body.slice(0, shown)}\n${truncated}`;
    if (result.truncated) d.bus.publish({ type: 'warning', runId: parent.runId, conversationId: parent.conversationId, code: 'agent_output_truncated', message: engineText(language, 'warn.agent_output_truncated') });
    emit('done', toolCalls);
    if (kids) kids.ok += 1;
    return { content: `${open}\n${cutNote}${body}\n${close}`, ...(fetched ? { fetched: true } : {}) };
  }
  // 会話のいまの権限モード。子の担当の会話は、任せた親の会話のモードを見る（子の会話自身のモードは使わない）
  #modeOf(conversationId: string): PermissionMode { return this.#d.conversations.modeOf(this.#modeHost.get(conversationId) ?? conversationId); }

  #modeFor(kind: RunKind, conversationId: string, startedMode: PermissionMode | undefined): PermissionMode {
    const current = this.#modeOf(conversationId);
    return kind === 'chat' || kind === 'agent' ? stricterMode(startedMode ?? current, current) : 'auto';
  }

  #defers(kind: RunKind, forbid: ReadonlySet<string> | undefined, started: AppConfig | undefined): boolean {
    const search = this.#d.tools?.registry.get('tool_search');
    return (kind === 'chat' || kind === 'task') && search !== undefined && search.mcp === undefined && search.allowedIn.includes(kind)
      && !this.#excluded(kind, forbid, started)(search);
  }

  #finishCancelled(runId: string, conversationId: string, counters: { attempts: number; iterations: number; toolCalls: number }, route: Route, partial: string): EngineResult {
    const d = this.#d;
    const language = languageOf(d.config());
    if (partial.trim()) {
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: `${partial}\n\n${engineText(language, 'message.stopped_partway')}` }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
    }
    d.runs.finish(runId, { ok: false, attempts: counters.attempts, iterations: counters.iterations, toolCalls: counters.toolCalls, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), modelId: route.model.id, providerId: route.provider.id, model: route.model.model });
    d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled' });
    return { ok: false, runId, text: '', errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled', retryable: false };
  }

  async #compact(c: { route: Route; adapter: ProviderAdapter; runId: string; conversationId: string; removed: StoredMessage[]; previous: string | null; capacity: number; signal: AbortSignal }): Promise<boolean> {
    const d = this.#d;
    const language = languageOf(d.config());
    const transcript = c.removed.map(m => `${compactSpeaker(m.message, language)}: ${m.text.slice(0, m.message.role === 'user' && m.message.note !== undefined ? COMPACT_NOTE_CHARS : 1500)}`).join('\n').slice(-COMPACT_TRANSCRIPT_CHARS);
    const prompt = compactPrompt({ previous: c.previous, transcript }, language);
    const maxOutputTokens = Math.min(2000, d.status.limits(c.route.model).maxOutput);
    if (estimateTextTokens(prompt) * 1.15 + maxOutputTokens > c.capacity * CONTEXT_FILL_RATIO) return false;
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(c.route.provider.id, () => c.route.provider.maxParallel, c.signal);
      let text = '';
      for await (const event of c.adapter.stream({
        model: c.route.model, system: { frozen: compactSystem(language), dynamic: '', tail: '' },
        messages: [{ role: 'user', content: prompt }], tools: [], maxOutputTokens, signal: c.signal,
      })) if (event.type === 'text') text += event.delta;
      if (!text.trim()) return false;
      d.conversations.setSummary(c.conversationId, text.trim(), c.removed.at(-1)!.id);
      return true;
    } catch {
      if (c.signal.aborted) return false;
      d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'compaction_failed', message: engineText(language, 'warn.compaction_failed') });
      return false;
    } finally { release?.(); }
  }

  #snapshot(conversationId: string, project: ToolContext['project'], scout = false): string {
    const d = this.#d;
    const existing = d.conversations.get(conversationId)?.snapshot;
    if (existing) return existing;
    recordFileVersions(d.conversations.db, d.paths);
    const language = languageOf(d.config());
    const snapshot = this.#buildSnapshotText(language, conversationId, project, d.log, scout);
    d.conversations.setSnapshotOnce(conversationId, snapshot.text, snapshot.hash);
    return d.conversations.get(conversationId)?.snapshot ?? snapshot.text;
  }

  // 会話の始めに固定する system の文。作るだけで、何も書かない
  #buildSnapshotText(language: Language, conversationId: string, project: ToolContext['project'], log?: (line: string) => void, scout = false) {
    const d = this.#d;
    const product = d.conversations.projectOf(conversationId) !== null;
    const root = project?.root ? project.productRoot ?? project.root : undefined;
    const rootKey = root && project ? d.projects?.get(project.id)?.root_key : undefined;
    return buildSnapshot(d.paths, {
      ...(d.botMemory && d.memory && !scout ? { memories: renderBooks(d.memory.list(), language, this.memoryBudget()) } : {}),
      ...(d.skills ? { skills: d.skills.index(language) } : {}),
      ...(product ? { persona: false, instructions: root && rootKey ? instructionsSection(readInstructions(root, instructionsBudget(this.#smallestAvailable()), log, rootKey)) : undefined } : {}),
    }, language);
  }

  #checkTruncation(runId: string, conversationId: string, model: ModelConfig, estimate: { raw: number; tokens: number }, usage: Usage, capacity: number, flags: string[]): void {
    const d = this.#d;
    const actual = usage.inputTokens;
    if (typeof actual !== 'number' || actual <= 0) return;
    const key = `truncation:${model.id}`;
    if (estimate.tokens > TRUNCATION_MIN_ESTIMATE && actual < estimate.tokens * TRUNCATION_RATIO) {
      const strikes = (d.kv.getJson<number>(key) ?? 0) + 1;
      d.kv.setJson(key, strikes);
      if (!flags.includes('server_truncation_suspected')) flags.push('server_truncation_suspected');
      const language = languageOf(d.config());
      const params = { actual: actual.toLocaleString('en-US'), estimate: estimate.tokens.toLocaleString('en-US') };
      const message = engineText(language, 'warn.server_truncation', params);
      d.bus.publish({ type: 'warning', runId, conversationId, code: 'server_truncation_suspected', message, params });
      if (strikes >= TRUNCATION_STRIKES) {
        d.status.disable(model.id, engineText(language, 'truncation.disable', { message, strikes }));
      }
      return;
    }
    d.kv.delete(key);
    // 切り捨てが起こりえない範囲（容量の半分未満）でだけ、実測との比を学習する
    if (capacity > 0 && estimate.tokens < capacity * 0.5 && estimate.raw > 200) {
      const ratio = Math.min(2, Math.max(0.5, actual / estimate.raw));
      const previous = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
      d.kv.setJson(`calibration:${model.id}`, Number((previous * (1 - CALIBRATION_ALPHA) + ratio * CALIBRATION_ALPHA).toFixed(4)));
    }
  }
}
