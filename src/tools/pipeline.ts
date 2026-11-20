import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Value } from '@sinclair/typebox/value';
import { prefixLength, suffixLength } from '../engine/tokens.ts';
import type { RunEvent, ToolCall, ToolGate } from '../engine/types.ts';
import { previewJson } from '../shared/json-preview.ts';
import { redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import { languageOf } from '../shared/language.ts';
import { stricterMode, type PermissionMode } from '../shared/permission-mode.ts';
import { guardText } from '../shared/messages/guard.ts';
import { scoutText } from '../shared/messages/scout.ts';
import { toolText } from '../shared/messages/tools.ts';
import type { AppConfig, Language } from '../config/schema.ts';
import type { ApprovalBroker } from './approvals.ts';
import { matchRule, ruleCandidate, type RuleCandidate, type RuleHit } from './approval-rules.ts';
import { judgeOnce, type AutoVerdict, type ClassifierInput, type ClassifierPrompt, type JudgeCall, type JudgeLimits, type JudgeReply, type JudgeSpend } from './auto-approve.ts';
import { forgetAllow, involvedSnapshot, judgeCacheKey, judgeIdentity, nextCallNumber, rememberAllow, rememberedAllow } from './judge-cache.ts';
import { recordJudgeCall, type JudgeOutcome } from './judge-stats.ts';
import { GIT_IDENTITY_KEY, ownerKeysOf, POLICY_KEYS, refusedKeysOf, SHELL_FETCH_TO_JUDGE } from './hooks/decision-order.ts';
import { carriesHeld, newChecks, recheckOf, type PendingKind, type PendingStore } from '../pending/store.ts';
import { parseRemotes } from '../projects/remotes.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { QuestionError } from '../questions/store.ts';
import { runCommandHook, type HookPayload } from './hooks/command-hook.ts';
import { outboundOfCall, submitsOf, type Outbound } from './hooks/outbound.ts';
import { windowsNames } from './hooks/scope.ts';
import { worst, type Decision } from './hooks/shell-guard.ts';
import { isCore, projectAllows, type ToolRegistry } from './registry.ts';
import { isBrowserTool } from './browser/names.ts';
import { effectivePolicy, type HasPolicies, type ToolPolicy } from './tool-policy.ts';
import type { AskKind, PreCheck, ToolContext, ToolDef, ToolOutput } from './types.ts';

export const REVIEW_FORBIDDEN: ReadonlySet<ToolDef['effect']> = new Set(['write', 'exec', 'network']);

// 振り返りで使えない道具: 効果が REVIEW_FORBIDDEN にあるもの、またはファイルも書く道具（writesFiles。効果が何でも）。モデルに渡す一覧（engine/chat.ts の #toolsFor）も、パイプラインの拒否も、reviewAllows を通す
export function reviewAllows(tool: Pick<ToolDef, 'effect' | 'writesFiles'>): boolean {
  return !REVIEW_FORBIDDEN.has(tool.effect) && tool.writesFiles !== true;
}

export const TOOL_OUTPUT_LIMIT = 16_000;

export const JUDGE_REUSE = 'judge-reuse';

export const NO_JUDGE = 'no-judge';

export const OWNER_RULE = 'owner-rule';

export const SELF_TOUCH_KEY = 'code.self_touch';
export const OPAQUE_CONTROL_KEY = 'shape.control_opaque';

export const judgeOff = (config: Pick<AppConfig, 'routing'>): boolean => config.routing.judgeMode === 'off';

function runsWithoutJudge(ctx: ToolContext, deps: PipelineDeps): boolean {
  try { return judgeOff(ctx.config) && judgeOff(deps.config?.() ?? ctx.config); } catch { return false; }
}

// 計画モードで使える道具の効果: 読む道具（read）と Web の読み取り（network）。ただしファイルも書く道具（writesFiles）は除く。モデルに渡す一覧（engine/chat.ts の #toolsFor）も、パイプラインの拒否も、planAllows を通す
export const PLAN_EFFECTS: ReadonlySet<ToolDef['effect']> = new Set(['read', 'network']);

// MCP の道具（外のプログラムが書いた道具）は、効果の申告があっても計画モードには渡さない（申告は持ち主のものでも、中身は外のプログラムが決めるため）
export function planAllows(tool: Pick<ToolDef, 'effect' | 'writesFiles' | 'mcp' | 'submits' | 'planOk'>): boolean {
  if (tool.planOk === true && (tool.effect === 'meta' || tool.effect === 'read') && tool.writesFiles !== true && tool.submits !== true && tool.mcp === undefined) return true;
  return PLAN_EFFECTS.has(tool.effect) && tool.writesFiles !== true && tool.mcp === undefined && tool.submits !== true;
}

export function acceptanceAllows(tool: Pick<ToolDef, 'acceptanceState'>, frozen: boolean): boolean {
  return tool.acceptanceState === undefined || (tool.acceptanceState === 'frozen') === frozen;
}

// この呼び出しが外へ出るか（効果が network でない道具の networkCall）。投げたら、迷ったので外へ出るとみなす（印を付ける・毎回確かめる向きにしか倒れない）
function callsNetwork(tool: ToolDef, args: unknown): boolean {
  if (!tool.networkCall) return false;
  try { return tool.networkCall(args) !== false; } catch { return true; }
}

export interface PipelineDeps {
  registry: ToolRegistry;
  approvals: ApprovalBroker;
  db: DatabaseSync;
  emit: (event: RunEvent) => void;
  // いまの設定。実行の途中で道具の方針が厳しくなったら、その場から効かせる（緩くなったときは、実行を始めたときの設定のまま = 次の実行から）
  config?: (() => AppConfig) | undefined;
  // 会話のいまの権限モード。実行に効くのは、実行を始めたときのモード（ctx.permissionMode）との厳しい方（effectiveMode）
  permissionMode?: (() => PermissionMode) | undefined;
  // 自動承認の判定役（モデル）を 1 回呼ぶ。返事の文字を返し、呼べなければ投げる。無ければ、自動承認は何も許さない
  autoClassify?: ((prompt: ClassifierPrompt, signal: AbortSignal, call?: JudgeCall) => Promise<string | JudgeReply>) | undefined;
  // 判定役に見せる、会話の利用者の最後の発言（添付の中身は除く）
  lastUserRequest?: (() => string) | undefined;
  // この会話の実行が、よそから来た文を一度でも読んだことがあるか（会話ごとの印）。あれば、判定役に見せる文に「よそから来た文を読んだ会話」の 1 行を足す。渡さない・読めないときも、あるとみなす
  conversationTainted?: (() => boolean) | undefined;
  // 判定役を待つ時間の上限（ミリ秒。試験用。既定 20 秒）
  autoTimeoutMs?: number | undefined;
  pending?: PendingStore | undefined;
  productRoots?: (() => string[]) | undefined;
  judgeLimits?: JudgeLimitSet | undefined;
}

export interface JudgeLimitSet { chat: JudgeLimits; unattended: JudgeLimits }

export const JUDGE_LIMITS: JudgeLimitSet = { chat: { answerMs: 20_000, slotWaitMs: 40_000 }, unattended: { answerMs: 60_000 } };

// Pending に積めない実行（振り返り・考える実行・直す実行）と、判定役を呼べない実行（振り返り・考える実行）。
// 直す実行（beat 8-6a D-11）は Pending に積まないが、判定役は呼べる（4 の形の npm test などを止めないため。考える実行の印で動かすと 4 の形より前で断られる）
export const cannotPark = (ctx: Pick<ToolContext, 'kind' | 'scout' | 'fix' | 'research'>): boolean => ctx.kind === 'review' || ctx.scout === true || ctx.fix === true || ctx.research !== undefined;
export const cannotJudge = (ctx: Pick<ToolContext, 'kind' | 'scout' | 'research'>): boolean => ctx.kind === 'review' || ctx.scout === true || ctx.research !== undefined;

// 直す実行の判定役に見せる頼みの文: beat が書いた決まった文だけ（提案の文は Web から来たので入れない。D-11）
export function judgeRequestOf(ctx: Pick<ToolContext, 'fix' | 'project'>, deps: Pick<PipelineDeps, 'lastUserRequest'>): string {
  if (ctx.fix) return scoutText('en', 'fix.judge_request', { path: ctx.project?.root ?? '' });
  return deps.lastUserRequest?.() ?? '';
}
export const unattendedRun =(ctx: Pick<ToolContext, 'kind' | 'parent'>): boolean => ctx.kind === 'task' || (ctx.kind === 'agent' && ctx.parent?.kind !== 'chat');

function judgeLimitsFor(ctx: ToolContext, deps: PipelineDeps): JudgeLimits {
  const base = (deps.judgeLimits ?? JUDGE_LIMITS)[unattendedRun(ctx) ? 'unattended' : 'chat'];
  return deps.autoTimeoutMs !== undefined ? { ...base, answerMs: deps.autoTimeoutMs } : base;
}

function trustedOf(ctx: ToolContext): string[] {
  if (!ctx.project) return [];
  try { return parseRemotes(ctx.services?.projects?.get(ctx.project.id)?.remotes).flatMap(r => [r.url, ...(r.pushUrl ? [r.pushUrl] : [])]); } catch { return []; }
}

const WINDOWS = process.platform === 'win32';

export function hookPaths(tool: ToolDef, check: PreCheck | undefined): NonNullable<HookPayload['paths']> {
  const out = new Map<string, { path: string; write: boolean; dir?: boolean }>();
  const writeTool = tool.effect === 'write' || tool.writesFiles === true;
  const add = (given: string, write: boolean): void => {
    const path = WINDOWS ? windowsNames(given) : given;
    const before = out.get(path);
    const isWrite = write || before?.write === true;
    out.set(path, { path, write: isWrite, ...(isWrite && !existsSync(path) ? { dir: true } : {}) });
  };
  for (const path of check?.writes ?? []) add(path, true);
  for (const p of check?.paths ?? []) if (p.path) add(p.path, check?.writes === undefined && writeTool);
  return [...out.values()];
}

export function safeProductRoots(deps: Pick<PipelineDeps, 'productRoots'>): string[] {
  try { return deps.productRoots?.() ?? []; } catch { return []; }
}

export function readFilesOf(check: PreCheck | undefined): { files: string[]; more: boolean } {
  const writes = new Set(check?.writes ?? []);
  const all = check?.readPaths ?? (check?.paths ?? []).flatMap(p => (p.path ? [p.path] : []));
  return { files: [...new Set(all.filter(p => !writes.has(p)))], more: check?.readPaths === undefined && (check?.pathsMore ?? 0) > 0 };
}

interface ParkRequest {
  tool: ToolDef; args: unknown; ctx: ToolContext; pending: PendingStore; first: PreCheck | undefined; cwd: string;
  kind: PendingKind; reason: string; checks: string[]; outbound: Outbound | undefined; tainted: boolean; rule: RuleCandidate | undefined;
}

async function parkCall(r: ParkRequest): Promise<number> {
  const { ctx, first, outbound } = r;
  const read = readFilesOf(first);
  const sendOrDelete = outbound?.kind === 'send' || outbound?.kind === 'delete' ? outbound : undefined;
  const parked = await r.pending.park({
    tool: r.tool.name, input: r.args, cwd: r.cwd, workspace: ctx.workspace, kind: r.kind, reason: r.reason, checks: r.checks, check: first,
    ...(sendOrDelete ? { outbound: { kind: sendOrDelete.kind, reason: sendOrDelete.reason, targets: sendOrDelete.targets } } : {}),
    ...(sendOrDelete?.kind === 'delete' ? { targets: sendOrDelete.targets } : {}),
    files: read.files, filesMore: read.more, places: first?.places, created: first?.created, pushes: first?.pushes,
    runId: ctx.runId, runKind: ctx.kind, conversationId: ctx.conversationId, taskId: ctx.task?.id ?? ctx.parent?.taskId ?? null, projectId: ctx.project?.id ?? null, tainted: r.tainted, ...(r.rule ? { rule: r.rule } : {}),
  });
  return parked.id;
}

const WINDOW_EFFECTS: ReadonlySet<ToolDef['effect']> = new Set(['exec', 'write']);
const opensWindow = (tool: ToolDef): boolean => tool.replayable !== false && (WINDOW_EFFECTS.has(tool.effect) || tool.writesFiles === true);

export interface ToolCallOutcome {
  output: ToolOutput;
  decision: Decision;
  decidedBy: string;
  invalidArguments: boolean;
  gate?: ToolGate;
}

// 文字数の上限（TOOL_OUTPUT_LIMIT）と、残りの余裕から決まるトークンの上限（tokens）の、先に達した方で切る
function capOutput(output: ToolOutput, language: Language, tokens: number | undefined): ToolOutput {
  const content = redactSecrets(output.content);
  const shown = prefixLength(content, TOOL_OUTPUT_LIMIT, tokens ?? Infinity);
  if (shown >= content.length) return { ...output, content };
  const note = output.fullRef ? toolText(language, 'pipeline.note_full', { ref: output.fullRef }) : toolText(language, 'pipeline.note_none');
  if (output.keepTail) {
    const limit = tokens ?? Infinity;
    const head = prefixLength(content, Math.floor(TOOL_OUTPUT_LIMIT * 0.6), limit * 0.6);
    const tail = suffixLength(content, TOOL_OUTPUT_LIMIT - Math.floor(TOOL_OUTPUT_LIMIT * 0.6), limit * 0.4);
    const middle = toolText(language, 'pipeline.truncated_middle', { total: content.length.toLocaleString('en-US'), head: head.toLocaleString('en-US'), tail: tail.toLocaleString('en-US'), omitted: (content.length - head - tail).toLocaleString('en-US'), note });
    return { ...output, content: `${content.slice(0, head)}\n\n${middle}\n\n${content.slice(content.length - tail)}` };
  }
  return { ...output, content: `${content.slice(0, shown)}\n\n${toolText(language, 'pipeline.truncated', { total: content.length.toLocaleString('en-US'), shown: shown.toLocaleString('en-US'), note })}` };
}

const matches = (matcher: string, name: string) => { try { return new RegExp(`^(?:${matcher})$`, 'u').test(name); } catch { return false; } };

// ブラウザの道具を使ってよいか。実行を始めたときの設定と、いまの設定のどちらかが無効なら使わせない
function browserEnabled(ctx: ToolContext, deps: PipelineDeps): boolean {
  try { return ctx.config.tools.browser.enabled && (deps.config?.() ?? ctx.config).tools.browser.enabled; } catch { return false; }
}

// この呼び出しに効く道具ごとの方針: 実行を始めたときの設定と、いまの設定の厳しい方
function policyFor(name: string, ctx: ToolContext, deps: PipelineDeps): ToolPolicy {
  let now: HasPolicies | undefined;
  try { now = deps.config?.(); } catch { }
  return effectivePolicy(name, now ?? ctx.config, ctx.config);
}

// この呼び出しに効く権限モード: 実行を始めたときのモードと、会話のいまのモードの厳しい方（厳しい向きはその場から、緩む向きは次の実行から）。
// 会話（チャット）の実行と、それが任せた子の担当（agent。親の会話のモードを見る）だけ。タスクと振り返りは、会話のモードに関係なく auto
export function effectiveMode(ctx: ToolContext, deps: PipelineDeps): PermissionMode {
  if (ctx.kind !== 'chat' && ctx.kind !== 'agent') return 'auto';
  const start = ctx.permissionMode ?? 'auto';
  let now: PermissionMode = start;
  if (deps.permissionMode) { try { now = deps.permissionMode(); } catch { now = start; } }
  return stricterMode(start, now);
}

function conversationTainted(deps: PipelineDeps): boolean {
  if (!deps.conversationTainted) return true;
  try { return deps.conversationTainted(); } catch { return true; }
}

function askSubmit(tool: ToolDef, args: unknown, ctx: ToolContext, deps: PipelineDeps): void {
  const questions = ctx.services?.questions;
  const taskId = ctx.task?.id ?? ctx.parent?.taskId;
  if (!questions || !taskId) return;
  const tasks = ctx.services?.tasks;
  const tab = typeof args === 'object' && args !== null && typeof (args as { tab?: unknown }).tab === 'string' ? (args as { tab: string }).tab : undefined;
  let url: string | undefined;
  try { url = ctx.services?.browser?.tabUrl(ctx.conversationId, tab); } catch { url = undefined; }
  try {
    questions.addSubmitRefused({
      taskId, projectId: ctx.project?.id ?? tasks?.get(taskId)?.project_id ?? null, conversationId: ctx.conversationId, tool: tool.name, url,
      tainted: ctx.taint.tainted || conversationTainted(deps) || tasks?.textTainted(taskId) === true,
    });
  } catch (error) { if (!(error instanceof QuestionError)) throw error; }
}

// truncated: 出力の上限で切れた返事に付いていた呼び出し。動かさず、deny で記録して誤りの結果を返す（message が結果の文、raw が切れた元の文字で、記録の入力欄に 2000 文字まで残す。モデルには送らない）
export async function runToolCall(call: ToolCall, ctx: ToolContext, deps: PipelineDeps, truncated?: { message: string; raw: string }): Promise<ToolCallOutcome> {
  const id = randomUUID();
  const language = languageOf(ctx.config);
  const started = Date.now();
  const callNumber = nextCallNumber(ctx);
  const tool = deps.registry.get(call.name);
  const shownInput = truncated
    ? redactSecrets(truncated.raw).slice(0, 2000)
    : previewJson(redactJsonValue(call.arguments ?? call.raw ?? null), 4000);
  deps.emit({ type: 'tool.call', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, input: shownInput });

  // 自動承認の判定役が許したときの短い理由（結果の知らせに添える）
  let autoWhy: string | undefined;
  let sameAs: number | undefined;
  let ruleGate: RuleHit | undefined;
  const finish = (outcome: ToolCallOutcome, approvalId?: string): ToolCallOutcome => {
    const capped = capOutput(outcome.output, language, ctx.outputTokens);
    const gate: ToolGate | undefined = outcome.decidedBy === 'pending' && approvalId?.startsWith('pending:') ? { by: 'pending', id: Number(approvalId.slice('pending:'.length)) }
      : outcome.decidedBy === 'not-parked' ? { by: 'not-parked' }
      : outcome.decidedBy === 'auto-mode' && outcome.decision === 'allow' && autoWhy !== undefined ? { by: 'judge', reason: autoWhy.slice(0, 300) }
      : outcome.decidedBy === JUDGE_REUSE && outcome.decision === 'allow' && autoWhy !== undefined && sameAs !== undefined ? { by: 'judge', reason: autoWhy.slice(0, 300), same: sameAs }
      : outcome.decidedBy === NO_JUDGE && outcome.decision === 'allow' ? { by: 'no-judge' }
      : outcome.decidedBy === OWNER_RULE && outcome.decision === 'allow' && ruleGate !== undefined ? { by: 'rule', id: ruleGate.id, shown: ruleGate.shown }
      : undefined;
    const tagged = ctx.kind === 'task' && call.name !== 'tool_search' ? 1 : 0;
    const row = deps.db.prepare(`INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, approval_id, ok, duration_ms, output_preview, full_ref, evidence_no, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN (SELECT COALESCE(MAX(evidence_no), 0) + 1 FROM tool_calls WHERE conversation_id = ? AND evidence_no IS NOT NULL) END, ?)
      RETURNING evidence_no`).get(
      id, ctx.runId, ctx.conversationId, call.name, shownInput, outcome.decision, outcome.decidedBy, approvalId ?? null,
      capped.isError ? 0 : 1, Date.now() - started, capped.content.slice(0, 2000), capped.fullRef ?? null, tagged, ctx.conversationId, started,
    ) as { evidence_no: number | null } | undefined;
    const evidenceNo = row?.evidence_no ?? null;
    const output: ToolOutput = evidenceNo === null ? capped : { ...capped, content: `${capped.content}\n[E-${evidenceNo}]` };
    deps.emit({ type: 'tool.result', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, ok: !output.isError, decision: outcome.decision, preview: output.content.slice(0, 1500), ...(gate ? { gate } : {}) });
    return { ...outcome, output, ...(gate ? { gate } : {}) };
  };
  const refuse = (decision: Decision, decidedBy: string, message: string, invalid = false) =>
    finish({ output: { content: message, isError: true }, decision, decidedBy, invalidArguments: invalid });

  if (truncated) return refuse('deny', 'truncated', truncated.message);
  if (!tool) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_missing', { name: call.name, names: (ctx.reachable?.() ?? deps.registry.forRun(ctx.kind)).filter(t => !ctx.deferred || ctx.deferred.sent.has('tool_search') || ctx.deferred.sent.has(t.name)).map(t => t.name).join(', ') }), true);
  if (!tool.allowedIn.includes(ctx.kind) || ctx.forbiddenTools?.has(tool.name)) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_allowed', { name: call.name }));
  if (!projectAllows(tool, { kind: ctx.kind, project: ctx.project !== undefined, memoryProject: ctx.memoryProject !== undefined })) return refuse('deny', 'registry', toolText(language, 'pipeline.project_only', { name: call.name }));
  if (tool.scoutOnly === true && !ctx.scout) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_allowed', { name: call.name }));
  if (tool.researchOnly === true && !ctx.research) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_allowed', { name: call.name }));
  if (tool.acceptanceState !== undefined) {
    const frozen = Boolean(ctx.project && ctx.services?.acceptance?.latest(ctx.project.id));
    if (!acceptanceAllows(tool, frozen)) return refuse('deny', 'registry', toolText(language, frozen ? 'pipeline.acceptance_frozen' : 'pipeline.acceptance_draft', { name: call.name }));
  }
  // 振り返りでは、登録の設定にかかわらず、外に影響する道具（書き込み・実行・送信、ファイルも書く道具）を使わせない（二重の禁止）
  if (ctx.kind === 'review' && !reviewAllows(tool)) return refuse('deny', 'registry', toolText(language, 'pipeline.review_forbidden', { name: call.name }));
  // 持ち主が「止める」にした道具（モデルに渡す一覧からも外している。二重の拒否）。フックの allow では越えられない
  const policy = policyFor(tool.name, ctx, deps);
  if (policy === 'block') return refuse('deny', 'policy', toolText(language, 'pipeline.policy_blocked', { name: tool.name }));
  // ブラウザの道具は、設定で無効（既定）のあいだは使わせない（モデルに渡す一覧からも外している。二重の拒否）。設定を読めないときも、止める側に倒す
  if (isBrowserTool(tool.name) && !browserEnabled(ctx, deps)) return refuse('deny', 'mode', guardText(language, 'browser.off'));
  // 計画モードでは、読む道具と Web の読み取りのほかは使わせない（モデルに渡す一覧からも外している。二重の拒否）
  if (effectiveMode(ctx, deps) === 'plan' && !planAllows(tool)) return refuse('deny', 'mode', toolText(language, 'pipeline.mode_plan', { name: tool.name }));
  if (ctx.deferred?.sent.has('tool_search') && !isCore(tool) && !ctx.deferred.loaded.has(tool.name) && !ctx.deferred.sent.has(tool.name)) return refuse('deny', 'registry', toolText(language, 'pipeline.tool_not_loaded', { name: tool.name }));
  if (call.arguments === undefined) return refuse('deny', 'validation', toolText(language, 'pipeline.bad_json', { raw: (call.raw ?? '').slice(0, 300) }), true);
  const args = Value.Default(tool.input, Value.Clone(call.arguments));
  if (!Value.Check(tool.input, args)) {
    const errors = [...Value.Errors(tool.input, args)].slice(0, 5).map(e => `${e.path || '/'}: ${e.message}`);
    return refuse('deny', 'validation', toolText(language, 'pipeline.bad_args', { errors: errors.join('\n- ') }), true);
  }
  // 会話の外（タスク・子の担当）でページのフォームを送る呼び出しは、積まずに断って質問票に 1 行（事前の判定が要素を調べて submits を出したもの。9-1b）
  const refuseSubmit = (): ToolCallOutcome => {
    askSubmit(tool, args, ctx, deps);
    return refuse('deny', 'mode', pendingText('en', 'unattended_submit', { name: tool.name }));
  };
  // この呼び出しが外へ出るか（効果が network、または networkCall がそう答えた）。外から読んだ印だけがこれを使う
  const network = tool.effect === 'network' || callsNetwork(tool, args);

  // ── 実行前フック ──
  let decision: Decision = 'allow';
  let decidedBy = 'builtin';
  const reasons: string[] = [];
  let first: PreCheck | undefined;
  // 確かめ（ask）になった理由の種類。理由を足すたびに、その種類も足す（段 8b の自動承認は、これで判定役に回すかを決める）
  const askKinds = new Set<AskKind>();
  if (tool.preCheck) {
    try {
      const pre = await tool.preCheck(args, ctx);
      first = pre;
      decision = pre.decision; reasons.push(...pre.reasons);
      // 事前の判定が理由ごとに付けた種類。何も付けていない確かめは precheck（細かい種類なし）で、自動承認の判定役には回らない
      if (pre.decision === 'ask') { for (const kind of pre.askKinds ?? []) askKinds.add(kind); if (!pre.askKinds?.length) askKinds.add('precheck'); }
    } catch (error) {
      decision = 'deny'; reasons.push(guardText(language, 'pipeline.precheck_failed', { detail: (error as Error).message }));
    }
  }
  // 持ち主の決め（J-5 の決まり）・判定役・Pending より前に断る
  if (decision !== 'deny' && submitsOf(tool, first) && ctx.kind !== 'chat') return refuseSubmit();
  const outbound = decision === 'deny' ? undefined : outboundOfCall(tool, first, language);
  if (outbound?.kind === 'deny') return refuse('deny', 'outbound', toolText(language, 'pipeline.denied', { reasons: outbound.reason }));
  // 直す実行（beat 8-6a D-11 の 1）: 外へ出る・外から取る呼び出しは、道具を問わず判定役にも Pending にも回さず断る（シェルは shell.ts が先に fix.* で断る）
  if (ctx.fix && decision !== 'deny' && (network || first?.fetched === true || outbound?.kind === 'send' || askKinds.has('egress'))) {
    return refuse('deny', 'fix', toolText(language, 'pipeline.denied', { reasons: guardText(language, 'fix.network', { cmd: tool.name }) }));
  }
  const tainted = ctx.taint.tainted || conversationTainted(deps);
  // 外から読んだ内容のあとは、ほかの理由で既に ask でも、理由の種類に taint を載せる。拒否は拒否のまま
  if (ctx.taint.tainted && tool.escalateOnTaint === true && decision !== 'deny') {
    const sources = ctx.taint.sources.slice(0, 3).join(guardText(language, 'pipeline.taint_sep'));
    if (ctx.kind === 'review') {
      decision = 'deny';
      reasons.push(guardText(language, 'pipeline.taint_review', { sources }));
    } else {
      decision = worst(decision, 'ask');
      askKinds.add('taint');
      reasons.push(guardText(language, 'pipeline.taint', { sources }));
    }
  }
  const fetchToJudge = SHELL_FETCH_TO_JUDGE.on && ctx.taint.tainted && tool.name === 'shell_run' && first?.fetched === true && decision !== 'deny';
  // The egress kind only the taint adds here is not part of a rule's keys (AP-1, Q5); one the pre-check gave stays
  const fetchEgress = fetchToJudge && !askKinds.has('egress');
  if (fetchToJudge) {
    decision = worst(decision, 'ask');
    askKinds.add('egress');
    reasons.push(guardText(language, 'pipeline.shell_fetch'));
  }
  // 道具ごとの方針 ask: 今の判定に「承認を求める」を足すだけ（拒否は拒否のまま。allow は何もしない）。振り返りには承認する人がいないので拒否として扱う
  if (policy === 'ask' && decision !== 'deny') {
    if (ctx.kind === 'review') {
      decision = 'deny'; decidedBy = 'policy';
      reasons.push(guardText(language, 'pipeline.policy_review', { name: tool.name }));
    } else {
      decision = worst(decision, 'ask');
      askKinds.add('policy');
      reasons.push(guardText(language, 'pipeline.policy_ask', { name: tool.name }));
    }
  }
  const policyAsk = policy === 'ask' && decision !== 'deny';
  const hookAsks: string[] = [];
  let summaryMemo: { value: ReturnType<NonNullable<ToolDef['summarize']>> | undefined } | undefined;
  const callSummary = () => (summaryMemo ??= { value: tool.summarize?.(args, language) }).value;
  const callCwd = (): string => {
    if (first?.cwd) return first.cwd;
    const given = callSummary()?.cwd;
    return given ? resolve(ctx.workspace, given) : ctx.workspace;
  };
  for (const hook of ctx.config.tools.hooks.preToolUse) {
    if (hook.enabled === false || !matches(hook.matcher, tool.name) || decision === 'deny') continue;
    const hookCwd = callCwd();
    const result = await runCommandHook(hook, {
      hook_event_name: 'PreToolUse', tool_name: tool.name, tool_input: args, cwd: WINDOWS ? windowsNames(hookCwd) : hookCwd, run_id: ctx.runId, conversation_id: ctx.conversationId,
      paths: hookPaths(tool, first), tainted, run_kind: ctx.kind, ...(ctx.project?.root ? { project_root: ctx.project.root } : {}), product_roots: safeProductRoots(deps),
    }, ctx.signal, language);
    if (result.decision && worst(decision, result.decision) !== decision) { decision = result.decision; decidedBy = `hook:${result.hook}`; }
    if (result.decision === 'ask') { askKinds.add('hook'); hookAsks.push(result.reason || result.hook); }
    if (result.reason && result.decision && result.decision !== 'allow') reasons.push(result.reason);
  }

  let judgedId: string | undefined;
  let earlier: PreCheck | undefined;
  const candidateFor = (parkKind: PendingKind, check: PreCheck | undefined, out: Outbound | undefined): RuleCandidate | undefined => {
    try { return ruleCandidate({ tool, args, ctx, parkKind, check, outbound: out, askKinds, policyAsk, fetchEgress }); } catch { return undefined; }
  };
  const ruleFor = (candidate: RuleCandidate | undefined): RuleHit | undefined => {
    if (!candidate || !ctx.project?.id) return undefined;
    // A call carrying a value beat holds (the same list the Pending card hides) never goes by a rule; without that list, no rule at all
    try { return deps.pending && !carriesHeld([JSON.stringify(args) ?? '', candidate.base, candidate.shown, ...(first?.ruleShape?.words ?? [])], deps.pending.heldFor(tool)) ? matchRule(deps.db, ctx.project.id, candidate) : undefined; } catch { return undefined; }
  };
  const park =async (kind: PendingKind, reason: string, parkOutbound: Outbound | undefined = outbound, offer = false): Promise<ToolCallOutcome> => {
    const sendOrDelete = parkOutbound?.kind === 'send' || parkOutbound?.kind === 'delete' ? parkOutbound : undefined;
    const parkReasons = [...new Set([...(sendOrDelete ? [sendOrDelete.reason] : []), ...reasons])];
    if (cannotPark(ctx)) return refuse('deny', 'pending',toolText(language, 'pipeline.denied', { reasons: parkReasons.join('\n- ') }));
    if (tool.replayable === false) return finish({ output: { content: pendingText('en', 'not_parked', { tool: tool.name, reason }), isError: true }, decision: 'ask', decidedBy: 'not-parked', invalidArguments: false });
    if (!deps.pending) return refuse('deny', 'pending', pendingText('en', 'no_pending', { reason }));
    const parkCwd = callCwd();
    if (/^[\\/]{2}/u.test(parkCwd) || /^[\\/]{2}/u.test(ctx.workspace)) return refuse('deny', 'pending', pendingText('en', 'network_cwd', { path: parkCwd }));
    let parkedId: number;
    try {
      parkedId = await parkCall({ tool, args, ctx, pending: deps.pending, first, cwd: parkCwd, kind, reason, checks: parkReasons, outbound: parkOutbound, tainted, rule: offer ? candidateFor(kind, first, parkOutbound) : undefined });
    } catch (error) {
      return refuse('deny', 'pending', pendingText('en', 'park_failed', { detail: (error as Error).message }));
    }
    return finish({ output: { content: pendingText('en', 'parked', { id: parkedId, reason }) }, decision: 'ask', decidedBy: 'pending', invalidArguments: false }, `pending:${parkedId}`);
  };

  if (decision !== 'deny') {
    const sendOrDelete = outbound?.kind === 'send' || outbound?.kind === 'delete' ? outbound : undefined;
    const keys = first?.reasonKeys ?? [];
    if (decision === 'ask' && refusedKeysOf(keys).length) return refuse('deny', decidedBy, toolText(language, 'pipeline.denied', { reasons: reasons.join('\n- ') }));
    const stepFour = !fetchToJudge && first?.productRun !== undefined && tool.name === 'shell_run' && Boolean(ctx.project?.root) && [...askKinds].every(kind => (first?.askKinds ?? []).includes(kind));
    const owned = decision === 'ask' ? ownerKeysOf(keys).filter(key => !(stepFour && key === GIT_IDENTITY_KEY)) : [];
    const ownerPolicy = decision === 'ask' && keys.some(key => POLICY_KEYS.has(key));
    const parkAs: { kind: PendingKind; reason: string } | undefined = sendOrDelete ? { kind: sendOrDelete.kind as PendingKind, reason: sendOrDelete.reason }
      : hookAsks.length ? { kind: 'hook', reason: hookAsks.join('; ') }
      : policyAsk ? { kind: 'policy', reason: guardText(language, 'pipeline.policy_ask', { name: tool.name }) }
      : ownerPolicy ? { kind: 'policy', reason: reasons.join('; ') }
      : first?.ownerReason !== undefined && decision === 'ask' ? { kind: 'owner', reason: first.ownerReason }
      : owned.length ? { kind: 'owner', reason: pendingText('en', 'owner_protected', { reasons: reasons.join('; ') }) }
      : undefined;
    const ruleBlockers = hookAsks.length > 0 || ownerPolicy || (first?.ownerReason !== undefined && decision === 'ask') || owned.length > 0;
    const ruleKind = parkAs !== undefined && !ruleBlockers && (parkAs.kind === 'send' || parkAs.kind === 'delete' || parkAs.kind === 'policy');
    const parkRule = ruleKind && parkAs ? ruleFor(candidateFor(parkAs.kind, first, outbound)) : undefined;
    if (parkAs && parkRule) {
      decision = 'allow'; decidedBy = OWNER_RULE; ruleGate = parkRule; judgedId = `rule:${parkRule.id}`;
    } else if (parkAs) return park(parkAs.kind, parkAs.reason, outbound, ruleKind);
    if (decision === 'ask') {
      if (cannotJudge(ctx)) return refuse('deny', decidedBy,toolText(language, 'pipeline.denied', { reasons: reasons.join('\n- ') }));
      if (stepFour && first?.productRun !== undefined) {
        decision = 'allow';
        decidedBy = first.productRun;
      } else {
        const judgeKeys = first?.reasonKeys ?? [];
        const noteJudge = (outcome: JudgeOutcome, failed: string | undefined, spend: JudgeSpend) => recordJudgeCall(deps.db, {
          runId: ctx.runId, runKind: ctx.kind, projectId: ctx.project?.id ?? null, tool: tool.name, reasonKeys: judgeKeys, askKinds: [...askKinds], outcome, failed, spend,
        });
        const noJudge = runsWithoutJudge(ctx, deps);
        // 直す実行は判定役の「許す」でだけ動く。判定役を切っていれば断る（D-11）
        if (noJudge && ctx.fix) return refuse('deny', decidedBy, toolText(language, 'pipeline.denied', { reasons: [...reasons, guardText(language, 'fix.no_judge')].join('\n- ') }));
        if (noJudge && judgeKeys.includes(SELF_TOUCH_KEY)) return park('owner', pendingText('en', 'owner_no_judge_self', { reasons: reasons.join('; ') }));
        // AP-1c sends this to the judge; with the judge off nobody would decide it, so it still waits for the owner
        if (noJudge && unattendedRun(ctx) && tool.escalateOnTaint === true && askKinds.has('taint')) return park('owner', pendingText('en', 'owner_task_taint', { name: tool.name }));
        if (noJudge && judgeKeys.includes(OPAQUE_CONTROL_KEY)) return park('owner', pendingText('en', 'owner_no_judge_opaque', { reasons: reasons.join('; ') }));
        if (noJudge && !judgeRequestOf(ctx, deps).trim()) return park('owner', pendingText('en', 'owner_no_judge_request'));
        if (noJudge && tool.mcp && tool.effect === 'write') return park('owner', pendingText('en', 'owner_no_judge_mcp', { server: tool.mcp.server, tool: tool.mcp.tool }));
        const ruled = ruleFor(candidateFor('judge', first, outbound));
        const classify = deps.autoClassify;
        const summary = callSummary() ?? { title: tool.name, body: JSON.stringify(args, null, 2) };
        const autoEvent = (state: 'checking' | 'allowed' | 'asked', reason?: string) => noJudge || ruled ? undefined :
          deps.emit({ type: 'tool.auto', runId: ctx.runId, conversationId: ctx.conversationId, callId: call.id, name: call.name, state, ...(reason !== undefined ? { reason } : {}) });
        const judgeInput: ClassifierInput = {
          userRequest: judgeRequestOf(ctx, deps), tool: tool.name, title: summary.title, body: summary.body, cwd: summary.cwd, reasons: [...reasons], paths: first?.paths ?? [], tainted, trusted: trustedOf(ctx),
        };
        const cwdNow = callCwd();
        const snapshotNow = () => {
          const read = readFilesOf(first);
          return involvedSnapshot(cwdNow, { files: [...read.files, ...(first?.writes ?? [])], filesMore: read.more, pushes: first?.pushes, places: first?.places, dataDir: ctx.paths.data }, ctx.signal).catch(() => undefined);
        };
        let judgeModel: unknown;
        try { judgeModel = judgeIdentity(deps.config?.() ?? ctx.config, ctx.model?.id); } catch { judgeModel = undefined; }
        const cacheKey = ruled || noJudge || judgeModel === undefined ? undefined : judgeCacheKey(ctx, {
          judgeInput, input: args, workspace: ctx.workspace, cwd: cwdNow, taintSources: ctx.taint.sources.length,
          reasonKeys: judgeKeys, askKinds: [...askKinds], bind: first?.bind ?? null, judge: judgeModel,
        });
        const known = cacheKey === undefined ? undefined : rememberedAllow(ctx, cacheKey);
        const reused = known && known.snapshot === await snapshotNow() ? known : undefined;
        let verdict: AutoVerdict;
        if (ruled) verdict = { decision: 'allow', reason: '' };
        else if (noJudge) verdict = { decision: 'allow', reason: '' };
        else if (reused) verdict = { decision: 'allow', reason: reused.reason };
        else if (!classify) { noteJudge('failed', 'no_judge', { ms: 0 }); return park('judge_failed', pendingText('en', 'judge_failed_no_judge'), outbound, true); }
        else {
          autoEvent('checking');
          const judged = await judgeOnce(judgeInput, classify, ctx.signal, judgeLimitsFor(ctx, deps));
          verdict = judged.verdict;
          noteJudge(verdict.failed ? 'failed' : verdict.decision, verdict.failed, judged.spend);
        }
        const freshAllow = !reused && cacheKey !== undefined && verdict.decision === 'allow' && !verdict.failed;
        if (known && !reused && !freshAllow && cacheKey !== undefined) forgetAllow(ctx, cacheKey);
        const storeSnapshot = freshAllow ? await snapshotNow() : undefined;
        if (ctx.signal.aborted) {
          autoEvent('asked');
          return finish({ output: { content: toolText(language, 'pipeline.cancelled'), isError: true }, decision: 'ask', decidedBy: 'user', invalidArguments: false });
        }
        if (effectiveMode(ctx, deps) === 'plan' && !planAllows(tool)) {
          autoEvent('asked');
          return refuse('deny', 'mode', toolText(language, 'pipeline.mode_plan', { name: tool.name }));
        }
        if (verdict.decision !== 'allow' || verdict.failed) {
          autoEvent('asked');
          if (verdict.failed) return park('judge_failed', pendingText('en', `judge_failed_${verdict.failed}`), outbound, true);
          return park('judge', verdict.reason ? pendingText('en', 'judge_asked', { reason: verdict.reason }) : pendingText('en', 'judge_asked_no_reason'), outbound, true);
        }
        let changed: string[] | undefined;
        if (tool.preCheck) {
          const before = earlier = first;
          try {
            const again = first = await tool.preCheck(args, ctx);
            const refused = again.decision === 'deny' || refusedKeysOf(again.reasonKeys ?? []).length > 0;
            const moved = (again.bind ?? null) !== (before?.bind ?? null) || JSON.stringify(again.pushes ?? null) !== JSON.stringify(before?.pushes ?? null);
            const fresh = refused ? again.reasons : [...newChecks(before && recheckOf(before), again), ...(moved ? [toolText(language, 'pipeline.changed_target')] : [])];
            if (refused || fresh.length) changed = fresh;
          } catch (error) { changed = [guardText(language, 'pipeline.precheck_failed', { detail: (error as Error).message })]; }
        }
        if (!changed && ruled && ruleFor(candidateFor('judge', first, outbound))?.id !== ruled.id) changed = [toolText(language, 'pipeline.changed_rule')];
        // 判定のあいだに押す先が送信の部品に変わったら、会話の外では、変わった旨より先に同じく断って質問票に 1 行（会話は下の変わった旨で断る）
        if (first?.decision !== 'deny' && submitsOf(tool, first) && ctx.kind !== 'chat') { autoEvent('asked'); return refuseSubmit(); }
        if (changed) { autoEvent('asked'); return refuse('deny', decidedBy, toolText(language, 'pipeline.changed_judging', { reasons: changed.join('\n- ') })); }
        const late = outboundOfCall(tool, first, language);
        if (late?.kind === 'deny') { autoEvent('asked'); return refuse('deny', 'outbound', toolText(language, 'pipeline.denied', { reasons: late.reason })); }
        if (late?.kind === 'send' || late?.kind === 'delete') { autoEvent('asked'); return park(late.kind, late.reason, late); }
        const keysNow = first?.reasonKeys ?? [];
        const ownerNow: { kind: PendingKind; reason: string } | undefined = keysNow.some(key => POLICY_KEYS.has(key)) ? { kind: 'policy', reason: reasons.join('; ') }
          : first?.ownerReason !== undefined ? { kind: 'owner', reason: first.ownerReason }
          : ownerKeysOf(keysNow).length ? { kind: 'owner', reason: pendingText('en', 'owner_protected', { reasons: reasons.join('; ') }) }
          : undefined;
        if (ownerNow) { autoEvent('asked'); return park(ownerNow.kind, ownerNow.reason); }
        decision = 'allow';
        if (ruled) {
          decidedBy = OWNER_RULE; ruleGate = ruled; judgedId = `rule:${ruled.id}`;
        } else if (noJudge) {
          decidedBy = NO_JUDGE;
          judgedId = deps.approvals.recordAuto({ runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, reasons }, guardText(language, 'pipeline.no_judge_reason'));
        } else {
          const why = verdict.reason || guardText(language, 'pipeline.auto_no_reason');
          const shownWhy = reused ? guardText(language, 'pipeline.judge_reused', { reason: why }) : why;
          const autoId = deps.approvals.recordAuto({
            runId: ctx.runId, conversationId: ctx.conversationId, tool: tool.name, input: args, reasons,
          }, shownWhy);
          decidedBy = reused ? JUDGE_REUSE : 'auto-mode'; autoWhy = why; sameAs = reused?.call;
          if (freshAllow && cacheKey !== undefined && storeSnapshot !== undefined) rememberAllow(ctx, cacheKey, { call: callNumber, reason: why, snapshot: storeSnapshot });
          autoEvent('allowed', shownWhy);
          judgedId = autoId;
        }
      }
    }
  }

  if (decision === 'deny') return refuse('deny', decidedBy, toolText(language, 'pipeline.denied', { reasons: reasons.join('\n- ') }));

  // ── 実行 ──
  let output: ToolOutput;
  const closeWindow = opensWindow(tool) ? ctx.toolWindow?.() : undefined;
  const approvedEgress = [first, earlier].some(check => check?.decision === 'ask' && check.askKinds?.includes('egress') === true);
  const fetchedBefore = first?.fetched === true || earlier?.fetched === true || approvedEgress;
  try { output = await tool.execute(args, ctx, { approvedOnce: false, callId: call.id, ...(fetchedBefore ? { fetched: true } : {}) }); }
  catch (error) { output = { content: toolText(language, 'pipeline.exec_error', { detail: (error as Error).message }), isError: true }; }
  finally { closeWindow?.(); }
  // 外から読んだ印は、通信の道具が「結果の文に相手の文字が 1 つも入らない失敗」と自分で言ったとき（noRemoteContent）のほかは付ける。失敗の文にも相手の文字（Content-Type・転送先の URL など）は入りうる。
  // シェルのコマンドが外から取得する・外の中身を持ち込む（curl・Invoke-WebRequest・git clone・npm install など。first.fetched）ときも、動かした以上は、成功・失敗を問わず付ける（どのモードでも）。
  // 事前の判定が「外とやり取りする」確かめ（種類 egress。git push・curl の送信など）にして、持ち主が通した呼び出しも、動かしたら付ける。
  // 結果が外の中身を持ち込んだと自分で言ったとき（output.fetched。実行してみないと分からない道具）も付ける。付ける向きにしか働かない。
  if ((network && !(output.isError && output.noRemoteContent)) || fetchedBefore || output.fetched === true) { ctx.taint.tainted = true; ctx.taint.sources.push(tool.name); }

  // ── 実行後フック（記録用。結果は変えない） ──
  for (const hook of ctx.config.tools.hooks.postToolUse) {
    if (hook.enabled === false || !matches(hook.matcher, tool.name)) continue;
    await runCommandHook(hook, {
      hook_event_name: 'PostToolUse', tool_name: tool.name, tool_input: args, tool_output: output.content.slice(0, 8000),
      cwd: ctx.workspace, run_id: ctx.runId, conversation_id: ctx.conversationId,
    }, ctx.signal).catch(() => undefined);
  }
  return finish({ output, decision, decidedBy, invalidArguments: false }, judgedId);
}
