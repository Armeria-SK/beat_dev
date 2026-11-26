// 外の実行役のプロセスを起こすのは、ここだけ（PLAN.md Approach 3）。
// 決まり: シェルを通さない／実行ファイルは絶対パスに直してから起こす／子の環境は runtimeEnv を通したものだけ／秘密らしい引数は断る／
// 標準出力は 1 行の長さと全体の量に上限／1 回の返事ごとに起こして閉じる（入力を閉じる → 決まった秒数待つ → 残っていれば木ごと止める）／
// Windows はジョブ（src/os/run-job.ts）に入れ、閉じたとき・beat が落ちたときに孫まで止める
import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform, type Readable, type Writable } from 'node:stream';
import { openRunJob, type RunJob } from '../os/run-job.ts';
import { isSensitiveEnvName, redactSecrets } from '../shared/redaction.ts';
import { findExecutable, killTree, scrubEnv } from '../tools/shell/runner.ts';

const WINDOWS = process.platform === 'win32';

// 子に残す実行役の名前は、この 3 つだけ（使う人のログインと設定の置き場、Windows の Bash の場所）
export const KEPT_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDE_CODE_GIT_BASH_PATH'] as const;
const DROPPED_PREFIXES = ['CLAUDE', 'ANTHROPIC_', 'CODEX_', 'OPENAI_'];

const isDroppedPrefix = (name: string): boolean => DROPPED_PREFIXES.some(prefix => name.toUpperCase().startsWith(prefix));
const isSecretName = (name: string): boolean => isSensitiveEnvName(name) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/iu.test(name);

// 4 つの接頭辞で始まる名前は、残す 3 つ以外を全部落とす（scrubEnv の許可の一覧が将来広がっても、実行役の名前は増えない）
export function keepRuntimeNames(env: Record<string, string>): Record<string, string> {
  const keep = new Set<string>(KEPT_ENV);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isDroppedPrefix(name) || keep.has(name.toUpperCase())));
}

// 子の環境。scrubEnv（許可した名前だけ・鍵らしい名前は落とす）に、実行役の名前の絞りを足す。
// dropped は、落とした名前のうち記録に値するもの（鍵らしい名前と、4 つの接頭辞で始まる名前）。名前だけで、値は持たない
// allow は試験のための口（既定は残す 3 つだけ）。広げても、keepRuntimeNames が 3 つ以外の実行役の名前を落とす
export function runtimeEnv(source: NodeJS.ProcessEnv = process.env, allow: readonly string[] = KEPT_ENV): { env: Record<string, string>; dropped: string[] } {
  const env = keepRuntimeNames(scrubEnv(allow, source));
  const dropped = Object.keys(source).filter(name => source[name] !== undefined && !(name in env) && (isDroppedPrefix(name) || isSecretName(name))).sort();
  return { env, dropped };
}

export class ProcessRefused extends Error {
  readonly reason: 'args' | 'relative' | 'not_found' | 'launcher' | 'cwd' | 'aborted' | 'closed' | 'spawn' | 'line';
  constructor(reason: ProcessRefused['reason'], message: string) {
    super(message);
    this.name = 'ProcessRefused';
    this.reason = reason;
  }
}

// 引数に秘密を入れない（コマンドラインは他のプロセスから見える）。1 つずつと、つなげた形（フラグと値が別の引数）の両方で見る。文には引数の中身を入れない
function checkArgs(args: readonly string[]): void {
  const joined = args.join(' ');
  const at = args.findIndex(arg => redactSecrets(arg) !== arg);
  if (at >= 0) throw new ProcessRefused('args', `Argument ${at + 1} looks like a secret. Secrets are not passed on the command line`);
  if (redactSecrets(joined) !== joined) throw new ProcessRefused('args', 'The arguments look like they hold a secret. Secrets are not passed on the command line');
}

const SEPARATOR = /[\\/]/u;

// 名前は PATH から絶対パスに直し、パスは絶対で実在するものだけ。Windows は .exe / .com だけ（.cmd・.bat の入れ物はシェルなしでは起こせず、シェルは通さない）
export function resolveExecutable(file: string, env: Record<string, string>, cwd: string): string {
  let resolved = file;
  if (!SEPARATOR.test(file)) {
    const found = findExecutable(file, env, cwd);
    if (!found) throw new ProcessRefused('not_found', `"${file}" was not found on PATH. Set the full path of the program in the runtime settings`);
    resolved = found;
  } else if (!isAbsolute(file)) {
    throw new ProcessRefused('relative', 'The program path must be an absolute path');
  }
  if (!statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new ProcessRefused('not_found', `The program was not found: ${basename(resolved)}`);
  if (WINDOWS) {
    const extension = extname(resolved).toLowerCase();
    if (extension === '.cmd' || extension === '.bat') throw new ProcessRefused('launcher', `${basename(resolved)} is a ${extension} launcher, which cannot be started without a shell. Set the path of the real .exe in the runtime settings`);
    if (extension !== '.exe' && extension !== '.com') throw new ProcessRefused('launcher', `${basename(resolved)} is not a .exe program`);
  }
  return resolved;
}

export interface Limits {
  // 1 行（改行から改行まで）の最大のバイト数
  lineBytes: number;
  // 1 つのプロセスの標準出力の合計の最大のバイト数
  totalBytes: number;
}

const DEFAULT_LIMITS: Limits = { lineBytes: 8 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
const DEFAULT_GRACE_MS = 5000;
const STDERR_TAIL = 8 * 1024;

// 上限を超えたら、そこで流れを終える（例外にしない）。超えた行より前の完全な行までは通す。止めるのは onLimit の側
function capOutput(limits: Limits, onLimit: (which: 'line' | 'total') => void): Transform {
  let line = 0;
  let total = 0;
  let stopped = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (stopped) { done(); return; }
      total += chunk.length;
      let over: 'line' | 'total' | undefined = total > limits.totalBytes ? 'total' : undefined;
      let passed = chunk.length;
      if (!over) {
        let from = 0;
        while (from < chunk.length) {
          const newline = chunk.indexOf(10, from);
          line += (newline === -1 ? chunk.length : newline) - from;
          if (line > limits.lineBytes) { over = 'line'; passed = from; break; }
          if (newline === -1) break;
          line = 0;
          from = newline + 1;
        }
      } else passed = 0;
      if (!over) { done(null, chunk); return; }
      stopped = true;
      if (passed > 0) this.push(chunk.subarray(0, passed));
      this.push(null);
      onLimit(over);
      done();
    },
  });
}

export interface SpawnSpec {
  file: string;
  args?: readonly string[];
  cwd: string;
  // 子の環境の元。無ければ process.env。どちらも runtimeEnv を通す
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// 実行の記録に残す、起こしたものの控え。引数は伏せたもの、環境は名前だけ
export interface LaunchRecord {
  executable: string;
  args: string[];
  cwd: string;
  droppedEnv: string[];
  keptEnv: string[];
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  stoppedBy?: 'abort' | 'grace' | 'limit' | 'killed';
  limit?: 'line' | 'total';
  error?: string;
  // 標準エラーの終わりの部分（伏せたもの）
  stderr: string;
}

export interface RuntimeProcess {
  readonly pid: number | undefined;
  readonly record: LaunchRecord;
  // 上限つきの標準出力
  readonly stdout: Readable;
  readonly exited: Promise<ExitInfo>;
  // ジョブに入れられなかった理由（入れられていれば無い）。入れられないと、孫は止められない
  readonly containReason: string | undefined;
  lines(): AsyncIterable<string>;
  writeLine(line: string): boolean;
  closeInput(): void;
  // 入力を閉じる → 決まった秒数待つ → 残っていれば木ごと止める
  stop(): Promise<ExitInfo>;
  // すぐ木ごと止める
  kill(): void;
}

class ManagedProcess implements RuntimeProcess {
  readonly child: ChildProcess;
  readonly record: LaunchRecord;
  readonly stdout: Transform;
  readonly exited: Promise<ExitInfo>;
  containReason: string | undefined;
  #stoppedBy: ExitInfo['stoppedBy'];
  #limit: ExitInfo['limit'];
  #stderr = '';
  readonly #graceMs: number;

  constructor(child: ChildProcess, record: LaunchRecord, options: { graceMs: number; limits: Limits; signal: AbortSignal | undefined }) {
    this.child = child;
    this.record = record;
    this.#graceMs = options.graceMs;
    this.stdout = capOutput(options.limits, which => { this.#limit = which; this.kill('limit'); });
    child.stdout?.on('error', () => undefined);
    child.stdout?.pipe(this.stdout);
    child.stdin?.on('error', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-STDERR_TAIL); });
    const signal = options.signal;
    const onAbort = (): void => this.kill('abort');
    signal?.addEventListener('abort', onAbort, { once: true });
    this.exited = new Promise<ExitInfo>(resolve => {
      let done = false;
      const finish = (info: Pick<ExitInfo, 'code' | 'signal'> & { error?: string }): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        resolve({
          code: info.code, signal: info.signal, stderr: redactSecrets(this.#stderr),
          ...(this.#stoppedBy ? { stoppedBy: this.#stoppedBy } : {}), ...(this.#limit ? { limit: this.#limit } : {}),
          ...(info.error !== undefined ? { error: redactSecrets(info.error) } : {}),
        });
      };
      child.once('exit', (code, signalName) => finish({ code, signal: signalName }));
      child.once('error', error => finish({ code: null, signal: null, error: error.message }));
    });
  }

  get pid(): number | undefined { return this.child.pid; }
  get killed(): boolean { return this.#stoppedBy !== undefined; }

  lines(): AsyncIterable<string> {
    const stdout = this.stdout;
    return (async function* () {
      const reader = createInterface({ input: stdout, crlfDelay: Infinity });
      try { for await (const line of reader) yield line; } finally { reader.close(); }
    })();
  }

  // 1 行 1 メッセージ。改行を含む文字列は、別のメッセージ（承認の返事など）を作れてしまうので書かない
  writeLine(line: string): boolean {
    if (/[\r\n]/u.test(line)) throw new ProcessRefused('line', 'A line written to a runtime cannot contain a line break');
    const stdin = this.child.stdin;
    return stdin !== null && stdin.writable ? stdin.write(`${line}\n`) : false;
  }

  closeInput(): void {
    const stdin = this.child.stdin;
    if (stdin && !stdin.destroyed && stdin.writable) stdin.end();
  }

  kill(by: 'abort' | 'grace' | 'limit' | 'killed' = 'killed'): void {
    this.#stoppedBy ??= by;
    killTree(this.child);
  }

  async stop(): Promise<ExitInfo> {
    this.closeInput();
    let timer: NodeJS.Timeout | undefined;
    const exitedInTime = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), this.#graceMs); }),
    ]);
    clearTimeout(timer);
    if (!exitedInTime) this.kill('grace');
    return this.exited;
  }
}

// SDK（@anthropic-ai/claude-agent-sdk）の spawnClaudeCodeProcess に渡す形。SDK の部品そのものは AR-5 で入れる（この形が SDK の型に合うかは、そのとき確かめる）
export interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export interface SdkSpawnedProcess {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
}

export interface ProcessManagerOptions {
  graceMs?: number;
  limits?: Partial<Limits>;
  log?: (line: string) => void;
  // 子の環境の元（既定は process.env）
  env?: NodeJS.ProcessEnv;
  openJob?: () => Promise<RunJob | { failed: string }>;
}

// 1 回の返事の入れ物。起こしたプロセスと、Windows のジョブ（孫まで止めるため）を持つ
export class ProcessScope {
  readonly #options: ProcessManagerOptions;
  readonly #job: RunJob | undefined;
  readonly #processes: ManagedProcess[] = [];
  readonly containReason: string | undefined;
  #finishing: Promise<ExitInfo[]> | undefined;
  #closed = false;

  readonly #onDone: () => void;

  constructor(options: ProcessManagerOptions, job: RunJob | undefined, containReason: string | undefined, onDone: () => void) {
    this.#options = options;
    this.#job = job;
    this.containReason = containReason;
    this.#onDone = onDone;
  }

  // 同期で返す（SDK の spawnClaudeCodeProcess は同期）。入れ物のジョブは open() で先に作ってある
  spawn(spec: SpawnSpec): RuntimeProcess {
    if (this.#closed) throw new ProcessRefused('closed', 'The process scope is already closed');
    if (spec.signal?.aborted) throw new ProcessRefused('aborted', 'The process was stopped before it started');
    // 作業フォルダは必ず呼ぶ側が絶対パスで決める。既定（beat 自身のフォルダ）に倒れない
    if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd)) throw new ProcessRefused('cwd', 'The working folder must be given as an absolute path');
    const { env, dropped } = runtimeEnv(spec.env ?? this.#options.env ?? process.env);
    const args = [...(spec.args ?? [])];
    checkArgs(args);
    const file = resolveExecutable(spec.file, env, spec.cwd);
    if (!statSync(spec.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new ProcessRefused('cwd', 'The working folder does not exist');
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: spec.cwd, env, shell: false, windowsHide: true, detached: !WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      throw new ProcessRefused('spawn', redactSecrets((error as Error).message));
    }
    const record: LaunchRecord = { executable: file, args: args.map(arg => redactSecrets(arg)), cwd: spec.cwd, droppedEnv: dropped, keptEnv: KEPT_ENV.filter(name => name in env) };
    const managed = new ManagedProcess(child, record, {
      graceMs: this.#options.graceMs ?? DEFAULT_GRACE_MS,
      limits: { ...DEFAULT_LIMITS, ...this.#options.limits },
      signal: spec.signal,
    });
    managed.containReason = this.containReason;
    this.#processes.push(managed);
    if (this.#job) {
      this.#job.add(child, reason => {
        managed.containReason ??= reason;
        this.#options.log?.(`[WARN] runtime process ${managed.pid ?? '?'} is not in the job (${reason}); its child processes may stay running`);
      });
    }
    this.#options.log?.(`[INFO] runtime process started: ${basename(file)} pid=${child.pid ?? '?'}${dropped.length ? `; env names dropped: ${dropped.join(', ')}` : ''}`);
    return managed;
  }

  spawnForSdk(options: SdkSpawnOptions): SdkSpawnedProcess {
    // SDK は cwd を省けるが、省いた子が beat 自身のフォルダで動かないよう、省いた起動は断る
    if (options.cwd === undefined) throw new ProcessRefused('cwd', 'The SDK did not give a working folder, so the runtime was not started');
    const managed = this.spawn({ file: options.command, args: options.args, cwd: options.cwd, env: options.env, signal: options.signal }) as ManagedProcess;
    const child = managed.child;
    const listen = (method: 'on' | 'once' | 'off') => (event: 'exit' | 'error', listener: (...args: never[]) => void): void => {
      (child[method] as (name: string, handler: (...args: unknown[]) => void) => ChildProcess).call(child, event, listener as (...args: unknown[]) => void);
    };
    return {
      stdin: child.stdin as Writable,
      stdout: managed.stdout,
      get killed() { return managed.killed; },
      get exitCode() { return child.exitCode; },
      kill: () => { managed.kill('killed'); return true; },
      on: listen('on'), once: listen('once'), off: listen('off'),
    };
  }

  // 返事の終わり: どのプロセスも、入力を閉じる → 待つ → 残っていれば木ごと止める。そのあとジョブを閉じ、残った孫も止める
  finish(): Promise<ExitInfo[]> {
    this.#closed = true;
    this.#finishing ??= (async () => {
      const exits = await Promise.all(this.#processes.map(process => process.stop()));
      await this.#job?.close();
      this.#onDone();
      return exits;
    })();
    return this.#finishing;
  }

  // すぐ全部止める（beat が止まるとき・実行を中断するとき）
  async abort(): Promise<void> {
    this.#closed = true;
    for (const process of this.#processes) process.kill('killed');
    await Promise.all(this.#processes.map(process => process.exited));
    await this.#job?.close();
    this.#onDone();
  }
}

export class ProcessManager {
  readonly #options: ProcessManagerOptions;
  readonly #scopes = new Set<ProcessScope>();

  constructor(options: ProcessManagerOptions = {}) { this.#options = options; }

  // ジョブを先に作る（Windows で 0.4 秒ほど）。作れなければ、孫を止められないと記録して続ける
  async open(): Promise<ProcessScope> {
    const opened = await (this.#options.openJob ?? openRunJob)().catch((error: unknown) => ({ failed: (error as Error).message }));
    const failed = 'failed' in opened ? redactSecrets(opened.failed) : undefined;
    if (failed !== undefined) this.#options.log?.(`[WARN] runtime process job could not be made (${failed}); child processes of a runtime may stay running`);
    const scope: ProcessScope = new ProcessScope(this.#options, 'failed' in opened ? undefined : opened, failed, () => { this.#scopes.delete(scope); });
    this.#scopes.add(scope);
    return scope;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#scopes].map(scope => scope.abort()));
  }
}
