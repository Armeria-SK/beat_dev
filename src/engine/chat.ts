import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { DEFAULT_LANGUAGE, isRuntimeModel, providerModels, providerOf, type AppConfig, type Language, type ModelConfig, type ProviderConfig, type ProviderModelConfig, type RuntimeModelConfig } from '../config/schema.ts';
import type { ConversationRow, Conversations, StoredMessage } from '../db/conversations.ts';
import { transaction } from '../db/database.ts';
import type { KV } from '../db/kv.ts';
import { fileReadLog } from '../tools/builtin/files.ts';
import type { Runs } from '../db/runs.ts';
import { conversationSawOutside } from '../db/outside.ts';
import type { AppPaths } from '../paths.ts';
import { redactExact, redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { EndpointLimiter } from '../providers/limiter.ts';
import { UPSTREAM_KEEP, upstreamText } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, providerError, type ModelRequest, type ProviderAdapter } from '../providers/types.ts';
import { stripsThinkingOnText } from '../providers/anthropic.ts';
import { renderBooks, type MemoryStore } from '../memory/store.ts';
import type { ProductMemory } from '../memory/files.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import { JudgeRefused, NoJudge, TruncatedReply, USER_REQUEST_LIMIT, type ClassifierPrompt, type JudgeCall, type JudgeReply } from '../tools/auto-approve.ts';
import { checklistInjects, checklistSection, readChecklist } from '../tools/builtin/checklist-core.ts';
import { acceptanceAllows, planAllows, reviewAllows, runToolCall, type JudgeLimitSet } from '../tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { PlanStore } from '../projects/plan.ts';
import { meshIndexLimit, meshStatusSection, wrapMeshIndex, type Mesh } from '../mesh/index.ts';
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
import { growSkills, skillsIndexBudget, type SkillStore } from '../tools/skills/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import type { ResearchSession } from '../research/evidence.ts';
import { CreatedFiles } from '../projects/created.ts';
import type { PendingStore } from '../pending/store.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { gateText } from '../shared/messages/gate.ts';
import type { RunBus } from './bus.ts';
import type { RuntimeChecks } from '../runtimes/checks.ts';
import type { RuntimeRegistry } from '../runtimes/registry.ts';
import type { RuntimeApprovals } from './runtime-approvals.ts';
import { runRuntimeTurn, runtimeFolder, runtimePreflight, type RuntimeRefusal, type RuntimeTurnDeps } from './runtime-bridge.ts';
import { runtimePlanTools } from './runtime-plan-tools.ts';
import { COMPACT_FAILURE_LIMIT, CONTEXT_FILL_RATIO, CONTEXT_TARGET_RATIO, KEEP_TOOL_RESULTS, MEMORY_BUDGET_RATIO, PERSONA_BUDGET_RATIO, SPLIT_EXCHANGE_RATIO, clearFloor, compactOutputTokens, contextAvailable, ownerWordsTokens, raisedOutputFor, toolResultTokens } from './context-budget.ts';
import { modelEfforts } from './efforts.ts';
import { closeToolCalls, ContextOverflow, fitMessages, groupExchanges, irreducibleEstimate } from './fit.ts';
import type { ModelStatus } from './status.ts';
import { extractToolCalls, looksLikeTextToolCall } from './toolcall-parse.ts';
import type { AttachmentMeta, ChatMessage, ContextDetail, EngineErrorKind, EngineResult, ImageRef, StopReason, ThinkingBlock, ThinkingRecord, ToolCall, ToolSpec, Usage } from './types.ts';
import { estimateMessageTokens, estimateRequest, estimateTextTokens, prefixLength } from './tokens.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import { openPendingIds } from '../tasks/pending-wake.ts';
import { buildSection, type BuildLine } from '../tasks/build-status.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../shared/messages/tools.ts';
import { plainLine, stripHidden } from '../shared/plain-text.ts';
import { compactPrompt, compactRequest, compactSpeaker, compactSystem, composeSummary, hasSummarySections, quoteOwner, summarySection } from './prompts.ts';
import { buildDynamic, buildSnapshot, buildTail, fenceTail, isFencedTail, nextTail, recordFileVersions, requirementsText, type TailSent } from './workspace.ts';
import { instructionsBudget, instructionsSection, readInstructions } from '../projects/instructions.ts';
import { languageName } from '../projects/build.ts';
import { ownWords, stripAttachments, Uploads } from '../uploads/store.ts';
import type { RunJob } from '../os/run-job.ts';

export { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, contextAvailable };
export const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 2048;
const TRUNCATION_STRIKES = 2;
const CALIBRATION_ALPHA = 0.3;
const MAX_BACKOFF_MS = 30_000;
const MAX_INVALID_STREAK = 3;
export const MAX_CONTINUATIONS = 3;
const PENDING_WAIT_MS = 4 * 60_000;
// モデルを呼んでから（提供元の枠を取ったあと）最初の出来事が来ないまま、これだけたったら「黙っている」と知らせる。知らせるだけで打ち切らない
const MODEL_SILENT_MS = 60_000;
const RESUME_WORD_MAX = 40;
// 自動承認の判定役の呼び出しの出力の上限。考えを文で書くモデルは、答え（最後の行の JSON）の前に切れていた。切れたときだけ、同じ枠のまま 1 回、JUDGE_OUTPUT_RAISED まで上げて呼び直す（どちらもモデルの上限までで、それ以上は上げない）
export const JUDGE_OUTPUT_TOKENS = 1024;
export const JUDGE_OUTPUT_RAISED = 4096;

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

// 保存した発言をモデルに渡す形にする。gate は渡さない。imageIds の画像は、置き場のファイルから images に戻す（ファイルが無ければ、その画像だけ渡さない）
function forModel(message: ChatMessage, load: (id: string) => ImageRef | undefined): ChatMessage {
  if (message.role !== 'tool' || (!message.gate && !message.imageIds)) return message;
  const { gate: _gate, imageIds, ...rest } = message;
  const images = [...(rest.images ?? []), ...(imageIds ?? []).flatMap(id => load(id) ?? [])];
  return images.length ? { ...rest, images } : rest;
}
const clean = (message: ChatMessage, fence: ReturnType<typeof makeFence> | undefined): ChatMessage =>
  (fence && message.role !== 'assistant' && message.content.toLowerCase().includes(fence.nonce.toLowerCase()) ? { ...message, content: fence.clean(message.content) } : message);
// 消した結果の印に書く入力の要点の長さ（TE-4）
const CLEARED_INPUT_CHARS = 160;
// 印の要点に要る分だけ残した入力（長い文字列・多い要素を先に切る）。文字列は見えない文字を消して空白を詰めた見える長さで切り、鍵の名前も見えない文字を消す
// （切った所は 1 行の要点の 160 字よりずっと後ろになり、鍵の名前の伏せ字が効く）
function boundedInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return plainLine(value, CLEARED_INPUT_CHARS * 4);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 8) return '…';
  if (Array.isArray(value)) return value.slice(0, 40).map(item => boundedInput(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [stripHidden(key), boundedInput(item, depth + 1)]));
}
// 消した結果の印の入力の要点（保存してある呼び出しの入力から作る。伏せ字と印の nonce を消すのは呼ぶ側）
function inputGist(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args !== 'object' || Array.isArray(args)) return JSON.stringify(args);
  return Object.entries(args).map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(', ');
}
const withdrawOnly = (store: PendingStore | undefined): Pick<PendingStore, 'row' | 'withdraw'> | undefined =>
  store ? { row: id => store.row(id), withdraw: (id, reason) => store.withdraw(id, reason) } : undefined;
// 道具の結果が書いている全文のファイルの場所。道具・パイプラインの注記は結果の最後に付くので最後の 1 つを見て、tool_outputs の中に留まるときだけ（replay.ts と同じ確かめ）
function fullRefIn(content: string, dir: string): string | undefined {
  const at = content.lastIndexOf(dir);
  if (at < 0) return undefined;
  const ref = /^[^\s\]]+/u.exec(content.slice(at))![0].replace(/[.,;:]+$/u, '');
  return resolve(ref).startsWith(resolve(dir) + sep) ? ref : undefined;
}
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
// beat 8-6a: 直す実行に渡す道具（許す一覧）。読む・書く・表・シェル（裏のコマンドは shell.ts が断る）・mesh を読む・計算。Web・ブラウザ・MCP・agent_run・task_*・question_add・proposal_add・ledger_record は渡さない
export const FIX_TOOLS: ReadonlySet<string> = new Set(['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'table_write', 'shell_run', 'mesh_read', 'mesh_search', 'calculate', 'date_calc']);
class FixAllow extends AllBut {}
// beat R (D1): 調べる実行に渡す道具（許す一覧）。Web を読むことと記録だけ。製品のフォルダ・mesh・記憶・agent_run・tool_search は渡さない
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch', 'research_record']);
class ResearchAllow extends AllBut {}
export interface ResearchPrompt { prompt: string; followUp?: string | undefined }
// 直す実行の置き場（写しの行）。root は写し、productRoot は本体
export interface FixPlace { id: string; path: string; productRoot: string; branch: string; base: string; ceiling: string; job?: RunJob }
export const SCOUT_AGENT_TIMEOUT_MS = 1_800_000;
export type ScoutEnd = 'agents_busy' | 'agents_used';
export interface ScoutRoute { modelId: string; providerId: string; local: boolean; room: boolean; available: number | undefined }

// 1 回の実行で要約を重ねられる回数。外す発言が増えるたびに要約し直すが、無限には繰り返さない
const MAX_COMPACTIONS_PER_RUN = 5;
// 1 つの会話で、実行中に待たせておける発言の数
const MAX_PENDING_MESSAGES = 10;
const COMPACT_TRANSCRIPT_CHARS = 60_000;
const COMPACT_NOTE_CHARS = 300;
// 要約の「触ったファイル」の数と、1 つのパスの字数の上限（TE-5）
const FILES_TOUCHED_MAX = 50;
const FILE_PATH_CHARS = 300;
const HISTORY_READ = 'history_read';
// 1 回のモデルの呼び出しで削り（TE-4 の #reduce）をやり直してよい回数
const MAX_REDUCTIONS_PER_CALL = 10;
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
  // P5: このタスクの待ちの行のうち古くなったものを閉じる（app.ts の sweepStale）
  pendingSweep?: ((taskId: string) => Promise<Array<{ id: number; reason: string }>>) | undefined;
  // P6: 承認待ちだけが残った実行が、決めを待つ時間（ミリ秒）。試験で短くするためだけの上書き。ふつうは 4 分
  pendingWaitMs?: number | undefined;
  // 最初の出来事が来ないモデルを「黙っている」と知らせるまでの時間（ミリ秒）。試験で短くするためだけの上書き。ふつうは 60 秒
  modelSilentMs?: number | undefined;
  // 外の実行役（AR-7）。無ければ、実行役のモデルは会話で使えない
  runtimes?: { registry: RuntimeRegistry; checks: RuntimeChecks } | undefined;
  // 止めると言ってから、実行役の終わりの知らせを待つ時間（ミリ秒）。試験で短くするためだけの上書き。ふつうは 15 秒
  runtimeStopGraceMs?: number | undefined;
  // 実行役の承認の求めの待ちの控え（AR-8a）。無ければ、実行役の承認の求めは全部断る
  runtimeApprovals?: RuntimeApprovals | undefined;
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

type Route = { model: ProviderModelConfig; provider: ProviderConfig; backup?: boolean };

interface ChatItem { content: string; images: ImageRef[]; attachments: AttachmentMeta[]; generated?: true; askAnswer?: true }

const userMessage = ({ content, images, attachments, generated, askAnswer }: ChatItem): ChatMessage => ({ role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}), ...(generated ? { generated } : {}), ...(askAnswer ? { askAnswer } : {}) });
// held: 実行が始まったあとに会話のモデルか権限モードが替わり、そのあとに送られた発言。今の実行（古いモデルの鎖・古いモードの実行）へは差し込まず、実行が終わってから新しいモデル・新しいモードの実行で読ませる
// afterStop: 今の実行を止めたあとに送られた発言。止めた実行が終わるのを待って、新しい実行を始める（止める前に待たせた発言は、保存だけ）
interface PendingMessage extends ChatItem { id: string; interrupt: boolean; createdAt: number; held: boolean; afterStop: boolean }

export type ContextUsageOutcome =
  | { ok: true; modelId: string; tokens: number; available: number; capacity: number; ratio: number }
  | (Extract<SendOutcome, { ok: false }> & { errorParams?: MessageParams });

// 製品の中の実行（計画モードを除く）が頭で先読みする道具の名前（browser-rethink P1）。何も書かない（先読み・使用量・mesh-probe の見積もりが同じ答えを使う）
// ブラウザの道具は、会話と裏方で使えるいちばん小さいモデルと、この実行のモデル自身の、使える量の小さい方（smallestAvailable）がこの値以上のときだけ先読みする（それより小さい・分からないときは tool_search で読む。fixed-prompt-trim S1）
const BROWSER_PRELOAD_MIN_AVAILABLE = 85_000;
export function usualTools(tools: readonly ToolDef[], inProduct: boolean, mode: PermissionMode, model: Pick<ModelConfig, 'vision'>, smallestAvailable: number | undefined): string[] {
  if (!inProduct || mode === 'plan') return [];
  const preloadBrowser = smallestAvailable !== undefined && smallestAvailable >= BROWSER_PRELOAD_MIN_AVAILABLE;
  const browser = preloadBrowser ? tools.filter(t => !t.mcp && isBrowserTool(t.name)).map(t => t.name) : [];
  return [...browser, 'pending_withdraw', 'deviation_add', ...(model.vision === true ? ['image_view'] : [])];
}

// 会話（チャット）や裏の作業が、どのモデルを順に試すか。順番が空なら設定のモデル全部（モデルが 0 個なら空）。
// 送信の画像の可否の確かめも、これを使う（エンジンと確かめの候補を食い違わせない）。
export function candidateModelIds(config: AppConfig, route: 'chat' | 'background'): string[] {
  const preferred = route === 'background' && config.routing.background.length ? config.routing.background : config.routing.chat;
  return preferred.length ? [...preferred] : providerModels(config).map(m => m.id);
}

// 会話の tail の状態（kv の tail-state:<会話>。TE-1）: 最後に送った節と時刻、時刻・各節のいまの文を載せている発言の id（要約・削りでその発言が送る範囲から外れたら、全部を付け直す）
// tainted: 外から読んだ一覧・裏のコマンドの節を載せた tail の発言の id（その tail は以後も送るので、要約で外れるまで次の実行を「外から読んだ」で始める）
interface TailState { sent?: TailSent; carriers: Partial<Record<'time' | 'checklist' | 'background' | 'product' | 'build', number>>; tainted?: Partial<Record<'checklist' | 'background', number[]>> }
// 1 回の実行の要約の状態: 要約した回数・失敗したか（失敗したら外すだけ）・要約した発言の合計・要約せずに外した発言の合計
interface CompactionState { count: number; failed: boolean; summarized: number; trimmed: number }

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
  // 会話の実行が始まるときに止めた実行の数（タスクの無い振り返りなども含む）。実行の始まりに 1 回だけ画面へ知らせる
  #pausedCount = new Map<string, number>();
  #initialTaint = new Map<string, string[]>();
  #reviewEvidence = new Map<string, NonNullable<ToolContext['reviewEvidence']>>();
  #scoutEnds = new Map<string, ScoutEnd>();
  #researchSessions = new Map<string, ResearchSession>();
  #scoutChildren = new Map<string, { spawned: number; ok: number; area?: string }>();
  // 会話のチャットの実行が始まったときに選ばれていたモデル（null は自動）。待たせる発言が、そのあとのモデルの変更より後かを見分けるのに使う
  #runModel = new Map<string, string | null>();
  // 会話のチャットの実行が始まったときの権限モード。待たせる発言が、そのあとのモードの変更より後かを見分けるのに使う（モデルと同じ決まり）
  #runMode = new Map<string, PermissionMode>();
  #runFence = new Map<string, string>();
  #runIndex = new Map<string, { list: string; status: string[] }>();
  // この実行が tail を付けた発言の id（実行の前から tail を持つ最後の発言に、新しい tail が要るときだけ付け替えるため）
  #runTail = new Map<string, Set<number>>();
  #loaded = new Map<string, { loaded: Set<string>; sent: Set<string> }>();
  #sentCalls = new Map<string, ReadonlySet<string>>();
  // その実行で、提供元が読み（cacheReadTokens > 0）を報告したモデルの ID（TE-5: 要約を前半のあとに頼む形は、読みが効くと分かったモデルだけ）
  #cacheSeen = new Map<string, Set<string>>();
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
  #noteWaiters = new Map<string, () => void>();
  lastUserActivity = 0;
  onRunEnd: ((run: { runId: string; conversationId: string; kind: RunKind }) => void) | undefined;

  readonly created: CreatedFiles;

  constructor(deps: ChatEngineDeps) { this.#d = deps; this.created = new CreatedFiles({ kv: deps.kv, dataDir: deps.paths.data, ...(deps.log ? { log: deps.log } : {}) }); }

  #imageStore?: Uploads;
  #images(): Uploads {
    const d = this.#d;
    return this.#imageStore ??= new Uploads(d.conversations.db, d.paths.uploads, () => (d.now?.() ?? new Date()).getTime());
  }

  // 道具の結果の画像は、添付と同じ置き場（uploads の行とファイル）に置き、発言には id だけ残す（base64 のまま入れると messages.parts が大きくなる）。置けなかった画像は、失わないよう base64 のまま残す
  #storeImages(tool: string, images: ImageRef[]): { ids: string[]; inline: ImageRef[] } {
    const ids: string[] = [];
    const inline: ImageRef[] = [];
    for (const image of images) {
      try { ids.push(this.#images().save({ name: tool, mime: image.mediaType, body: Buffer.from(image.data, 'base64') }).id); } catch (error) {
        this.#d.log?.(`[WARN] Could not put an image of ${tool} in the uploads folder; kept it in the message: ${(error as Error).message}`);
        inline.push(image);
      }
    }
    return { ids, inline };
  }

  // 読めない画像は、モデルに渡さず、画像ごとに 1 回だけ知らせる（#assemble は 1 つの返事のあいだに何度も動く）
  #imageLost = new Set<string>();
  #loadImage(id: string): ImageRef | undefined {
    try {
      const upload = this.#images().get(id);
      if (upload?.kind !== 'image') throw new Error('it is not in the uploads table');
      return this.#images().image(upload);
    } catch (error) {
      if (!this.#imageLost.has(id)) {
        this.#imageLost.add(id);
        this.#d.log?.(`[WARN] Could not read the image ${id} of a tool result; the model will not see it: ${(error as Error).message}`);
      }
      return undefined;
    }
  }

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
    if (images.length > 0 && this.#runtimeConversation(this.#d.conversations.get(conversationId))) return this.#refuse({ key: 'runtime.no_images' });
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

  // beat R (R3.13 の 1): 新しい発言を足さずに、会話の最後の発言へ返事の実行を始める。会話が動いていれば断る（呼ぶ側は確かめてから同期で呼ぶ）
  reply(conversationId: string): SendOutcome {
    if (this.#byConversation.has(conversationId)) return this.#busy('send.busy_chat');
    const row = this.#d.conversations.get(conversationId);
    if (!row) return { ok: false, httpStatus: 404, errorKind: 'not_found', errorMessage: 'conversation not found' };
    if (this.#runtimeConversation(row)) return this.#refuse({ key: 'runtime.no_retry' });
    return this.#beginChat(conversationId, [], {});
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
    const route = this.#runtimeRoute(conversationId, existing, pinned);
    if (route && 'refused' in route) return route.refused;
    // 自動（モデルを選んでいない）で先頭が実行役のモデルでも、製品の無い会話は、使える提供元のモデルがあればそちらで返す（実行役の会話は製品の会話だけ）
    const noProduct = (existing ? existing.project_id : projectId ?? null) === null;
    if (route && !(route.auto && noProduct && this.#chain('chat', pinned).usable.length)) return this.#beginRuntimeChat(conversationId, items, choice, projectId, existing, route);
    const chain = this.#chain('chat', pinned);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    // ユーザーが同じ id へ新しく送ったときは、消したばかりの会話の覚えを外す（動いていた実行の遅れた書き込みだけを見送るため）
    this.#d.conversations.reopen(conversationId);
    if (existing) {
      if (hasChoice(choice)) this.#d.conversations.setChoice(conversationId, choice);
    } else {
      this.#d.conversations.ensure(conversationId, { projectId, modelId: choice.modelId, effort: choice.effort, permissionMode: this.#newConversationMode(choice, projectId) });
    }
    const runId = randomUUID();
    this.#notePreempted(runId, preempted);
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
    return { ok: true, runId, ...(firstId !== undefined ? { messageId: firstId } : {}) };
  }

  // The mode a new conversation starts in when the send names none: plan for a product that has no plan yet, else auto (provider and runtime routes alike)
  #newConversationMode(choice: SendChoice, projectId: string | undefined): PermissionMode {
    return choice.permissionMode ?? (projectId !== undefined && this.#d.plans?.has(projectId) === false ? 'plan' : 'auto');
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
    return d.memory ? { db: d.conversations.db, memory: d.memory, tasks: d.tasks, curiosity: d.curiosity, skills: d.skills, plans: d.plans, acceptance: d.acceptance, projects: d.projects, mesh: d.mesh, questions: d.questions, memoryFiles: d.memoryFiles, web: d.web, notify: d.notify, browser: d.browser, background: d.background, pending: withdrawOnly(d.tools?.pending), emit: e => d.bus.publish(e) } : undefined;
  }

  // 書く・動かす道具が動いたあと、このタスクの待ちの行のうち古くなったものを閉じ、道具の結果の末尾で担当に知らせる（P5）
  async #sweepAfter<T extends { decision: string; output: ToolOutput }>(taskId: string | undefined, name: string, config: AppConfig, outcome: T): Promise<T> {
    const tool = this.#d.tools?.registry.get(name);
    if (!taskId || !this.#d.pendingSweep || outcome.decision !== 'allow' || !tool || !(tool.effect === 'write' || tool.effect === 'exec' || tool.writesFiles)) return outcome;
    let closed: Array<{ id: number; reason: string }>;
    try { closed = await this.#d.pendingSweep(taskId); } catch (error) {
      this.#d.log?.(`[WARN] Could not check the Pending items of task ${taskId}: ${(error as Error).message}`);
      return outcome;
    }
    if (!closed.length) return outcome;
    const lines = closed.map(c => pendingText(languageOf(config), 'swept', { id: c.id, reason: c.reason }));
    return { ...outcome, output: { ...outcome.output, content: [outcome.output.content, ...lines].join('\n\n') } };
  }

  addNote(conversationId: string, content: string, fetched: boolean): void {
    if (!this.#d.conversations.get(conversationId)) return;
    if (this.#byConversation.has(conversationId)) {
      const queue = this.#notes.get(conversationId) ?? [];
      queue.push({ content, fetched });
      this.#notes.set(conversationId, queue);
      this.#noteWaiters.get(conversationId)?.();
      return;
    }
    this.#saveNote(conversationId, { content, fetched });
  }

  #waitForNote(conversationId: string, ms: number, signal: AbortSignal): Promise<boolean> {
    if (this.#notes.get(conversationId)?.length) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const done = (woke: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        if (this.#noteWaiters.get(conversationId) === wake) this.#noteWaiters.delete(conversationId);
        resolve(woke);
      };
      const wake = () => done(true);
      const stop = () => done(false);
      const timer = setTimeout(stop, ms);
      signal.addEventListener('abort', stop, { once: true });
      this.#noteWaiters.set(conversationId, wake);
    });
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
    return (this.#d.background?.list({ conversationId }).some(job => job.tainted === true) ?? false) || this.#tailCarriesTaint(conversationId, 'background');
  }

  #checklistCarriesTaint(conversationId: string): boolean {
    const list = readChecklist(this.#d.kv, conversationId);
    return (list?.tainted === true && checklistInjects(list)) || this.#tailCarriesTaint(conversationId, 'checklist');
  }

  // 外から読んだ節を載せて保存した tail が、まだ送る範囲（要約より後）にあるか（TE-1。一覧を済ませても消しても、その tail は送り続ける）
  #tailCarriesTaint(conversationId: string, key: 'checklist' | 'background'): boolean {
    const ids = this.#d.kv.getJson<TailState>(`tail-state:${conversationId}`)?.tainted?.[key] ?? [];
    if (!ids.length) return false;
    const upto = this.#d.conversations.get(conversationId)?.summary_upto ?? 0;
    const find = this.#d.conversations.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id = ?');
    return ids.some(id => id > upto && find.get(conversationId, id) !== undefined);
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
    if (this.#runtimeConversation(conversation)) return this.#refuse({ key: 'runtime.no_retry' });
    const chain = this.#chain('chat', conversation?.model_id ?? null);
    if (!chain.usable.length) return this.#noUsableModel(chain.problems);
    const preempted = this.#preemptFor(chain.usable);
    this.lastUserActivity = this.#d.now?.().getTime() ?? Date.now();
    const runId = randomUUID();
    this.#notePreempted(runId, preempted);
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
    // 会話の実行も数える（会話の返事を書いている提供元に、考える実行を重ねない。`backgroundHasRoom` と同じ数え方）
    let running = 0;
    for (const active of this.#active.values()) if (active.primary === first.provider.id) running += 1;
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

  // beat 8-6a: 直す実行。考える実行と同じ 1 本（routing.scout）で、写しの中だけを書く。始めから外を読んだ扱い（提案の文は Web から来た）
  runFix(task: Task, conversationId: string, prompt: string, modelId: string, place: FixPlace, materials: string): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
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
    this.#start(runId, conversationId, [{ model: route.model, provider: route.provider }], 'task', { task, control: { value: { outcome: 'none' } }, fix: place }, new FixAllow(FIX_TOOLS, []), this.#d.config().scout?.effort ?? null);
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  // beat R (D1・D4): 調べる実行の 1 つの部分。見えない行と調べる会話で動き、Pending にも判定役にも回さない。モデルは routing.research、無ければ計画の会話の組（pinned か routing.chat）
  researchRoute(pinned: string | null): ScoutRoute | null {
    const first = this.#chain('research', pinned).usable[0];
    if (!first) return null;
    const { capacity, maxOutput } = this.#d.status.limits(first.model);
    let host = '';
    try { host = first.provider.baseUrl ? new URL(first.provider.baseUrl).hostname : ''; } catch { host = ''; }
    return { modelId: first.model.id, providerId: first.provider.id, local: host !== '' && isLoopbackHost(host), room: true, available: capacity > 0 ? contextAvailable(capacity, maxOutput) : undefined };
  }

  runResearch(task: Task, conversationId: string, prompt: ResearchPrompt, options: { pinned: string | null; session: ResearchSession; initialTaint?: readonly string[] | undefined; tools?: ReadonlySet<string> | undefined }): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const chain = this.#chain('research', options.pinned);
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const runId = randomUUID();
    if (prompt.prompt) {
      const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt.prompt });
      this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    if (prompt.followUp) {
      const extra = this.#d.conversations.append(conversationId, { role: 'user', content: prompt.followUp, generated: true });
      this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: extra.id, role: 'user' });
    }
    if (options.initialTaint?.length) this.#initialTaint.set(runId, [...options.initialTaint]);
    this.#researchSessions.set(runId, options.session);
    const allowed = options.tools ? new Set([...options.tools].filter(name => RESEARCH_TOOLS.has(name))) : RESEARCH_TOOLS;
    this.#start(runId, conversationId, chain.usable, 'task', { task, control: { value: { outcome: 'none' } } }, new ResearchAllow(allowed, []), null);
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
  // 数えるのは、動いている実行（会話・子の担当・裏の実行）の「最初に使う提供元」（道具を動かしている最中で limiter の枠を返しているものも含む）。
  // 会話の実行も数える（会話で埋まった提供元に、裏の実行を重ねない。`#preemptFor` が数える範囲と同じ）。使えるモデルが無いときは true（始めて、いつもの失敗の道に任せる）
  backgroundHasRoom(): boolean {
    const first = this.#chain('background').usable[0];
    if (!first) return true;
    let running = 0;
    for (const active of this.#active.values()) if (active.primary === first.provider.id) running += 1;
    return running < first.provider.maxParallel;
  }

  // 裏の実行が最初に使う提供元が、会話の実行がいるせいで満杯か（ワーカーの待つ理由を「会話の返事」と言うか「枠」と言うかの区別。
  // 満杯でも、そこに会話の実行がいなければ false。会話が別の提供元で動いているだけなら、待たせているのは裏の実行で埋まった枠）
  chatHoldsBackground(): boolean {
    const first = this.#chain('background').usable[0];
    if (!first) return false;
    let running = 0;
    let chat = false;
    for (const active of this.#active.values()) {
      if (active.primary !== first.provider.id) continue;
      running += 1;
      if (active.kind === 'chat') chat = true;
    }
    return chat && running >= first.provider.maxParallel;
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
  // 実行役に結ばれた会話（boundRuntime）でモデルを選んでいないときは、その実行役のモデルで決める（提供元の先頭のモデルではなく）
  // freshInProduct (a product conversation with no messages and no runtime yet) with no model chosen: the first send goes to the first chat runtime model (same rule as #runtimeRoute), so its efforts apply
  effortChoices(pinned: string | null, boundRuntime: string | null = null, freshInProduct = false): { modelId: string | undefined; efforts: string[] } {
    const config = this.#d.config();
    const runtimeFirst = pinned === null && boundRuntime !== null ? config.models.find(m => isRuntimeModel(m) && m.runtime === boundRuntime)?.id : undefined;
    const autoRuntime = pinned === null && boundRuntime === null && freshInProduct ? this.#firstChatRuntimeModel()?.id : undefined;
    const id = pinned ?? runtimeFirst ?? autoRuntime ?? this.#chain('chat').usable[0]?.model.id ?? candidateModelIds(config, 'chat')[0];
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

  // 会話の実行が始まるとき、裏の実行を止めるのは、会話が最初に使う提供元（routes[0]）に空きが無いときだけ（Q-SF-1）。
  // 数えるのは、その提供元を最初に使って動いている実行の全部（会話・子の担当・裏の実行。いま始める会話の実行はまだ入っていない）。maxParallel より少なければ何も止めない。
  // すでに止めた（止めかけで、まだ終わりきっていない）実行は、数にも止める候補にも入れない（二重に知らせず、生きている実行を余計に止めない。枠の本当の同時数は、モデルを呼ぶ 1 回ごとに limiter が抑える）。
  // 空きが無ければ、足りない分（数 − maxParallel + 1 本）を、始まりの新しい順に止める。止める候補（会話・子の担当以外）が無ければ止めず、提供元の枠の待ち行列に任せる。
  // 会話の鎖の後ろにだけ同じ提供元がある裏の実行は止めない（会話が後ろへ落ちたら、モデルを呼ぶ 1 回ごとに枠を待つ）。止めたタスクの id と、止めた実行の数を返す
  #preemptFor(routes: Route[]): { tasks: string[]; count: number } {
    const first = routes[0];
    const stopped = { tasks: [] as string[], count: 0 };
    if (!first) return stopped;
    const same = [...this.#active.values()].filter(active => active.primary === first.provider.id && !this.#preempted.has(active.runId));
    const lack = same.length - first.provider.maxParallel + 1;
    if (lack <= 0) return stopped;
    for (const active of same.filter(a => a.kind !== 'chat' && a.kind !== 'agent').reverse().slice(0, lack)) {
      this.#preempted.add(active.runId);
      if (active.taskId) stopped.tasks.push(active.taskId);
      stopped.count += 1;
      active.controller.abort(new ProviderError('cancelled', engineText(DEFAULT_LANGUAGE, 'run.preempted'), { retryable: false }));
    }
    return stopped;
  }

  // 止めたタスク（引き継ぎのメモの相手）と、止めた実行の数（始まりの知らせの件数）を、この会話の実行に結びつける
  #notePreempted(runId: string, stopped: { tasks: string[]; count: number }): void {
    if (stopped.tasks.length) this.#preemptedTasks.set(runId, stopped.tasks);
    if (stopped.count) this.#pausedCount.set(runId, stopped.count);
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
  #chain(route: 'chat' | 'background' | 'scout' | 'research', pinned: string | null = null): { usable: Route[]; problems: ModelProblem[] } {
    const config = this.#d.config();
    const language = languageOf(config);
    const research = route === 'research' ? config.routing.research ?? [] : [];
    const ids = research.length ? [...research] : pinned ? [pinned] : route === 'scout' ? [...(config.routing.scout ?? [])] : candidateModelIds(config, route === 'research' ? 'chat' : route);
    const usable: Route[] = [];
    const cooling: Route[] = [];
    const problems: ModelProblem[] = [];
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      if (model && isRuntimeModel(model)) { problems.push({ modelId: id, status: 'error', message: engineText(language, 'problem.runtime_unavailable'), messageCode: 'engine.problem.runtime_unavailable' }); continue; }
      const provider = model && providerOf(config, model);
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

  #start(runId: string, conversationId: string, chain: Route[], kind: RunKind, task?: { task: Task; control: { value: TaskControl }; place?: string | null; fix?: FixPlace }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): void {
    this.#track(
      { runId, conversationId, kind, ...(task ? { taskId: task.task.id } : {}), providers: new Set(chain.map(r => r.provider.id)), primary: chain[0]!.provider.id },
      signal => this.#execute(runId, conversationId, chain, signal, kind, task, forbid, effort, agent),
    );
  }

  // 実行を「いま動いている」ものとして載せ、終わったら片付けて、待たせた発言を引き取る。提供元の実行（#execute）も外の実行役の実行（runRuntimeTurn）も、ここを通る
  #track(info: { runId: string; conversationId: string; kind: RunKind; taskId?: string; providers: Set<string>; primary: string }, execute: (signal: AbortSignal) => Promise<EngineResult>): void {
    const { runId, conversationId, kind } = info;
    const controller = new AbortController();
    this.#hardStops.set(runId, new AbortController());
    this.#byConversation.set(conversationId, runId);
    if (kind === 'chat') { this.#runModel.set(runId, this.#d.conversations.get(conversationId)?.model_id ?? null); this.#runMode.set(runId, this.#d.conversations.modeOf(conversationId)); }
    let ended: EngineResult | undefined;
    const done = execute(controller.signal)
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
        this.#pausedCount.delete(runId);
        this.#runModel.delete(runId);
        this.#runMode.delete(runId);
        this.#runFence.delete(runId);
        this.#runIndex.delete(runId);
        this.#runTail.delete(runId);
        this.#loaded.delete(runId);
        this.#sentCalls.delete(runId);
        this.#cacheSeen.delete(runId);
        this.#outputCap.delete(runId);
        this.#reviewEvidence.delete(runId);
        this.#stopped.delete(runId);
        this.#hardStops.delete(runId);
        this.#modeHost.delete(conversationId);
        this.#agentSpawned.delete(runId);
        this.#researchSessions.delete(runId);
        setTimeout(() => { this.#preempted.delete(runId); this.#scoutEnds.delete(runId); this.#scoutChildren.delete(runId); }, 60_000).unref?.();
        // 待っている発言の引き取り（会話の実行の鎖が途切れないよう、ロックを外した直後に、同じ呼び出しの中で次の実行を始める）
        this.#flushNotes(conversationId, runId);
        if (kind === 'chat') {
          try { this.#drainPending(conversationId, runId, ended); } catch (error) { this.#d.log?.(`[ERROR] Failed to pick up the waiting messages: ${(error as Error).stack ?? error}`); }
        }
        try { this.onRunEnd?.({ runId, conversationId, kind }); } catch (error) { this.#d.log?.(`[ERROR] onRunEnd: ${(error as Error).message}`); }
      });
    this.#active.set(runId, { runId, conversationId, kind, ...(info.taskId !== undefined ? { taskId: info.taskId } : {}), providers: info.providers, primary: info.primary, controller, done });
  }

  // 外の実行役（AR-7）。会話が実行役に結ばれているか、選んだモデルが実行役のモデルなら、提供元の鎖を通さず、実行役の道へ分ける。
  // 実行役の会話は、最初の 1 回で行き先が決まって替わらない。提供元の会話に発言があれば実行役へは替えられず、実行役の会話から提供元・別の実行役へも替えられない
  #runtimeRoute(conversationId: string, existing: ConversationRow | undefined, pinned: string | null): { runtimeId: string; model: RuntimeModelConfig; auto?: true } | { refused: Extract<SendOutcome, { ok: false }> } | undefined {
    const d = this.#d;
    const bound = d.conversations.runtimeOf(conversationId).runtimeId;
    if (!d.runtimes) return bound === null ? undefined : { refused: this.#refuse({ key: 'runtime.unavailable', params: { id: bound, reason: 'beat was started without runtime support' } }) };
    const config = d.config();
    const pinnedModel = pinned !== null ? config.models.find(m => m.id === pinned) : undefined;
    if (bound !== null) {
      if (pinned !== null && !(pinnedModel && isRuntimeModel(pinnedModel) && pinnedModel.runtime === bound)) return { refused: this.#refuse({ key: 'runtime.fixed', params: { id: bound } }) };
      const model = pinnedModel ?? config.models.find(m => isRuntimeModel(m) && m.runtime === bound);
      if (!model || !isRuntimeModel(model)) return { refused: this.#refuse({ key: 'runtime.no_model', params: { id: bound } }) };
      return { runtimeId: bound, model };
    }
    const fresh = !existing || d.conversations.messages(conversationId, 1).length === 0;
    if (pinned !== null) {
      if (!pinnedModel || !isRuntimeModel(pinnedModel)) return undefined;
      if (!fresh) return { refused: this.#refuse({ key: 'runtime.not_fresh', params: { id: pinnedModel.runtime } }) };
      return { runtimeId: pinnedModel.runtime, model: pinnedModel };
    }
    const first = this.#firstChatRuntimeModel();
    return fresh && first ? { runtimeId: first.runtime, model: first, auto: true } : undefined;
  }

  // The first chat candidate when it is a runtime model (where the first send of a conversation with no model goes). None when the engine has no runtimes
  #firstChatRuntimeModel(): RuntimeModelConfig | undefined {
    if (!this.#d.runtimes) return undefined;
    const config = this.#d.config();
    const first = config.models.find(m => m.id === candidateModelIds(config, 'chat')[0]);
    return first && isRuntimeModel(first) ? first : undefined;
  }

  #runtimeConversation(conversation: ConversationRow | undefined): boolean {
    if (!conversation) return false;
    if (conversation.runtime_id !== null) return true;
    const model = conversation.model_id === null ? undefined : this.#d.config().models.find(m => m.id === conversation.model_id);
    return model !== undefined && isRuntimeModel(model);
  }

  #refuse(refusal: RuntimeRefusal): Extract<SendOutcome, { ok: false }> {
    return {
      ok: false, httpStatus: 409, errorKind: 'provider_error', errorMessage: engineText(languageOf(this.#d.config()), refusal.key, refusal.params), errorCode: `engine.${refusal.key}`,
      ...(refusal.params ? { errorParams: refusal.params } : {}),
    };
  }

  #bridge(): RuntimeTurnDeps {
    const d = this.#d;
    const tools = d.tools;
    const planTools: RuntimeTurnDeps['planTools'] = tools && d.memory
      ? input => runtimePlanTools({ tools, config: d.config, paths: d.paths, conversations: d.conversations, projects: d.projects, acceptance: d.acceptance, bus: d.bus, log: d.log, services: () => this.toolServices(), modeOf: id => d.conversations.modeOf(id) }, input)
      : undefined;
    return { config: d.config, conversations: d.conversations, runs: d.runs, bus: d.bus, runtimes: d.runtimes!, paths: d.paths, projects: d.projects, log: d.log, stopGraceMs: d.runtimeStopGraceMs, pending: d.tools?.pending, approvals: d.runtimeApprovals, kv: d.kv, planTools };
  }

  // 実行役の道で、発言を保存して返事を始める。何かを書く前に、製品・作業フォルダ・実行役の確かめを見て、断れるものは断る（何も保存しない）
  #beginRuntimeChat(conversationId: string, items: ChatItem[], choice: SendChoice, projectId: string | undefined, existing: ConversationRow | undefined, route: { runtimeId: string; model: RuntimeModelConfig }): SendOutcome {
    const d = this.#d;
    if (items.some(item => item.images.length > 0)) return this.#refuse({ key: 'runtime.no_images' });
    const bridge = this.#bridge();
    const product = existing ? existing.project_id : projectId ?? null;
    const folder = runtimeFolder(bridge, product);
    if (!folder.ok) return this.#refuse(folder.refusal);
    const refusal = runtimePreflight(bridge, d.config(), route.runtimeId);
    if (refusal) return this.#refuse(refusal);
    this.lastUserActivity = d.now?.().getTime() ?? Date.now();
    d.conversations.reopen(conversationId);
    if (existing) {
      if (hasChoice(choice)) d.conversations.setChoice(conversationId, choice);
    } else d.conversations.ensure(conversationId, { projectId, modelId: choice.modelId, effort: choice.effort, permissionMode: this.#newConversationMode(choice, projectId) });
    if (!d.conversations.bindRuntime(conversationId, route.runtimeId)) return this.#refuse({ key: 'runtime.fixed', params: { id: d.conversations.runtimeOf(conversationId).runtimeId ?? route.runtimeId } });
    const runId = randomUUID();
    let firstId: number | undefined;
    for (const item of items) {
      const saved = d.conversations.append(conversationId, userMessage(item));
      firstId ??= saved.id;
      d.conversations.autoTitle(conversationId, item.attachments.length ? ownWords(item.content) || item.attachments[0]!.name : item.content);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    }
    this.#track(
      { runId, conversationId, kind: 'chat', providers: new Set(), primary: `runtime:${route.runtimeId}` },
      signal => runRuntimeTurn(bridge, { runId, conversationId, projectId: product, runtimeId: route.runtimeId, modelId: route.model.id, model: route.model.model, signal }),
    );
    return { ok: true, runId, ...(firstId !== undefined ? { messageId: firstId } : {}) };
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
    const research = forbid instanceof ResearchAllow;
    return (t: ToolDef) => (kind === 'review' && !reviewAllows(t)) || (t.scoutOnly === true && !scout) || (t.researchOnly === true && !research) || (t.name === 'agent_run' && !scout && (agentOff(config, kind) || (started !== undefined && agentOff(started, kind)))) || (isBrowserTool(t.name) && (!config.tools.browser.enabled || started?.tools.browser.enabled === false)) || (t.name === 'skill_draft' && (!growSkills(config) || (started !== undefined && !growSkills(started)))) || forbid?.has(t.name) === true || effectivePolicy(t.name, config, started) === 'block'
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

  async #execute(runId: string, conversationId: string, chain: Route[], signal: AbortSignal, kind: RunKind, task?: { task: Task; control: { value: TaskControl }; place?: string | null; fix?: FixPlace }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): Promise<EngineResult> {
    const d = this.#d;
    // 子の担当は、親が始めたときの設定で動く（親と同じ決まり。途中で緩めても広がらない）
    const config = agent?.parent.config ?? d.config();
    d.runs.start(runId, kind, conversationId, agent?.parent.runId);
    // 直す実行（beat 8-6a）は、ワーカーの置き場の表ではなく、渡された写しで動く
    const fixPlace = !agent && kind === 'task' ? task?.fix : undefined;
    const worktree = fixPlace ? { id: fixPlace.id, path: fixPlace.path, branch: fixPlace.branch, base: fixPlace.base, ceiling: fixPlace.ceiling }
      : !agent && task && kind === 'task' ? d.places?.runPlace(task.task.id) : undefined;
    if (!agent && task && task.place !== undefined && (worktree?.id ?? null) !== task.place) throw new Error(engineText(languageOf(config), 'run.place_changed'));
    const own = agent ? undefined : runProject(d.projects, d.conversations.projectOf(conversationId), worktree);
    const resolved = agent ? agent.parent.project : own;
    const place: RunPlace | undefined = agent ? agent.parent.place
      : own?.worktree && own.productRoot ? { kind: fixPlace ? 'fix' : 'worktree', id: own.worktree.id, productRoot: own.productRoot, branch: own.worktree.branch, base: own.worktree.base, ceiling: own.worktree.ceiling } : undefined;
    const scout = agent ? agent.parent.scout === true : forbid instanceof ScoutAllow;
    // 直す実行は写しが本体のものか確かめられたときだけ（productRoot が本体）。持ち主の記憶は渡さない（考える実行と同じ）
    const fix = fixPlace !== undefined && place?.kind === 'fix' && own?.productRoot !== undefined;
    if (fixPlace && !fix) throw new Error('The fix copy does not belong to this product');
    const research = !agent && kind === 'task' && forbid instanceof ResearchAllow ? this.#researchSessions.get(runId) : undefined;
    if (forbid instanceof ResearchAllow && !research) throw new Error('A research run needs its research session');
    const snapshot = this.#snapshot(conversationId, resolved, scout || fix, research !== undefined);
    d.bus.publish({ type: 'run.start', runId, conversationId, modelId: chain[0]!.model.id });
    // この返事にモデルを回すために裏の実行を止めたときは、最初の往復の前に 1 回だけ知らせる（止めたのは提供元に空きが無かったとき）
    const paused = this.#pausedCount.get(runId) ?? 0;
    if (paused > 0) d.bus.publish({ type: 'warning', runId, conversationId, code: 'task_paused', message: engineText(languageOf(d.config()), 'warn.task_paused', { count: paused }), params: { count: paused } });
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
    // 続きを頼むとき切り戻した最後の語のうち、まだ保存した返事に戻っていない分。次の呼び出しが終わる（成功して返事が来る）まで持ち、そのあいだに呼び出しが失敗・停止したら返事に戻す。
    // 会話（chat）の実行では持たない: 戻すと末尾が assistant になり、retry が断られる（再試行のボタンも消える）。会話は続きの一言（user）で終わったままにして、retry が続きの一言から書き直させる（切った語もそのとき戻る）
    let owedTail = '';
    let warnedToolCut = false;
    let lastEstimate = 0;
    let lastRoute: Route = chain[0]!;
    const project = kind === 'review' ? undefined : resolved;
    if (project) d.mesh?.persist(project.id);
    if (project && !project.root && !agent) d.log?.(`[WARN] The folder of product ${project.id} could not be confirmed, so run ${runId} does not get it as a writable folder`);
    const allRoots = rootsLister(d.projects);
    allRoots();
    const productRoots = agent || kind === 'review' ? [] : allRoots;
    // 考える実行は製品を読むだけ。直す実行は写しだけ（持ち主の足した許可フォルダは渡さない。写しは buildPolicy が書ける場所に足す）
    const reach: AppConfig = research ? { ...config, tools: { ...config.tools, roots: [] } } : scout ? { ...config, tools: { ...config.tools, roots: project?.root ? [{ path: project.root, mode: 'read' }] : [] } }
      : fix ? { ...config, tools: { ...config.tools, roots: [] } } : config;
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
      ...(fix ? { fix: true as const, ...(fixPlace?.job ? { fixJob: fixPlace.job } : {}) } : {}),
      ...(research ? { research } : {}),
    };
    ctx.noteCreated = abs => this.created.note(ctx, abs);
    ctx.fileReads = fileReadLog(d.kv, conversationId);
    ctx.sentCalls = () => this.#sentCalls.get(runId) ?? new Set();
    ctx.isCreated = abs => this.created.isCreated(abs, ctx);
    ctx.toolWindow = () => this.created.open(ctx);
    ctx.reachable = () => this.#reachable(kind, forbid, config, this.#modeFor(kind, conversationId, ctx.permissionMode), ctx.project !== undefined || ctx.memoryProject !== undefined, this.#frozen(ctx.project?.id));
    if (this.#defers(kind, forbid, config)) {
      // 読み込んだ道具は会話ごとに持ち越す（TE-2。kv の loaded-tools:<会話>。並びが前の実行の終わりと同じになり、前半を読める）。使えない道具は #toolsFor が外す
      // 要約のある会話には history_read を入れておく（TE-4a。手放した元の文を読み戻せるように。要約した時点で入るが、それより前に要約した会話はここで）
      if (d.conversations.get(conversationId)?.summary) this.preload(conversationId, [HISTORY_READ]);
      // 製品の中の実行は、よく読み込む道具を 1 回目の呼び出しから並べる（browser-rethink P1。途中の読み込みは道具の後ろ全部のキャッシュを書き直すため）
      this.preload(conversationId, this.#usualTools(project, this.#modeFor(kind, conversationId, ctx.permissionMode), chain[0]!.model));
      const loaded = new Set<string>(this.#carriedTools(conversationId));
      const sent = new Set<string>();
      this.#loaded.set(runId, { loaded, sent });
      ctx.deferred = {
        loaded,
        sent,
        list: () => this.#deferred(kind, forbid, config, this.#modeFor(kind, conversationId, ctx.permissionMode), ctx.project !== undefined || ctx.memoryProject !== undefined, this.#frozen(ctx.project?.id)),
        load: names => {
          const added = names.filter(name => !loaded.has(name));
          for (const name of added) loaded.add(name);
          if (added.length) this.preload(conversationId, added);
        },
      };
    }
    if (project?.root && !agent) await this.created.begin(runId, task ? { kind: 'task', id: task.task.id } : { kind: 'conv', id: conversationId }, project.root);
    // 子の担当を任せる道具の入口（設定で有効のときだけ。子は孫を作れない。タスクは tools.agent.inTasks で許したときだけ）
    if (kind !== 'agent' && !fix && !research && (scout || (config.tools.agent.enabled && (kind === 'chat' || (kind === 'task' && config.tools.agent.inTasks))))) {
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
    const sweepTask = task?.task.id ?? agent?.parent.task?.id;
    const callTool = async (toolCall: ToolCall, truncated?: { message: string; raw: string }) => this.#sweepAfter(sweepTask, toolCall.name, config, await runToolCall(toolCall, ctx, {
      registry: tools!.registry, approvals: tools!.approvals, pending: tools!.pending, productRoots: allRoots, db: d.conversations.db, emit: e => d.bus.publish(e), config: d.config,
      permissionMode: () => this.#modeOf(conversationId),
      autoClassify: (prompt, classifierSignal, judgeCall) => this.#autoAsk(lastRoute, prompt, classifierSignal, judgeCall),
      lastUserRequest: () => (task ? d.tasks?.judgeRequest(task.task.id) ?? ''
        : agent ? (agent.parent.task ? d.tasks?.judgeRequest(agent.parent.task.id) ?? '' : this.#lastUserRequest(agent.parent.conversationId))
        : this.#lastUserRequest(conversationId)),
      judgeLimits: d.judgeLimits,
      conversationTainted: () => d.conversations.everTainted(conversationId),
    }, truncated));
    // 実際に動いた道具の呼び出しを「仕事」に数える（結果が誤りでも数える。Pending に預けた・断られた・引数の誤り・task_ / tool_search / question_add / pending_withdraw は数えない）。
    // そのうち書き換え・実行の仕事（changeDone）に数えるのは、効果が write の道具（結果を問わない）・誤りなく終わった exec の道具・子の担当（agent_run）
    const countDone = (name: string, outcome: { output: { isError?: boolean }; decision: string; invalidArguments?: boolean }) => {
      if (outcome.decision !== 'allow' || outcome.invalidArguments || name.startsWith('task_') || name === 'tool_search' || name === 'question_add' || name === 'pending_withdraw') return;
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
    const splits = Boolean(task) && kind === 'task' && !scout && !fix && !research;
    // P6: 承認待ちだけが残ったら、実行を終える前に決めを待つ（1 回の実行で合わせて上限まで）。決まれば同じ実行のまま続ける
    const waitLimit = d.pendingWaitMs ?? PENDING_WAIT_MS;
    let waited = 0;
    let holdStopped = false;
    let holds = 0;
    const holdForPending = async (): Promise<boolean> => {
      const left = waitLimit - waited;
      if (!splits || !task || left <= 0 || !openPendingIds(d.conversations.db, task.task.id).length) return false;
      holds++;
      const minutes = Math.ceil(left / 60_000);
      d.bus.publish({ type: 'warning', runId, conversationId, code: 'pending_wait', message: engineText(languageOf(config), 'warn.pending_wait', { minutes }), params: { minutes } });
      const began = Date.now();
      try { return await this.#waitForNote(conversationId, left, signal); } finally { waited += Date.now() - began; holdStopped = signal.aborted; }
    };
    let startedOver = false;
    const compaction: CompactionState = { count: 0, failed: false, summarized: 0, trimmed: 0 };
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
        // 続きを頼んだ呼び出しが失敗・停止したときは、切り戻した最後の語を失わない。止められる前に続きが文を書いていれば、その文が残る（モデルは切った語から書き直すので足さない）
        if (call.cancelled) return this.#finishCancelled(runId, conversationId, counters, call.route ?? lastRoute, call.partial.trim() ? call.partial : owedTail, flags);
        if (call.usage) addUsage(call.usage);
        if (owedTail) {
          const tail = d.conversations.append(conversationId, { role: 'assistant', content: owedTail }, runId);
          d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: tail.id, role: 'assistant' });
        }
        return finishFail(call.failure);
      }
      owedTail = '';
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
      // 続きが空のときは、もう続きを頼まない（終える）。ここで room を真にすると、次の行で cutTail が空に上書きされ、前の呼び出しから戻した語を失う
      const room = !empty && !call.toolCalls.length && call.truncated && continuations < MAX_CONTINUATIONS
        && this.#continuationFits({ runId, conversationId, snapshot, model: lastRoute.model, kind, forbid, started: config, startedMode: ctx.permissionMode, project: ctx.project, memoryProject: ctx.memoryProject }, [{ role: 'assistant', content: resumePoint(call.text) }, ask]);
      if (room) {
        const kept = resumePoint(call.text);
        cutTail = call.text.slice(kept.length);
        owedTail = kind === 'chat' ? '' : cutTail;
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
        const heldBefore = holds;
        if (!call.truncated && !cutTexts.length && await holdForPending()) continue;
        if (holdStopped) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '', flags);
        const left = task && holds > heldBefore ? openPendingIds(d.conversations.db, task.task.id) : [];
        if (task && left.length) task.control.value = { outcome: 'await_pending', ids: left };
        return finishOk(cutTexts.join('') + call.text, call.stop);
      }
      cutTexts.length = 0;
      if (!d.tools) return finishOk(call.text, call.stop);

      let invalidThisRound = 0;
      let askedOwner = false;
      // 呼び出しごとに結果の行を必ず残す（結果の無い呼び出しが残ると、次の頼みを提供元が断る）
      const unrun = [...call.toolCalls];
      const closeUnrun = () => {
        for (const left of unrun.splice(0)) {
          const closed = d.conversations.append(conversationId, { role: 'tool', toolCallId: left.id, name: left.name, content: engineText(languageOf(config), 'tool.not_run_stopped'), isError: true }, runId);
          d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: closed.id, role: 'tool' });
        }
      };
      try {
        for (const toolCall of call.toolCalls) {
          if (signal.aborted) { closeUnrun(); return this.#finishCancelled(runId, conversationId, counters, lastRoute, '', flags); }
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
          const images = !outcome.output.isError && outcome.output.images?.length ? this.#storeImages(toolCall.name, outcome.output.images) : undefined;
          const toolSaved = d.conversations.append(conversationId, {
            role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: outcome.output.content, ...(outcome.output.isError ? { isError: true } : {}), ...(outcome.gate ? { gate: outcome.gate } : {}),
            ...(images?.inline.length ? { images: images.inline } : {}), ...(images?.ids.length ? { imageIds: images.ids } : {}),
          }, runId);
          unrun.shift();
          d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: toolSaved.id, role: 'tool' });
        }
      } catch (error) {
        try { closeUnrun(); } catch { }
        throw error;
      }
      if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '', flags);
      if (task && task.control.value.outcome === 'await_pending' && await holdForPending()) {
        task.control.value = { outcome: 'none' };
        continue;
      }
      if (holdStopped) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '', flags);
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
        const provider = model && providerOf(config, model);
        return model && !isRuntimeModel(model) && provider ? [{ model, provider }] : [];
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
        if (signal.aborted || error instanceof TruncatedReply || error instanceof JudgeRefused) throw error;
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
      const maxOutput = d.status.limits(model).maxOutput;
      let limit = Math.min(JUDGE_OUTPUT_TOKENS, maxOutput);
      const raised = Math.min(JUDGE_OUTPUT_RAISED, maxOutput);
      // 返事が出力の上限で切れたら、切れた返事の文字は捨て、上限を上げられるときだけ、同じ枠のまま（答えの時計の中で）1 回だけ呼び直す。使うのは呼び直しの返事だけで、それも切れたら TruncatedReply（呼ぶ側は読めない返事として確かめる側に倒す）。
      // 使用量は、呼び直しの分も足して知らせる
      const spent: Usage = {};
      for (;;) {
        let text = '';
        let usage: Usage = {};
        let cut = false;
        for await (const event of adapter.stream({
          model, system: { frozen: prompt.system, dynamic: '', tail: '' }, messages: [{ role: 'user', content: prompt.user }], tools: [], maxOutputTokens: limit, signal,
        })) {
          if (event.type === 'text') text += event.delta;
          else if (event.type === 'usage') { usage = { ...usage, ...event.usage }; call?.used?.(model.id, addUsageTo({ ...spent }, usage)); }
          else if (event.type === 'done' && event.stop === 'max_tokens') { cut = true; break; }
          else if (event.type === 'done' && event.refused) throw new JudgeRefused();
        }
        addUsageTo(spent, usage);
        // 返事の短い理由は承認の記録・画面の出来事・実行ログの API に出るので、API キーそのものは、読む前に伏せる
        if (!cut) return { text: redactExact(text, d.registry.secrets()), model: model.id, usage: spent };
        if (limit >= raised) throw new TruncatedReply();
        signal.throwIfAborted();
        limit = raised;
      }
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
    // この呼び出しで削り（#reduce）をやり直した回数。位置は前へしか動かないので止まるはずだが、止まらなければ誤りで終える（固まらない）
    let reductions = 0;
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
        const { toolDefs, listed, system, pending, history, replay, stored, conversation, apiTools, capacity, available, maxOutput, planned, factor, trimmed, readable, clearedCalls } = this.#assemble({ runId: p.runId, conversationId: p.conversationId, snapshot: p.snapshot, model, kind: p.kind, forbid: p.forbid, started: p.started, startedMode: p.startedMode, project: p.project, memoryProject: p.memoryProject, sendTail: true });
        // 送る量が available を超えたら、まとめて削って位置を覚え（TE-4）、組み立て直す。位置は前へしか動かないので、動かなくなれば先へ進む。
        // 最後の発言に付けた tail は、組み立て直しで「実行の前から持つ tail」として扱い、載せた節の発言が外れていれば全部の tail に替える
        const over = capacity > 0 && estimateRequest(systemText(system), history, apiTools, factor, pending).tokens > available;
        if (over && reductions >= MAX_REDUCTIONS_PER_CALL) {
          d.log?.(`[ERROR] run ${p.runId}: reducing the context of conversation ${p.conversationId} did not converge after ${reductions} tries`);
          return { ok: false, cancelled: false, partial: '', failure: { kind: 'context_overflow', message: engineText(language, 'fit.reduce_stuck', { count: reductions }), code: 'engine.fit.reduce_stuck', params: { count: reductions }, retryable: false, route }, usage: spent };
        }
        if (over && ++reductions && await this.#reduce({ runId: p.runId, conversationId: p.conversationId, kind: p.kind, readable, route, adapter, signal: p.signal, compaction: p.compaction, flags: p.flags, system, history, stored, apiTools, factor, pending, available, capacity, previous: conversation?.summary ?? null })) {
          const lastId = stored.at(-1)?.id;
          if (lastId !== undefined) this.#runTail.get(p.runId)?.delete(lastId);
          attempt--; continue;
        }
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
        const notRun = new Set<string>();
        const paired = closeToolCalls(fitted.messages, engineText(language, 'tool.not_run_stopped'), notRun);
        const sentCalls = new Set(paired.flatMap(m => (m.role === 'tool' && !notRun.has(m.toolCallId) && !clearedCalls.has(m.toolCallId) ? [m.toolCallId] : [])));
        if (paired !== fitted.messages) fitted = { ...fitted, messages: [...paired], estimate: estimateRequest(systemText(system), paired, apiTools, factor, pending) };

        this.#sentCalls.set(p.runId, sentCalls);
        let text = '';
        let usage: Usage = {};
        let stop: StopReason = 'other';
        const toolCalls: ToolCall[] = [];
        const thoughts: ThinkingBlock[] = [];
        let release: (() => void) | undefined;
        let callStarted = 0;
        // 提供元から届いた出来事の数（種類を問わない。progress も数える）。0 のまま上限まで待つと「黙っている」の知らせを出し（silent）、
        // そのあと時間切れで終わったら試し直さない。上限より前の失敗は、黙っていたことにならないので今までどおり試し直す
        let events = 0;
        let silent = false;
        let silentTimer: ReturnType<typeof setTimeout> | undefined;
        let waitStarted = 0;
        try {
          release = await d.limiter.acquire(provider.id, () => provider.maxParallel, p.signal);
          callStarted = d.runs.now();
          waitStarted = Date.now();
          const silentMs = d.modelSilentMs ?? MODEL_SILENT_MS;
          silentTimer = setTimeout(() => {
            silent = true;
            const seconds = Math.round(silentMs / 1000);
            d.bus.publish({ type: 'warning', runId: p.runId, conversationId: p.conversationId, code: 'model_silent', message: engineText(language, 'warn.model_silent', { model: model.id, seconds }), params: { model: model.id, seconds } });
          }, silentMs);
          for await (const event of adapter.stream({ model, system, messages: fitted.messages, tools: apiTools, maxOutputTokens: maxOutput, ...(effort ? { effort } : {}), signal: p.signal })) {
            if (events++ === 0) clearTimeout(silentTimer);
            if (event.type === 'text') { text += event.delta; d.bus.publish({ type: 'text.delta', runId: p.runId, conversationId: p.conversationId, text: event.delta }); }
            else if (event.type === 'usage') usage = { ...usage, ...event.usage };
            else if (event.type === 'tool_call') toolCalls.push(event.call);
            else if (event.type === 'thinking') thoughts.push(event.block);
            else if (event.type === 'replay_rejected') { if (!p.flags.includes('thinking_replay_rejected')) p.flags.push('thinking_replay_rejected'); }
            else if (event.type === 'done') stop = event.stop;
          }
        } catch (error) {
          const e = error instanceof ProviderError ? error
            : p.signal.aborted ? providerError('cancelled', 'cancelled', {}, { retryable: false })
            : providerError('internal', 'unexpected', {}, { retryable: false, upstream: redactSecrets((error as Error).message, d.registry.secrets()).slice(0, UPSTREAM_KEEP) });
          if (e.kind === 'cancelled' || p.signal.aborted) return { ok: false, cancelled: true, partial: text, failure: last, route };
          last = { kind: e.kind, message: e.text(language), ...(e.code ? { code: `provider.${e.code}`, params: e.params } : {}), retryable: e.retryable, route, ...(e.detail ? { detail: e.detail } : {}), ...(e.upstream ? { upstream: e.upstream } : {}) };
          // 上限まで 1 つも出来事が来ないまま時間切れで終わった呼び出しは、同じモデルで待ち直しても同じなので試し直さない（鎖に次があればそこへ、無ければここで終える）。
          // 時間切れは kind が timeout のもの（標準の fetch〔undici〕が先に切る 300 秒の頭・本文の時間切れも、classifyFetchError が timeout にして返す）。出来事が届いてからの失敗・上限より前の失敗は、今までどおり試し直す
          if (events === 0 && silent && e.kind === 'timeout') {
            const minutes = Math.max(0.1, Math.round((Date.now() - waitStarted) / 6000) / 10);
            last = { kind: 'timeout', message: engineText(language, 'run.model_no_answer', { minutes }), code: 'engine.run.model_no_answer', params: { minutes }, retryable: e.retryable, route };
            break;
          }
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
        } finally { clearTimeout(silentTimer); release?.(); }
        if ((usage.cacheReadTokens ?? 0) > 0) {
          const seen = this.#cacheSeen.get(p.runId) ?? new Set<string>();
          seen.add(model.id);
          this.#cacheSeen.set(p.runId, seen);
        }
        const callRecord = { runId: p.runId, model: model.id, usage, estTokens: fitted.estimate.tokens, removed: fitted.removed + trimmed, tools: apiTools, system, startedAt: callStarted };

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
            d.runs.recordCall({ ...callRecord, purpose: 'discarded' });
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
        d.runs.recordCall({ ...callRecord, purpose: 'turn' });
        return { ok: true, index, text, toolCalls, usage: addUsageTo({ ...spent }, usage), stop: toolCalls.length ? 'tool_use' : stop, truncated: stop === 'max_tokens', estimate: fitted.estimate.tokens, ...(thinking ? { thinking } : {}) };
      }
    }
    return { ok: false, cancelled: false, partial: '', failure: last, usage: spent };
  }

  // モデルへ送る 1 回分の組み立て（system・履歴・道具の仕様・見積もりの補正）。実行（#callModel）と使用量（contextUsage）の両方がここを通るので、数がずれない。
  // 何も書かない。固定の system（snapshot）は呼ぶ側が渡す
  // startedMode: 実行を始めたときの権限モード（実行の中でだけ渡す。使用量の数え方は次の実行のためなので、会話のいまのモードで数える）
  #assemble(p: { runId?: string | undefined; conversationId: string; snapshot: string; model: ProviderModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined; sendTail?: boolean }) {
    const d = this.#d;
    const { model } = p;
    const config = d.config();
    const language = languageOf(config);
    const mode = this.#modeFor(p.kind, p.conversationId, p.startedMode);
    const frozen = this.#frozen(p.project?.id);
    // 使用量は、次の実行が頭で先読みする道具も数える（kv には書かない）
    const loaded = p.runId ? this.#loaded.get(p.runId)?.loaded : this.#defers(p.kind, p.forbid, p.started) ? new Set<string>([...this.#carriedTools(p.conversationId), ...this.#usualTools(p.project, mode, model)]) : undefined;
    // 画像を読めないモデルには image_view を渡さない（呼んでも断るだけ。予備のモデルに替わったときも）
    const toolDefs = this.#toolsFor(p.kind, p.forbid, p.started, mode, p.project !== undefined || p.memoryProject !== undefined, frozen, loaded).filter(t => t.name !== 'image_view' || model.vision === true);
    const listed = loaded && toolDefs.some(t => t.name === 'tool_search') ? this.#deferred(p.kind, p.forbid, p.started, mode, p.project !== undefined || p.memoryProject !== undefined, frozen) : [];
    const deferred = deferredSection(listed, config);
    const specs = ToolRegistry.specs(toolDefs, config, { fixProduct: p.project ? d.projects?.get(p.project.id)?.scout_mode === 'fix' : false });
    const { capacity, maxOutput: planned } = d.status.limits(model);
    // 考えるだけで上限に達してこの実行で上げた上限は、上げたそのモデルにだけ（予備のモデルに替わったら引き継がない）、使える量の見積もりすべてに効かせる
    const raisedCap = p.runId ? this.#outputCap.get(p.runId)?.get(model.id) : undefined;
    const maxOutput = raisedCap ? Math.min(raisedOutputFor(model, capacity, planned, d.status.get(model.id)?.maxOutput), Math.max(planned, raisedCap)) : planned;
    const available = contextAvailable(capacity, maxOutput);
    const conversation = d.conversations.get(p.conversationId);
    // 送る発言は、要約した所と外した所（kv の trim-upto:<会話>。TE-4）の後ろ。外したが要約していない発言の数は呼び出しの記録へ
    const summaryUpto = conversation?.summary_upto ?? 0;
    const { trimUpto, clearedUpto } = this.#reduced(p.conversationId);
    const all = d.conversations.messages(p.conversationId);
    const stored = all.filter(m => m.id > Math.max(summaryUpto, trimUpto));
    const trimmed = trimUpto > summaryUpto ? all.filter(m => m.id > summaryUpto && m.id <= trimUpto).length : 0;
    // 印・要約に元を読む口を書くのは、この実行で history_read に届くときだけ（タスクの実行では書かない。自分の会話を読むと「外から読んだ」が付くため）
    const readable = p.kind !== 'task' && this.#reachable(p.kind, p.forbid, p.started, mode, p.project !== undefined || p.memoryProject !== undefined, frozen).some(t => t.name === HISTORY_READ);
    // 要約の頭の行（外した発言の id の範囲・元を読む口）はコードが書く（TE-5）
    // 範囲の頭は会話の最初の発言（messages は新しい 500 行だけなので、別に数える）
    const first = conversation?.summary ? (d.conversations.db.prepare('SELECT MIN(id) AS id FROM messages WHERE conversation_id = ?').get(p.conversationId) as { id: number | null } | undefined)?.id ?? 0 : 0;
    const summary = summarySection(conversation?.summary ?? '', language, { from: first, to: summaryUpto, read: readable ? p.conversationId : undefined });
    const list = readChecklist(d.kv, p.conversationId);
    const jobs = d.background?.list({ conversationId: p.conversationId }) ?? [];
    const checklist = checklistSection(list, language);
    const background = backgroundSection(jobs, language);
    // この会話の計画から作った、開いている Build の様子（会話の実行だけ。新しい順に 3 件まで。決まった英語の文と id・数字だけで、タスクの文は入れない）
    // 止めたタスクのうち、同じ返事のあいだに動き直したもの（止められていない実行がいる）は、止めた扱いにしない
    const restarted = new Set([...this.#active.values()].filter(active => active.taskId !== undefined && !this.#preempted.has(active.runId)).map(active => active.taskId!));
    const paused = new Set((p.runId ? this.#preemptedTasks.get(p.runId) ?? [] : []).filter(id => !restarted.has(id)));
    const openBuilds = p.kind === 'chat' ? (d.tasks?.buildsFrom(p.conversationId) ?? []).filter(task => task.status === 'ready' || task.status === 'running' || task.status === 'waiting').slice(-3).reverse() : [];
    const build = buildSection(openBuilds.map((task): BuildLine => ({ id: task.id, status: task.status as BuildLine['status'], pausedNow: paused.has(task.id), pending: task.status === 'waiting' ? openPendingIds(d.conversations.db, task.id) : [] })));
    const bare = p.forbid instanceof ResearchAllow;
    const row = p.project?.root && !bare ? d.projects?.get(p.project.id) : undefined;
    const planMemory = p.kind === 'chat' && mode === 'plan' && row?.archived_at === null && !d.botMemory && d.memoryFiles ? (config.memory.review ? 'review' as const : 'off' as const) : undefined;
    const worktree = p.project?.worktree && p.project.productRoot ? { branch: p.project.worktree.branch, productRoot: p.project.productRoot } : undefined;
    const product = row && p.project?.root ? { name: row.name, root: p.project.root, docLanguage: row.doc_language, memory: planMemory, worktree } : undefined;
    const { index: mesh, status: productStatus } = bare ? { index: '', status: '' } : this.#meshIndex(p.runId, p.project, available, p.conversationId);
    const requirements = p.kind === 'chat' && product && mode === 'plan' ? requirementsText(d.paths, available) : '';
    // dynamic は実行のあいだ変わらない部分だけ（日付まで）。時刻・Checklist・裏のコマンドは tail へ（S1。dynamic が変わると後ろの履歴が全部書き直しになる）
    const now = d.now?.() ?? new Date();
    const fence = this.#fence(p.runId, p.conversationId);
    const ownerTag = config.ui.explainLanguage === 'auto' ? product?.docLanguage : config.ui.explainLanguage;
    const owner = p.kind === 'task' && !bare && ownerTag ? engineText(language, 'run.owner_language', { language: languageName(ownerTag) }) : '';
    const dynamic = [buildDynamic(config.timezone, language, now, mode, product, requirements), owner, deferred, mesh, p.runId ? fence.clean(summary) : summary].filter(Boolean).join('\n\n');
    const sections = { checklist, background, product: productStatus, build };
    const system = { frozen: p.snapshot, dynamic, tail: fenceTail(buildTail(config.timezone, language, now, sections), fence.nonce) };
    const apiTools = specs;
    const factor = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
    // 考える部分を送り返すかはここだけで決め、呼び出し・道具の結果の量・続きの見積もり・使用量の表示が同じ履歴を使う。
    // 送り返すのは、それを書いた提供元・モデルへ送り、要約の無い会話で、考える部分の量も数えて古い発言を 1 つも外さずに入りきるときだけ（前の発言が変わると API が断る）
    // 実行の中では、道具の結果・発言から会話の nonce を消す（tail の印を装えないように）
    // 消した・外した会話（TE-4）でも、要約と同じく考える部分を送り返さない。消した位置より前の道具の結果は、nonce を消したあとに印へ替える
    const reduced = Boolean(conversation?.summary) || trimUpto > 0 || clearedUpto > 0;
    let history = stored.map(m => withThinkingFor(clean(forModel(m.message, id => this.#loadImage(id)), p.runId ? fence : undefined), reduced ? undefined : { provider: model.provider, model: model.model }));
    const clearedCalls = new Set<string>();
    history = this.#clearResults(history, stored, clearedUpto, { conversationId: p.conversationId, kind: p.kind, readable, fence: p.runId ? fence : undefined, language }, clearedCalls);
    // 発言に保存した tail（TE-1）は、次の実行でも同じ文で同じ場所に送る。実行の中では、いまの会話の印で囲まれたものだけ送る（ほかは外し、載せていた節は送っていないものとして付け直す）。
    // 実行の外（使用量）は保存したまま数える
    const kept = new Set<number>();
    history = history.map((m, i) => {
      if (m.role === 'assistant' || m.tail === undefined) return m;
      if (!p.runId || isFencedTail(m.tail, fence.nonce)) { kept.add(stored[i]!.id); return m; }
      const { tail: _tail, ...rest } = m;
      return rest as ChatMessage;
    });
    // 最後の user / tool の発言に付ける、変わった分の tail を決める（何も書かない）。モデルを呼ぶとき（実行の中の sendTail）だけ、付けて保存する。
    // 最後に送った節と時刻・載せた発言は kv の tail-state:<会話>
    const last = stored.at(-1);
    const mine = p.runId ? this.#runTail.get(p.runId) ?? new Set<number>() : new Set<number>();
    let next: { tail: string; state: TailState } | undefined;
    if (last && last.id > 0 && last.message.role !== 'assistant' && !mine.has(last.id)) {
      const state = d.kv.getJson<TailState>(`tail-state:${p.conversationId}`) ?? { carriers: {} };
      // いまの文を載せた発言が、要約で消えたか、削られて送る範囲から外れるか、印が違って送らないなら、前に送ったことにしないで全部を付け直す（削る量は全体の tail を足した多めの見積もり）。
      // 最後の発言が実行の前から tail を持つ（やり直し・失敗のあと）なら、新しい tail が要るときだけ、その発言の tail を全部の tail に替える
      const carried = Object.values(state.carriers ?? {});
      const relabel = kept.has(last.id);
      let outside = false;
      if (carried.length) {
        let removed = 0;
        try { removed = fitMessages({ system: systemText(system), messages: history, tools: apiTools, available, factor, tail: system.tail }).removed; } catch (error) { if (!(error instanceof ContextOverflow)) throw error; }
        const window = new Set(stored.slice(removed).map(m => m.id));
        outside = carried.some(id => !window.has(id) || !kept.has(id));
      }
      const lost = relabel || outside;
      const due = relabel && !outside && !nextTail(state.sent, config.timezone, language, now, sections) ? undefined : nextTail(lost ? undefined : state.sent, config.timezone, language, now, sections);
      if (due) {
        const carriers: TailState['carriers'] = lost ? {} : { ...state.carriers };
        carriers.time = last.id;
        for (const key of ['product', 'build', 'checklist', 'background'] as const) {
          if (lost || (state.sent?.[key] ?? '') !== sections[key]) { if (sections[key]) carriers[key] = last.id; else delete carriers[key]; }
        }
        const upto = conversation?.summary_upto ?? 0;
        const tainted: NonNullable<TailState['tainted']> = {};
        const carries = { checklist: list?.tainted === true, background: jobs.some(job => job.tainted === true) };
        for (const key of ['checklist', 'background'] as const) {
          const ids = (state.tainted?.[key] ?? []).filter(id => id > upto && id !== last.id);
          if (carries[key] && sections[key] && due.text.includes(sections[key])) ids.push(last.id);
          if (ids.length) tainted[key] = ids;
        }
        next = { tail: fenceTail(due.text, fence.nonce), state: { sent: due.sent, carriers, ...(Object.keys(tainted).length ? { tainted } : {}) } };
      }
    }
    if (next && last && p.runId && p.sendTail) {
      const { tail, state } = next;
      transaction(d.conversations.db, () => {
        d.conversations.setTail(last.id, tail);
        d.kv.setJson(`tail-state:${p.conversationId}`, state);
      });
      mine.add(last.id); this.#runTail.set(p.runId, mine);
      history = history.map((m, i) => (i === stored.length - 1 && m.role !== 'assistant' ? { ...m, tail } : m));
    }
    // 古い Anthropic の考えるモデル（stripsThinkingOnText）に考える部分を送り返すとき、adapter は tail を全部 system の後ろに置く。
    // 送り返すかは adapter が最後に決めるので、ここでは送り返しうるとき全体の tail も数える（多めの見積もり）
    const oldThinking = config.providers.find(x => x.id === model.provider)?.kind === 'anthropic' && stripsThinkingOnText(model.model) && history.some(m => m.role === 'assistant' && m.thinking);
    // まだ発言に付けていない、次に送る tail（見積もり用）。発言が無いか最後が assistant なら、次の発言か system の後ろに置く全体。最後が user / tool なら、モデルを呼ぶときは付けた分を発言が数えるので 0、
    // それ以外（使用量・道具の結果の量・続きの見積もり）は、次の呼び出しで最後の発言に付く分
    const pending = !last || oldThinking || last.message.role === 'assistant' ? system.tail : p.sendTail ? '' : next?.tail ?? '';
    let replay = false;
    if (history.some(m => m.role === 'assistant' && m.thinking)) {
      try { replay = fitMessages({ system: systemText(system), messages: history, tools: apiTools, available, factor, tail: pending }).removed === 0; } catch (error) { if (!(error instanceof ContextOverflow)) throw error; }
      if (!replay) history = history.map(m => withThinkingFor(m));
    }
    return { toolDefs, listed, system, pending, history, replay, stored, conversation, apiTools, capacity, available, maxOutput, planned, factor, trimmed, readable, clearedCalls };
  }

  // 道具の結果 1 つに許す量（見積もりのトークン）。次の呼び出しで古い発言を全部外しても残る分（system・道具の仕様・いまのやり取り）を、
  // そのモデルの available から引いた余裕の一部（context-budget.ts の toolResultTokens）。モデルの容量が分からなければ undefined（文字数の上限だけ）。何も書かない
  #toolResultTokens(p: { runId: string; conversationId: string; snapshot: string; model: ProviderModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }): { tokens: number | undefined; available: number | undefined } {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return { tokens: undefined, available: undefined };
    const { tokens } = irreducibleEstimate({ system: systemText(built.system), messages: built.history, tools: built.apiTools, factor: built.factor, tail: built.pending });
    return { tokens: toolResultTokens(built.available, tokens, built.factor), available: built.available };
  }

  // タスクの実行を区切るか: いまのやり取り（固定の分を除く）が、使える量から固定の分を引いた余裕の SPLIT_EXCHANGE_RATIO を超えた。容量が分からなければ区切らない
  #exchangeTooLong(p: { runId: string; conversationId: string; snapshot: string; model: ProviderModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }): boolean {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return false;
    const system = `${built.system.frozen}\n${built.system.dynamic}`;
    const fixed = estimateRequest(system, [], built.apiTools, built.factor).tokens;
    const exchange = irreducibleEstimate({ system, messages: built.history, tools: built.apiTools, factor: built.factor }).tokens - fixed;
    return exchange > SPLIT_EXCHANGE_RATIO * (built.available - fixed);
  }

  #continuationFits(p: { runId: string; conversationId: string; snapshot: string; model: ProviderModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project']; memoryProject?: string | undefined }, pending: ChatMessage[]): boolean {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return true;
    const { tokens } = irreducibleEstimate({ system: systemText(built.system), messages: [...built.history, ...pending], tools: built.apiTools, factor: built.factor, tail: built.pending });
    return tokens <= built.available;
  }

  // 製品の目次: 動かない一覧は MESH の印で囲んで dynamic へ、状態の行は tail の節へ（TE-2。どちらも実行のあいだは同じ）
  #meshIndex(runId: string | undefined, project: ToolContext['project'], available: number, conversationId: string): { index: string; status: string } {
    const mesh = this.#d.mesh;
    if (!mesh || !project) return { index: '', status: '' };
    let parts = runId ? this.#runIndex.get(runId) : undefined;
    if (parts === undefined) {
      parts = { list: '', status: [] };
      try { parts = mesh.indexParts(project.id, meshIndexLimit(available), conversationId); } catch (error) { this.#d.log?.(`[WARN] Could not build the mesh index of product ${project.id}: ${(error as Error).message}`); }
      if (runId) this.#runIndex.set(runId, parts);
    }
    return { index: parts.list ? wrapMeshIndex(parts.list, this.#fence(runId, conversationId).nonce) : '', status: meshStatusSection(parts.status) };
  }

  // 会話ごとの印（mesh の索引と tail が同じ nonce を使う。kv の fence:<会話>。TE-1: 保存した tail が前の実行の印を持つので、実行をまたいで同じ印を使う）。
  // 作って書くのは実行の中だけ。実行の外（使用量）は同じ長さの仮の nonce で、何も書かない
  #fence(runId: string | undefined, conversationId: string): ReturnType<typeof makeFence> {
    if (!runId) return makeFence(PLACEHOLDER_NONCE);
    let nonce = this.#runFence.get(runId);
    if (!nonce) {
      const key = `fence:${conversationId}`;
      const saved = this.#d.kv.get(key);
      if (saved !== undefined && /^[0-9a-f]{16}$/u.test(saved) && saved !== PLACEHOLDER_NONCE) nonce = saved;
      else { nonce = newNonce(); this.#d.kv.set(key, nonce); }
      this.#runFence.set(runId, nonce);
    }
    return makeFence(nonce);
  }

  // いまの会話を次に送るとき、モデルへ送る量（トークンの見積もり）。古い発言を削る前の全体で、available（削り始める境目）に対する割合 ratio は 1 を超えうる。
  // 副作用を持たない: 無い会話を作らず、固定の system が無い会話は固定せず（そのとき作るはずの文で数える）、ファイルの版も書かない。
  contextUsage(conversationId: string, modelId?: string): ContextUsageOutcome {
    const d = this.#d;
    const config = d.config();
    const language = languageOf(config);
    let model: ProviderModelConfig | undefined;
    const existing = d.conversations.get(conversationId);
    if (existing?.runtime_id) return this.#refuse({ key: 'usage.runtime' });
    // 数えるモデル: 指定されたもの → 会話で選んだもの → 設定の順番の先頭の使えるもの。選んだモデルが使えなくても、ほかのモデルで数えない
    const wanted = modelId ?? existing?.model_id ?? undefined;
    if (wanted !== undefined) {
      const found = config.models.find(m => m.id === wanted);
      if (!found) {
        if (modelId === undefined) return this.#noUsableModel(this.#chain('chat', wanted).problems);
        return { ok: false, httpStatus: 404, errorKind: 'not_found', errorMessage: engineText(language, 'usage.model_missing', { id: wanted }), errorCode: 'engine.usage.model_missing', errorParams: { id: wanted } };
      }
      if (isRuntimeModel(found)) return this.#refuse({ key: 'usage.runtime' });
      model = found;
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
    const { tokens } = estimateRequest(systemText(built.system), closeToolCalls(built.history, engineText(language, 'tool.not_run_stopped')), built.apiTools, built.factor, built.pending);
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

  // 会話で読み込んだ道具の名前（TE-2。kv の loaded-tools:<会話>。会話を消すと消える）
  #carriedTools(conversationId: string): string[] {
    const saved = this.#d.kv.getJson<unknown>(`loaded-tools:${conversationId}`);
    return Array.isArray(saved) ? saved.filter((name): name is string => typeof name === 'string') : [];
  }

  // 道具をこの会話の次の実行から並びに入れておく（TE-2 の先読みの口。tool_search の読み込みもここを通る）。登録に無い名前・核の道具は覚えない。
  // 実際に渡すかは実行ごとに #toolsFor が決める（止めた道具・計画モード・製品の外などは並びに入らず、パイプラインも断る）
  preload(conversationId: string, names: readonly string[]): void {
    const registry = this.#d.tools?.registry;
    if (!registry) return;
    const carried = this.#carriedTools(conversationId);
    const added = names.filter(name => !carried.includes(name) && registry.get(name) !== undefined && !isCore(registry.get(name)!));
    if (added.length) this.#d.kv.setJson(`loaded-tools:${conversationId}`, [...carried, ...new Set(added)]);
  }

  #usualTools(project: ToolContext['project'], mode: PermissionMode, model: ModelConfig): string[] {
    const { capacity, maxOutput } = this.#d.status.limits(model);
    const smallest = this.#smallestAvailable();
    const own = capacity > 0 ? contextAvailable(capacity, maxOutput) : undefined;
    return usualTools(this.#d.tools?.registry.list() ?? [], project?.root !== undefined, mode, model, smallest === undefined || own === undefined ? undefined : Math.min(smallest, own));
  }

  #defers(kind: RunKind, forbid: ReadonlySet<string> | undefined, started: AppConfig | undefined): boolean {
    const search = this.#d.tools?.registry.get('tool_search');
    return (kind === 'chat' || kind === 'task') && search !== undefined && search.mcp === undefined && search.allowedIn.includes(kind)
      && !this.#excluded(kind, forbid, started)(search);
  }

  #finishCancelled(runId: string, conversationId: string, counters: { attempts: number; iterations: number; toolCalls: number }, route: Route, partial: string, flags: readonly string[]): EngineResult {
    const d = this.#d;
    const language = languageOf(d.config());
    if (partial.trim()) {
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: `${partial}\n\n${engineText(language, 'message.stopped_partway')}` }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
    }
    d.runs.finish(runId, { ok: false, attempts: counters.attempts, iterations: counters.iterations, toolCalls: counters.toolCalls, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), modelId: route.model.id, providerId: route.provider.id, model: route.model.model, flags: flags.filter(flag => flag === 'thinking_replay_rejected') });
    d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled' });
    return { ok: false, runId, text: '', errorKind: 'cancelled', errorMessage: providerText(language, 'cancelled'), errorCode: 'provider.cancelled', retryable: false };
  }

  // 会話に覚えた削りの位置（TE-4）: これ以下の id の発言は送らない（trim-upto）・これ以下の id の道具の結果は印に替える（cleared-upto）
  #reduced(conversationId: string): { trimUpto: number; clearedUpto: number } {
    const read = (key: string): number => { const value = this.#d.kv.getJson<unknown>(`${key}:${conversationId}`); return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0; };
    return { trimUpto: read('trim-upto'), clearedUpto: read('cleared-upto') };
  }

  // upto 以下の id の道具の結果を短い印に替える（DB の元の結果は変えない）。印は道具の名前・入力の要点・全文のファイル・元を読む口（readable のときだけ）を書き、
  // やり直しを勧めるのは効果が read の道具だけ。タスクの結果の証拠の札（[E-n]）は印の後ろに残す。入力の要点は、保存した入力を JSON のまま伏せ → 見えない文字を消して 1 行に → 文として伏せ → nonce を消す。
  // 呼び出しとの組（toolCallId）・tail はそのまま。印の方が長くなる結果は替えない。替えた呼び出しの id は cleared に入れる
  #clearResults(history: ChatMessage[], stored: readonly StoredMessage[], upto: number, c: { conversationId: string; kind: RunKind; readable: boolean; fence: ReturnType<typeof makeFence> | undefined; language: Language }, cleared?: Set<string>): ChatMessage[] {
    if (upto <= 0) return history;
    const d = this.#d;
    const inputs = new Map<string, unknown>();
    for (const m of stored) if (m.message.role === 'assistant') for (const call of m.message.toolCalls ?? []) inputs.set(call.id, call.arguments);
    const outputs = join(d.paths.data, 'tool_outputs');
    const scrub = (text: string): string => (c.fence ? c.fence.clean(text) : text);
    return history.map((m, i) => {
      const id = stored[i]!.id;
      if (m.role !== 'tool' || id > upto) return m;
      const gist = plainLine(inputGist(redactJsonValue(boundedInput(inputs.get(m.toolCallId)))), CLEARED_INPUT_CHARS * 4);
      const input = plainLine(scrub(redactSecrets(gist, d.registry.secrets())), CLEARED_INPUT_CHARS) || '-';
      const file = fullRefIn(m.content, outputs);
      const marker = scrub(engineText(c.language, 'context.cleared', {
        tool: m.name, input,
        file: file ? engineText(c.language, 'context.cleared_file', { path: file }) : '',
        read: c.readable ? engineText(c.language, 'context.cleared_read', { conversation: c.conversationId, id }) : '',
        again: d.tools?.registry.get(m.name)?.effect === 'read' ? engineText(c.language, 'context.cleared_again') : '',
      }));
      const tag = c.kind === 'task' ? /\n(\[E-\d+\])$/u.exec(m.content)?.[1] : undefined;
      const content = tag ? `${marker}\n${tag}` : marker;
      if (content.length >= m.content.length && !m.images?.length) return m;
      cleared?.add(m.toolCallId);
      const { images: _images, ...rest } = m;
      return { ...rest, content };
    });
  }

  // 古いやり取りを外せば available に入るか
  #trimFits(input: Parameters<typeof fitMessages>[0]): boolean {
    try { fitMessages(input); return true; } catch (error) { if (error instanceof ContextOverflow) return false; throw error; }
  }

  // 送る量が available を超えたとき（TE-4）: (1) 新しい方から KEEP_TOOL_RESULTS + 1 個目の道具の結果までを印に替える位置を覚える（減る量が clearFloor 未満なら替えない）。
  // (2) それでも目標（available × CONTEXT_TARGET_RATIO）を超えるなら、古いやり取りを目標まで外す位置を覚え、外した発言（前に要約せずに外した分も）を要約する。
  // 外したなら発言の数によらず要約を頼む（黙って捨てない）。位置が動いたら true（呼ぶ側が組み立て直す）
  async #reduce(c: { runId: string; conversationId: string; kind: RunKind; readable: boolean; route: Route; adapter: ProviderAdapter; signal: AbortSignal; compaction: CompactionState; flags: string[]; system: ModelRequest['system']; history: ChatMessage[]; stored: StoredMessage[]; apiTools: ToolSpec[]; factor: number; pending: string; available: number; capacity: number; previous: string | null }): Promise<boolean> {
    const d = this.#d;
    const language = languageOf(d.config());
    const system = systemText(c.system);
    const measure = (messages: readonly ChatMessage[]): number => estimateRequest(system, messages, c.apiTools, c.factor, c.pending).tokens;
    const target = Math.floor(c.available * CONTEXT_TARGET_RATIO);
    const { trimUpto, clearedUpto } = this.#reduced(c.conversationId);
    const base = c.history.map(m => withThinkingFor(m));
    let current = c.history;
    let moved = false;
    const upto = c.stored.filter(m => m.message.role === 'tool').at(-(KEEP_TOOL_RESULTS + 1))?.id;
    if (upto !== undefined && upto > clearedUpto) {
      const cleared = this.#clearResults(c.history, c.stored, upto, { conversationId: c.conversationId, kind: c.kind, readable: c.readable, fence: this.#fence(c.runId, c.conversationId), language }).map(m => withThinkingFor(m));
      // 減る量が下限未満でも、古いやり取りを外しても available に入らない（1 つの長いやり取り）なら消す（ContextOverflow で止めるより先に）
      const saving = measure(base) - measure(cleared);
      if (saving >= clearFloor(c.available) || (saving > 0 && !this.#trimFits({ system, messages: base, tools: c.apiTools, available: c.available, factor: c.factor, tail: c.pending }))) {
        d.kv.setJson(`cleared-upto:${c.conversationId}`, upto);
        // 消した結果の元を history_read で読み戻せるよう道具の並びに入れる（TE-4a。並びが変わるのは、消して前半を書き直すこの呼び出しに重なる）
        this.preload(c.conversationId, [HISTORY_READ]);
        this.#loaded.get(c.runId)?.loaded.add(HISTORY_READ);
        current = cleared;
        moved = true;
      }
    }
    if (measure(current) <= target) return moved;
    let removed: number;
    try { removed = fitMessages({ system, messages: current, tools: c.apiTools, available: target, factor: c.factor, tail: c.pending }).removed; } catch (error) {
      if (!(error instanceof ContextOverflow)) throw error;
      removed = current.length - (groupExchanges(current).at(-1)?.length ?? current.length);
    }
    if (removed <= 0) return moved;
    const until = c.stored[removed - 1]!.id;
    d.kv.setJson(`trim-upto:${c.conversationId}`, until);
    const summaryUpto = d.conversations.get(c.conversationId)?.summary_upto ?? 0;
    const gone = d.conversations.messages(c.conversationId).filter(m => m.id > summaryUpto && m.id <= until);
    // 要約は 1 回の実行で失敗したらその実行のあいだは頼まない（次に超えたとき、外した発言をまとめて要約する）。
    // 実行をまたいで同じモデルで COMPACT_FAILURE_LIMIT 回続けて失敗した会話では、要約をやめて外すだけにする（kv の compact-failures:<会話> = { n, model }。
    // 成功で消す。取り消しと、再試行してよい提供元の誤り（混雑・429・通信）は数えない。失敗したのと違うモデルで要約するときは数え直す）
    const model = c.route.model.id;
    const stored = d.kv.getJson<{ n?: unknown; model?: unknown }>(`compact-failures:${c.conversationId}`);
    const failures = stored && stored.model === model && typeof stored.n === 'number' ? stored.n : 0;
    if (!c.compaction.failed && c.compaction.count < MAX_COMPACTIONS_PER_RUN && failures < COMPACT_FAILURE_LIMIT) {
      c.compaction.count++;
      const outcome = await this.#compact({ route: c.route, adapter: c.adapter, runId: c.runId, conversationId: c.conversationId, kind: c.kind, removed: gone, previous: c.previous, capacity: c.capacity, available: c.available, signal: c.signal,
        prefix: { system: c.system, history: c.history, apiTools: c.apiTools, factor: c.factor, pending: c.pending } });
      const summarized = outcome === 'ok';
      if (summarized) d.kv.delete(`compact-failures:${c.conversationId}`);
      else if (outcome === 'failed' && !c.signal.aborted) {
        d.kv.setJson(`compact-failures:${c.conversationId}`, { n: failures + 1, model });
        if (failures + 1 >= COMPACT_FAILURE_LIMIT) d.log?.(`[WARN] summarizing conversation ${c.conversationId} with model ${model} failed ${failures + 1} times in a row; old messages are only trimmed until another model is used`);
      }
      if (summarized) {
        // 要約した会話は、元の文を history_read で読み戻せるよう道具の並びに入れる（TE-4a）
        this.preload(c.conversationId, [HISTORY_READ]);
        this.#loaded.get(c.runId)?.loaded.add(HISTORY_READ);
        // お知らせは 1 回の実行で 1 回ずつ。件数は、この実行で要約した発言の合計に更新する（画面は同じお知らせを置き換える）
        c.compaction.summarized += gone.length;
        d.bus.publish({ type: 'compaction', runId: c.runId, conversationId: c.conversationId, summarized: c.compaction.summarized });
        d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'compacted', message: engineText(language, 'warn.compacted', { count: c.compaction.summarized }), params: { count: c.compaction.summarized } });
        if (!c.flags.includes('compacted')) c.flags.push('compacted');
        return true;
      }
      c.compaction.failed = true;
    }
    c.compaction.trimmed += removed;
    d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'context_trimmed', message: engineText(language, 'warn.context_trimmed', { count: c.compaction.trimmed }), params: { count: c.compaction.trimmed } });
    if (!c.flags.includes('context_trimmed')) c.flags.push('context_trimmed');
    return true;
  }

  // 古いやり取りの要約（TE-5）。2 つの形がある:
  // - 前半を読み直す形: いま送っている発言（prefix）の後ろに要約の頼みを 1 つ足す。この実行でそのモデルの提供元が読みを報告したときだけ（読めない提供元では入力が写しの何倍にもなる）。
  //   入りきらない・道具を呼んだ・失敗したら写しの形へ。決まった見出しの無い返事は 1 回だけ頼み直し、それでも無ければ写しの形へ
  // - 写しの形（今まで）: 外した発言を 1 発言 1,500 字・全体 60,000 字に切った写しから、道具なしで作る
  // 返事から見えない文字を消し、秘密を伏せ、会話の nonce を消してから、決まった節に組む。持ち主の発言と触ったファイルの節はコードが作る。
  // 外を読んだ節（Checklist・裏のコマンド）を載せた tail がこの会話にあれば、前半の形は使わない（前半は保存した tail を含むので、要約に写ると dynamic へ移り、tail の taint の数えから外れる）。
  // 結果: ok = 要約した / failed = 使えない返事・入りきらない・再試行しない誤り（3 回の数えに入る）/ transient = 取り消し・再試行してよい提供元の誤り（数えない）
  async #compact(c: { route: Route; adapter: ProviderAdapter; runId: string; conversationId: string; kind: RunKind; removed: StoredMessage[]; previous: string | null; capacity: number; available: number; signal: AbortSignal;
    prefix?: { system: ModelRequest['system']; history: readonly ChatMessage[]; apiTools: ToolSpec[]; factor: number; pending: string } }): Promise<'ok' | 'failed' | 'transient'> {
    const d = this.#d;
    const language = languageOf(d.config());
    const fence = this.#fence(c.runId, c.conversationId);
    const scrub = (text: string): string => fence.clean(redactSecrets(stripHidden(text), d.registry.secrets()));
    const upto = c.removed.at(-1)!.id;
    const maxOutputTokens = Math.min(compactOutputTokens(c.available), d.status.limits(c.route.model).maxOutput);
    const room = c.capacity * CONTEXT_FILL_RATIO;
    const ask = async (req: Pick<ModelRequest, 'system' | 'messages' | 'tools'>, estTokens: number) => {
      let text = '';
      let usage: Usage = {};
      let calls = 0;
      const startedAt = d.runs.now();
      for await (const event of c.adapter.stream({ model: c.route.model, ...req, maxOutputTokens, signal: c.signal })) {
        if (event.type === 'text') text += event.delta;
        else if (event.type === 'usage') usage = { ...usage, ...event.usage };
        else if (event.type === 'tool_call') calls++;
      }
      return { text, calls, record: { runId: c.runId, purpose: 'compact' as const, model: c.route.model.id, usage, estTokens, removed: c.removed.length, tools: req.tools, system: req.system, startedAt } };
    };
    const save = (reply: string): number => {
      const summary = scrub(composeSummary(scrub(reply), { ...this.#filesTouched(c.conversationId, scrub), owner: this.#ownerWords(c.conversationId, c.kind, upto, ownerWordsTokens(c.available), scrub, language) }, language));
      d.conversations.setSummary(c.conversationId, summary, upto);
      return summary.length;
    };
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(c.route.provider.id, () => c.route.provider.maxParallel, c.signal);
      if (c.prefix && this.#cacheSeen.get(c.runId)?.has(c.route.model.id) && !this.#tailTainted(c.conversationId)) {
        const head = [...closeToolCalls(c.prefix.history, engineText(language, 'tool.not_run_stopped'))];
        for (const retry of [false, true]) {
          const messages: ChatMessage[] = [...head, { role: 'user', content: compactRequest(language, retry) }];
          const estTokens = estimateRequest(systemText(c.prefix.system), messages, c.prefix.apiTools, c.prefix.factor, c.prefix.pending).tokens;
          if (estTokens + maxOutputTokens > room) break;
          let got;
          try { got = await ask({ system: c.prefix.system, messages, tools: c.prefix.apiTools }, estTokens); } catch (error) {
            if (c.signal.aborted) return 'transient';
            d.log?.(`[WARN] summarizing conversation ${c.conversationId} after the sent part failed, using the transcript instead: ${redactSecrets((error as Error).message, d.registry.secrets()).slice(0, UPSTREAM_KEEP)}`);
            break;
          }
          const usable = got.calls === 0 && got.text.trim() !== '' && hasSummarySections(got.text, language);
          d.runs.recordCall({ ...got.record, ...(usable ? { summaryChars: save(got.text) } : {}) });
          if (usable) return 'ok';
          if (got.calls > 0) break;
        }
      }
      const transcript = c.removed.map(m => `${compactSpeaker(m.message, language)}: ${m.text.slice(0, m.message.role === 'user' && m.message.note !== undefined ? COMPACT_NOTE_CHARS : 1500)}`).join('\n').slice(-COMPACT_TRANSCRIPT_CHARS);
      const prompt = compactPrompt({ previous: c.previous, transcript }, language);
      if (estimateTextTokens(prompt) * 1.15 + maxOutputTokens > room) return 'failed';
      const got = await ask({ system: { frozen: compactSystem(language), dynamic: '', tail: '' }, messages: [{ role: 'user', content: prompt }], tools: [] }, estimateTextTokens(prompt));
      const usable = got.text.trim() !== '';
      d.runs.recordCall({ ...got.record, ...(usable ? { summaryChars: save(got.text) } : {}) });
      return usable ? 'ok' : 'failed';
    } catch (error) {
      if (c.signal.aborted) return 'transient';
      d.bus.publish({ type: 'warning', runId: c.runId, conversationId: c.conversationId, code: 'compaction_failed', message: engineText(language, 'warn.compaction_failed') });
      return error instanceof ProviderError && error.retryable ? 'transient' : 'failed';
    } finally { release?.(); }
  }

  // 要約に原文で残す持ち主の発言。ctx.ownerText と同じ決まり（9-1b の D-7）: 会話（chat）は upto 以下の、generated でも note でも札の答えでもない user の発言（添付の中身は除く）、
  // タスクは持ち主の頼み（ownerRequestText）、ほか（振り返り・子の担当）は無し（user の発言はコードが組んだ頼みで、外の文や beat の書いた文を含む）。
  // 新しい方から、合計 budget（見積もりのトークン）まで。入りきらない発言は頭だけ残して印を付け、そこで止める
  #ownerWords(conversationId: string, kind: RunKind, upto: number, budget: number, scrub: (text: string) => string, language: Language): string[] {
    const d = this.#d;
    let rows: Array<{ id: number | undefined; text: string }> = [];
    if (kind === 'chat') {
      rows = d.conversations.messages(conversationId)
        .filter(({ id, message }) => id <= upto && message.role === 'user' && !message.generated && !message.note && !message.askAnswer)
        .map(row => ({ id: row.id, text: row.message.role === 'user' ? stripAttachments(row.message.content) : '' }))
        .reverse();
    } else if (kind === 'task') {
      const task = d.tasks?.byConversation(conversationId);
      const text = task ? d.tasks?.ownerRequestText(task.id) : undefined;
      if (text) rows = [{ id: undefined, text }];
    }
    const picked: string[] = [];
    let used = 0;
    for (const row of rows) {
      const words = scrub(row.text).trim();
      if (!words) continue;
      const tokens = estimateTextTokens(words);
      if (used + tokens <= budget) { picked.push(quoteOwner(row.id, words, false, language)); used += tokens; continue; }
      const keep = Math.floor((words.length * (budget - used)) / tokens);
      if (keep > 0) picked.push(quoteOwner(row.id, words.slice(0, keep), true, language));
      break;
    }
    return picked;
  }

  // 外を読んだ節を載せて保存した tail（tail-state の tainted）が、この会話にまだ 1 つでもあるか（要約の前半の形を使わない。TE-5）
  #tailTainted(conversationId: string): boolean {
    const tainted = this.#d.kv.getJson<TailState>(`tail-state:${conversationId}`)?.tainted;
    return (tainted?.checklist?.length ?? 0) > 0 || (tainted?.background?.length ?? 0) > 0;
  }

  // 要約の「触ったファイル」: 書き換えの記録（file_changes。recordToolWrite が書く）にある、この会話で作った・変えたファイル。新しい順に FILES_TOUCHED_MAX まで
  #filesTouched(conversationId: string, scrub: (text: string) => string): { files: string[]; more: number } {
    try {
      const rows = this.#d.conversations.db.prepare("SELECT path FROM file_changes WHERE conversation_id = ? AND action IN ('create', 'modify') GROUP BY path ORDER BY MAX(id) DESC").all(conversationId) as Array<{ path: string }>;
      return { files: rows.slice(0, FILES_TOUCHED_MAX).map(r => plainLine(scrub(r.path), FILE_PATH_CHARS)).filter(Boolean), more: Math.max(0, rows.length - FILES_TOUCHED_MAX) };
    } catch (error) {
      this.#d.log?.(`[WARN] could not list the files changed in conversation ${conversationId}: ${(error as Error).message}`);
      return { files: [], more: 0 };
    }
  }

  #snapshot(conversationId: string, project: ToolContext['project'], scout = false, bare = false): string {
    const d = this.#d;
    const existing = d.conversations.get(conversationId)?.snapshot;
    if (existing) return existing;
    recordFileVersions(d.conversations.db, d.paths);
    const language = languageOf(d.config());
    const snapshot = this.#buildSnapshotText(language, conversationId, project, d.log, scout, bare);
    d.conversations.setSnapshotOnce(conversationId, snapshot.text, snapshot.hash);
    return d.conversations.get(conversationId)?.snapshot ?? snapshot.text;
  }

  // 会話の始めに固定する system の文。作るだけで、何も書かない
  #buildSnapshotText(language: Language, conversationId: string, project: ToolContext['project'], log?: (line: string) => void, scout = false, bare = false) {
    const d = this.#d;
    if (bare) return buildSnapshot(d.paths, { persona: false }, language);
    const product = d.conversations.projectOf(conversationId) !== null;
    const root = project?.root ? project.productRoot ?? project.root : undefined;
    const rootKey = root && project ? d.projects?.get(project.id)?.root_key : undefined;
    return buildSnapshot(d.paths, {
      ...(d.botMemory && d.memory && !scout ? { memories: renderBooks(d.memory.list(), language, this.memoryBudget()) } : {}),
      // scout は考える実行と直す実行の両方で真。どちらにも skill_view は渡らないので、開けないスキルの名前は見せない
      ...(d.skills && !scout ? { skills: d.skills.index(language, skillsIndexBudget(this.#smallestAvailable())) } : {}),
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
