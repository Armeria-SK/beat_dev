// Codex app-server への 1 本のつなぎ（標準入出力の 1 行 1 JSON の JSON-RPC。"jsonrpc" の印は省く）。
// プロセスを起こすのは src/runtimes/process-manager.ts だけ。ここは、起こされたプロセス（RuntimeProcess）の上で話すだけで、何も起こさない。
// 決まり: 送るメソッドは ClientMethods の 8 つだけ／initialize は experimentalApi を送らない／求め（id 付き）への返事は 1 つの求めに 1 回だけ／
// 答えられない求め・形の読めない行は黙って捨てずに、呼ぶ側へ返す（呼ぶ側が断りで答える）
import { redactSecrets } from '../../shared/redaction.ts';
import type { ExitInfo, RuntimeProcess } from '../process-manager.ts';
import type { ClientMethod, ClientMethods, JsonObject, RequestId } from './protocol.ts';

export class CodexRefused extends Error {
  readonly reason: 'not_installed' | 'login_required' | 'auth_mismatch' | 'sandbox_not_ready' | 'permission' | 'config_mismatch' | 'protocol' | 'timeout' | 'process' | 'busy';
  constructor(reason: CodexRefused['reason'], message: string) {
    super(message);
    this.name = 'CodexRefused';
    this.reason = reason;
  }
}

export const isRecord = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const asRecord = (value: unknown): JsonObject | undefined => (isRecord(value) ? value : undefined);

// Codex が送ってくる名前（メソッド名など）を、ログと画面の行に出すときの形: 制御文字・改行・見えない書式文字は ? にし、秘密は伏せ、長さを切る
export function safeLabel(value: string, limit = 100): string {
  return redactSecrets(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '?')).slice(0, limit);
}

export const CLIENT_INFO = { name: 'beat', title: null, version: '0.1.0' } as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const ERROR_TEXT_LIMIT = 300;

export interface ConnectionHandlers {
  notification(conn: CodexConnection, method: string, params: unknown): void;
  // 答えは conn.respond / conn.respondError で 1 回だけ返す。返さないと Codex が待ち続ける
  serverRequest(conn: CodexConnection, id: RequestId, method: string, params: unknown): void;
  // JSON でない・JSON-RPC の形でない行
  unreadable(conn: CodexConnection, line: string): void;
  // プロセスが終わった（返事待ちの求めは、先に失敗で閉じてある）
  ended(conn: CodexConnection, exit: ExitInfo): void;
}

interface Waiting { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const keyOf = (id: RequestId): string => `${typeof id}:${String(id)}`;

export function parseCodexVersion(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/^[^/\s]+\/(\d+(?:\.\d+){1,3}[\w.+-]*)/u)?.[1];
}

export class CodexConnection {
  readonly #process: RuntimeProcess;
  readonly #handlers: ConnectionHandlers;
  readonly #log: (line: string) => void;
  readonly #waiting = new Map<number, Waiting>();
  readonly #open = new Set<string>();
  #next = 1;
  #ended = false;
  platformOs: string | undefined;

  constructor(process: RuntimeProcess, handlers: ConnectionHandlers, log: (line: string) => void) {
    this.#process = process;
    this.#handlers = handlers;
    this.#log = log;
    void this.#read();
  }

  get ended(): boolean { return this.#ended; }

  async #read(): Promise<void> {
    try {
      for await (const line of this.#process.lines()) this.#line(line);
    } catch (error) {
      this.#log(`[WARN] Codex output could not be read: ${redactSecrets((error as Error).message)}`);
    }
    const exit = await this.#process.exited;
    this.#ended = true;
    const detail = exit.stoppedBy === 'limit' ? 'Codex wrote more output than beat allows' : `Codex stopped (exit code ${exit.code ?? 'none'})${exit.stderr ? `: ${exit.stderr.slice(-ERROR_TEXT_LIMIT)}` : ''}`;
    for (const [id, waiting] of this.#waiting) {
      clearTimeout(waiting.timer);
      this.#waiting.delete(id);
      waiting.reject(new CodexRefused('process', `${detail} while waiting for ${waiting.method}`));
    }
    this.#open.clear();
    this.#guard(() => this.#handlers.ended(this, exit));
  }

  #guard(fn: () => void): void {
    try { fn(); } catch (error) { this.#log(`[ERROR] Codex message handler failed: ${redactSecrets((error as Error).message)}`); }
  }

  #line(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { this.#guard(() => this.#handlers.unreadable(this, line)); return; }
    if (!isRecord(message)) { this.#guard(() => this.#handlers.unreadable(this, line)); return; }
    const id = message.id;
    const method = asString(message.method);
    const validId = typeof id === 'number' || typeof id === 'string';
    if (method !== undefined && validId) {
      this.#open.add(keyOf(id));
      this.#guard(() => this.#handlers.serverRequest(this, id, method, message.params));
    } else if (method !== undefined) {
      this.#guard(() => this.#handlers.notification(this, method, message.params));
    } else if (typeof id === 'number' && ('result' in message || 'error' in message)) {
      const waiting = this.#waiting.get(id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.#waiting.delete(id);
      const error = asRecord(message.error);
      if (error) waiting.reject(new CodexRefused('protocol', `Codex rejected ${waiting.method}: ${redactSecrets(asString(error.message) ?? 'no reason given').slice(0, ERROR_TEXT_LIMIT)}`));
      else waiting.resolve(message.result);
    } else this.#guard(() => this.#handlers.unreadable(this, line));
  }

  #send(message: JsonObject): void {
    if (this.#ended || !this.#process.writeLine(JSON.stringify(message))) throw new CodexRefused('process', 'The Codex process is not accepting input');
  }

  request<M extends ClientMethod>(method: M, params: ClientMethods[M]['params'], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.#ended) return Promise.reject(new CodexRefused('process', `The Codex process has ended (${method})`));
    const id = this.#next;
    this.#next += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new CodexRefused('timeout', `Codex did not answer ${method} in time`));
      }, timeoutMs);
      this.#waiting.set(id, { method, resolve, reject, timer });
      try {
        this.#send(params === undefined ? { id, method } : { id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#waiting.delete(id);
        reject(error as Error);
      }
    });
  }

  // 始めのあいさつ。experimentalApi は常に false（型の上でも true を書けない）。返りは Codex の版と OS だけ
  async initialize(timeoutMs?: number): Promise<{ version: string | undefined; platformOs: string | undefined }> {
    const result = asRecord(await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } }, timeoutMs));
    this.#send({ method: 'initialized' });
    this.platformOs = asString(result?.platformOs);
    return { version: parseCodexVersion(asString(result?.userAgent)), platformOs: this.platformOs };
  }

  // 求め（id 付き）への返事。同じ求めに 2 回は返さない（返せなかったら false）
  respond(id: RequestId, result: unknown): boolean {
    if (!this.#open.delete(keyOf(id))) return false;
    this.#send({ id, result: result as JsonObject });
    return true;
  }

  respondError(id: RequestId, code: number, message: string): boolean {
    if (!this.#open.delete(keyOf(id))) return false;
    this.#send({ id, error: { code, message } });
    return true;
  }

  // Codex が自分で片付けた求め（serverRequest/resolved）。もう返事は要らない
  resolved(id: RequestId): void {
    this.#open.delete(keyOf(id));
  }
}
