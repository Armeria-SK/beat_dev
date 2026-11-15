import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, unlinkSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
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
  partialLineBytes: 4096,
  keyHoldBytes: 64 * 1024,
  stopWaitMs: 5000,
  termGraceMs: 5000,
};

const FLUSH_DELAY_MS = 50;
const FLUSH_NOW_CHARS = 64 * 1024;
const MERGE_BELOW_BYTES = 4096;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

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
  spawnError?: string;
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
const PRIVATE_KEY_MARKER = /-----(BEGIN|END) (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu;
const OPEN_ASSIGNMENT = /(?<![A-Za-z0-9_-])["']?([A-Za-z_][A-Za-z0-9_-]*)["']?[ \t]*[:=][ \t]*\r?$/u;
const REDACTED = '[REDACTED]';

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function cleanOutput(text: string): string {
  return redactSecrets(stripAnsi(text));
}

function openKeyAt(text: string): number {
  let open = -1;
  for (const match of text.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'BEGIN') { if (open < 0) open = match.index; } else open = -1;
  }
  return open;
}

function keyEndAfter(text: string): number {
  for (const match of text.matchAll(PRIVATE_KEY_MARKER)) {
    if (match[1] === 'END') return match.index + match[0].length;
  }
  return -1;
}

function lastSeparator(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x2c) return i;
  }
  return -1;
}

export interface GateUnit {
  text: string;
  continues: boolean;
}

export class LineGate {
  #pending = '';
  #inKey = false;
  #midLine = false;
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
        const end = keyEndAfter(buf);
        if (end < 0) {
          const tail = final ? '' : buf.slice(buf.lastIndexOf('\n') + 1);
          this.#pending = tail.length > 256 ? tail.slice(-256) : tail;
          return out;
        }
        buf = buf.slice(end);
        this.#inKey = false;
        continue;
      }
      let cut = final ? buf.length : buf.lastIndexOf('\n') + 1;
      const begin = final ? -1 : openKeyAt(buf);
      if (begin >= 0) {
        const lineAt = buf.lastIndexOf('\n', begin - 1) + 1;
        if (buf.length - lineAt > this.#keyHoldBytes) {
          this.#emit(out, `${buf.slice(0, begin)}${REDACTED}`);
          this.#inKey = true;
          buf = buf.slice(begin + 1);
          continue;
        }
        cut = Math.min(cut, lineAt);
      } else if (!final && cut > 0) {
        const lineAt = buf.lastIndexOf('\n', cut - 2) + 1;
        const head = OPEN_ASSIGNMENT.exec(stripAnsi(buf.slice(lineAt, cut - 1)));
        if (head && isSensitiveName(head[1]!) && buf.length - lineAt <= this.#keyHoldBytes) cut = lineAt;
      }
      if (!final && begin < 0 && buf.length - cut > this.#partialLineBytes) {
        const tail = buf.slice(cut);
        const at = lastSeparator(tail);
        cut += at > 0 ? at + 1 : tail.length;
      }
      if (cut > 0) this.#emit(out, buf.slice(0, cut));
      this.#pending = buf.slice(cut);
      return out;
    }
  }

  #emit(out: GateUnit[], text: string): void {
    out.push({ text: cleanOutput(text), continues: this.#midLine });
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
  spawnError?: string;
  child: ChildProcess | undefined;
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
}

export interface BackgroundOptions {
  logDir: string;
  now?: () => number;
  limits?: Partial<BackgroundLimits>;
  isOpen?: (owner: JobOwner) => boolean;
}

export class BackgroundJobs {
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Set<(view: JobView) => void>();
  readonly #limits: BackgroundLimits;
  readonly #logDir: string;
  readonly #now: () => number;
  readonly #isOpen: (owner: JobOwner) => boolean;
  readonly #instance = randomBytes(4).toString('hex');
  #seq = 0;
  #finished = 0;
  #closed = false;

  constructor(options: BackgroundOptions) {
    this.#logDir = options.logDir;
    this.#now = options.now ?? Date.now;
    this.#limits = { ...BACKGROUND_LIMITS, ...options.limits };
    this.#isOpen = options.isOpen ?? (() => true);
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
      fetched: input.fetched, child: undefined, ring: new OutputRing(),
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }, gates: { stdout: gate(), stderr: gate() },
      incoming: { stdout: '', stderr: '' }, flushTimer: undefined, cursor: 0,
      log: undefined, logOpened: false, logQueue: [], logPath: join(this.#logDir, `bg-${input.conversationId}-${seq}-${this.#instance}.log`), logBytes: 0, logCut: false,
      rootExited: false, rootExit: deferred(), done: deferred(), finishedOrder: 0, onExit: input.onExit,
    };
    this.#jobs.set(job.id, job);
    try {
      mkdirSync(this.#logDir, { recursive: true });
      const log = createWriteStream(job.logPath, { flags: 'wx' });
      log.on('open', () => { job.logOpened = true; });
      log.on('error', () => { if (job.log === log) job.log = undefined; });
      job.log = log;
    } catch { job.log = undefined; }
    try {
      job.child = spawn(input.file, [...input.args], {
        cwd: input.cwd, env: input.env, windowsHide: true, detached: !WINDOWS, shell: false,
        stdio: [input.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      job.spawnError = (error as Error).message;
      this.#finish(job);
      return { id: job.id };
    }
    const child = job.child;
    child.stdout?.on('data', (chunk: Buffer) => this.#data(job, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.#data(job, 'stderr', chunk));
    if (input.stdin !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input.stdin);
    }
    child.on('error', error => {
      job.spawnError ??= error.message;
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
    this.#emit(job);
    return { id: job.id };
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
    const job = by === 'model' ? this.#owned(id, conversationId ?? '') : this.#jobs.get(id);
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
    if (job.child) stopTree(job.child, this.#limits.termGraceMs);
    job.halting = (async () => {
      await within(job.rootExit.promise, this.#limits.termGraceMs + 1000);
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

  #finish(job: Job): void {
    if (job.state !== 'running') return;
    this.#flush(job, true);
    job.state = job.stoppedBy ? 'stopped' : 'exited';
    job.endedAt = this.#now();
    job.finishedOrder = ++this.#finished;
    if (!job.logCut) job.log?.end();
    job.rootExit.resolve();
    job.done.resolve();
    try { job.onExit?.(); } catch { }
    this.#prune();
    this.#emit(job);
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
      unread: job.ring.total > job.cursor, fetched: job.fetched, ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
      logPath: job.logPath, logCut: job.logCut,
    };
  }
}
