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
import type { ProjectStore } from '../projects/store.ts';
import { usableCheck, type RuntimeChecks } from '../runtimes/checks.ts';
import { ownFolderOverlap } from '../runtimes/claude-code/adapter.ts';
import type { RuntimeRegistry } from '../runtimes/registry.ts';
import { BLOCKING_ISSUES, type AgentRuntime, type RuntimeEvent, type RuntimeIssue, type RuntimeSession, type RuntimeStatus } from '../runtimes/types.ts';
import { previewJson } from '../shared/json-preview.ts';
import { languageOf } from '../shared/language.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { engineText, type EngineMessageKey } from '../shared/messages/engine.ts';
import { providerText } from '../shared/messages/providers.ts';
import { plainBlock, plainLine } from '../shared/plain-text.ts';
import { redactExact, redactJsonValue, redactSecrets } from '../shared/redaction.ts';
import { TOOL_INPUT_PREVIEW_CHARS, TOOL_OUTPUT_LIMIT } from '../tools/pipeline.ts';
import type { RunBus } from './bus.ts';
import type { ChatMessage, EngineErrorKind, EngineResult } from './types.ts';

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
const UNKNOWN_LOG_LIMIT = 5;

// 実行役が言ってきた文（失敗・断りの理由）を、ログ・画面に渡す前に整える: 見えない文字・向きを変える文字・制御文字を消し、鍵を伏せ、長さを切る
export function cleanRuntimeText(text: string, secrets: readonly string[], max: number = FAILURE_TEXT_MAX): string {
  return redactSecrets(plainBlock(text, max), secrets);
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

  const held: { runtime: AgentRuntime | undefined; session: RuntimeSession | undefined } = { runtime: undefined, session: undefined };
  let launch: unknown;
  let permission = 'unknown';
  let sessionStart: string | undefined;
  let resumed = false;
  let toolCount = 0;
  let unknownCount = 0;
  let paragraph = '';
  let text = '';
  const open = new Map<string, OpenTool>();
  const usedIds = new Set<string>();

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
  const writeTool = (entry: OpenTool, output: string, isError: boolean): void => {
    savePair(
      { role: 'assistant', content: '', toolCalls: [{ id: entry.callId, name: entry.name, arguments: entry.input }], runtime: true, ...(entry.nested ? { nested: true as const } : {}) },
      { role: 'tool', toolCallId: entry.callId, name: entry.name, content: output, ...(isError ? { isError: true } : {}), gate: { by: 'runtime' }, runtime: true, ...(entry.nested ? { nested: true as const } : {}) },
    );
    deps.bus.publish({ type: 'tool.result', runId, conversationId, callId: entry.callId, name: entry.name, ok: !isError, decision: 'allow', preview: output.slice(0, 1500), gate: { by: 'runtime' }, ...(entry.nested ? { nested: true as const } : {}) });
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
        writeTool(entry, shownOutput(event.output), event.isError);
        return undefined;
      }
      case 'approval': {
        // 承認の橋は AR-8a。それまでは、何も許さずに返事を止める
        try { await held.runtime!.approve(held.session!.id, event.requestId, 'cancel'); } catch (error) { log(`[WARN] Could not decline the approval request of runtime ${runtimeId}: ${clean((error as Error).message)}`); }
        try { await held.runtime!.interrupt(held.session!.id); } catch { /* もう終わっている */ }
        log(`[INFO] Runtime ${runtimeId} asked for approval (${clean(plainLine(event.tool, 80), 80)}); the reply was stopped because approvals are not bridged yet`);
        return fail('provider_error', 'runtime.approval_bridge', { tool: clean(plainLine(event.tool, 80) || 'tool', 80) });
      }
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

  const drive = async (): Promise<Outcome> => {
    let check = deps.runtimes.checks.get(runtimeId);
    if (!check) {
      const checked = await deps.runtimes.checks.check(config, runtimeId);
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
    permission = found.permission;
    const folder = runtimeFolder(deps, input.projectId);
    if (!folder.ok) return fail('provider_error', folder.refusal.key, folder.refusal.params ?? {});
    const message = unansweredText(deps.conversations, conversationId);
    if (message.trim() === '') return fail('provider_error', 'runtime.start_failed', { detail: 'There is no message to send' });
    const previous = deps.conversations.runtimeOf(conversationId).session;
    resumed = previous !== null;
    const instructions = found.runtime.kind === 'claude-code' ? productInstructions(folder.root, log) : undefined;
    try {
      held.session = await deps.runtimes.registry.start(config, runtimeId, {
        conversationId, cwd: folder.root, model: input.model, signal,
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

  // 返事の終わりの片付け: 書きかけの文と、終わりの知らせが来なかった道具を残し、実行役を閉じる
  try {
    const stopped = !outcome.ok && outcome.cancelled === true;
    flushText(stopped);
    for (const entry of [...open.values()]) writeTool(entry, engineText(language, 'runtime.tool_lost'), true);
    open.clear();
  } catch (error) { log(`[WARN] Could not save the last part of the reply of run ${runId}: ${clean((error as Error).message)}`); }
  const sessionEnd = held.session?.runtimeSession;
  if (held.session && held.runtime) {
    try { await held.runtime.close(held.session.id); } catch (error) { log(`[WARN] Could not close the runtime session of run ${runId}: ${clean((error as Error).message)}`); }
  }
  if (sessionEnd) { try { deps.conversations.setRuntimeSession(conversationId, sessionEnd); } catch (error) { log(`[WARN] Could not remember the runtime session of ${conversationId}: ${clean((error as Error).message)}`); } }
  try {
    const record = redactJsonValue({ runtime: runtimeId, kind: held.runtime?.kind ?? null, model: input.model, permission, resumed, sessionStart: sessionStart ?? null, sessionEnd: sessionEnd ?? null, contained: held.session ? held.session.containReason === undefined : null, launch: launch ?? null });
    deps.runs.setRuntime(runId, JSON.parse(redactExact(JSON.stringify(record), secrets)) as unknown);
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
