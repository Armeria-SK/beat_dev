import { randomUUID } from 'node:crypto';
import { DEFAULT_LANGUAGE, type AppConfig, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { Conversations, StoredMessage } from '../db/conversations.ts';
import type { KV } from '../db/kv.ts';
import type { Runs } from '../db/runs.ts';
import type { AppPaths } from '../paths.ts';
import { redactExact, redactSecrets } from '../shared/redaction.ts';
import type { PermissionMode } from '../shared/permission-mode.ts';
import type { EndpointLimiter } from '../providers/limiter.ts';
import { UPSTREAM_KEEP, upstreamText } from '../providers/http.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { ProviderError, providerError, type ProviderAdapter } from '../providers/types.ts';
import { renderBooks, type MemoryStore } from '../memory/store.ts';
import type { ApprovalBroker } from '../tools/approvals.ts';
import { TruncatedReply, USER_REQUEST_LIMIT, type ClassifierPrompt } from '../tools/auto-approve.ts';
import { checklistInjects, checklistSection, readChecklist } from '../tools/builtin/checklist-core.ts';
import { localAllows, planAllows, reviewAllows, runToolCall } from '../tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../tools/policy.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { PlanStore } from '../projects/plan.ts';
import { meshIndexLimit, wrapMeshIndex, type Mesh } from '../mesh/index.ts';
import { newNonce, PLACEHOLDER_NONCE } from '../shared/fence.ts';
import type { AcceptanceStore } from '../projects/acceptance.ts';
import { runProject } from '../projects/run.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { effectivePolicy } from '../tools/tool-policy.ts';
import { stricterMode } from '../shared/permission-mode.ts';
import type { BrowserSession } from '../tools/browser/session.ts';
import { isBrowserTool } from '../tools/browser/names.ts';
import type { AgentRunInput, RunKind, TaskControl, ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import type { CuriosityStore } from '../curiosity/store.ts';
import type { SkillStore } from '../tools/skills/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import type { RunBus } from './bus.ts';
import { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, PERSONA_BUDGET_RATIO, contextAvailable, toolResultTokens } from './context-budget.ts';
import { modelEfforts } from './efforts.ts';
import { ContextOverflow, fitMessages, irreducibleEstimate } from './fit.ts';
import { isLocalModel, isLocalPinned, isLocalProvider } from './local-model.ts';
import type { ModelStatus } from './status.ts';
import { extractToolCalls, looksLikeTextToolCall } from './toolcall-parse.ts';
import type { AttachmentMeta, ChatMessage, ContextDetail, EngineErrorKind, EngineResult, ImageRef, StopReason, ToolCall, Usage } from './types.ts';
import { estimateRequest, estimateTextTokens, prefixLength } from './tokens.ts';
import { languageOf } from '../shared/language.ts';
import { providerText } from '../shared/messages/providers.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { toolText, type ToolMessageKey } from '../shared/messages/tools.ts';
import { plainLine } from '../shared/plain-text.ts';
import { compactPrompt, compactSpeaker, compactSystem, summarySection } from './prompts.ts';
import { buildDynamic, buildSnapshot, recordFileVersions } from './workspace.ts';
import { instructionsBudget, instructionsSection, readInstructions } from '../projects/instructions.ts';
import { stripAttachments } from '../uploads/store.ts';

export { CONTEXT_FILL_RATIO, MEMORY_BUDGET_RATIO, contextAvailable };
export const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 2048;
const TRUNCATION_STRIKES = 2;
const CALIBRATION_ALPHA = 0.3;
const MAX_BACKOFF_MS = 30_000;
const MAX_INVALID_STREAK = 3;
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

const COMPACT_MIN_MESSAGES = 4;
// 1 回の実行で要約を重ねられる回数。外す発言が増えるたびに要約し直すが、無限には繰り返さない
const MAX_COMPACTIONS_PER_RUN = 5;
// 1 つの会話で、実行中に待たせておける発言の数
const MAX_PENDING_MESSAGES = 10;
const COMPACT_TRANSCRIPT_CHARS = 60_000;
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
  tools?: { registry: ToolRegistry; approvals: ApprovalBroker };
  memory?: MemoryStore;
  botMemory?: boolean | undefined;
  tasks?: TaskStore;
  curiosity?: CuriosityStore;
  skills?: SkillStore;
  projects?: ProjectStore | undefined;
  plans?: PlanStore | undefined;
  mesh?: Mesh | undefined;
  acceptance?: AcceptanceStore | undefined;
  web?: NonNullable<ToolContext['services']>['web'];
  notify?: NonNullable<ToolContext['services']>['notify'];
  log?: (line: string) => void;
  now?: () => Date;
  // 子の担当の時間切れ（ミリ秒）。試験で短くするためだけの上書き。ふつうは設定 tools.agent.timeoutSec（秒）を使う
  agentTimeoutMs?: number | undefined;
  // maxTools で切られた MCP の道具を、モデルごとに知らせる（空の一覧は「切られていない」）。MCP の管理が、道具の状態を cut にするために使う
  mcpCut?: (modelId: string, names: readonly string[]) => void;
  // ブラウザ 1 つ（全会話で共有）。無ければ browser_* は動かない（ToolContext.services.browser）
  browser?: BrowserSession | undefined;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retriesPerModel?: number;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const ATTACHMENT_PLACEHOLDER = new RegExp(`^(?:${[engineText(DEFAULT_LANGUAGE, 'attachment.image'), engineText(DEFAULT_LANGUAGE, 'attachment.file')].map(escapeRegExp).join('|')})$`, 'u');

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

interface ChatItem { content: string; images: ImageRef[]; attachments: AttachmentMeta[] }
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
  | { ok: true; index: number; text: string; toolCalls: ToolCall[]; usage: Usage; stop: StopReason; truncated: boolean; estimate: number }
  | { ok: false; cancelled: boolean; partial: string; failure: Failure; route?: Route };

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
  // 会話のチャットの実行が始まったときに選ばれていたモデル（null は自動）。待たせる発言が、そのあとのモデルの変更より後かを見分けるのに使う
  #runModel = new Map<string, string | null>();
  // 会話のチャットの実行が始まったときの権限モード。待たせる発言が、そのあとのモードの変更より後かを見分けるのに使う（モデルと同じ決まり）
  #runMode = new Map<string, PermissionMode>();
  #runFence = new Map<string, string>();
  #runIndex = new Map<string, string>();
  // 止める操作（stop）を受けた実行
  #stopped = new Set<string>();
  // 子の担当の会話 → それを任せた親の会話（親がチャットのときだけ。子の権限モードは、親の会話のいまのモードに従う）
  #modeHost = new Map<string, string>();
  // 実行（親）ごとに、これまでに任せた子の数
  #agentSpawned = new Map<string, number>();
  // 実行中に送られて、まだ履歴に入っていない発言（会話ごと。再起動で消える）
  #pending = new Map<string, PendingMessage[]>();
  // maxTools で切られた MCP の道具の警告を出したもの（モデル id と道具の名前の組。1 組に 1 回だけ）
  #cutWarned = new Set<string>();
  lastUserActivity = 0;
  onRunEnd: ((run: { runId: string; conversationId: string; kind: RunKind }) => void) | undefined;

  constructor(deps: ChatEngineDeps) { this.#d = deps; }

  #busy(key: EngineMessageKey): SendOutcome {
    return { ok: false, httpStatus: 409, errorKind: 'busy', errorMessage: engineText(languageOf(this.#d.config()), key), errorCode: `engine.${key}` };
  }

  // 実行中の会話に送った発言は、新しい実行にせず待たせる（待ちの発言）。今の実行が次の区切り（道具の結果を返して、次にモデルを呼ぶ前）に来たら
  // 履歴に入れ、実行が先に終わったら、その発言で新しい実行を始める。interrupt なら、今の実行を止めて、待っていた発言と一緒に新しい実行を始める
  send(conversationId: string, text: string, images: ImageRef[] = [], attachments: AttachmentMeta[] = [], choice: SendChoice = {}, options: { interrupt?: boolean; projectId?: string | undefined } = {}): SendOutcome {
    const item: ChatItem = { content: text, images, attachments };
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
      || this.#d.conversations.modeOf(conversationId) !== (this.#runMode.get(running) ?? 'normal');
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
      const permissionMode = choice.permissionMode ?? (projectId !== undefined && this.#d.plans?.has(projectId) === false ? 'plan' : 'normal');
      this.#d.conversations.ensure(conversationId, { projectId, modelId: choice.modelId, effort: choice.effort, permissionMode });
    }
    const runId = randomUUID();
    if (preempted.length) this.#preemptedTasks.set(runId, preempted);
    let firstId: number | undefined;
    for (const { content, images, attachments } of items) {
      const saved = this.#d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
      firstId ??= saved.id;
      // 添付の中身はタイトルにしない（本文が無ければ添付の名前にする）
      this.#d.conversations.autoTitle(conversationId, attachments.length ? stripAttachments(content).replace(ATTACHMENT_PLACEHOLDER, '') || attachments[0]!.name : content);
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
  #taintFromHistory(runId: string, conversationId: string): void {
    const language = languageOf(this.#d.config());
    const sources: string[] = [];
    const stored = this.#d.conversations.messages(conversationId, TAINT_SCAN_LIMIT);
    let replied = false;
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'assistant' && !message.toolCalls?.length) { replied = true; break; }
      if (message.role === 'user') sources.unshift(...(message.attachments ?? []).map(a => engineText(language, 'attachment.taint', { name: a.name })));
    }
    if (!replied && stored.length >= TAINT_SCAN_LIMIT) sources.push(engineText(language, 'taint.unknown'));
    if (this.#previousRunCarriesTaint(conversationId)) sources.push(engineText(language, 'taint.carried'));
    if (this.#checklistCarriesTaint(conversationId)) sources.push(engineText(language, 'taint.checklist'));
    if (sources.length) this.#initialTaint.set(runId, sources);
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
    try { const found = JSON.parse(last.flags) as string[]; wrappedUp = found.includes('max_iterations') || found.includes('output_truncated'); } catch { }
    return !(last.ok === 1 && !wrappedUp);
  }

  // 実行の区切りで、待っている発言を履歴に入れる（承認の札を待っているあいだは、実行が道具の呼び出しの中で待っているので、区切りに来ない。承認の答えが先）。
  // 差し込む発言は別の返事の元なので、「この返事のあいだ」のフォルダの許可（ctx.writeGrants）はここで全部終わる。
  // 添付つきの発言は外から来た文なので、この実行の残りも「外から読んだ」扱いにする。
  // 実行が始まったあとにモデルか権限モードを替えて送られた発言（held）は入れない（古いモデル・古いモードの実行へ渡さない）。実行が終わってから新しい実行で読ませる
  #injectPending(runId: string, conversationId: string, ctx: ToolContext): void {
    const d = this.#d;
    const queue = this.#pending.get(conversationId);
    if (!queue?.length) return;
    const injectable = queue.filter(p => !p.held);
    if (!injectable.length) return;
    ctx.writeGrants = undefined;
    const held = queue.filter(p => p.held);
    if (held.length) this.#pending.set(conversationId, held); else this.#pending.delete(conversationId);
    const language = languageOf(d.config());
    for (const { content, images, attachments } of injectable) {
      const saved = d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) }, runId);
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
    for (const { content, images, attachments } of messages) {
      const saved = d.conversations.append(conversationId, { role: 'user', content, ...(images.length ? { images } : {}), ...(attachments.length ? { attachments } : {}) });
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

  // task.local_only: 手元のモデルを選んだ会話から作ったタスク。裏方の順番のうち手元のモデルだけで動かし、使えるものが無ければ（チャットの順番や外のモデルに回さず）始めない（localOnly: true で知らせる）
  runTask(task: Task, conversationId: string, prompt: string): { ok: true; runId: string; control: { value: TaskControl }; done: Promise<EngineResult> } | { ok: false; errorMessage: string; localOnly?: true } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.task_running') };
    const localOnly = task.local_only === 1;
    const chain = this.#chain('background', null, localOnly);
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage, ...(localOnly ? { localOnly: true as const } : {}) };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    const control = { value: { outcome: 'none' } as TaskControl };
    const language = languageOf(this.#d.config());
    const sources = [
      ...(this.#d.runs.anyTaintedTask(conversationId) ? [engineText(language, 'taint.carried')] : []),
      ...(this.#checklistCarriesTaint(conversationId) ? [engineText(language, 'taint.checklist')] : []),
    ];
    if (sources.length) this.#initialTaint.set(runId, sources);
    this.#start(runId, conversationId, chain.usable, 'task', { task, control });
    return { ok: true, runId, control, done: this.#active.get(runId)!.done };
  }

  // localOnly: 手元のモデルで話した会話の振り返り。裏方の順番のうち手元のモデルだけを使い、無ければ（チャットの順番や外のモデルに回さず）始めない
  runReview(conversationId: string, prompt: string, options: { forbidTools?: readonly string[]; localOnly?: boolean } = {}): { ok: true; runId: string; done: Promise<EngineResult> } | { ok: false; errorMessage: string } {
    if (this.#byConversation.has(conversationId)) return { ok: false, errorMessage: engineText(languageOf(this.#d.config()), 'send.review_running') };
    const chain = this.#chain('background', null, options.localOnly === true);
    if (!chain.usable.length) {
      const outcome = this.#noUsableModel(chain.problems);
      return { ok: false, errorMessage: outcome.ok ? '' : outcome.errorMessage };
    }
    const saved = this.#d.conversations.append(conversationId, { role: 'user', content: prompt });
    const runId = randomUUID();
    this.#d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'user' });
    this.#start(runId, conversationId, chain.usable, 'review', undefined, options.forbidTools?.length ? new Set(options.forbidTools) : undefined);
    return { ok: true, runId, done: this.#active.get(runId)!.done };
  }

  wasPreempted(runId: string): boolean { return this.#preempted.has(runId); }

  // 裏の実行（タスク・振り返り）をもう 1 本始めても、先に使う提供元の maxParallel を越えないか。
  // 数えるのは、動いている裏の実行の「最初に使う提供元」（道具を動かしている最中で limiter の枠を返しているものも含む）。使えるモデルが無いときは true（始めて、いつもの失敗の道に任せる）
  backgroundHasRoom(localOnly = false): boolean {
    const first = this.#chain('background', null, localOnly).usable[0];
    if (!first) return true;
    let running = 0;
    for (const active of this.#active.values()) if (active.kind !== 'chat' && active.primary === first.provider.id) running += 1;
    return running < first.provider.maxParallel;
  }

  // 手元のモデルで話した会話の振り返りに使える、手元の裏方モデルがあるか
  localReviewAvailable(): boolean { return this.#chain('background', null, true).usable.length > 0; }

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
    return { modelId: model?.id, efforts: model ? modelEfforts(config, model, this.#d.status.get(model.id)) : [] };
  }

  #smallestAvailable(): number | undefined {
    const config = this.#d.config();
    const ids = new Set([...candidateModelIds(config, 'chat'), ...candidateModelIds(config, 'background')]);
    let smallest: number | undefined;
    for (const id of ids) {
      const model = config.models.find(m => m.id === id);
      if (!model || !this.#d.status.usable(id)) continue;
      const capacity = this.#d.status.get(id)?.effective ?? model.contextLength ?? 0;
      if (!(capacity > 0)) continue;
      const available = contextAvailable(capacity, model);
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
    active.controller.abort(providerError('cancelled', 'cancelled', {}, { retryable: false }));
    return true;
  }

  stopAll(): void { for (const runId of this.#active.keys()) this.stop(runId); }

  wait(runId: string): Promise<EngineResult> | undefined { return this.#active.get(runId)?.done; }
  get chatting(): boolean { return [...this.#active.values()].some(a => a.kind === 'chat'); }
  activeRuns(): Array<{ runId: string; conversationId: string; kind: RunKind; mode?: PermissionMode }> {
    return [...this.#active.values()].map(a => ({
      runId: a.runId, conversationId: a.conversationId, kind: a.kind,
      ...(a.kind === 'chat' ? { mode: stricterMode(this.#runMode.get(a.runId) ?? 'normal', this.#d.conversations.modeOf(a.conversationId)) } : {}),
    }));
  }

  // 会話で選んだモデルがあれば（pinned）、そのモデルだけで鎖を作る。使えなければ、ほかのモデルへ切り替えずに、そのモデルの問題だけを返す
  // localOnly: 裏方の順番（routing.background）のうち、手元のモデルだけ。順番が空でもチャットの順番や設定のモデル全部には回さない
  #chain(route: 'chat' | 'background', pinned: string | null = null, localOnly = false): { usable: Route[]; problems: ModelProblem[] } {
    const config = this.#d.config();
    const language = languageOf(config);
    const ids = localOnly ? config.routing.background.filter(id => isLocalModel(config, id)) : pinned ? [pinned] : candidateModelIds(config, route);
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

  #start(runId: string, conversationId: string, chain: Route[], kind: RunKind, task?: { task: Task; control: { value: TaskControl } }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): void {
    const controller = new AbortController();
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
        this.#byConversation.delete(conversationId);
        this.#preemptedTasks.delete(runId);
        this.#runModel.delete(runId);
        this.#runMode.delete(runId);
        this.#runFence.delete(runId);
        this.#runIndex.delete(runId);
        this.#stopped.delete(runId);
        this.#modeHost.delete(conversationId);
        this.#agentSpawned.delete(runId);
        setTimeout(() => this.#preempted.delete(runId), 60_000).unref?.();
        // 待っている発言の引き取り（会話の実行の鎖が途切れないよう、ロックを外した直後に、同じ呼び出しの中で次の実行を始める）
        if (kind === 'chat') {
          try { this.#drainPending(conversationId, runId, ended); } catch (error) { this.#d.log?.(`[ERROR] Failed to pick up the waiting messages: ${(error as Error).stack ?? error}`); }
        }
        try { this.onRunEnd?.({ runId, conversationId, kind }); } catch (error) { this.#d.log?.(`[ERROR] onRunEnd: ${(error as Error).message}`); }
      });
    this.#active.set(runId, { runId, conversationId, kind, ...(task ? { taskId: task.task.id } : {}), providers: new Set(chain.map(r => r.provider.id)), primary: chain[0]!.provider.id, controller, done });
  }

  // モデルに渡す道具の一覧。外す条件はここだけ（maxTools の数える前に外す）: 振り返りで禁止の道具（reviewAllows: 効果が write・exec・network のもの、ファイルも書く道具）・この実行で禁止された道具・持ち主が「止める」にした道具（tools.policies）。
  // 「止める」は、パイプラインと同じく、実行を始めたときの設定（started）といまの設定の厳しい方。始めたときに止めていた道具は、途中で緩めても、その実行のあいだは戻らない。
  // 計画モード（plan）の会話では、planAllows を通る道具だけを渡す: 効果が読む（read）か Web の読み取り（network）で、ファイルも書く道具（writesFiles）でないもの（パイプラインの二重の拒否は runToolCall）。
  // 実行に効くモードは、実行を始めたときのモード（#assemble の startedMode）と会話のいまのモードの厳しい方。始めたときが計画なら、途中でふつうに戻しても、その実行のあいだは計画のまま
  // 手元のモデルの会話（localOnly）には、localOk でない MCP の道具を渡さない（localAllows。パイプラインも同じに拒む）。
  // maxTools で切られた MCP の道具は、モデルと道具の組ごとに 1 回だけ [WARN] を出し、MCP の管理に知らせる（画面の状態が cut になる）
  #toolsFor(model: ModelConfig, kind: RunKind, forbid?: ReadonlySet<string>, started?: AppConfig, mode: PermissionMode = 'normal', localOnly = false, inProject = false): ToolDef[] {
    if (!this.#d.tools || model.maxTools === 0) return [];
    const config = this.#d.config();
    const exclude = (t: ToolDef) => (kind === 'review' && !reviewAllows(t)) || (t.name === 'agent_run' && agentOff(config, kind)) || (isBrowserTool(t.name) && !config.tools.browser.enabled) || forbid?.has(t.name) === true || effectivePolicy(t.name, config, started) === 'block'
      || (mode === 'plan' && !planAllows(t)) || !localAllows(t, localOnly) || (t.projectOnly === true && !inProject);
    const options = { limit: model.maxTools, exclude };
    const registry = this.#d.tools.registry;
    if (kind === 'chat' && this.#d.mcpCut) {
      const cut = registry.cut(kind, options).filter(t => t.mcp !== undefined);
      this.#d.mcpCut(model.id, cut.map(t => t.name));
      for (const t of cut) {
        const key = `${model.id}\n${t.name}`;
        if (this.#cutWarned.has(key)) continue;
        this.#cutWarned.add(key);
        this.#d.log?.(`[WARN] MCP tool "${t.name}" cannot be passed to model "${model.id}" because it is over the tool limit (maxTools ${model.maxTools}). Raise the limit, or turn off tools you do not use`);
      }
    }
    return registry.forRun(kind, options);
  }

  async #execute(runId: string, conversationId: string, chain: Route[], signal: AbortSignal, kind: RunKind, task?: { task: Task; control: { value: TaskControl } }, forbid?: ReadonlySet<string>, effort: string | null = null, agent?: AgentLink): Promise<EngineResult> {
    const d = this.#d;
    // 子の担当は、親が始めたときの設定で動く（親と同じ決まり。途中で緩めても広がらない）
    const config = agent?.parent.config ?? d.config();
    d.runs.start(runId, kind, conversationId, agent?.parent.runId);
    const resolved = agent ? agent.parent.project : runProject(d.projects, d.conversations.projectOf(conversationId));
    const snapshot = this.#snapshot(conversationId, resolved);
    d.bus.publish({ type: 'run.start', runId, conversationId, modelId: chain[0]!.model.id });
    const flags: string[] = chain[0]!.backup ? ['fallback'] : [];
    const usage: Usage = {};
    const counters = { attempts: 0, iterations: 0, toolCalls: 0, workCalls: 0 };
    let index = 0;
    let invalidStreak = 0;
    // 切れた呼び出しが続けて何回目か（invalidStreak とは別に数える）
    let truncatedStreak = 0;
    let lastEstimate = 0;
    let lastRoute: Route = chain[0]!;
    const project = kind === 'review' ? undefined : resolved;
    if (project) d.mesh?.persist(project.id);
    if (project && !project.root && !agent) d.log?.(`[WARN] The folder of product ${project.id} could not be confirmed, so run ${runId} does not get it as a writable folder`);
    const productRoots = agent || kind === 'review' ? [] : [...(d.projects?.list() ?? []), ...(d.projects?.list({ archived: true }) ?? [])].map(p => p.root);
    const base = agent ? undefined : buildPolicy(config, d.paths, undefined, productRoots);
    const policy = agent?.parent.policy ?? (project?.root ? buildPolicy(config, d.paths, { root: project.root }, productRoots) : base!);
    const home = agent ? agent.parent.home ?? agent.parent.workspace : defaultWorkspace(base!, d.paths);
    // 道具が書き込む「どう終えるか」の印は、ワーカーが読む control.value と同じ入れ物にする
    const taskSlot = task ? { id: task.task.id, get control() { return task.control.value; }, set control(v: TaskControl) { task.control.value = v; } } : undefined;
    const touchedTasks = new Set<string>();
    const ctx: ToolContext = {
      runId, conversationId, kind, signal, config, paths: d.paths, policy, workspace: agent?.parent.workspace ?? (project ? project.root ?? d.projects?.get(project.id)?.root ?? d.paths.projects : home), home, ...(project ? { project } : {}),
      taint: (() => { const sources = this.#initialTaint.get(runId) ?? []; this.#initialTaint.delete(runId); return { tainted: sources.length > 0, sources }; })(),
      conversationTainted: () => d.conversations.everTainted(conversationId),
      log: d.log ?? (() => undefined),
      services: d.memory ? { db: d.conversations.db, memory: d.memory, tasks: d.tasks, curiosity: d.curiosity, skills: d.skills, plans: d.plans, acceptance: d.acceptance, projects: d.projects, mesh: d.mesh, web: d.web, notify: d.notify, browser: d.browser, emit: e => d.bus.publish(e) } : undefined,
      task: taskSlot,
      touchedTasks,
      ...(forbid ? { forbiddenTools: forbid } : {}),
      ...(kind === 'chat' ? { permissionMode: this.#runMode.get(runId) ?? 'normal' } : agent ? { permissionMode: agent.mode } : {}),
      ...(agent ? { parent: { runId: agent.parent.runId, conversationId: agent.parent.conversationId, kind: agent.parent.kind, title: d.conversations.get(conversationId)?.title ?? '' } } : {}),
    };
    ctx.modelsLocal = chain.every(route => isLocalProvider(route.provider)) && (agent?.parent.modelsLocal ?? true);
    if (agent?.parent.autoReadOutside) ctx.autoReadOutside = true;
    ctx.localOnly = agent ? agent.parent.localOnly : kind === 'chat' ? isLocalPinned(config, d.conversations.get(conversationId)?.model_id) : task?.task.local_only === 1;
    // 子の担当を任せる道具の入口（設定で有効のときだけ。子は孫を作れない。タスクは tools.agent.inTasks で許したときだけ）
    if (kind !== 'agent' && config.tools.agent.enabled && (kind === 'chat' || (kind === 'task' && config.tools.agent.inTasks))) {
      ctx.agent = (input, callId) => this.#runAgent({ ctx, routes: chain.slice(index), forbid }, input, callId);
    }
    // 外から読んだ印は、実行の記録に読んだ時点で書く（途中で止まる・落ちる実行でも、やり直し・続きが引き継げるように）
    let taintRecorded = false;
    // 会話にも「外から読んだことがある」印を付ける（自動承認の判定役には、この会話は「よそから来た文を読んだ」と伝わる）
    const recordTaint = () => { if (taintRecorded || !ctx.taint.tainted) return; taintRecorded = true; d.runs.markTainted(runId); if (kind === 'chat' || kind === 'agent') d.conversations.markTainted(conversationId); };
    // 自動承認で許可フォルダの外を読んだ印は、会話に書く（この会話のシェルのコマンドと通信の道具は、あとの実行でもずっと毎回確かめる。実行が止まる・落ちても残るよう、読んだ時点で書く）
    let autoReadRecorded = false;
    const recordAutoRead = () => { if (autoReadRecorded || !ctx.autoReadOutside) return; autoReadRecorded = true; d.conversations.markAutoRead(conversationId); };
    const addUsage = (u: Usage) => {
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        if (typeof u[key] === 'number') usage[key] = (usage[key] ?? 0) + u[key]!;
      }
    };
    const finishOk = (text: string, stop: StopReason, split?: { split: true }): EngineResult => {
      if (kind === 'chat') this.#handOver(runId, text, { workCalls: counters.workCalls, touched: touchedTasks, tainted: ctx.taint.tainted || d.conversations.everTainted(conversationId), localOnly: ctx.localOnly === true, projectId: ctx.project?.id ?? null });
      d.runs.finish(runId, { ok: true, modelId: lastRoute.model.id, providerId: lastRoute.provider.id, model: lastRoute.model.model, attempts: counters.attempts, stop, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, estPromptTokens: lastEstimate, flags });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: true });
      return { ok: true, runId, text, modelId: lastRoute.model.id, usage, stop, ...(stop === 'max_tokens' ? { truncated: true as const } : {}), ...(split ? { split: true as const } : {}) };
    };
    const finishFail = (f: Failure): EngineResult => {
      const route = f.route ?? lastRoute;
      // 実行ログには、相手のサーバーの本文も残す（画面に届く出来事・結果には入れない）
      d.runs.finish(runId, { ok: false, attempts: counters.attempts, errorKind: f.kind, errorMessage: f.upstream ? `${f.message}: ${upstreamText(f.upstream, d.registry.secrets())}` : f.message, flags, iterations: counters.iterations, toolCalls: counters.toolCalls, usage, modelId: route.model.id, model: route.model.model, providerId: route.provider.id });
      d.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), ...(f.detail ? { detail: f.detail } : {}) });
      return { ok: false, runId, text: '', errorKind: f.kind, errorMessage: f.message, ...(f.code ? { errorCode: f.code, errorParams: f.params ?? {} } : {}), retryable: f.retryable, ...(f.detail ? { detail: f.detail } : {}) };
    };

    const ceiling = kind === 'chat' ? Infinity : UNATTENDED_ITERATION_CEILING;
    const compaction: CompactionState = { count: 0, failed: false, summarized: 0, trimmedShown: -1 };
    for (counters.iterations = 1; counters.iterations <= ceiling; counters.iterations++) {
      if (kind === 'chat') this.#injectPending(runId, conversationId, ctx);
      if (kind === 'chat' || kind === 'agent') { recordTaint(); recordAutoRead(); }
      if (kind === 'task') recordTaint();
      const call = await this.#callModel({ runId, conversationId, chain, start: index, snapshot, signal, counters, flags, compaction, kind, forbid, effort, started: config, startedMode: ctx.permissionMode, project: ctx.project });
      if (!call.ok) {
        if (call.cancelled) return this.#finishCancelled(runId, conversationId, counters, call.route ?? lastRoute, call.partial);
        return finishFail(call.failure);
      }
      index = call.index;
      lastRoute = chain[index]!;
      lastEstimate = call.estimate;
      addUsage(call.usage);
      // 考える部分を別に返すモデル（Qwen3 など）は、答えの頭に空行が付く。保存する前に落とす
      call.text = call.text.replace(/^\s+/u, '');

      // 出力の上限で切れた返事: 黙って成功にしない。お知らせと実行の印を残し、付いていたツール呼び出しは動かさない
      // （切れた元の文字は記録の入力欄にだけ残し、会話には {} で保存する。次の呼び出しにも、提供元に断られる切れた文字を送らない）
      const cutRaw = new Map<string, string>();
      if (call.truncated) {
        if (!flags.includes('output_truncated')) {
          flags.push('output_truncated');
          d.bus.publish({ type: 'warning', runId, conversationId, code: 'output_truncated', message: engineText(languageOf(config), 'warn.output_truncated') });
        }
        for (const c of call.toolCalls) cutRaw.set(c.id, c.raw ?? JSON.stringify(c.arguments ?? null));
        call.toolCalls = call.toolCalls.map(c => ({ id: c.id, name: c.name, arguments: {} }));
      }
      const saved = d.conversations.append(conversationId, { role: 'assistant', content: call.text, ...(call.toolCalls.length ? { toolCalls: call.toolCalls } : {}) }, runId);
      d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: 'assistant' });
      if (!call.toolCalls.length) return finishOk(call.text, call.stop);
      if (!d.tools) return finishOk(call.text, call.stop);

      let invalidThisRound = 0;
      for (const toolCall of call.toolCalls) {
        if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
        counters.toolCalls++;
        if (!toolCall.name.startsWith('task_')) counters.workCalls++;
        // この結果に許す量は、次のモデル呼び出しの残りの余裕から決める（結果が積まれるほど小さくなる）
        const budget = this.#toolResultTokens({ runId, conversationId, snapshot, model: lastRoute.model, kind, forbid, started: config, startedMode: ctx.permissionMode, project: ctx.project });
        ctx.outputTokens = budget.tokens;
        ctx.contextAvailable = budget.available;
        ctx.model = { id: lastRoute.model.id, vision: lastRoute.model.vision };
        const outcome = await runToolCall(toolCall, ctx, {
          registry: d.tools.registry, approvals: d.tools.approvals, db: d.conversations.db, emit: e => d.bus.publish(e), config: d.config,
          permissionMode: () => this.#modeOf(conversationId),
          autoClassify: (prompt, classifierSignal) => this.#autoAsk(lastRoute, ctx, prompt, classifierSignal),
          lastUserRequest: () => this.#lastUserRequest(conversationId),
          conversationTainted: () => d.conversations.everTainted(conversationId),
          conversationAutoRead: () => d.conversations.everAutoRead(conversationId),
        }, cutRaw.has(toolCall.id) ? { message: engineText(languageOf(config), toolCall.name === 'skill_draft' ? 'tool.truncated_skill_draft' : 'tool.truncated_call'), raw: cutRaw.get(toolCall.id)! } : undefined);
        recordTaint();
        recordAutoRead();
        if (outcome.invalidArguments) invalidThisRound++;
        const toolSaved = d.conversations.append(conversationId, {
          role: 'tool', toolCallId: toolCall.id, name: toolCall.name, content: outcome.output.content, ...(outcome.output.isError ? { isError: true } : {}),
          ...(!outcome.output.isError && outcome.output.images?.length ? { images: outcome.output.images } : {}),
        }, runId);
        d.bus.publish({ type: 'message.saved', runId, conversationId, messageId: toolSaved.id, role: 'tool' });
      }
      if (signal.aborted) return this.#finishCancelled(runId, conversationId, counters, lastRoute, '');
      // タスクの終え方（完了・途中経過・質問）が決まったら、モデルを呼び直さずに終える
      if (task && task.control.value.outcome !== 'none') return finishOk(call.text, 'end_turn');
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
    return finishOk('', 'other', { split: true });
  }

  // 自動承認の判定役に見せる、会話の利用者の最後の発言（添付の中身は除く）。無ければ空（判定役には回らず、確かめる）
  #lastUserRequest(conversationId: string): string {
    const stored = this.#d.conversations.messages(conversationId, 50);
    for (let i = stored.length - 1; i >= 0; i--) {
      const message = stored[i]!.message;
      if (message.role === 'user') return stripAttachments(message.content).slice(0, USER_REQUEST_LIMIT);
    }
    return '';
  }

  // 自動承認の判定役（モデル）を 1 回呼び、返事の文字を返す。呼べなければ投げる（呼ぶ側は確かめる側に倒す）。
  // 使うのは、この実行がいま使っているモデル（route）だけで、ほかのモデルは探さない。手元のモデルを選んだ会話（ctx.localOnly）は、手元のモデルのときだけ。道具は渡さない。
  // 判定役の呼び出しは engine_runs に入れず、会話も作らない
  async #autoAsk(route: Route, ctx: ToolContext, prompt: ClassifierPrompt, signal: AbortSignal): Promise<string> {
    const d = this.#d;
    const { model, provider } = route;
    if (ctx.localOnly && !isLocalProvider(provider)) throw new Error('the classifier model must be local for a local conversation');
    const adapter = d.registry.get(provider.id);
    if (!adapter) throw new Error('no adapter for the classifier model');
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(provider.id, () => provider.maxParallel, signal);
      let text = '';
      for await (const event of adapter.stream({
        model, system: { frozen: prompt.system, dynamic: '' }, messages: [{ role: 'user', content: prompt.user }], tools: [], maxOutputTokens: Math.min(400, model.maxOutputTokens), signal,
      })) {
        if (event.type === 'text') text += event.delta;
        else if (event.type === 'done' && event.stop === 'max_tokens') throw new TruncatedReply();
      }
      // 返事の短い理由は承認の記録・画面の出来事・実行ログの API に出るので、API キーそのものは、読む前に伏せる
      return redactExact(text, d.registry.secrets());
    } finally { release?.(); }
  }

  // 会話の実行が終わるとき、会話で進んだ分をタスクの経過（メモ）に書く。書く先は次のとおりで、何にも触っていなければ何も書かない:
  // - この実行で作った・task_update で触ったタスク（作る以外の道具を使った実行だけ。作っただけの確認の返事はメモにしない）
  // この実行が止めたタスク（preempted）は、止めただけでは書かない（止めるのは、同じモデルの提供元を使っているだけで、別の会話のタスクかもしれない）。触ったときだけ書き、そのとき実行中のままの状態（running）も許す
  // 外から読んだ実行（taint）は書かない: メモはタスクの詳細に入り、外を読んでいないタスクの実行が指示として読むため
  // 手元のモデルの会話の実行（localOnly）が書いたタスクは、手元のモデルだけで動かすタスクにする（メモに会話の文が入るため）
  #handOver(runId: string, text: string, run: { workCalls: number; touched: ReadonlySet<string>; tainted: boolean; localOnly: boolean; projectId: string | null }): void {
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
      d.tasks.update(id, { appendNote: engineText(language, 'handover.note', { text: note.slice(0, 1500) }) }, 'clive', runId);
      if (run.localOnly) d.tasks.markLocalOnly(id);
    }
  }

  async #callModel(p: { runId: string; conversationId: string; chain: Route[]; start: number; snapshot: string; signal: AbortSignal; counters: { attempts: number }; flags: string[]; compaction: CompactionState; kind: RunKind; forbid?: ReadonlySet<string> | undefined; effort?: string | null | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project'] }): Promise<CallResult> {
    const d = this.#d;
    const sleep = d.sleep ?? abortableSleep;
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
        const { toolDefs, system, history, stored, conversation, apiTools, capacity, available, factor } = this.#assemble({ runId: p.runId, conversationId: p.conversationId, snapshot: p.snapshot, model, kind: p.kind, forbid: p.forbid, started: p.started, startedMode: p.startedMode, project: p.project });
        const toolNames = new Set(toolDefs.map(t => t.name));
        // 考える深さは、そのモデルが受け付ける値のときだけ送る（鎖の途中で別のモデルに替わったとき、受け付けない値を送らない）
        const effort = p.effort && modelEfforts(d.config(), model, d.status.get(model.id)).includes(p.effort) ? p.effort : undefined;
        let fitted;
        try {
          fitted = fitMessages({ system: `${system.frozen}\n${system.dynamic}`, messages: history, tools: apiTools, available, factor });
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
        let release: (() => void) | undefined;
        try {
          release = await d.limiter.acquire(provider.id, () => provider.maxParallel, p.signal);
          for await (const event of adapter.stream({ model, system, messages: fitted.messages, tools: apiTools, maxOutputTokens: model.maxOutputTokens, ...(effort ? { effort } : {}), signal: p.signal })) {
            if (event.type === 'text') { text += event.delta; d.bus.publish({ type: 'text.delta', runId: p.runId, conversationId: p.conversationId, text: event.delta }); }
            else if (event.type === 'usage') usage = { ...usage, ...event.usage };
            else if (event.type === 'tool_call') toolCalls.push(event.call);
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

        // 本文に書かれたツール呼び出しを拾う（tool_calls を使わずに本文に書いたモデル）
        if (!toolCalls.length && toolNames.size && looksLikeTextToolCall(text)) {
          const parsed = extractToolCalls(text, toolNames);
          if (parsed.calls.length) {
            toolCalls.push(...parsed.calls);
            text = parsed.text;
            if (!p.flags.includes('text_tool_calls')) p.flags.push('text_tool_calls');
          }
        }
        this.#checkTruncation(p.runId, p.conversationId, model, fitted.estimate, usage, capacity, p.flags);
        if (effort && !p.flags.includes(`effort:${effort}`)) p.flags.push(`effort:${effort}`);
        // truncated は書き換える前の停止理由で決める（ツール呼び出しが付いても、出力の上限で切れた返事は切れたまま）
        return { ok: true, index, text, toolCalls, usage, stop: toolCalls.length ? 'tool_use' : stop, truncated: stop === 'max_tokens', estimate: fitted.estimate.tokens };
      }
    }
    return { ok: false, cancelled: false, partial: '', failure: last };
  }

  // モデルへ送る 1 回分の組み立て（system・履歴・道具の仕様・見積もりの補正）。実行（#callModel）と使用量（contextUsage）の両方がここを通るので、数がずれない。
  // 何も書かない。固定の system（snapshot）は呼ぶ側が渡す
  // startedMode: 実行を始めたときの権限モード（実行の中でだけ渡す。使用量の数え方は次の実行のためなので、会話のいまのモードで数える）
  #assemble(p: { runId?: string | undefined; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project'] }) {
    const d = this.#d;
    const { model } = p;
    const config = d.config();
    const language = languageOf(config);
    const current = this.#modeOf(p.conversationId);
    const mode: PermissionMode = p.kind === 'chat' || p.kind === 'agent' ? stricterMode(p.startedMode ?? current, current) : 'normal';
    const localOnly = p.kind === 'chat' && isLocalPinned(config, d.conversations.get(p.conversationId)?.model_id);
    const toolDefs = this.#toolsFor(model, p.kind, p.forbid, p.started, mode, localOnly, p.project !== undefined);
    const specs = ToolRegistry.specs(toolDefs, config);
    const capacity = d.status.get(model.id)?.effective ?? model.contextLength ?? 0;
    const available = contextAvailable(capacity, model);
    const conversation = d.conversations.get(p.conversationId);
    const upto = conversation?.summary_upto ?? 0;
    const stored = d.conversations.messages(p.conversationId).filter(m => m.id > upto);
    const summary = summarySection(conversation?.summary ?? '', language);
    const checklist = checklistSection(readChecklist(d.kv, p.conversationId), language);
    const row = p.project?.root ? d.projects?.get(p.project.id) : undefined;
    const product = row && p.project?.root ? { name: row.name, root: p.project.root, docLanguage: row.doc_language } : undefined;
    const mesh = this.#meshIndex(p.runId, p.project, available);
    const dynamic = [buildDynamic(config.timezone, language, d.now?.() ?? new Date(), mode, product, p.kind === 'chat'), mesh, summary, checklist].filter(Boolean).join('\n\n');
    const system = { frozen: p.snapshot, dynamic };
    const history = stored.map(m => m.message);
    const apiTools = specs;
    const factor = d.kv.getJson<number>(`calibration:${model.id}`) ?? 1;
    return { toolDefs, system, history, stored, conversation, apiTools, capacity, available, factor };
  }

  // 道具の結果 1 つに許す量（見積もりのトークン）。次の呼び出しで古い発言を全部外しても残る分（system・道具の仕様・いまのやり取り）を、
  // そのモデルの available から引いた余裕の一部（context-budget.ts の toolResultTokens）。モデルの容量が分からなければ undefined（文字数の上限だけ）。何も書かない
  #toolResultTokens(p: { runId: string; conversationId: string; snapshot: string; model: ModelConfig; kind: RunKind; forbid?: ReadonlySet<string> | undefined; started?: AppConfig | undefined; startedMode?: PermissionMode | undefined; project?: ToolContext['project'] }): { tokens: number | undefined; available: number | undefined } {
    const built = this.#assemble(p);
    if (!(built.capacity > 0)) return { tokens: undefined, available: undefined };
    const { tokens } = irreducibleEstimate({ system: `${built.system.frozen}\n${built.system.dynamic}`, messages: built.history, tools: built.apiTools, factor: built.factor });
    return { tokens: toolResultTokens(built.available, tokens, built.factor), available: built.available };
  }

  #meshIndex(runId: string | undefined, project: ToolContext['project'], available: number): string {
    const mesh = this.#d.mesh;
    if (!mesh || !project) return '';
    let body = runId ? this.#runIndex.get(runId) : undefined;
    if (body === undefined) {
      body = '';
      try { body = mesh.indexBody(project.id, meshIndexLimit(available)); } catch (error) { this.#d.log?.(`[WARN] Could not build the mesh index of product ${project.id}: ${(error as Error).message}`); }
      if (runId) this.#runIndex.set(runId, body);
    }
    if (!body) return '';
    let nonce = runId ? this.#runFence.get(runId) : PLACEHOLDER_NONCE;
    if (!nonce) { nonce = newNonce(); this.#runFence.set(runId!, nonce); }
    return wrapMeshIndex(body, nonce);
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
      if (!((d.status.get(model.id)?.effective ?? model.contextLength ?? 0) > 0)) {
        return this.#noUsableModel([{ modelId: model.id, status: 'unknown', message: engineText(language, 'problem.unchecked'), messageCode: 'engine.problem.unchecked' }]);
      }
    } else {
      const chain = this.#chain('chat');
      model = chain.usable.map(r => r.model).find(m => (d.status.get(m.id)?.effective ?? m.contextLength ?? 0) > 0);
      if (!model) return this.#noUsableModel(chain.problems);
    }
    const project = runProject(d.projects, d.conversations.projectOf(conversationId));
    const snapshot = existing?.snapshot ?? this.#buildSnapshotText(language, conversationId, project).text;
    const built = this.#assemble({ conversationId, snapshot, model, kind: 'chat', project });
    const { tokens } = estimateRequest(`${built.system.frozen}\n${built.system.dynamic}`, built.history, built.apiTools, built.factor);
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
    if (!d.tools || !p.routes.length || agentOff(d.config(), parent.kind)) return fail('agent.unavailable');
    // 数の歯止め（どちらも、始めずにエラーで返す。待たない）
    const spawned = this.#agentSpawned.get(parent.runId) ?? 0;
    if (spawned >= config.tools.agent.maxPerRun) return fail('agent.too_many', { max: config.tools.agent.maxPerRun });
    let live = 0;
    for (const active of this.#active.values()) if (active.kind === 'agent') live += 1;
    if (live >= MAX_LIVE_AGENTS) return fail('agent.busy');
    // 子に渡せる道具 = 親にいま渡る道具 ∩ allowedIn に 'agent' を明示した道具 ∩ 入力の tools（狭めるだけ）
    const mode: PermissionMode = parent.kind === 'chat' ? stricterMode(parent.permissionMode ?? 'normal', this.#modeOf(parent.conversationId)) : 'normal';
    const givable = this.#toolsFor(p.routes[0]!.model, parent.kind, p.forbid, config, mode, false, parent.project !== undefined).filter(t => t.allowedIn.includes('agent'));
    const givableNames = new Set(givable.map(t => t.name));
    if (input.tools) {
      const unknown = [...new Set(input.tools)].filter(name => !givableNames.has(name));
      if (unknown.length) return fail('agent.unknown_tools', { names: unknown.join(', ') });
    }
    const granted = new Set(input.tools ?? [...givableNames]);
    const childForbid = new Set<string>([...(p.forbid ?? []), 'agent_run']);
    for (const name of d.tools.registry.names()) if (!granted.has(name)) childForbid.add(name);

    const title = plainLine(input.title ?? input.task, AGENT_CHILD_TITLE_MAX) || plainLine(input.task, AGENT_CHILD_TITLE_MAX) || 'agent';
    const childRunId = randomUUID();
    const child = d.conversations.create({ title, kind: 'task', source: { conversationId: parent.conversationId }, parentRunId: parent.runId, projectId: d.conversations.projectOf(parent.conversationId) });
    const saved = d.conversations.append(child.id, { role: 'user', content: `${engineText(language, 'agent.preamble')}\n\n${input.task}` });
    d.bus.publish({ type: 'message.saved', runId: childRunId, conversationId: child.id, messageId: saved.id, role: 'user' });
    // 親が外から読んでいたら、子もその状態で始める。外を読まずに許可フォルダの外を読んだ印も引き継ぐ
    if (parent.taint.tainted || d.conversations.everTainted(parent.conversationId)) this.#initialTaint.set(childRunId, [engineText(language, 'taint.parent')]);
    if (parent.autoReadOutside || d.conversations.everAutoRead(parent.conversationId)) d.conversations.markAutoRead(child.id);
    if (parent.kind === 'chat') this.#modeHost.set(child.id, parent.conversationId);
    this.#agentSpawned.set(parent.runId, spawned + 1);

    const emit = (state: 'running' | 'done' | 'failed' | 'cancelled' | 'timeout', toolCalls = 0) => d.bus.publish({
      type: 'agent.state', runId: parent.runId, conversationId: parent.conversationId, callId: callId ?? '', childRunId, childConversationId: child.id, state, toolCalls,
    });
    this.#start(childRunId, child.id, p.routes, 'agent', undefined, childForbid, null, { parent, mode });
    emit('running');
    const why: { value?: 'timeout' | 'parent' } = {};
    const timeoutMs = d.agentTimeoutMs ?? config.tools.agent.timeoutSec * 1000;
    const timer = setTimeout(() => { why.value ??= 'timeout'; this.stop(childRunId); }, timeoutMs);
    const onParentAbort = () => { why.value ??= 'parent'; this.stop(childRunId); };
    parent.signal.addEventListener('abort', onParentAbort, { once: true });
    if (parent.signal.aborted) onParentAbort();
    let result: EngineResult;
    try { result = await this.#active.get(childRunId)!.done; } finally { clearTimeout(timer); parent.signal.removeEventListener('abort', onParentAbort); }

    const row = d.runs.get(childRunId);
    const toolCalls = row?.tool_calls ?? 0;
    // 子が外から読んでいたら、親も外から読んだことにする（結果に fetched を付ける。pipeline が tool 名を sources に足す）
    const fetched = row?.tainted === 1;
    if (d.conversations.everAutoRead(child.id)) parent.autoReadOutside = true;
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
    return { content: `${open}\n${cutNote}${body}\n${close}`, ...(fetched ? { fetched: true } : {}) };
  }
  // 会話のいまの権限モード。子の担当の会話は、任せた親の会話のモードを見る（子の会話自身のモードは使わない）
  #modeOf(conversationId: string): PermissionMode { return this.#d.conversations.modeOf(this.#modeHost.get(conversationId) ?? conversationId); }

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
    const transcript = c.removed.map(m => `${compactSpeaker(m.message, language)}: ${m.text.slice(0, 1500)}`).join('\n').slice(-COMPACT_TRANSCRIPT_CHARS);
    const prompt = compactPrompt({ previous: c.previous, transcript }, language);
    const maxOutputTokens = Math.min(2000, c.route.model.maxOutputTokens);
    if (estimateTextTokens(prompt) * 1.15 + maxOutputTokens > c.capacity * CONTEXT_FILL_RATIO) return false;
    let release: (() => void) | undefined;
    try {
      release = await d.limiter.acquire(c.route.provider.id, () => c.route.provider.maxParallel, c.signal);
      let text = '';
      for await (const event of c.adapter.stream({
        model: c.route.model, system: { frozen: compactSystem(language), dynamic: '' },
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

  #snapshot(conversationId: string, project: ToolContext['project']): string {
    const d = this.#d;
    const existing = d.conversations.get(conversationId)?.snapshot;
    if (existing) return existing;
    recordFileVersions(d.conversations.db, d.paths);
    const language = languageOf(d.config());
    const snapshot = this.#buildSnapshotText(language, conversationId, project, d.log);
    d.conversations.setSnapshotOnce(conversationId, snapshot.text, snapshot.hash);
    return d.conversations.get(conversationId)?.snapshot ?? snapshot.text;
  }

  // 会話の始めに固定する system の文。作るだけで、何も書かない
  #buildSnapshotText(language: Language, conversationId: string, project: ToolContext['project'], log?: (line: string) => void) {
    const d = this.#d;
    const product = d.conversations.projectOf(conversationId) !== null;
    return buildSnapshot(d.paths, {
      ...(d.botMemory && d.memory ? { memories: renderBooks(d.memory.list(), language, this.memoryBudget()) } : {}),
      ...(d.skills ? { skills: d.skills.index(language) } : {}),
      ...(product ? { persona: false, instructions: project?.root && instructionsSection(readInstructions(project.root, instructionsBudget(this.#smallestAvailable()), log)) } : {}),
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
