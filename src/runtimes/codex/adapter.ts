// Codex の実行役（auth-runtime AR-4）。使う人が自分で入れてログインした codex を `codex app-server`（標準入出力。試験的な口は使わない）で動かし、
// 会話・承認・モデルの一覧・状態を beat の共通の窓口（AgentRuntime）に写す。ログインは Codex に任せる（beat はトークンも認証のファイルも持たない・読まない）。
// 決まり:
//  - プロセスを起こすのは ProcessManager だけ（ここでは spawn しない）。1 回の返事ごとに起こして、終わったら close で閉じる
//  - 許可の設定は起こすたびに permissionFor('codex', …) を通し、thread/start と毎回の turn/start に必ず渡す（既定は read-only + on-request + approvalsReviewer user）。
//    Claude Code の値は断り、知らない値・無い値は既定に倒す。何でも通す側・untrusted・never は送れない（protocol.ts の型）。Codex が返した実際の設定も確かめる
//  - 番の前に account/read（契約の ChatGPT のログインか）と windowsSandbox/readiness（ready か）を確かめ、満たさなければ始めない
//  - 聞いてきた求めは beat では許さず、共通の出来事（approval）にして持ち主へ渡す（approvals.ts）。答えられない求めは断りで答える
import { tmpdir } from 'node:os';
import type { RuntimeConfig } from '../../config/schema.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import { ProcessRefused, type ExitInfo, type LaunchRecord, type ProcessScope, type RuntimeProcess } from '../process-manager.ts';
import type { RuntimeDeps } from '../registry.ts';
import {
  PERMISSIONS, permissionFor, type AgentRuntime, type ApprovalDecision, type RuntimeCapabilities, type RuntimeEvent, type RuntimeInput, type RuntimeModel,
  type RuntimeIssue, type RuntimePermission, type RuntimeRequest, type RuntimeSession, type RuntimeStatus,
} from '../types.ts';
import { ApprovalTable, requestIdFor } from './approvals.ts';
import { asRecord, asString, CodexConnection, CodexRefused, isRecord, safeLabel, type ConnectionHandlers } from './app-server.ts';
import {
  IGNORED_NOTIFICATIONS, isClaudeCodePermission, QUIET_ITEM_TYPES, TOOL_ITEM_TYPES, VERIFIED_VERSION, WARNING_NOTIFICATIONS, wirePermission, type PermissionParams, type RequestId,
} from './protocol.ts';

// 実際に起こした記録（実行の記録 engine_runs.runtime に写す。秘密は入らない）
export interface CodexRunRecord {
  executable: string;
  args: string[];
  cwd: string;
  version: string | undefined;
  verifiedVersion: boolean;
  keptEnv: string[];
  droppedEnv: string[];
  contained: boolean;
  // account/read の account.type だけ（本人の情報は持たない）
  account: string;
  sandboxReadiness: string;
  permission: RuntimePermission;
  sent: Pick<PermissionParams, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>;
  // Codex が返した、実際に効いている設定（modelProvider は、会話がどこの口へ行くか。openai だけ通す）
  effective: { approvalPolicy: string; approvalsReviewer: string; sandbox: string; modelProvider: string };
  threadId: string;
  resumed: boolean;
}

export interface CodexRuntimeSession extends RuntimeSession { record: CodexRunRecord }

export interface CodexLaunch { file: string; args: string[] }
// どちらも試験のための口（にせの app-server を起こす・待ちを短くする）。レジストリの作り手（createCodexRuntime）は渡さないので、設定からは変えられない
export interface CodexRuntimeOptions { launch?: CodexLaunch; initializeTimeoutMs?: number }

const TEXT_LIMIT = 100_000;
const UNKNOWN_LIMIT = 50;
const START_TIMEOUT_MS = 60_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const MODEL_PAGE = 100;
const MODEL_PAGES = 20;

const clip = (value: string, limit = TEXT_LIMIT): string => (value.length > limit ? `${value.slice(0, limit)}\n[output cut at ${limit} characters]` : value);
const short = (value: string, limit = 300): string => redactSecrets(value).slice(0, limit);

class EventQueue implements AsyncIterable<RuntimeEvent> {
  readonly #items: RuntimeEvent[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(event: RuntimeEvent): void {
    if (this.#closed) return;
    this.#items.push(event);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next) { yield next; continue; }
      if (this.#closed) return;
      await new Promise<void>(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}

const RATE_LIMIT_ERRORS: ReadonlySet<string> = new Set(['usageLimitExceeded', 'rateLimitExceeded', 'apiKeySpendLimitExceeded', 'projectSpendLimitExceeded', 'organizationSpendLimitExceeded', 'sessionBudgetExceeded', 'serverOverloaded']);

export function failureKind(info: unknown): 'auth' | 'rate_limit' | 'process' {
  const key = typeof info === 'string' ? info : isRecord(info) ? Object.keys(info)[0] : undefined;
  if (key === 'unauthorized') return 'auth';
  return key !== undefined && RATE_LIMIT_ERRORS.has(key) ? 'rate_limit' : 'process';
}

function toolInput(item: Record<string, unknown>, type: string): unknown {
  switch (type) {
    case 'commandExecution': return { command: asString(item.command) ?? null, cwd: asString(item.cwd) ?? null };
    case 'fileChange': return { changes: (Array.isArray(item.changes) ? item.changes : []).slice(0, 500).flatMap(change => {
      const record = asRecord(change);
      return record && asString(record.path) !== undefined ? [{ path: record.path, kind: asString(asRecord(record.kind)?.type) ?? 'unknown' }] : [];
    }) };
    case 'mcpToolCall': return { server: asString(item.server) ?? null, tool: asString(item.tool) ?? null, arguments: item.arguments ?? null };
    case 'dynamicToolCall': return { namespace: asString(item.namespace) ?? null, tool: asString(item.tool) ?? null, arguments: item.arguments ?? null };
    case 'webSearch': return { query: asString(item.query) ?? null };
    case 'collabAgentToolCall': return { tool: asString(item.tool) ?? null, prompt: asString(item.prompt) ?? null };
    default: return {};
  }
}

function toolResult(item: Record<string, unknown>, type: string): { output: string; isError: boolean } {
  const status = asString(item.status);
  const failed = status === 'failed' || status === 'declined';
  switch (type) {
    case 'commandExecution': return { output: asString(item.aggregatedOutput) ?? (status === 'declined' ? 'The command was declined' : ''), isError: failed };
    case 'fileChange': {
      const lines = (Array.isArray(item.changes) ? item.changes : []).slice(0, 500).flatMap(change => {
        const record = asRecord(change);
        const path = asString(record?.path);
        return path === undefined ? [] : [`${asString(asRecord(record?.kind)?.type) ?? 'change'} ${path}`];
      });
      return { output: lines.length > 0 ? lines.join('\n') : status === 'declined' ? 'The change was declined' : '', isError: failed };
    }
    case 'mcpToolCall': {
      const error = asRecord(item.error);
      if (error) return { output: asString(error.message) ?? 'The tool call failed', isError: true };
      return { output: item.result === null || item.result === undefined ? '' : JSON.stringify(item.result), isError: failed };
    }
    case 'dynamicToolCall': return { output: Array.isArray(item.contentItems) ? JSON.stringify(item.contentItems) : '', isError: failed || item.success === false };
    default: return { output: '', isError: failed };
  }
}

class CodexSession {
  readonly id: string;
  readonly queue = new EventQueue();
  readonly approvals = new ApprovalTable();
  scope!: ProcessScope;
  proc!: RuntimeProcess;
  conn!: CodexConnection;
  threadId = '';
  turnId: string | undefined;
  cwd = '';
  model: string | undefined;
  wire!: PermissionParams;
  record!: CodexRunRecord;
  turnStarted = false;
  finished = false;
  stopping = false;
  readonly #log: (line: string) => void;
  readonly #streamed = new Set<string>();
  #last: 'none' | 'text' | 'tool' = 'none';
  #unknown = 0;
  #lastError: { message: string; kind: 'auth' | 'rate_limit' | 'process' } | undefined;

  constructor(id: string, log: (line: string) => void) {
    this.id = id;
    this.#log = log;
  }

  readonly handlers: ConnectionHandlers = {
    notification: (conn, method, params) => this.#notification(conn, method, params),
    serverRequest: (conn, id, method, params) => this.#serverRequest(conn, id, method, params),
    unreadable: (_conn, line) => this.#unknownEvent(line),
    ended: (_conn, exit) => this.#ended(exit),
  };

  #finish(event: RuntimeEvent): void {
    if (this.finished) return;
    this.finished = true;
    this.queue.push(event);
    this.queue.close();
    // 返事が終わったら入力を閉じる（Codex はそれで自分で終わる）。閉じるまで、この返事の中で出した「この返事のあいだ許す」が生き残らないように
    try { this.proc?.closeInput(); } catch { /* もう終わっている */ }
  }

  // 返事を始められなかった・途中で壊れた。出来事を failed で終えて、プロセスを止める
  fail(message: string): void {
    this.#finish({ type: 'failed', kind: 'process', message: short(message) });
    try { this.proc?.kill(); } catch { /* もう終わっている */ }
  }

  #unknownEvent(raw: string): void {
    if (this.finished || this.#unknown >= UNKNOWN_LIMIT) return;
    this.#unknown += 1;
    this.queue.push({ type: 'unknown', raw: short(raw, 2000) });
  }

  #push(event: RuntimeEvent): void {
    if (this.finished) return;
    this.#last = event.type === 'text' ? 'text' : 'tool';
    this.queue.push(event);
  }

  #notification(conn: CodexConnection, method: string, params: unknown): void {
    const p = asRecord(params);
    // Codex が起こした別の会話（子の担当）の知らせは、最初の版では扱わない。親の会話の中の 1 つの道具として出る
    const threadId = asString(p?.threadId);
    if (threadId !== undefined && this.threadId !== '' && threadId !== this.threadId) return;
    switch (method) {
      case 'item/agentMessage/delta': {
        const itemId = asString(p?.itemId);
        const delta = asString(p?.delta);
        if (itemId !== undefined) this.#streamed.add(itemId);
        if (delta) this.#push({ type: 'text', delta });
        return;
      }
      case 'item/started': return this.#itemStarted(asRecord(p?.item));
      case 'item/completed': return this.#itemCompleted(asRecord(p?.item));
      case 'turn/completed': return this.#turnCompleted(asRecord(p?.turn));
      case 'error': {
        const error = asRecord(p?.error);
        this.#lastError = { message: short(asString(error?.message) ?? 'Codex reported an error'), kind: failureKind(error?.codexErrorInfo) };
        return;
      }
      case 'item/fileChange/patchUpdated': {
        // 承認の前に変更の一覧が変わった。承認の札に古い一覧を出さない（道は「分からない」にして持ち主へ）
        const itemId = asString(p?.itemId);
        if (itemId !== undefined) this.approvals.forgetChanges(itemId);
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = p?.requestId;
        if (typeof requestId === 'number' || typeof requestId === 'string') { this.approvals.resolved(requestId); conn.resolved(requestId); }
        return;
      }
      default:
        if (WARNING_NOTIFICATIONS.has(method)) {
          this.#log(`[WARN] Codex said (${method}): ${short(JSON.stringify(p ?? {}))}`);
          const issue = method === 'windows/worldWritableWarning' ? worldWritableIssue(p) : undefined;
          if (issue && !this.finished) this.queue.push({ type: 'issue', issue });
          return;
        }
        if (!IGNORED_NOTIFICATIONS.has(method)) this.#unknownEvent(JSON.stringify({ method, params: p ?? null }));
    }
  }

  #itemStarted(item: Record<string, unknown> | undefined): void {
    const type = asString(item?.type);
    const id = asString(item?.id);
    if (!item || type === undefined || id === undefined) { this.#unknownEvent(JSON.stringify({ method: 'item/started', item: item ?? null })); return; }
    if (type === 'agentMessage') {
      if (this.#last === 'text') this.#push({ type: 'text', delta: '\n\n' });
      return;
    }
    if (TOOL_ITEM_TYPES.has(type)) {
      if (type === 'fileChange') this.approvals.rememberChanges(id, item.changes);
      this.#push({ type: 'tool_start', id, name: type, input: toolInput(item, type) });
    } else if (!QUIET_ITEM_TYPES.has(type)) this.#unknownEvent(JSON.stringify({ method: 'item/started', type }));
  }

  #itemCompleted(item: Record<string, unknown> | undefined): void {
    const type = asString(item?.type);
    const id = asString(item?.id);
    if (!item || type === undefined || id === undefined) { this.#unknownEvent(JSON.stringify({ method: 'item/completed', item: item ?? null })); return; }
    if (type === 'agentMessage') {
      // 流れてきた文字が無かったときだけ、最終の文を使う（二重に出さない）
      const full = asString(item.text);
      if (!this.#streamed.has(id) && full) this.#push({ type: 'text', delta: full });
      return;
    }
    if (TOOL_ITEM_TYPES.has(type)) {
      if (type === 'fileChange') this.approvals.rememberChanges(id, item.changes);
      const { output, isError } = toolResult(item, type);
      this.#push({ type: 'tool_end', id, output: clip(redactSecrets(output)), isError });
    } else if (!QUIET_ITEM_TYPES.has(type)) this.#unknownEvent(JSON.stringify({ method: 'item/completed', type }));
  }

  #turnCompleted(turn: Record<string, unknown> | undefined): void {
    const status = asString(turn?.status);
    if (status === 'completed' || status === 'interrupted') { this.#finish({ type: 'done' }); return; }
    const error = asRecord(turn?.error);
    const message = short(asString(error?.message) ?? this.#lastError?.message ?? (status === 'failed' ? 'The Codex turn failed' : 'Codex ended the turn in an unexpected state'));
    this.#finish({ type: 'failed', kind: error ? failureKind(error.codexErrorInfo) : (this.#lastError?.kind ?? 'process'), message });
  }

  #serverRequest(conn: CodexConnection, id: RequestId, method: string, params: unknown): void {
    const classified = this.approvals.classify(id, method, params);
    try {
      if ('approval' in classified) {
        if (this.finished || this.stopping) {
          const answer = this.approvals.answer(classified.approval.requestId, 'cancel');
          conn.respond(answer.rpcId, answer.result);
        } else this.#push(classified.approval);
        return;
      }
      const { reply, row } = classified.refused;
      if ('result' in reply) conn.respond(id, reply.result); else conn.respondError(id, reply.error.code, reply.error.message);
      this.#log(`[INFO] Codex asked for something beat does not answer (${classified.refused.label}); it was declined`);
      if (row) {
        const rowId = `${requestIdFor(id)}-declined`;
        this.#push({ type: 'tool_start', id: rowId, name: row.name, input: {} });
        this.#push({ type: 'tool_end', id: rowId, output: row.message, isError: true });
      }
    } catch (error) {
      this.#log(`[WARN] Codex request ${safeLabel(method)} could not be answered: ${short((error as Error).message)}`);
    }
  }

  #ended(exit: ExitInfo): void {
    if (this.finished) return;
    if (this.stopping) { this.#finish({ type: 'done' }); return; }
    const detail = exit.stoppedBy === 'limit' ? 'Codex wrote more output than beat allows' : `Codex stopped before the reply ended (exit code ${exit.code ?? 'none'})`;
    this.#finish({ type: 'failed', kind: 'process', message: short(`${detail}${exit.stderr ? `: ${exit.stderr.slice(-200)}` : ''}`) });
  }

  end(): void {
    this.finished = true;
    this.queue.close();
  }
}

const PROBE_HANDLERS: ConnectionHandlers = {
  notification: () => undefined,
  serverRequest: (conn, id) => { try { conn.respondError(id, -32601, 'beat is only checking the connection'); } catch { /* 終わっている */ } },
  unreadable: () => undefined,
  ended: () => undefined,
};

// windows/worldWritableWarning（囲い〔サンドボックス〕が守れない、誰でも書けるフォルダの知らせ）を、状態の行に出す注意にする。0.172.0 の型は samplePaths・extraCount・failedScan で、スレッドの番号は持たない。
// いつ来るかは確かめていない（0.172.0 の本物の 1 往復では見えなかった）ので、確かめ（probe）では待たない。会話の中で来たときに、会話をつなぐ段が RuntimeChecks.report へ渡す。フォルダの名前は数件と、残りの数だけ短く残す
export function worldWritableIssue(params: unknown): RuntimeIssue | undefined {
  const record = asRecord(params);
  const sample = (Array.isArray(record?.samplePaths) ? record.samplePaths : []).flatMap(path => (typeof path === 'string' ? [safeLabel(path)] : [])).slice(0, 3);
  const extra = typeof record?.extraCount === 'number' && Number.isFinite(record.extraCount) ? Math.max(0, Math.floor(record.extraCount)) : 0;
  if (sample.length > 0 || extra > 0) return { code: 'world_writable', detail: `${sample.join(', ')}${extra > 0 ? `${sample.length > 0 ? ' ' : ''}(+${extra})` : ''}` };
  return record?.failedScan === true ? { code: 'writable_scan_failed' } : undefined;
}

async function readAccount(conn: CodexConnection): Promise<{ type: string | undefined; requiresLogin: boolean }> {
  // 本人の情報（email・workspace・id）は読み捨てる。残すのは account.type と、ログインが要るかだけ
  const raw = asRecord(await conn.request('account/read', { refreshToken: false }));
  const type = asString(asRecord(raw?.account)?.type);
  return { type, requiresLogin: type === undefined && raw?.requiresOpenaiAuth === true };
}

export function checksWindowsSandbox(platformOs: string | undefined, platform: string = process.platform): boolean {
  return platform === 'win32' || /^win/iu.test(platformOs ?? '');
}

// Windows の囲いが ready か。ready でなければ「読むだけ」が効いているか分からないので、会話は始めない。Windows 以外では確かめない（その OS の囲いは Codex が持つ）
async function readSandbox(conn: CodexConnection): Promise<string> {
  if (!checksWindowsSandbox(conn.platformOs)) return 'not_checked';
  return asString(asRecord(await conn.request('windowsSandbox/readiness', undefined))?.status) ?? 'unknown';
}

function checkEffective(response: unknown, wire: PermissionParams): CodexRunRecord['effective'] {
  const r = asRecord(response);
  const sandbox = asRecord(r?.sandbox);
  const effective = {
    approvalPolicy: asString(r?.approvalPolicy) ?? 'unknown', approvalsReviewer: asString(r?.approvalsReviewer) ?? 'unknown', sandbox: asString(sandbox?.type) ?? 'unknown',
    modelProvider: asString(r?.modelProvider) ?? 'unknown',
  };
  const sameSandbox = effective.sandbox === wire.sandboxPolicy.type && sandbox?.networkAccess !== true;
  if (effective.approvalPolicy !== wire.approvalPolicy || effective.approvalsReviewer !== wire.approvalsReviewer || !sameSandbox) {
    throw new CodexRefused('config_mismatch', `Codex is not using the permission settings beat asked for (approval ${short(effective.approvalPolicy, 40)}, reviewer ${short(effective.approvalsReviewer, 40)}, sandbox ${short(effective.sandbox, 40)}), so it was not started`);
  }
  // 名前つきの許可の組（profile）が効いていると、送った sandbox の意味が変わる。何も効いていない（null・無い）ときだけ通す
  if (r?.activePermissionProfile !== null && r?.activePermissionProfile !== undefined) {
    throw new CodexRefused('config_mismatch', 'Codex is using a named permission profile, which beat did not ask for, so it was not started');
  }
  // 会話の行き先は、契約（ChatGPT のログイン）の OpenAI だけ。設定やプロジェクトの .codex で別の口に向けられていたら、始めない
  if (effective.modelProvider !== 'openai') {
    throw new CodexRefused('auth_mismatch', `Codex is sending the conversation to a model provider other than OpenAI (${short(effective.modelProvider, 40)}), so beat did not start it`);
  }
  return effective;
}

export class CodexRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind = 'codex' as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true, resume: true, interrupt: true, approvals: true, fileChanges: true, commandExecution: true, nativeTools: true,
    listsModels: true, externalApprovals: true, permissions: PERMISSIONS.codex,
  };
  readonly #config: RuntimeConfig;
  readonly #deps: Pick<RuntimeDeps, 'processes' | 'log'>;
  readonly #options: CodexRuntimeOptions;
  readonly #sessions = new Map<string, CodexSession>();
  #next = 0;

  constructor(config: RuntimeConfig, deps: Pick<RuntimeDeps, 'processes' | 'log'>, options: CodexRuntimeOptions = {}) {
    this.id = config.id;
    this.#config = config;
    this.#deps = deps;
    this.#options = options;
  }

  #launch(): CodexLaunch {
    return this.#options.launch ?? { file: this.#config.executablePath ?? 'codex', args: ['app-server'] };
  }

  async #open(cwd: string, handlers: ConnectionHandlers, signal?: AbortSignal) {
    const scope = await this.#deps.processes.open();
    try {
      const launch = this.#launch();
      const proc = scope.spawn({ file: launch.file, args: launch.args, cwd, ...(signal ? { signal } : {}) });
      const conn = new CodexConnection(proc, handlers, this.#deps.log);
      const hello = await conn.initialize(this.#options.initializeTimeoutMs);
      return { scope, proc, conn, version: hello.version };
    } catch (error) {
      await scope.abort();
      if (error instanceof ProcessRefused && (error.reason === 'not_found' || error.reason === 'launcher' || error.reason === 'relative')) throw new CodexRefused('not_installed', error.message);
      throw error;
    }
  }

  async probe(): Promise<RuntimeStatus> {
    let opened;
    try {
      opened = await this.#open(tmpdir(), PROBE_HANDLERS);
    } catch (error) {
      if (error instanceof CodexRefused) return { installed: error.reason !== 'not_installed', auth: 'unknown', reason: error.message };
      throw error;
    }
    const verified = opened.version === VERIFIED_VERSION;
    try {
      const account = await readAccount(opened.conn);
      const sandbox = await readSandbox(opened.conn);
      const notes: string[] = [];
      const issues: RuntimeIssue[] = [];
      if (!verified) notes.push(`beat has only checked Codex ${VERIFIED_VERSION}${opened.version ? ` (this is ${opened.version})` : ''}.`);
      if (sandbox !== 'ready' && sandbox !== 'not_checked') {
        notes.push(`The Windows sandbox for Codex is not ready (${short(sandbox, 40)}), so beat will not start a conversation yet.`);
        issues.push({ code: 'sandbox_not_ready', detail: safeLabel(sandbox, 40) });
      }
      if (account.requiresLogin) notes.unshift('Codex is not signed in. Sign in with Codex itself.');
      else if (account.type !== 'chatgpt') notes.unshift(`Codex is signed in with ${short(account.type ?? 'an unknown method', 40)}, not with a ChatGPT subscription.`);
      const auth = account.requiresLogin ? 'login_required' : account.type === 'chatgpt' ? 'ok' : 'unknown';
      const login = account.type === undefined ? undefined : account.type === 'chatgpt' ? 'subscription' : 'other';
      return {
        installed: true, ...(opened.version ? { version: opened.version } : {}), verified, auth, ...(login ? { login } : {}),
        ...(notes.length > 0 ? { reason: notes.join(' ') } : {}), ...(issues.length > 0 ? { issues } : {}),
      };
    } catch (error) {
      if (error instanceof CodexRefused) return { installed: true, ...(opened.version ? { version: opened.version } : {}), verified, auth: 'unknown', reason: error.message };
      throw error;
    } finally {
      await opened.scope.finish();
    }
  }

  async models(): Promise<RuntimeModel[]> {
    const opened = await this.#open(tmpdir(), PROBE_HANDLERS);
    try {
      // ログインが要るときは一覧を取らない（空を返す。理由は probe が言う）
      if ((await readAccount(opened.conn)).requiresLogin) return [];
      const models: RuntimeModel[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MODEL_PAGES; page += 1) {
        const reply = asRecord(await opened.conn.request('model/list', { limit: MODEL_PAGE, ...(cursor ? { cursor } : {}) }));
        for (const entry of Array.isArray(reply?.data) ? reply.data : []) {
          const model = asRecord(entry);
          const id = asString(model?.model);
          if (!model || id === undefined || seen.has(id) || model.hidden === true) continue;
          seen.add(id);
          const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).flatMap(option => {
            const effort = asString(asRecord(option)?.reasoningEffort);
            return effort === undefined ? [] : [effort];
          });
          const label = asString(model.displayName);
          models.push({ id, ...(label ? { label } : {}), ...(efforts.length > 0 ? { efforts } : {}) });
        }
        cursor = asString(reply?.nextCursor);
        if (!cursor) break;
      }
      return models;
    } finally {
      await opened.scope.finish();
    }
  }

  async start(request: RuntimeRequest): Promise<CodexRuntimeSession> {
    // Claude Code の許可の設定を Codex に渡さない（呼ぶ側の取り違え）。そのほかの知らない値・無い値は既定（read-only + on-request）に倒す
    if (isClaudeCodePermission(request.permission)) throw new CodexRefused('permission', 'A Claude Code permission setting cannot be used for Codex');
    const requested = permissionFor('codex', request.permission);
    if (request.signal.aborted) throw new CodexRefused('process', 'The reply was stopped before Codex started');
    const session = new CodexSession(`codex-${(this.#next += 1)}`, this.#deps.log);
    const opened = await this.#open(request.cwd, session.handlers, request.signal);
    const permission: RuntimePermission = opened.version === VERIFIED_VERSION ? requested : 'read-only';
    const wire = wirePermission(permission);
    if (permission !== requested) this.#deps.log(`[WARN] Codex ${opened.version ?? 'of an unknown version'} is not a version beat has checked, so it was started with ${permission} instead of ${requested}`);
    session.scope = opened.scope;
    session.proc = opened.proc;
    session.conn = opened.conn;
    request.signal.addEventListener('abort', () => { session.stopping = true; }, { once: true });
    try {
      const account = await readAccount(opened.conn);
      if (account.requiresLogin) throw new CodexRefused('login_required', 'Codex is not signed in. Sign in with Codex itself, then try again');
      if (account.type !== 'chatgpt') throw new CodexRefused('auth_mismatch', `Codex is signed in with ${short(account.type ?? 'an unknown method', 40)}, not with a ChatGPT subscription, so beat did not start it`);
      const sandbox = await readSandbox(opened.conn);
      if (sandbox !== 'ready' && sandbox !== 'not_checked') throw new CodexRefused('sandbox_not_ready', `The Windows sandbox for Codex is not ready (${short(sandbox, 40)}). Finish Codex's own sandbox setup, then try again`);
      const model = request.model ? { model: request.model } : {};
      const modes = { approvalPolicy: wire.approvalPolicy, approvalsReviewer: wire.approvalsReviewer, sandbox: wire.sandbox } as const;
      const resumed = request.resume !== undefined && request.resume !== '';
      const response = resumed
        ? await opened.conn.request('thread/resume', { threadId: request.resume as string, cwd: request.cwd, ...modes, ...model, excludeTurns: true }, START_TIMEOUT_MS)
        : await opened.conn.request('thread/start', { cwd: request.cwd, ...modes, ...model, ephemeral: false }, START_TIMEOUT_MS);
      const threadId = asString(asRecord(asRecord(response)?.thread)?.id);
      if (threadId === undefined || (resumed && threadId !== request.resume)) throw new CodexRefused('protocol', resumed ? 'Codex did not resume the conversation that was asked for' : 'Codex did not return a conversation id');
      const effective = checkEffective(response, wire);
      session.threadId = threadId;
      session.cwd = request.cwd;
      session.model = request.model;
      session.wire = wire;
      const launched: LaunchRecord = opened.proc.record;
      session.record = {
        executable: launched.executable, args: launched.args, cwd: launched.cwd, version: opened.version, verifiedVersion: opened.version === VERIFIED_VERSION,
        keptEnv: launched.keptEnv, droppedEnv: launched.droppedEnv, contained: opened.proc.containReason === undefined,
        account: account.type, sandboxReadiness: sandbox, permission, sent: modes, effective, threadId, resumed,
      };
      this.#sessions.set(session.id, session);
      this.#deps.log(`[INFO] Codex ${opened.version ?? 'unknown version'} ${resumed ? 'resumed' : 'started'} a conversation (account ${account.type}, ${wire.sandbox}, ${wire.approvalPolicy})`);
      return { id: session.id, runtimeSession: threadId, record: session.record, ...(opened.proc.containReason !== undefined ? { containReason: short(opened.proc.containReason, 300) } : {}) };
    } catch (error) {
      session.end();
      await opened.scope.abort();
      throw error;
    }
  }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    const session = this.#session(sessionId);
    if (session.turnStarted) throw new CodexRefused('busy', 'This Codex process already has a reply. Each reply starts its own process');
    session.turnStarted = true;
    const { approvalPolicy, approvalsReviewer, sandboxPolicy } = session.wire;
    try {
      const reply = asRecord(await session.conn.request('turn/start', {
        threadId: session.threadId, input: [{ type: 'text', text: input.text, text_elements: [] }], cwd: session.cwd,
        approvalPolicy, approvalsReviewer, sandboxPolicy, ...(session.model ? { model: session.model } : {}),
      }, START_TIMEOUT_MS));
      session.turnId = asString(asRecord(reply?.turn)?.id);
    } catch (error) {
      // 返事を始められなかった（書けない・Codex が断った・時間切れ）。出来事を failed で終え、プロセスを止めてから、呼んだ側にも知らせる
      session.fail(error instanceof Error ? error.message : 'Codex could not start the reply');
      throw error;
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    session.stopping = true;
    // 待っている承認は、何も許さずに閉じる
    for (const { rpcId, result } of session.approvals.cancelAll()) {
      try { session.conn.respond(rpcId, result); } catch { /* プロセスが終わっている */ }
    }
    if (session.finished) return;
    if (session.turnId === undefined) { session.proc.kill(); return; }
    try {
      await session.conn.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }, INTERRUPT_TIMEOUT_MS);
    } catch {
      if (!session.finished) session.proc.kill();
    }
  }

  async approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.#session(sessionId);
    const { rpcId, result } = session.approvals.answer(requestId, decision);
    if (!session.conn.respond(rpcId, result)) throw new CodexRefused('protocol', 'Codex already closed that request');
  }

  events(sessionId: string): AsyncIterable<RuntimeEvent> {
    return this.#session(sessionId).queue;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.stopping = true;
    for (const { rpcId, result } of session.approvals.cancelAll()) {
      try { session.conn.respond(rpcId, result); } catch { /* プロセスが終わっている */ }
    }
    session.end();
    await session.scope.finish();
  }

  #session(sessionId: string): CodexSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new CodexRefused('protocol', `No Codex session ${sessionId}`);
    return session;
  }
}

export function createCodexRuntime(config: RuntimeConfig, deps: RuntimeDeps): AgentRuntime {
  return new CodexRuntime(config, deps);
}
