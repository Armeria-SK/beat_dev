import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { openRunJob, type RunJob } from '../../os/run-job.ts';
import { isSensitiveName, redactSecrets } from '../../shared/redaction.ts';
import { OutputRing } from './ring.ts';
import { killTree, stopTree } from './runner.ts';

const WINDOWS = process.platform === 'win32';

export const BACKGROUND_LIMITS = {
  perConversation: 4,
  total: 8,
  ringBytes: 256 * 1024,
  logBytes: 50 * 1024 * 1024,
  keepPerConversation: 8,
  keepTotal: 32,
  stoppedPorts: 64,
  partialLineBytes: 4096,
  keyHoldBytes: 64 * 1024,
  stopWaitMs: 5000,
  termGraceMs: 5000,
};

const FLUSH_DELAY_MS = 50;
const FLUSH_NOW_CHARS = 64 * 1024;
const MERGE_BELOW_BYTES = 4096;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const LOG_NAME = /^bg-[A-Za-z0-9_-]{1,128}-\d+-[0-9a-f]{8}\.log$/u;

// 前の起動が残した bg-*.log を消す。この起動が始まってからできた・書かれた分は、この起動の裏のコマンドのものなので残す（同じデータのフォルダを使う beat は、錠で 1 つだけ）
function sweepOldLogs(dir: string): void {
  const launchedAt = Date.now() - process.uptime() * 1000;
  try {
    for (const name of readdirSync(dir)) {
      if (!LOG_NAME.test(name)) continue;
      const file = join(dir, name);
      try { if (statSync(file).mtimeMs < launchedAt) unlinkSync(file); } catch { /* 開いている・すでに無い: 次の起動が消す */ }
    }
  } catch { /* フォルダがまだ無い */ }
}

export type BackgroundLimits = typeof BACKGROUND_LIMITS;
export type JobState = 'running' | 'exited' | 'stopped';
export type StopBy = 'model' | 'owner' | 'system';

export interface JobOwner {
  conversationId: string;
  projectId: string;
  taskId?: string;
}

export interface StartInput extends JobOwner {
  command: string;
  cwd: string;
  file: string;
  args: readonly string[];
  env: Record<string, string>;
  stdin?: string;
  fetched: boolean;
  tainted?: boolean;
  onExit?: () => void;
}

export interface JobView extends JobOwner {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  exitCode: number | null;
  stoppedBy?: StopBy;
  orphaned: boolean;
  unread: boolean;
  fetched: boolean;
  tainted?: boolean;
  spawnError?: string;
  contained?: false;
  containReason?: string;
  logPath: string;
  logCut: boolean;
}

export type StartResult =
  | { id: string }
  | { refused: 'conversation_limit' | 'total_limit'; running: JobView[]; elsewhere: number }
  | { refused: 'closed' };

export interface OutputSlice {
  text: string;
  next: number;
  skipped: number;
}

export type JobRead = JobView & OutputSlice;
export type WaitResult = 'done' | 'timeout' | 'aborted';
export type JobFilter = { conversationId: string } | { projectId: string } | { taskId: string };

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b\n]*(?:\u001b\\)?|\u001b[ -/]*[0-~]|\u009b[0-?]*[ -/]*[@-~]/gu;
const KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;
const PEM_BODY_LINE = /^[A-Za-z0-9+/=]+$/u;
const PEM_HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]/u;
const OPEN_ASSIGNMENT = /(?<![A-Za-z0-9_-])["']?([A-Za-z_][A-Za-z0-9_-]*)["']?[ \t]*[:=][ \t]*\r?$/u;
const SENSITIVE_TAIL = /(?:(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1[ \t]*[:=][ \t]*["']?|(?<![A-Za-z0-9_-])(?:Bearer|Basic|Token)[ \t]+["']?|(?<![A-Za-z0-9_-])--?([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+|=)["']?)[ \t]*$/iu;
const LEAD_TOKEN = /^[^\s,;"'<>(){}[\]]+/u;
const REDACTED = '[REDACTED]';

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function cleanOutput(text: string): string {
  return redactSecrets(stripAnsi(text));
}

function lastSeparator(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x2c) return i;
  }
  return -1;
}

function sensitiveTailStart(text: string): number {
  const match = SENSITIVE_TAIL.exec(text);
  if (!match) return -1;
  if (match[2] !== undefined && !isSensitiveName(match[2])) return -1;
  if (match[3] !== undefined && !isSensitiveName(match[3])) return -1;
  return match.index;
}

type KeyExtent = { kind: 'closed' | 'stopped'; at: number } | { kind: 'open'; at: number; sawBody: boolean };

function keyExtent(buf: string, from: number, final: boolean, sawBody: boolean): KeyExtent {
  let seen = sawBody;
  for (let pos = from; ;) {
    if (pos >= buf.length) return final ? { kind: 'stopped', at: buf.length } : { kind: 'open', at: pos, sawBody: seen };
    const nl = buf.indexOf('\n', pos);
    const line = buf.slice(pos, nl < 0 ? buf.length : nl);
    const end = KEY_END.exec(line);
    if (end) return { kind: 'closed', at: pos + end.index + end[0].length };
    const trimmed = line.trim();
    if (nl < 0 && !final) {
      const maybe = trimmed === '' || PEM_BODY_LINE.test(trimmed) || trimmed.startsWith('-') || (!seen && (PEM_HEADER_LINE.test(trimmed) || /^[A-Za-z][A-Za-z0-9-]*:?$/u.test(trimmed)));
      return maybe ? { kind: 'open', at: pos, sawBody: seen } : { kind: 'stopped', at: pos };
    }
    if (trimmed === '') { if (seen) return { kind: 'stopped', at: pos }; }
    else if (PEM_BODY_LINE.test(trimmed)) seen = true;
    else if (seen || !PEM_HEADER_LINE.test(trimmed)) return { kind: 'stopped', at: pos };
    if (nl < 0) return { kind: 'stopped', at: buf.length };
    pos = nl + 1;
  }
}

export interface GateUnit {
  text: string;
  continues: boolean;
}

export class LineGate {
  #pending = '';
  #inKey = false;
  #sawBody = false;
  #midLine = false;
  #redactLead = false;
  readonly #partialLineBytes: number;
  readonly #keyHoldBytes: number;

  constructor(partialLineBytes = BACKGROUND_LIMITS.partialLineBytes, keyHoldBytes = BACKGROUND_LIMITS.keyHoldBytes) {
    this.#partialLineBytes = partialLineBytes;
    this.#keyHoldBytes = keyHoldBytes;
  }

  get held(): number {
    return this.#pending.length;
  }

  push(text: string, final = false): GateUnit[] {
    const out: GateUnit[] = [];
    let buf = this.#pending + text;
    this.#pending = '';
    for (;;) {
      if (this.#inKey) {
        const ext = keyExtent(buf, 0, final, this.#sawBody);
        if (ext.kind === 'open') {
          this.#sawBody = ext.sawBody;
          const tail = buf.slice(ext.at);
          this.#pending = tail.length > 256 ? tail.slice(-256) : tail;
          return out;
        }
        this.#inKey = false;
        buf = ext.kind === 'closed' ? buf.slice(ext.at).replace(/^[ \t]*\r?\n/u, '') : buf.slice(ext.at);
        continue;
      }
      const begin = KEY_BEGIN.exec(buf)?.index ?? -1;
      if (begin >= 0) {
        const lineEnd = buf.indexOf('\n', begin);
        const ext: KeyExtent = lineEnd >= 0 ? keyExtent(buf, lineEnd + 1, final, false)
          : final ? { kind: 'stopped', at: buf.length } : { kind: 'open', at: buf.length, sawBody: false };
        if (ext.kind !== 'open') {
          this.#emit(out, `${buf.slice(0, begin)}${REDACTED}${ext.kind === 'stopped' ? '\n' : ''}`);
          buf = buf.slice(ext.at);
          continue;
        }
        const lineAt = buf.lastIndexOf('\n', begin - 1) + 1;
        if (buf.length - lineAt > this.#keyHoldBytes) {
          this.#emit(out, `${buf.slice(0, begin)}${REDACTED}\n`);
          this.#inKey = true;
          this.#sawBody = ext.sawBody;
          buf = lineEnd >= 0 ? buf.slice(lineEnd + 1) : '';
          continue;
        }
        if (lineAt > 0) this.#emit(out, buf.slice(0, lineAt));
        this.#pending = buf.slice(lineAt);
        return out;
      }
      let cut = final ? buf.length : buf.lastIndexOf('\n') + 1;
      if (!final && cut > 0) {
        const lineAt = buf.lastIndexOf('\n', cut - 2) + 1;
        const head = OPEN_ASSIGNMENT.exec(stripAnsi(buf.slice(lineAt, cut - 1)));
        if (head && isSensitiveName(head[1]!) && buf.length - lineAt <= this.#keyHoldBytes) cut = lineAt;
      }
      let lead = false;
      if (!final && buf.length - cut > this.#partialLineBytes) {
        const tail = buf.slice(cut);
        const at = lastSeparator(tail);
        let end = tail.length;
        lead = true;
        if (at > 0) {
          const head = sensitiveTailStart(tail.slice(0, at + 1));
          end = head < 0 ? at + 1 : head;
          lead = false;
          if (end === 0 && tail.length > this.#keyHoldBytes) { end = tail.length; lead = true; }
        }
        cut += end;
      }
      if (cut > 0) this.#emit(out, buf.slice(0, cut));
      if (lead) this.#redactLead = true;
      this.#pending = buf.slice(cut);
      return out;
    }
  }

  #emit(out: GateUnit[], text: string): void {
    let raw = text;
    if (this.#redactLead) {
      raw = raw.replace(LEAD_TOKEN, REDACTED);
      this.#redactLead = false;
    }
    out.push({ text: cleanOutput(raw), continues: this.#midLine });
    this.#midLine = !text.endsWith('\n');
  }
}

export function readOutput(ring: OutputRing, from: number): OutputSlice {
  const want = Number.isFinite(from) && from > 0 ? Math.floor(from) : 0;
  const start = Math.min(Math.max(want, ring.earliest), ring.total);
  let skipped = want < ring.earliest ? ring.earliest - want : 0;
  const read = ring.readFrom(start);
  const first = read.chunks[0];
  const firstAt = first?.at ?? start;
  const joined = Buffer.concat(read.chunks.map(chunk => Buffer.from(chunk.text, 'utf8')));
  let offset = Math.max(0, start - firstAt);
  const atLine = offset > 0 ? joined[offset - 1] === 0x0a
    : want < ring.earliest ? first === undefined || (first.gapBefore === undefined && first.continues === undefined)
      : true;
  if (!atLine) {
    const nl = joined.indexOf(0x0a, offset);
    const to = nl < 0 ? joined.length : nl + 1;
    skipped += to - offset;
    offset = to;
  }
  return { text: joined.subarray(offset).toString('utf8'), next: ring.total, skipped };
}

interface Deferred { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// GUI を開く道具は beat の外に窓を出さない（Vite・Create React App は BROWSER=none でブラウザを開かない）。開いた窓はコマンドと一緒に止まるので
function backgroundEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== 'BROWSER') out[key] = value;
  out.BROWSER = 'none';
  return out;
}

function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<void>(r => { timer = setTimeout(r, ms); })]).finally(() => clearTimeout(timer));
}

type Channel = 'stdout' | 'stderr';
const CHANNELS: readonly Channel[] = ['stdout', 'stderr'];

interface Job extends JobOwner {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  state: JobState;
  exitCode: number | null;
  stoppedBy?: StopBy;
  orphaned: boolean;
  fetched: boolean;
  tainted?: boolean;
  spawnError?: string;
  child: ChildProcess | undefined;
  runJob: RunJob | undefined;
  jobClosing: boolean;
  containReason?: string;
  ring: OutputRing;
  decoders: Record<Channel, StringDecoder>;
  gates: Record<Channel, LineGate>;
  incoming: Record<Channel, string>;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  cursor: number;
  log: WriteStream | undefined;
  logOpened: boolean;
  logQueue: Buffer[];
  logPath: string;
  logBytes: number;
  logCut: boolean;
  rootExited: boolean;
  rootExit: Deferred;
  done: Deferred;
  halting?: Promise<void>;
  finishedOrder: number;
  onExit: (() => void) | undefined;
  // 出力に出たループバックの URL のポート（ブラウザの「その実行の開発サーバー」。9-1b の R-8）
  ports: Set<number>;
}

const LOOPBACK_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\b/giu;
const PORTS_PER_JOB = 16;

export interface StoppedPort { port: number; jobId: string; stoppedBy?: StopBy }

export interface BackgroundOptions {
  logDir: string;
  now?: () => number;
  limits?: Partial<BackgroundLimits>;
  isOpen?: (owner: JobOwner) => boolean;
  openJob?: () => Promise<RunJob | { failed: string }>;
}

export class BackgroundJobs {
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Set<(view: JobView) => void>();
  readonly #limits: BackgroundLimits;
  readonly #logDir: string;
  readonly #now: () => number;
  readonly #isOpen: (owner: JobOwner) => boolean;
  readonly #openJob: () => Promise<RunJob | { failed: string }>;
  readonly #instance = randomBytes(4).toString('hex');
  // 止まった・自分で終わった裏のコマンドが出力に出したポート（掃除 #prune のあとも残す。古いものから上限で消す）
  readonly #stoppedPorts = new Map<string, StoppedPort & { conversationId: string; taskId: string | undefined }>();
  #seq = 0;
  #finished = 0;
  #closed = false;

  constructor(options: BackgroundOptions) {
    this.#logDir = options.logDir;
    sweepOldLogs(this.#logDir);
    this.#now = options.now ?? Date.now;
    this.#limits = { ...BACKGROUND_LIMITS, ...options.limits };
    this.#isOpen = options.isOpen ?? (() => true);
    this.#openJob = options.openJob ?? openRunJob;
  }

  start(input: StartInput): StartResult {
    if (!CONVERSATION_ID.test(input.conversationId)) throw new Error(`Invalid conversation id for a background command: ${JSON.stringify(input.conversationId)}`);
    const owner: JobOwner = { conversationId: input.conversationId, projectId: input.projectId, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) };
    if (this.#closed || !this.#isOpen(owner)) return { refused: 'closed' };
    const running = [...this.#jobs.values()].filter(job => job.state === 'running');
    const mine = running.filter(job => job.conversationId === input.conversationId);
    const refused = mine.length >= this.#limits.perConversation ? 'conversation_limit' : running.length >= this.#limits.total ? 'total_limit' : undefined;
    if (refused) return { refused, running: mine.map(job => this.#view(job)), elsewhere: running.length - mine.length };

    const seq = ++this.#seq;
    const gate = () => new LineGate(this.#limits.partialLineBytes, this.#limits.keyHoldBytes);
    const job: Job = {
      ...owner, id: `bg-${seq}`, command: redactSecrets(input.command), cwd: input.cwd, startedAt: this.#now(), state: 'running', exitCode: null, orphaned: false,
      fetched: input.fetched, ...(input.tainted ? { tainted: true } : {}), child: undefined, runJob: undefined, jobClosing: false, ring: new OutputRing(),
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }, gates: { stdout: gate(), stderr: gate() },
      incoming: { stdout: '', stderr: '' }, flushTimer: undefined, cursor: 0,
      log: undefined, logOpened: false, logQueue: [], logPath: join(this.#logDir, `bg-${input.conversationId}-${seq}-${this.#instance}.log`), logBytes: 0, logCut: false,
      rootExited: false, rootExit: deferred(), done: deferred(), finishedOrder: 0, onExit: input.onExit, ports: new Set(),
    };
    this.#jobs.set(job.id, job);
    try {
      mkdirSync(this.#logDir, { recursive: true });
      const log = createWriteStream(job.logPath, { flags: 'wx' });
      log.on('open', () => { job.logOpened = true; });
      log.on('error', () => { if (job.log === log) job.log = undefined; });
      job.log = log;
    } catch { job.log = undefined; }
    const opening = this.#openJob().catch((error: unknown) => ({ failed: (error as Error).message }));
    if (WINDOWS) {
      void opening.then(made => {
        const runJob = 'failed' in made ? undefined : made;
        if (job.state !== 'running') { void runJob?.close(); return; }
        if ('failed' in made) this.#uncontained(job, made.failed);
        else this.#attach(job, made);
        this.#spawn(job, input);
      });
      this.#emit(job);
      return { id: job.id };
    }
    if (!this.#spawn(job, input)) return { id: job.id };
    void opening.then(made => {
      if ('failed' in made) { this.#uncontained(job, made.failed); return; }
      this.#attach(job, made);
      if (job.child) made.add(job.child, reason => this.#uncontained(job, reason));
      if (job.state !== 'running') void this.#closeJob(job);
    });
    this.#emit(job);
    return { id: job.id };
  }

  #spawn(job: Job, input: StartInput): boolean {
    try {
      job.child = spawn(input.file, [...input.args], {
        cwd: input.cwd, env: backgroundEnv(input.env), windowsHide: true, detached: !WINDOWS, shell: false,
        stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      job.spawnError = redactSecrets((error as Error).message);
      this.#finish(job);
      return false;
    }
    const child = job.child;
    job.runJob?.add(child, reason => this.#uncontained(job, reason));
    child.stdout?.on('data', (chunk: Buffer) => this.#data(job, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.#data(job, 'stderr', chunk));
    if (input.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input.stdin);
    }
    child.on('error', error => {
      job.spawnError ??= redactSecrets(error.message);
      if (child.pid === undefined) this.#finish(job);
    });
    child.on('exit', code => {
      job.exitCode = code;
      job.rootExited = true;
      job.rootExit.resolve();
    });
    child.on('close', code => {
      if (code !== null) job.exitCode = code;
      this.#finish(job);
    });
    return true;
  }

  get(id: string): JobView | undefined {
    const job = this.#jobs.get(id);
    return job ? this.#view(job) : undefined;
  }

  list(filter: { conversationId?: string; projectId?: string } = {}): JobView[] {
    return [...this.#jobs.values()]
      .filter(job => (filter.conversationId === undefined || job.conversationId === filter.conversationId) && (filter.projectId === undefined || job.projectId === filter.projectId))
      .map(job => this.#view(job));
  }

  // 動いている裏のコマンドのうち、この会話かこのタスクが始めたものが出力に出したループバックの URL のポート
  printedPorts(owner: { conversationId: string; taskId?: string | undefined }): Set<number> {
    const out = new Set<number>();
    for (const job of this.#jobs.values()) {
      if (job.state !== 'running') continue;
      if (job.conversationId !== owner.conversationId && (owner.taskId === undefined || job.taskId !== owner.taskId)) continue;
      this.#flush(job);
      for (const port of job.ports) out.add(port);
    }
    return out;
  }

  // そのポートで待ち受けているプロセスが全部、この会話かこのタスクの動いている裏のコマンドのジョブの中のものか（browser-rethink P7: 暗証番号の欄に入れてよい「beat が自分で起動して、いま動いている」開発サーバー）。
  // 出力に出たポート（printedPorts）や持ち主が書いたポートは証拠にしない。Windows のジョブの中のプロセスだけが証拠で、ジョブに入れられなかったコマンド・止まっていくコマンド・分からない（unknown）・Windows 以外は false
  async ownsPort(owner: { conversationId: string; taskId?: string | undefined }, port: number): Promise<boolean> {
    if (!WINDOWS) return false;
    const mine = [...this.#jobs.values()].filter(job => job.state === 'running' && (job.conversationId === owner.conversationId || (owner.taskId !== undefined && job.taskId === owner.taskId)));
    for (const job of mine) {
      const runJob = job.runJob;
      if (runJob === undefined || job.jobClosing || job.containReason !== undefined) continue;
      const answer = await runJob.listens(port).catch((): 'unknown' => 'unknown');
      // 聞いているあいだに止まった・入れ物を失ったなら、その答えは使わない
      if (answer === 'yes' && job.state === 'running' && !job.jobClosing && job.containReason === undefined) return true;
    }
    return false;
  }

  // この会話かこのタスクが始めて、もう動いていない裏のコマンドが出したポート（いちばん新しく止まったもの）
  stoppedPort(owner: { conversationId: string; taskId?: string | undefined }, port: number): StoppedPort | undefined {
    let found: StoppedPort | undefined;
    for (const entry of this.#stoppedPorts.values()) {
      if (entry.port !== port) continue;
      if (entry.conversationId !== owner.conversationId && (owner.taskId === undefined || entry.taskId !== owner.taskId)) continue;
      found = { port: entry.port, jobId: entry.jobId, ...(entry.stoppedBy ? { stoppedBy: entry.stoppedBy } : {}) };
    }
    return found;
  }

  read(id: string, conversationId: string, from?: number): JobRead | undefined {
    const job = this.#owned(id, conversationId);
    if (!job) return undefined;
    this.#flush(job);
    const slice = readOutput(job.ring, from ?? job.cursor);
    job.cursor = slice.next;
    return { ...this.#view(job), ...slice };
  }

  peek(id: string, from: number): JobRead | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    this.#flush(job);
    return { ...this.#view(job), ...readOutput(job.ring, from) };
  }

  async wait(id: string, conversationId: string, sec: number, signal: AbortSignal): Promise<WaitResult | undefined> {
    const job = this.#owned(id, conversationId);
    if (!job) return undefined;
    if (job.state !== 'running') return 'done';
    if (signal.aborted) return 'aborted';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        job.done.promise.then(() => 'done' as const),
        new Promise<WaitResult>(r => { timer = setTimeout(() => r('timeout'), Math.max(0, sec) * 1000); }),
        new Promise<WaitResult>(r => { onAbort = () => r('aborted'); signal.addEventListener('abort', onAbort, { once: true }); }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  stop(id: string, by: 'model', conversationId: string): Promise<JobView | undefined>;
  stop(id: string, by: 'owner' | 'system'): Promise<JobView | undefined>;
  async stop(id: string, by: StopBy, conversationId?: string): Promise<JobView | undefined> {
    const job = by === 'owner' || by === 'system' ? this.#jobs.get(id) : this.#owned(id, conversationId ?? '');
    if (!job) return undefined;
    await this.#halt(job, by);
    return this.#view(job);
  }

  async stopWhere(filter: JobFilter): Promise<number> {
    const matches = [...this.#jobs.values()].filter(job => job.state === 'running' && (
      'conversationId' in filter ? job.conversationId === filter.conversationId
        : 'projectId' in filter ? job.projectId === filter.projectId
          : job.taskId === filter.taskId));
    await Promise.all(matches.map(job => this.#halt(job, 'system')));
    return matches.length;
  }

  forget(id: string, conversationId: string): boolean {
    const job = this.#owned(id, conversationId);
    if (!job || job.state === 'running') return false;
    this.#jobs.delete(id);
    this.#removeLog(job);
    return true;
  }

  closeAll(): void {
    this.#closed = true;
    for (const job of [...this.#jobs.values()]) {
      if (job.state !== 'running') continue;
      if (!job.rootExited) job.stoppedBy = 'system';
      if (job.child) {
        killTree(job.child);
        job.child.stdout?.destroy();
        job.child.stderr?.destroy();
      }
      this.#finish(job);
    }
  }

  onChange(listener: (view: JobView) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #owned(id: string, conversationId: string): Job | undefined {
    const job = this.#jobs.get(id);
    return job && job.conversationId === conversationId ? job : undefined;
  }

  #data(job: Job, channel: Channel, chunk: Buffer): void {
    job.logQueue.push(channel === 'stderr' ? Buffer.concat([Buffer.from('[stderr] '), chunk]) : chunk);
    job.incoming[channel] += job.decoders[channel].write(chunk);
    if (job.incoming[channel].length > FLUSH_NOW_CHARS) this.#flush(job);
    else if (job.flushTimer === undefined) {
      job.flushTimer = setTimeout(() => { job.flushTimer = undefined; this.#flush(job); }, FLUSH_DELAY_MS);
      job.flushTimer.unref();
    }
  }

  #flush(job: Job, final = false): void {
    clearTimeout(job.flushTimer);
    job.flushTimer = undefined;
    for (const channel of CHANNELS) {
      const text = job.incoming[channel] + (final ? job.decoders[channel].end() : '');
      job.incoming[channel] = '';
      if (text === '' && !final) continue;
      for (const unit of job.gates[channel].push(text, final)) {
        for (const match of unit.text.matchAll(LOOPBACK_URL)) {
          const port = Number(match[1]);
          if (port > 0 && port < 65536 && job.ports.size < PORTS_PER_JOB) job.ports.add(port);
        }
        job.ring.append(unit.text, { channel, ...(unit.continues ? { continues: true as const } : {}) }, this.#limits.ringBytes, MERGE_BELOW_BYTES);
      }
    }
    this.#writeLog(job);
  }

  #writeLog(job: Job): void {
    if (job.logQueue.length === 0) return;
    const data = Buffer.concat(job.logQueue);
    job.logQueue = [];
    if (!job.log || job.logCut) return;
    const room = this.#limits.logBytes - job.logBytes;
    if (data.length > room) {
      job.logCut = true;
      job.logBytes += Math.max(0, room);
      if (room > 0) job.log.write(data.subarray(0, room));
      job.log.end(`\n[beat] Log stopped at ${this.#limits.logBytes} bytes; later output is kept in memory only.\n`);
      return;
    }
    job.logBytes += data.length;
    job.log.write(data);
  }

  #removeLog(job: Job): void {
    const log = job.log;
    const unlink = () => { if (job.logOpened) { try { unlinkSync(job.logPath); } catch { } } };
    if (log && !log.closed) {
      log.once('close', unlink);
      if (!log.writableEnded) log.end();
    } else unlink();
  }

  #halt(job: Job, by: StopBy): Promise<void> {
    if (job.state !== 'running') return Promise.resolve();
    if (job.halting) return job.halting;
    if (!job.rootExited) job.stoppedBy = by;
    if (!job.child) { this.#finish(job); return Promise.resolve(); }
    stopTree(job.child, this.#limits.termGraceMs);
    job.halting = (async () => {
      await within(job.rootExit.promise, this.#limits.termGraceMs + 1000);
      if (WINDOWS && job.runJob) await within(this.#closeJob(job), this.#limits.stopWaitMs);
      await within(job.done.promise, this.#limits.stopWaitMs);
      if (job.state !== 'running') return;
      if (job.child) {
        killTree(job.child);
        job.child.stdout?.destroy();
        job.child.stderr?.destroy();
      }
      job.orphaned = true;
      this.#finish(job);
    })();
    return job.halting;
  }

  #attach(job: Job, runJob: RunJob): void {
    job.runJob = runJob;
    void runJob.ended.then(() => { if (!job.jobClosing && job.state === 'running') this.#uncontained(job, 'the job helper stopped, which also ends the processes inside the job'); });
  }

  #closeJob(job: Job): Promise<void> {
    job.jobClosing = true;
    return job.runJob?.close() ?? Promise.resolve();
  }

  #uncontained(job: Job, reason: string): void {
    if (job.containReason !== undefined || job.jobClosing) return;
    job.containReason = redactSecrets(reason);
    if (job.state === 'running') this.#emit(job);
  }

  #finish(job: Job): void {
    if (job.state !== 'running') return;
    this.#flush(job, true);
    job.state = job.stoppedBy ? 'stopped' : 'exited';
    job.endedAt = this.#now();
    job.finishedOrder = ++this.#finished;
    this.#rememberPorts(job);
    if (!job.logCut) job.log?.end();
    void this.#closeJob(job);
    job.rootExit.resolve();
    job.done.resolve();
    try { job.onExit?.(); } catch { }
    this.#prune();
    this.#emit(job);
  }

  #rememberPorts(job: Job): void {
    for (const port of job.ports) {
      const key = JSON.stringify([job.conversationId, job.taskId ?? null, port]);
      this.#stoppedPorts.delete(key);
      this.#stoppedPorts.set(key, { port, jobId: job.id, ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}), conversationId: job.conversationId, taskId: job.taskId });
    }
    for (const key of this.#stoppedPorts.keys()) {
      if (this.#stoppedPorts.size <= this.#limits.stoppedPorts) break;
      this.#stoppedPorts.delete(key);
    }
  }

  #prune(): void {
    const finished = [...this.#jobs.values()].filter(job => job.state !== 'running').sort((a, b) => b.finishedOrder - a.finishedOrder);
    const perConversation = new Map<string, number>();
    let kept = 0;
    for (const job of finished) {
      const count = perConversation.get(job.conversationId) ?? 0;
      if (count >= this.#limits.keepPerConversation || kept >= this.#limits.keepTotal) {
        this.#jobs.delete(job.id);
        continue;
      }
      perConversation.set(job.conversationId, count + 1);
      kept += 1;
    }
  }

  #emit(job: Job): void {
    const view = this.#view(job);
    for (const listener of this.#listeners) {
      try { listener(view); } catch { }
    }
  }

  #view(job: Job): JobView {
    if (job.state === 'running') this.#flush(job);
    return {
      id: job.id, conversationId: job.conversationId, projectId: job.projectId, ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
      command: job.command, cwd: job.cwd, startedAt: job.startedAt, ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      state: job.state, exitCode: job.exitCode, ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}), orphaned: job.orphaned,
      unread: job.ring.total > job.cursor, fetched: job.fetched, ...(job.tainted ? { tainted: true } : {}), ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
      ...(job.containReason !== undefined ? { contained: false as const, containReason: job.containReason } : {}),
      logPath: job.logPath, logCut: job.logCut,
    };
  }
}
