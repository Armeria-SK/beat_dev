// 外の実行役 Claude Code（PLAN.md AR-5。形 A = Agent SDK）。使う人が自分で入れてログインした claude.exe を、SDK の pathToClaudeCodeExecutable で指して動かすだけ。
// beat は本体を同梱せず・書き換えず・ログインの情報（資格情報のファイルやトークン）を読まない。SDK の同梱の本体の部品は入れない（package.json の overrides）。
// 起こすのは process-manager の spawnForSdk だけ（環境の絞り・絶対パス・孫まで止める）。1 回の返事ごとに起こして閉じる（resume で続ける）。
// 許可のモードは毎回 default か acceptEdits を明示して渡す（bypassPermissions は渡せない）。製品のフォルダの .claude/settings.json と .mcp.json は読ませない（settingSources: ['user']）。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { CanUseTool, Options, PermissionResult, PermissionUpdate, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeConfig } from '../../config/schema.ts';
import { resolvePaths, type AppPaths } from '../../paths.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import { isInside, isRemotePath, realish, windowsHazard } from '../../tools/hooks/scope.ts';
import { runtimeEnv, type LaunchRecord, type ProcessScope } from '../process-manager.ts';
import type { RuntimeDeps } from '../registry.ts';
import {
  PERMISSIONS, type AgentRuntime, type ApprovalDecision, type RuntimeCapabilities, type RuntimeEvent, type RuntimeInput, type RuntimeModel,
  type RuntimeRequest, type RuntimeSession, type RuntimeStatus,
} from '../types.ts';
import { findClaudeExecutable } from './executable.ts';
import { answerFor, claudeMode, disallowedTools, isCodexPermission, STOPPED_ANSWER, toolHooks, type ClaudePermissionMode } from './permissions.ts';
import { apiKeyInUse, EventTranslator, MIN_CLAUDE_CODE_VERSION, safeText, versionAtLeast, versionParts } from './protocol.ts';

export interface ClaudeCodeSdk {
  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
}

export interface ClaudeCodeOptions {
  // 試験用: SDK の入れ替え。既定は本物の SDK を最初に使うときに読み込む（beat の起動では読み込まない）
  loadSdk?: () => Promise<ClaudeCodeSdk>;
  // 試験用: beat 自身のフォルダ・データのフォルダの場所
  paths?: () => AppPaths;
  initTimeoutMs?: number;
  // 試験用: 子の環境の元（既定は process.env）
  env?: NodeJS.ProcessEnv;
  // 試験用: 版・ログインの状態の問い合わせ（既定は process-manager で本体を 1 回きり起こす）
  ask?: (file: string, args: string[]) => Promise<string[] | undefined>;
}

export class ClaudeCodeError extends Error {
  readonly reason: 'cwd' | 'permission' | 'executable' | 'version' | 'auth' | 'aborted' | 'resume' | 'model' | 'startup' | 'busy' | 'input' | 'closed';
  constructor(reason: ClaudeCodeError['reason'], message: string) {
    super(message);
    this.name = 'ClaudeCodeError';
    this.reason = reason;
  }
}

// 起こしたときの設定。実行の記録（engine_runs.runtime）に残すもの。秘密は持たない（引数は伏せたもの、環境は名前だけ）
export interface ClaudeCodeLaunch {
  record: LaunchRecord | undefined;
  claudeCodeVersion: string | undefined;
  permission: ClaudePermissionMode;
  settingSources: readonly string[];
  model: string | undefined;
  resumed: boolean;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiting: Array<(result: IteratorResult<T, undefined>) => void> = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: (): Promise<IteratorResult<T, undefined>> => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift() as T, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.#waiting.push(resolve));
      },
    };
  }
}

interface Pending {
  input: Record<string, unknown>;
  suggestions: readonly PermissionUpdate[] | undefined;
  resolve: (answer: PermissionResult) => void;
}

interface Session {
  id: string;
  info: RuntimeSession;
  scope: ProcessScope;
  query: Query;
  input: AsyncQueue<SDKUserMessage>;
  events: AsyncQueue<RuntimeEvent>;
  translator: EventTranslator;
  pending: Map<string, Pending>;
  launch: ClaudeCodeLaunch;
  sent: boolean;
  terminal: boolean;
  closed: boolean;
  interrupting: boolean;
  tripped: boolean;
  detach: () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;

const CAPABILITIES: RuntimeCapabilities = {
  streaming: true, resume: true, interrupt: true, approvals: true, fileChanges: true, commandExecution: true, nativeTools: true,
  listsModels: true, externalApprovals: true, permissions: PERMISSIONS['claude-code'],
};

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClaudeCodeError('startup', `${what} did not answer within ${Math.round(ms / 1000)} seconds`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 起こす作業フォルダが、beat 自身の入っているフォルダ・データのフォルダと重なるときの理由（両向きに見る。リンクの先も実体で見る）
export function ownFolderOverlap(cwd: string, paths: AppPaths): string | undefined {
  const target = realish(resolve(cwd));
  const own: Array<[string, string]> = [[resolve(paths.templates, '..'), 'the folder beat is installed in'], [paths.data, 'the beat data folder']];
  for (const [folder, name] of own) {
    const real = realish(resolve(folder));
    if (isInside(real, target) || isInside(target, real)) return `The working folder overlaps ${name}, so Claude Code is not started there`;
  }
  return undefined;
}

class ClaudeCodeRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind = 'claude-code' as const;
  readonly capabilities = CAPABILITIES;
  readonly #config: RuntimeConfig;
  readonly #deps: RuntimeDeps;
  readonly #options: ClaudeCodeOptions;
  readonly #sessions = new Map<string, Session>();
  #sdk: Promise<ClaudeCodeSdk> | undefined;
  #next = 0;

  constructor(config: RuntimeConfig, deps: RuntimeDeps, options: ClaudeCodeOptions) {
    this.id = config.id;
    this.#config = config;
    this.#deps = deps;
    this.#options = options;
  }

  #loadSdk(): Promise<ClaudeCodeSdk> {
    this.#sdk ??= (this.#options.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk') as Promise<ClaudeCodeSdk>))();
    return this.#sdk.catch((error: unknown) => {
      this.#sdk = undefined;
      throw new ClaudeCodeError('startup', redactSecrets(`The Claude Agent SDK could not be loaded: ${(error as Error).message}`));
    });
  }

  #childEnv(): { env: Record<string, string>; dropped: string[] } { return runtimeEnv(this.#options.env ?? process.env); }

  async #executable(): Promise<string> {
    const found = findClaudeExecutable(this.#config.executablePath, this.#options.env ?? process.env);
    if ('reason' in found) throw new ClaudeCodeError('executable', found.reason);
    return found.path;
  }

  // 1 回きりの小さな起動（版・ログインの状態）。起こすのは process-manager だけ。標準出力の行を返す（読めなければ undefined）
  async #ask(file: string, args: string[]): Promise<string[] | undefined> {
    if (this.#options.ask) return this.#options.ask(file, args);
    const scope = await this.#deps.processes.open();
    try {
      const process = scope.spawn({ file, args, cwd: tmpdir(), ...(this.#options.env ? { env: this.#options.env } : {}) });
      const lines: string[] = [];
      const reading = (async () => { for await (const line of process.lines()) lines.push(line); })();
      let timer: NodeJS.Timeout | undefined;
      const finished = await Promise.race([reading.then(() => true), new Promise<false>(done => { timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS); })]);
      clearTimeout(timer);
      return finished ? lines : undefined;
    } catch (error) {
      this.#deps.log(`[WARN] claude-code probe could not run: ${redactSecrets((error as Error).message)}`);
      return undefined;
    } finally {
      await scope.finish();
    }
  }

  async probe(): Promise<RuntimeStatus> {
    const found = findClaudeExecutable(this.#config.executablePath, this.#options.env ?? process.env);
    if ('reason' in found) return { installed: false, auth: 'unknown', reason: found.reason };
    const parts = versionParts((await this.#ask(found.path, ['--version']))?.join(' '));
    if (!parts) return { installed: true, auth: 'unknown', reason: 'The Claude Code version could not be read' };
    const version = parts.join('.');
    if (!versionAtLeast(version)) return { installed: true, version, auth: 'unknown', reason: `Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer is needed. Update Claude Code` };
    // ログインの状態だけ読む。本人の情報（メール・組織など）は読み捨てる
    const raw = await this.#ask(found.path, ['auth', 'status', '--json']);
    let loggedIn: unknown;
    try { loggedIn = (JSON.parse(raw?.join('\n') ?? '') as { loggedIn?: unknown }).loggedIn; } catch { loggedIn = undefined; }
    if (loggedIn === true) return { installed: true, version, auth: 'ok' };
    if (loggedIn === false) return { installed: true, version, auth: 'login_required', reason: 'Claude Code is not signed in. Run "claude auth login" in a terminal' };
    return { installed: true, version, auth: 'unknown', reason: 'The Claude Code login state could not be read' };
  }

  // 出せるモデルの一覧。設定も MCP も読まず、発言なしで起こして SDK の supportedModels() だけ読む（モデルの枠を使わない）
  async models(): Promise<RuntimeModel[]> {
    const executable = await this.#executable();
    const sdk = await this.#loadSdk();
    const scope = await this.#deps.processes.open();
    const input = new AsyncQueue<SDKUserMessage>();
    let query: Query | undefined;
    try {
      query = sdk.query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: executable, cwd: tmpdir(), env: this.#childEnv().env, permissionMode: 'default', settingSources: [], strictMcpConfig: true,
          disallowedTools: disallowedTools(), canUseTool: async () => STOPPED_ANSWER, spawnClaudeCodeProcess: options => scope.spawnForSdk(options),
        },
      });
      const list = await withTimeout(query.supportedModels(), this.#options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS, 'Claude Code');
      return list.map(model => ({ id: model.value, label: model.displayName, ...(model.supportedEffortLevels ? { efforts: model.supportedEffortLevels } : {}) }));
    } finally {
      input.end();
      try { query?.close(); } catch { /* 閉じるだけ */ }
      await scope.abort();
    }
  }

  async start(request: RuntimeRequest): Promise<RuntimeSession> {
    if (request.signal.aborted) throw new ClaudeCodeError('aborted', 'The reply was stopped before Claude Code started');
    // 別の実行役（Codex）の許可の値は、倒さずに断る（何も起こす前に）。それ以外の知らない値は、Claude Code の一覧への絞りで default に倒れる
    if (isCodexPermission(request.permission)) throw new ClaudeCodeError('permission', 'This permission value belongs to another runtime. Choose a Claude Code permission');
    const permission = claudeMode(request.permission);
    if (isRemotePath(request.cwd) || windowsHazard(request.cwd) !== undefined) throw new ClaudeCodeError('cwd', 'The working folder cannot be a network path or a device path');
    if (!isAbsolute(request.cwd) || !statSync(request.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new ClaudeCodeError('cwd', 'The working folder must be an existing folder given as an absolute path');
    const overlap = ownFolderOverlap(request.cwd, (this.#options.paths ?? resolvePaths)());
    if (overlap) throw new ClaudeCodeError('cwd', overlap);
    if (request.resume !== undefined && !UUID.test(request.resume)) throw new ClaudeCodeError('resume', 'The saved Claude Code session id is not valid');
    if (request.model !== undefined && !MODEL_NAME.test(request.model)) throw new ClaudeCodeError('model', 'The Claude Code model name is not valid');
    const executable = await this.#executable();
    const sdk = await this.#loadSdk();
    const scope = await this.#deps.processes.open();
    const id = `claude-code-${this.#next += 1}`;
    const input = new AsyncQueue<SDKUserMessage>();
    const childEnv = this.#childEnv();
    // 新しい会話は beat が付けた ID で始める（続きに使う ID を、最初の知らせより前に持てる）。続きの会話は渡された ID
    const runtimeSession = request.resume ?? randomUUID();
    const info: RuntimeSession = { id, runtimeSession };
    const launch: ClaudeCodeLaunch = { record: undefined, claudeCodeVersion: undefined, permission, settingSources: ['user'], model: request.model, resumed: request.resume !== undefined };
    let session: Session;
    const canUseTool: CanUseTool = (toolName, toolInput, options) => new Promise<PermissionResult>(resolve => {
      const requestId = options.toolUseID;
      // 同じ求めの ID が待っているあいだに、もう 1 つ来たら断る（答えは ID ごとに 1 回だけ）
      if (session.closed || session.pending.has(requestId)) { resolve(STOPPED_ANSWER); return; }
      // 「この返事のあいだ聞かない」の決まりが、聞かれた操作より広くなるとき（suppressAlwaysAllowRule）は、決まりを残す提案を使わない
      session.pending.set(requestId, { input: toolInput, suggestions: options.suppressAlwaysAllowRule === true ? undefined : options.suggestions, resolve });
      options.signal.addEventListener('abort', () => { if (session.pending.delete(requestId)) resolve(STOPPED_ANSWER); }, { once: true });
      session.events.push({ type: 'approval', requestId, tool: toolName, input: toolInput });
    });
    let query: Query | undefined;
    try {
      query = sdk.query({
        prompt: input,
        options: {
          pathToClaudeCodeExecutable: executable,
          cwd: request.cwd,
          env: childEnv.env,
          permissionMode: permission,
          settingSources: ['user'],
          disallowedTools: disallowedTools(),
          hooks: toolHooks(),
          canUseTool,
          includePartialMessages: true,
          spawnClaudeCodeProcess: options => {
            const spawned = scope.spawnForSdk(options);
            // 落とした名前は、ここで先に落とした分（親の環境）と process-manager が落とした分（SDK が足した名前）の両方を記録に残す
            launch.record = { ...spawned.record, droppedEnv: [...new Set([...childEnv.dropped, ...spawned.record.droppedEnv])].sort() };
            return spawned;
          },
          ...(request.model !== undefined ? { model: request.model } : {}),
          ...(request.resume !== undefined ? { resume: request.resume } : { sessionId: runtimeSession }),
        },
      });
      session = {
        id, info, scope, query, input, launch, events: new AsyncQueue<RuntimeEvent>(), pending: new Map(),
        translator: new EventTranslator({ expectedMode: permission, interrupted: () => session.interrupting, onSession: reported => { info.runtimeSession = reported; } }),
        sent: false, terminal: false, closed: false, interrupting: false, tripped: false, detach: () => undefined,
      };
      const initialized = await withTimeout(query.initializationResult(), this.#options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS, 'Claude Code');
      launch.claudeCodeVersion = initialized.claude_code_version;
      if (!versionAtLeast(initialized.claude_code_version)) throw new ClaudeCodeError('version', `Claude Code ${MIN_CLAUDE_CODE_VERSION} or newer is needed. Update Claude Code`);
      // 契約のログインで動かすつもりなので、API キーが使われているなら発言を渡す前に止める
      if (apiKeyInUse(initialized.account.apiKeySource)) throw new ClaudeCodeError('auth', 'Claude Code is set to use an API key, not the Claude login, so the reply was not started');
      // 起動の待ちのあいだに止められていたら、起こした本体を残さずに断る（止める合図は、まだ onAbort をつなぐ前なので、ここで見る）
      if (request.signal.aborted) throw new ClaudeCodeError('aborted', 'The reply was stopped while Claude Code was starting');
    } catch (error) {
      input.end();
      try { query?.close(); } catch { /* 閉じるだけ */ }
      await scope.abort();
      throw error instanceof ClaudeCodeError ? error : new ClaudeCodeError('startup', safeText(`Claude Code could not be started: ${(error as Error).message}`));
    }
    const onAbort = (): void => { void this.interrupt(id).catch(() => undefined); };
    request.signal.addEventListener('abort', onAbort, { once: true });
    session.detach = () => request.signal.removeEventListener('abort', onAbort);
    this.#sessions.set(id, session);
    this.#deps.log(`[INFO] claude-code session ${id} ready: version=${launch.claudeCodeVersion ?? '?'} permission=${permission} resumed=${launch.resumed}`);
    return info;
  }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    const session = this.#session(sessionId);
    if (session.sent) throw new ClaudeCodeError('busy', 'A Claude Code session takes one message. Start a new session for the next reply');
    if (input.text.trim() === '') throw new ClaudeCodeError('input', 'The message is empty');
    session.sent = true;
    session.input.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: input.text }] }, parent_tool_use_id: null });
    void this.#pump(session);
  }

  async #pump(session: Session): Promise<void> {
    try {
      // for await の break は SDK の Query を閉じてしまうので、next() で読む
      const messages = session.query[Symbol.asyncIterator]();
      while (!session.terminal) {
        const next = await messages.next();
        if (next.done) break;
        for (const event of session.translator.translate(next.value)) this.#emit(session, event);
      }
      if (!session.terminal) this.#emit(session, { type: 'failed', kind: 'process', message: 'Claude Code ended without finishing the reply' });
    } catch (error) {
      if (!session.closed) this.#emit(session, { type: 'failed', kind: 'process', message: safeText(`Claude Code stopped: ${(error as Error).message}`) });
    }
  }

  #emit(session: Session, event: RuntimeEvent): void {
    if (session.terminal || session.closed) return;
    session.events.push(event);
    if (event.type !== 'done' && event.type !== 'failed') return;
    session.terminal = true;
    session.events.end();
    // 始まりの知らせが頼んだものと違った（API キー・許可のモード）ときは、モデルへの呼び出しが続かないよう、すぐ止める
    if (event.type === 'failed' && session.translator.guarded && !session.tripped) {
      session.tripped = true;
      this.#answerAll(session, STOPPED_ANSWER);
      void session.scope.abort();
    }
  }

  #answerAll(session: Session, answer: PermissionResult): void {
    const waiting = [...session.pending.values()];
    session.pending.clear();
    for (const pending of waiting) pending.resolve(answer);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    if (session.terminal) return;
    session.interrupting = true;
    this.#answerAll(session, STOPPED_ANSWER);
    await session.query.interrupt();
  }

  async approve(sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.#session(sessionId);
    const pending = session.pending.get(requestId);
    if (!pending) throw new ClaudeCodeError('busy', 'There is no waiting approval with that id (it was already answered or is no longer waiting)');
    session.pending.delete(requestId);
    pending.resolve(answerFor(decision, pending.input, pending.suggestions));
  }

  events(sessionId: string): AsyncIterable<RuntimeEvent> { return this.#session(sessionId).events; }

  // 返事が終わっていれば、入力を閉じて待ち、残っていれば木ごと止める。途中なら待たずに木ごと止める。何度呼んでもよい
  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    const finishedTurn = session.terminal && !session.tripped;
    session.closed = true;
    session.detach();
    this.#answerAll(session, STOPPED_ANSWER);
    session.input.end();
    if (finishedTurn) await session.scope.finish();
    else await session.scope.abort();
    try { session.query.close(); } catch { /* 閉じるだけ */ }
    session.events.end();
  }

  // 実行の記録に残す、起こしたときの設定（AR-7 が engine_runs.runtime に書く）
  launchOf(sessionId: string): ClaudeCodeLaunch | undefined { return this.#sessions.get(sessionId)?.launch; }

  #session(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session || session.closed) throw new ClaudeCodeError('closed', `There is no open Claude Code session ${sessionId}`);
    return session;
  }
}

export type { ClaudeCodeRuntime };

export function createClaudeCodeRuntime(config: RuntimeConfig, deps: RuntimeDeps, options: ClaudeCodeOptions = {}): ClaudeCodeRuntime {
  return new ClaudeCodeRuntime(config, deps, options);
}
