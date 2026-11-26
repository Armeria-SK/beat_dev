// 外の実行役（Claude Code・Codex）で 1 回の返事を動かす橋（beat auth-runtime AR-7）。
// 分かれ道は ChatEngine#beginChat の中だけにあり、ここは「発言を渡す → 出来事を写して保存する」だけを持つ。実行役が動かした道具を、beat が動かし直すことはない。
// 道具の行は、名前を `<種類>:<道具>` にして beat の道具の登録に結び付かないようにし（: は beat の道具の名前に無い）、tool_calls・file_changes の表には書かない。
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import type { Conversations } from '../db/conversations.ts';
import { transaction } from '../db/database.ts';
import type { Runs } from '../db/runs.ts';
import type { AppPaths } from '../paths.ts';
import { readHead, stripInvisible } from '../projects/instructions.ts';
import { runProject } from '../projects/run.ts';
import type { PendingStore } from '../pending/store.ts';
import type { ProjectStore } from '../projects/store.ts';
import { usableCheck, type RuntimeChecks } from '../runtimes/checks.ts';
import { ownFolderOverlap } from '../runtimes/claude-code/adapter.ts';
import type { RuntimeRegistry } from '../runtimes/registry.ts';
import { mapApproval, type RefusalCode } from '../runtimes/approval-map.ts';
import { BLOCKING_ISSUES, permissionFor, type AgentRuntime, type RuntimeEvent, type RuntimeIssue, type RuntimeSession, type RuntimeStatus } from '../runtimes/types.ts';
import { previewJson } from '../shared/json-preview.ts';
import { languageOf } from '../shared/language.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import { pendingText } from '../shared/messages/pending.ts';
import { providerText } from '../shared/messages/providers.ts';
import { plainBlock, plainLine } from '../shared/plain-text.ts';
import { redactExact, redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import { TOOL_INPUT_PREVIEW_CHARS, TOOL_OUTPUT_LIMIT } from '../tools/pipeline.ts';
import type { RunBus } from './bus.ts';
import type { RuntimeApprovals } from './runtime-approvals.ts';
import type { ChatMessage, EngineErrorKind, EngineResult, ToolGate } from './types.ts';

export interface RuntimeTurnDeps {
  config: () => AppConfig;
  conversations: Conversations;
  runs: Runs;
  bus: RunBus;
  runtimes: { registry: RuntimeRegistry; checks: RuntimeChecks };
  paths: AppPaths;
  projects?: ProjectStore | undefined;
  log?: ((line: string) => void) | undefined;
  // 止めると言ってから、実行役が終わりの知らせを返すまで待つ時間（ミリ秒）。過ぎたら待たずに閉じる。試験で短くするためだけの上書き
  stopGraceMs?: number | undefined;
  // 実行役の承認の求めを持ち主へ回す先（Pending）と、答えを待つ控え。どちらかが無いときは、求めを全部断る（何も許さない）
  pending?: Pick<PendingStore, 'parkRuntime' | 'row'> | undefined;
  approvals?: RuntimeApprovals | undefined;
}

export interface RuntimeTurnInput {
  runId: string;
  conversationId: string;
  // 製品（実行役の会話は、製品の会話だけ）
  projectId: string | null;
  runtimeId: string;
  // 設定の models[].id（beat のモデルの名前）と、実行役に渡すモデルの名前
  modelId: string;
  model: string;
  signal: AbortSignal;
}

export interface RuntimeRefusal { key: EngineMessageKey; params?: MessageParams }

const STOP_GRACE_MS = 15_000;
const CLAUDE_MD_MAX_BYTES = 256 * 1024;
const OPEN_INPUT_LIMIT = 20_000;
const FAILURE_TEXT_MAX = 500;
const CLEAN_INPUT_MAX = 50_000;
const UNKNOWN_LOG_LIMIT = 5;

// 実行役が言ってきた文（失敗・断りの理由）を、ログ・画面に渡す前に整える: 見えない文字・向きを変える文字・制御文字を消し、鍵を伏せ、そのあとで長さを切る
// （先に切ると、切り口にかかった鍵の頭だけが残る。整える前の長さの上限 CLEAN_INPUT_MAX は、鍵の長さより十分大きい）
export function cleanRuntimeText(text: string, secrets: readonly string[], max: number = FAILURE_TEXT_MAX): string {
  return plainBlock(redactSecrets(plainBlock(text, CLEAN_INPUT_MAX), secrets), max);
}

// 実行役を起こす作業フォルダ（製品のフォルダ）。製品が無い・フォルダが無い・beat 自身の入っている場所やデータのフォルダと重なるときは断る（理由つき）
export function runtimeFolder(deps: Pick<RuntimeTurnDeps, 'projects' | 'paths'>, projectId: string | null): { ok: true; root: string } | { ok: false; refusal: RuntimeRefusal } {
  const project = runProject(deps.projects, projectId);
  if (!project) return { ok: false, refusal: { key: 'runtime.no_project' } };
  if (!project.root) return { ok: false, refusal: { key: 'runtime.folder_gone' } };
  const overlap = ownFolderOverlap(project.root, deps.paths);
  if (overlap) return { ok: false, refusal: { key: 'runtime.folder_refused', params: { reason: overlap } } };
  return { ok: true, root: project.root };
}

function notReadyReason(status: RuntimeStatus): string {
  if (status.reason) return status.reason;
  if (status.login === 'other') return 'It is not signed in with a subscription login';
  if (!status.installed) return 'It is not installed';
  return 'It is not ready';
}

// 会話を始める前の事前の確かめ（同期。何も書く前に断れるように）。見つからない・切れている・覚えている確かめが「始められない」なら断り、その理由を状態の行に覚えさせる。
// 確かめをまだしていない実行役は、ここでは断らない（返事の始まりで 1 回確かめる）
export function runtimePreflight(deps: Pick<RuntimeTurnDeps, 'runtimes'>, config: AppConfig, runtimeId: string): RuntimeRefusal | undefined {
  const secrets = deps.runtimes.registry.secrets();
  const found = deps.runtimes.registry.find(config, runtimeId);
  if (!found.ok) return { key: 'runtime.unavailable', params: { id: runtimeId, reason: cleanRuntimeText(found.detail, secrets) } };
  const check = deps.runtimes.checks.get(runtimeId);
  if (check && !usableCheck(check.status)) {
    const blocking = (check.status.issues ?? []).find(issue => BLOCKING_ISSUES.has(issue.code));
    if (blocking) deps.runtimes.checks.report(runtimeId, blocking);
    return { key: 'runtime.not_ready', params: { id: runtimeId, reason: cleanRuntimeText(notReadyReason(check.status), secrets) } };
  }
  return undefined;
}

// 製品の CLAUDE.md の全文（持ち主の決め Q-AR-13）。ふつうのファイルだけ読む（リンク・別の種類は読まない）。大きすぎるときは頭だけ
function productInstructions(root: string, log: (line: string) => void): string | undefined {
  const path = join(root, 'CLAUDE.md');
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return undefined;
    const head = entry.isFile() ? readHead(path, CLAUDE_MD_MAX_BYTES) : 'refused';
    if (head === 'refused') {
      log(`[INFO] Did not pass CLAUDE.md in the product folder ${root} to the runtime: only a plain file is read`);
      return undefined;
    }
    if (!head.whole) log(`[WARN] CLAUDE.md in the product folder ${root} is longer than ${CLAUDE_MD_MAX_BYTES} bytes, so only its beginning was passed to the runtime`);
    const text = stripInvisible(head.text).trim();
    return text === '' ? undefined : text;
  } catch (error) {
    log(`[WARN] Could not read CLAUDE.md in the product folder ${root} (${(error as NodeJS.ErrnoException).code ?? 'error'}), so the runtime starts without it`);
    return undefined;
  }
}

// 返事を始める発言: 最後の返事（user 以外の行）より後の user の発言を、続けて 1 つにする
function unansweredText(conversations: Conversations, conversationId: string): string {
  const rows = conversations.messages(conversationId, 50);
  const tail: string[] = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const message = rows[i]!.message;
    if (message.role !== 'user') break;
    tail.unshift(message.content);
  }
  return tail.join('\n\n');
}

interface OpenTool { callId: string; name: string; input: unknown; nested: boolean }

// 求めの ID（Claude Code は tool_use の id、Codex は項目の id）ごとの、beat が決めた印。道具の行を書くときに読む
type GateMark =
  | { kind: 'guard'; code: RefusalCode | 'plan_mode'; detail: string; name: string; input: unknown; used: boolean }
  | { kind: 'owner'; pendingId: number; used: boolean };

const GUARD_TEXT: Record<RefusalCode | 'plan_mode', EngineMessageKey> = {
  plan_mode: 'runtime.plan_declined', secret: 'runtime.guard.secret', outside_write: 'runtime.guard.outside_write', outside_read: 'runtime.guard.outside_read', readonly_root: 'runtime.guard.readonly_root',
  link_write: 'runtime.guard.link_write', protect_files: 'runtime.guard.protect_files', outside_cwd: 'runtime.guard.outside_cwd', self_target: 'runtime.guard.self_target',
  shell_deny: 'runtime.guard.shell_deny',
};

type Outcome = { ok: true } | { ok: false; kind: EngineErrorKind; key: EngineMessageKey; params: MessageParams; cancelled?: true };

const AUTH_REASONS: ReadonlySet<string> = new Set(['auth', 'login_required', 'auth_mismatch']);
const issueOf = (reason: unknown): RuntimeIssue | undefined =>
  reason === 'sandbox_not_ready' ? { code: 'sandbox_not_ready' } : reason === 'version' ? { code: 'too_old' } : undefined;

export async function runRuntimeTurn(deps: RuntimeTurnDeps, input: RuntimeTurnInput): Promise<EngineResult> {
  const { runId, conversationId, runtimeId, signal } = input;
  const config = deps.config();
  const language = languageOf(config);
  const secrets = deps.runtimes.registry.secrets();
  const log = (line: string): void => deps.log?.(line);
  const clean = (text: string, max?: number): string => cleanRuntimeText(text, secrets, max);
  const flags = ['runtime'];

  deps.runs.start(runId, 'chat', conversationId);
  // beat には、実行役が何を読んだか見えない。この実行も「外から読んだ」ものとして残す
  deps.runs.markTainted(runId);
  deps.bus.publish({ type: 'run.start', runId, conversationId, modelId: input.modelId });

  const fail = (kind: EngineErrorKind, key: EngineMessageKey, params: MessageParams = {}): Outcome => ({ ok: false, kind, key, params });
  const cancelled = (): Outcome => ({ ok: false, kind: 'cancelled', key: 'runtime.stopped_partway', params: {}, cancelled: true });

  // 実行役への呼びかけ（断る・止める・閉じる）を順に呼び、待つ時間は全部で止める猶予まで。応えない実行役のせいで、止めた返事が終わらないままにしない。呼びかけは必ず全部出す
  const bounded = async (calls: ReadonlyArray<readonly [string, () => Promise<void>]>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = deps.stopGraceMs ?? STOP_GRACE_MS;
    const expiry = new Promise<'expired'>(resolve => { timer = setTimeout(() => resolve('expired'), limit); });
    try {
      for (const [what, call] of calls) {
        const answered = (async () => call())().then(() => 'answered' as const, (error: unknown) => {
          log(`[WARN] Could not ${what} of runtime ${runtimeId}: ${clean((error as Error).message)}`);
          return 'answered' as const;
        });
        if (await Promise.race([answered, expiry]) === 'expired') log(`[WARN] Gave up waiting for runtime ${runtimeId} to ${what} after ${limit} ms; its process may be left running`);
      }
    } finally { clearTimeout(timer); }
  };

  const held: { runtime: AgentRuntime | undefined; session: RuntimeSession | undefined } = { runtime: undefined, session: undefined };
  let launch: unknown;
  let permission = 'unknown';
  let effort: string | undefined;
  let sessionStart: string | undefined;
  let resumed = false;
  let previousSession: string | null = null;
  let toolCount = 0;
  let unknownCount = 0;
  let paragraph = '';
  let text = '';
  const open = new Map<string, OpenTool>();
  const usedIds = new Set<string>();
  const gates = new Map<string, GateMark>();
  let planMode = false;
  let workRoot = '';
  let timedOut = false;

  const save = (message: ChatMessage): void => {
    const saved = deps.conversations.append(conversationId, message, runId);
    deps.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved.id, role: message.role });
  };
  const savePair = (assistant: ChatMessage, tool: ChatMessage): void => {
    const saved = transaction(deps.conversations.db, () => [deps.conversations.append(conversationId, assistant, runId), deps.conversations.append(conversationId, tool, runId)] as const);
    deps.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved[0].id, role: 'assistant' });
    deps.bus.publish({ type: 'message.saved', runId, conversationId, messageId: saved[1].id, role: 'tool' });
  };
  const flushText = (stoppedPartway = false): void => {
    const content = redactExact(paragraph, secrets, true);
    paragraph = '';
    if (content.trim() === '') return;
    text += content;
    save({ role: 'assistant', content: stoppedPartway ? `${content}\n\n${engineText(language, 'runtime.stopped_partway')}` : content });
  };
  // 実行役が言ってきた入力は、伏せてから保存し・画面へ出す（鍵らしい名前の値、環境の API キーの値、長すぎる入力）
  const shownInput = (value: unknown): unknown => {
    try {
      const redacted = redactJsonValue(value ?? null);
      const exact = JSON.parse(redactExact(JSON.stringify(redacted) ?? 'null', secrets)) as unknown;
      return JSON.stringify(exact).length > OPEN_INPUT_LIMIT ? previewJson(exact, TOOL_INPUT_PREVIEW_CHARS) : exact;
    } catch { return '[the input could not be read]'; }
  };
  const shownOutput = (output: string): string => {
    const redacted = redactSecrets(output, secrets, { keepLines: true });
    return redacted.length > TOOL_OUTPUT_LIMIT ? `${redacted.slice(0, TOOL_OUTPUT_LIMIT)}\n[output cut at ${TOOL_OUTPUT_LIMIT} characters]` : redacted;
  };
  const callIdFor = (rawId: string): string => {
    let id = `rt_${plainLine(rawId, 100) || 'tool'}`;
    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);
    return id;
  };
  const toolName = (name: string): string => `${held.runtime?.kind ?? 'runtime'}:${plainLine(name, 80) || 'tool'}`;
  const writeTool = (entry: OpenTool, output: string, isError: boolean, gate: ToolGate = { by: 'runtime' }, decision: 'allow' | 'deny' = 'allow'): void => {
    savePair(
      { role: 'assistant', content: '', toolCalls: [{ id: entry.callId, name: entry.name, arguments: entry.input }], runtime: true, ...(entry.nested ? { nested: true as const } : {}) },
      { role: 'tool', toolCallId: entry.callId, name: entry.name, content: output, ...(isError ? { isError: true } : {}), gate, runtime: true, ...(entry.nested ? { nested: true as const } : {}) },
    );
    deps.bus.publish({ type: 'tool.result', runId, conversationId, callId: entry.callId, name: entry.name, ok: !isError, decision, preview: output.slice(0, 1500), gate, ...(entry.nested ? { nested: true as const } : {}) });
  };
  const guardMessage = (mark: Extract<GateMark, { kind: 'guard' }>): string => engineText(language, GUARD_TEXT[mark.code], { detail: mark.detail });
  // 持ち主が決めた求めの結末。許した（answered・running）か、断った（rejected）か、持ち主の答えが出ないまま閉じた（古くなった・取り消された）か。待ったままの行は、実行役が自分で終えた求め（答えを待たずに道具が終わった）なので、古くして閉じる
  const ownerOutcome = (pendingId: number): { allowed: boolean; closed: boolean } => {
    const row = deps.pending?.row(pendingId);
    if (row?.status === 'waiting') deps.approvals?.release(pendingId, 'reply_closed');
    const allowed = row?.status === 'answered' || row?.status === 'running';
    return { allowed, closed: !allowed && row?.status !== 'rejected' };
  };
  // 実行役が終えた道具の行を書く。beat が断った求めは、実行役の結果の代わりに beat の文を 1 行だけ書く（実行役の「断られた」の結果と二重にしない）
  const finishTool = (rawId: string, entry: OpenTool, output: string, isError: boolean): void => {
    const mark = gates.get(rawId);
    if (mark) mark.used = true;
    if (mark?.kind === 'guard') { writeTool(entry, guardMessage(mark), true, { by: 'guard', key: mark.code }, 'deny'); return; }
    if (mark?.kind === 'owner') {
      const { allowed, closed } = ownerOutcome(mark.pendingId);
      writeTool(entry, output, isError, { by: 'owner', id: mark.pendingId, allowed, ...(closed ? { closed: true as const } : {}) }, allowed ? 'allow' : 'deny');
      return;
    }
    writeTool(entry, output, isError);
  };

  type ApprovalEvent = Extract<RuntimeEvent, { type: 'approval' }>;
  // 実行役への「断る・取り消す」の答え。答えない実行役のせいで、ここで止まらない
  const answerNow = async (event: ApprovalEvent, decision: 'decline_by_beat' | 'cancel'): Promise<void> => {
    const { runtime, session } = held;
    if (!runtime || !session) return;
    await bounded([[`${decision === 'cancel' ? 'cancel' : 'decline'} the approval request`, () => runtime.approve(session.id, event.requestId, decision)]]);
  };
  // 道具の行と結ぶ ID: Claude Code の求めの ID は tool_use の id と同じ。Codex の求めの ID は別で、項目の id（itemId）が道具の行の id
  const gateKeyOf = (event: ApprovalEvent): string => {
    const itemId = held.runtime?.kind === 'codex' && typeof event.input === 'object' && event.input !== null ? (event.input as { itemId?: unknown }).itemId : undefined;
    return typeof itemId === 'string' && itemId !== '' ? itemId : event.requestId;
  };
  // 承認の求め 1 つ: 計画モードなら断る → 写して守りに当たれば断る → それ以外は持ち主へ。待たずに戻る（答えは持ち主が決めたとき、Pending の側から実行役へ返る）
  const approval = async (event: ApprovalEvent): Promise<void> => {
    const { runtime, session } = held;
    if (!runtime || !session) return;
    const tool = clean(plainLine(event.tool, 80) || 'tool', 80);
    const key = gateKeyOf(event);
    const refuseHere = async (code: RefusalCode | 'plan_mode', detail: string): Promise<void> => {
      gates.set(key, { kind: 'guard', code, detail, name: toolName(event.tool), input: shownInput(event.input), used: false });
      log(`[INFO] Runtime ${runtimeId} asked for approval (${tool}); beat declined it without asking the owner (${code})`);
      await answerNow(event, 'decline_by_beat');
    };
    if (planMode || deps.conversations.modeOf(conversationId) === 'plan') { await refuseHere('plan_mode', ''); return; }
    const mapped = mapApproval({
      kind: runtime.kind, config: deps.config(), paths: deps.paths, root: workRoot, runId, conversationId,
      productRoots: [...(deps.projects?.list() ?? []), ...(deps.projects?.list({ archived: true }) ?? [])].map(p => p.root),
    }, event);
    if (mapped.decision === 'refuse') { await refuseHere(mapped.code, clean(mapped.detail, 300)); return; }
    if (!deps.pending || !deps.approvals) {
      log(`[WARN] Runtime ${runtimeId} asked for approval (${tool}), but there is no Pending to ask the owner in, so it was declined`);
      await answerNow(event, 'decline_by_beat');
      return;
    }
    let pendingId: number;
    try {
      pendingId = deps.pending.parkRuntime({
        runtimeId, tool: toolName(event.tool), requestId: event.requestId, title: mapped.card.title, body: mapped.card.body, cwd: mapped.card.cwd, extra: mapped.card.extra,
        reason: pendingText('en', 'runtime_reason', { runtime: runtime.kind === 'codex' ? 'Codex' : 'Claude Code', tool }),
        checks: [...mapped.checks, ...(mapped.checked ? [] : [pendingText('en', 'runtime_unchecked')])],
        reply: event.forReply === true && mapped.reply, root: workRoot, runId, conversationId, projectId: input.projectId,
      }).id;
    } catch (error) {
      log(`[WARN] Could not put the approval request of runtime ${runtimeId} (${tool}) in Pending, so it was declined: ${clean((error as Error).message)}`);
      await answerNow(event, 'decline_by_beat');
      return;
    }
    gates.set(key, { kind: 'owner', pendingId, used: false });
    deps.approvals.register({ pendingId, runtime, sessionId: session.id, requestId: event.requestId, runId, reply: event.forReply === true && mapped.reply, onTimeout: () => { timedOut = true; } });
  };

  // 1 つの出来事を写す。この返事をここで終えるなら、その結果を返す
  const handle = async (event: RuntimeEvent): Promise<Outcome | undefined> => {
    switch (event.type) {
      case 'text': {
        const delta = redactExact(event.delta, secrets, true);
        paragraph += event.delta;
        if (delta !== '') deps.bus.publish({ type: 'text.delta', runId, conversationId, text: delta });
        return undefined;
      }
      case 'tool_start': {
        if (open.has(event.id)) return undefined;
        flushText();
        const entry: OpenTool = { callId: callIdFor(event.id), name: toolName(event.name), input: shownInput(event.input), nested: event.nested === true };
        open.set(event.id, entry);
        toolCount += 1;
        deps.bus.publish({ type: 'tool.call', runId, conversationId, callId: entry.callId, name: entry.name, input: previewJson(entry.input, TOOL_INPUT_PREVIEW_CHARS), ...(entry.nested ? { nested: true as const } : {}) });
        return undefined;
      }
      case 'tool_end': {
        flushText();
        const started = open.get(event.id);
        open.delete(event.id);
        const entry: OpenTool = started ?? { callId: callIdFor(event.id), name: toolName('unknown'), input: {}, nested: event.nested === true };
        if (!started) { toolCount += 1; deps.bus.publish({ type: 'tool.call', runId, conversationId, callId: entry.callId, name: entry.name, input: '{}' }); }
        finishTool(event.id, entry, shownOutput(event.output), event.isError);
        return undefined;
      }
      case 'approval': await approval(event); return undefined;
      case 'issue': {
        deps.runtimes.checks.report(runtimeId, event.issue);
        log(`[WARN] Runtime ${runtimeId} reported a condition: ${event.issue.code}${event.issue.detail ? ` (${clean(event.issue.detail, 200)})` : ''}`);
        return undefined;
      }
      case 'unknown': {
        if (!flags.includes('runtime_unknown')) flags.push('runtime_unknown');
        unknownCount += 1;
        if (unknownCount <= UNKNOWN_LOG_LIMIT) log(`[WARN] Runtime ${runtimeId} sent an event beat does not know: ${clean(event.raw, 300)}`);
        return undefined;
      }
      case 'failed': {
        if (event.issue) deps.runtimes.checks.report(runtimeId, event.issue);
        const detail = clean(event.message);
        log(`[WARN] Runtime ${runtimeId} failed (${event.kind}): ${detail}`);
        return event.kind === 'auth' ? fail('auth', 'runtime.auth', { detail })
          : event.kind === 'rate_limit' ? fail('rate_limit', 'runtime.rate_limit', { detail })
            : fail('provider_error', 'runtime.process', { detail });
      }
      case 'done': return { ok: true };
    }
  };

  const waitMinutes = (): number => Math.max(1, Math.round((deps.approvals?.waitMs ?? 0) / 60_000));

  const stopped = new Promise<'stopped'>(resolve => { if (signal.aborted) resolve('stopped'); else signal.addEventListener('abort', () => resolve('stopped'), { once: true }); });

  const drive = async (): Promise<Outcome> => {
    let check = deps.runtimes.checks.get(runtimeId);
    if (!check) {
      // 最初の確かめは最長 60 秒かかる。止めると言われたら、確かめの終わりを待たずに終える
      const checked = await Promise.race([deps.runtimes.checks.check(config, runtimeId), stopped]);
      if (checked === 'stopped') return cancelled();
      if (!checked.ok) return fail('provider_error', 'runtime.unavailable', { id: runtimeId, reason: clean(checked.detail) });
      check = checked.check;
    }
    if (signal.aborted) return cancelled();
    if (!usableCheck(check.status)) {
      const blocking = (check.status.issues ?? []).find(issue => BLOCKING_ISSUES.has(issue.code));
      if (blocking) deps.runtimes.checks.report(runtimeId, blocking);
      return fail('provider_error', 'runtime.not_ready', { id: runtimeId, reason: clean(notReadyReason(check.status)) });
    }
    const found = deps.runtimes.registry.find(config, runtimeId);
    if (!found.ok) return fail('provider_error', 'runtime.unavailable', { id: runtimeId, reason: clean(found.detail) });
    held.runtime = found.runtime;
    // 計画モードの会話は、設定の許可より厳しい側（実行役ごとの一覧の先頭）で起こす。Claude Code の plan は選べる許可の一覧に無いので、default を使う
    const cautious = deps.conversations.modeOf(conversationId) === 'plan';
    planMode = cautious;
    permission = cautious ? permissionFor(found.runtime.kind, undefined) : found.permission;
    // 考える深さは、会話に覚えた値が、このモデルの一覧にあるときだけ渡す（無ければ実行役の既定）
    const stored = deps.conversations.get(conversationId)?.effort ?? null;
    effort = stored !== null && (config.models.find(m => m.id === input.modelId)?.efforts ?? []).includes(stored) ? stored : undefined;
    const folder = runtimeFolder(deps, input.projectId);
    if (!folder.ok) return fail('provider_error', folder.refusal.key, folder.refusal.params ?? {});
    workRoot = folder.root;
    const message = unansweredText(deps.conversations, conversationId);
    if (message.trim() === '') return fail('provider_error', 'runtime.start_failed', { detail: 'There is no message to send' });
    const previous = deps.conversations.runtimeOf(conversationId).session;
    previousSession = previous;
    resumed = previous !== null;
    const instructions = found.runtime.kind === 'claude-code' ? productInstructions(folder.root, log) : undefined;
    try {
      held.session = await deps.runtimes.registry.start(config, runtimeId, {
        conversationId, cwd: folder.root, model: input.model, signal, beatPort: config.server.port,
        ...(effort !== undefined ? { effort } : {}), ...(cautious ? { cautious: true as const } : {}),
        ...(instructions !== undefined ? { instructions } : {}), ...(previous !== null ? { resume: previous } : {}),
      });
    } catch (error) {
      if (signal.aborted) return cancelled();
      const reason = (error as { reason?: unknown }).reason;
      const issue = issueOf(reason);
      if (issue) deps.runtimes.checks.report(runtimeId, issue);
      const detail = clean((error as Error).message);
      log(`[WARN] Runtime ${runtimeId} could not be started: ${detail}`);
      if (typeof reason === 'string' && AUTH_REASONS.has(reason)) return fail('auth', 'runtime.auth', { detail });
      return fail('provider_error', resumed ? 'runtime.resume_failed' : 'runtime.start_failed', { detail });
    }
    const started = held.session;
    const active = found.runtime;
    sessionStart = started.runtimeSession;
    if (started.runtimeSession) deps.conversations.setRuntimeSession(conversationId, started.runtimeSession);
    const launchOf = (active as unknown as { launchOf?: (id: string) => unknown }).launchOf;
    launch = launchOf ? launchOf.call(active, started.id) : (started as unknown as { record?: unknown }).record;
    if (started.containReason !== undefined) {
      const reason = clean(started.containReason, 300);
      log(`[WARN] Runtime ${runtimeId} could not be put in a job: ${reason}`);
      deps.bus.publish({ type: 'warning', runId, conversationId, code: 'runtime_contain', message: engineText(language, 'warn.runtime_contain', { reason }), params: { reason } });
    }
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace'>(resolve => {
      const onAbort = (): void => {
        void active.interrupt(started.id).catch(() => undefined);
        graceTimer = setTimeout(() => resolve('grace'), deps.stopGraceMs ?? STOP_GRACE_MS);
      };
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await active.send(started.id, { text: message });
      const iterator = active.events(started.id)[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([iterator.next(), grace]);
        if (next === 'grace') return cancelled();
        if (next.done) break;
        const ended = await handle(next.value);
        if (ended) return signal.aborted && ended.ok ? cancelled() : ended;
      }
      return signal.aborted ? cancelled() : fail('provider_error', 'runtime.process', { detail: 'The runtime ended without finishing the reply' });
    } catch (error) {
      if (signal.aborted) return cancelled();
      const detail = clean((error as Error).message);
      log(`[WARN] Runtime ${runtimeId} stopped with an error: ${detail}`);
      return fail('provider_error', 'runtime.process', { detail });
    } finally { clearTimeout(graceTimer); }
  };

  let outcome: Outcome;
  try { outcome = await drive(); } catch (error) {
    const detail = clean((error as Error).message);
    log(`[ERROR] Runtime ${runtimeId} turn ${runId}: ${detail}`);
    outcome = fail('provider_error', 'runtime.process', { detail });
  }
  if (timedOut && !(!outcome.ok && outcome.cancelled === true)) outcome = fail('provider_error', 'runtime.approval_timeout', { minutes: waitMinutes() });

  // 返事の終わりの片付け: 書きかけの文と、終わりの知らせが来なかった道具を残し、実行役を閉じる
  try {
    const stopped = !outcome.ok && outcome.cancelled === true;
    flushText(stopped);
    for (const [rawId, entry] of [...open]) finishTool(rawId, entry, engineText(language, 'runtime.tool_lost'), true);
    open.clear();
    // beat が断ったのに、実行役がその道具の行を出さなかった求め: 返事の終わりで、beat の文の行を 1 つだけ書く
    for (const [rawId, mark] of gates) {
      if (mark.kind !== 'guard' || mark.used) continue;
      const entry: OpenTool = { callId: callIdFor(rawId), name: mark.name, input: mark.input, nested: false };
      toolCount += 1;
      deps.bus.publish({ type: 'tool.call', runId, conversationId, callId: entry.callId, name: entry.name, input: previewJson(entry.input, TOOL_INPUT_PREVIEW_CHARS) });
      finishTool(rawId, entry, '', true);
    }
  } catch (error) { log(`[WARN] Could not save the last part of the reply of run ${runId}: ${clean((error as Error).message)}`); }
  try { deps.approvals?.closeRun(runId, !outcome.ok && outcome.cancelled === true ? 'stopped' : 'reply_closed'); } catch (error) { log(`[WARN] Could not close the approval requests of run ${runId}: ${clean((error as Error).message)}`); }
  const sessionEnd = held.session?.runtimeSession;
  if (held.session && held.runtime) {
    const closing = { runtime: held.runtime, session: held.session };
    await bounded([['close the runtime session', () => closing.runtime.close(closing.session.id)]]);
  }
  if (sessionEnd) { try { deps.conversations.setRuntimeSession(conversationId, sessionEnd); } catch (error) { log(`[WARN] Could not remember the runtime session of ${conversationId}: ${clean((error as Error).message)}`); } }
  try {
    // 続きに使う会話の ID（beat が付けたもの・実行役が付けたもの）は、記録に残さない（起動の引数・thread の ID に入っていても伏せる）。一覧の API はこの記録をそのまま返す
    const sessionIds = [sessionStart, sessionEnd, previousSession].filter((id): id is string => typeof id === 'string' && id !== '');
    const record = redactJsonValue({ runtime: runtimeId, kind: held.runtime?.kind ?? null, model: input.model, effort: effort ?? null, permission, resumed, contained: held.session ? held.session.containReason === undefined : null, launch: launch ?? null });
    const hidden = sessionIds.reduce((json, id) => json.split(id).join('[session]'), redactExact(JSON.stringify(record), secrets));
    deps.runs.setRuntime(runId, JSON.parse(hidden) as unknown);
  } catch (error) { log(`[WARN] Could not record the runtime launch of run ${runId}: ${clean((error as Error).message)}`); }

  if (outcome.ok) {
    deps.runs.finish(runId, { ok: true, modelId: input.modelId, model: input.model, attempts: 1, stop: 'end_turn', iterations: 1, toolCalls: toolCount, flags });
    deps.bus.publish({ type: 'run.end', runId, conversationId, ok: true });
    return { ok: true, runId, text, modelId: input.modelId, usage: {}, stop: 'end_turn', workDone: 0, changeDone: 0, iterations: 1 };
  }
  const code = outcome.cancelled ? 'provider.cancelled' : `engine.${outcome.key}`;
  const message = outcome.cancelled ? providerText(language, 'cancelled') : engineText(language, outcome.key, outcome.params);
  deps.runs.finish(runId, { ok: false, modelId: input.modelId, model: input.model, attempts: 1, iterations: 1, toolCalls: toolCount, errorKind: outcome.kind, errorMessage: message, flags });
  deps.bus.publish({ type: 'run.end', runId, conversationId, ok: false, errorKind: outcome.kind, errorMessage: message, errorCode: code, ...(outcome.cancelled ? {} : { errorParams: outcome.params }) });
  return { ok: false, runId, text: '', errorKind: outcome.kind, errorMessage: message, errorCode: code, ...(outcome.cancelled ? {} : { errorParams: outcome.params }), retryable: false };
}
