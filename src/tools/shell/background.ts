import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from '../../shared/redaction.ts';
import { OutputRing, type JobChannel } from './ring.ts';
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
  stopWaitMs: 5000,
  termGraceMs: 5000,
};

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

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[()][0-9A-Za-z]|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function readOutput(ring: OutputRing, from: number, final: boolean, partialLineBytes = BACKGROUND_LIMITS.partialLineBytes): OutputSlice {
  const start = Math.min(Math.max(from, ring.earliest), ring.total);
  const skipped = from < ring.earliest ? ring.earliest - from : 0;
  const read = ring.readFrom(start);
  const firstAt = read.chunks[0]?.at ?? start;
  const joined = Buffer.concat(read.chunks.map(chunk => Buffer.from(chunk.text, 'utf8')));
  let offset = Math.max(0, start - firstAt);
  while (offset < joined.length && (joined[offset]! & 0xC0) === 0x80) offset += 1;
  const raw = joined.subarray(offset);
  let cut = raw.length;
  if (!final) {
    cut = raw.lastIndexOf(0x0a) + 1;
    if (raw.length - cut > partialLineBytes) cut = raw.length;
  }
  return { text: redactSecrets(stripAnsi(raw.subarray(0, cut).toString('utf8'))), next: firstAt + offset + cut, skipped };
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
  decoders: Record<'stdout' | 'stderr', StringDecoder>;
  cursor: number;
  log: WriteStream | undefined;
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
  #seq = 0;
  #finished = 0;

  constructor(options: BackgroundOptions) {
    this.#logDir = options.logDir;
    this.#now = options.now ?? Date.now;
    this.#limits = { ...BACKGROUND_LIMITS, ...options.limits };
    this.#isOpen = options.isOpen ?? (() => true);
  }

  start(input: StartInput): StartResult {
    const owner: JobOwner = { conversationId: input.conversationId, projectId: input.projectId, ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) };
    if (!this.#isOpen(owner)) return { refused: 'closed' };
    const running = [...this.#jobs.values()].filter(job => job.state === 'running');
    const mine = running.filter(job => job.conversationId === input.conversationId);
    const refused = mine.length >= this.#limits.perConversation ? 'conversation_limit' : running.length >= this.#limits.total ? 'total_limit' : undefined;
    if (refused) return { refused, running: mine.map(job => this.#view(job)), elsewhere: running.length - mine.length };

    const seq = ++this.#seq;
    const job: Job = {
      ...owner, id: `bg-${seq}`, command: input.command, cwd: input.cwd, startedAt: this.#now(), state: 'running', exitCode: null, orphaned: false,
      fetched: input.fetched, child: undefined, ring: new OutputRing(), decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      cursor: 0, log: undefined, logPath: join(this.#logDir, `bg-${input.conversationId}-${seq}.log`), logBytes: 0, logCut: false,
      rootExited: false, rootExit: deferred(), done: deferred(), finishedOrder: 0, onExit: input.onExit,
    };
    this.#jobs.set(job.id, job);
    try {
      mkdirSync(this.#logDir, { recursive: true });
      job.log = createWriteStream(job.logPath);
      job.log.on('error', () => { job.log = undefined; });
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
    const slice = readOutput(job.ring, from ?? job.cursor, job.state !== 'running', this.#limits.partialLineBytes);
    job.cursor = slice.next;
    return { ...this.#view(job), ...slice };
  }

  peek(id: string, from: number): JobRead | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    return { ...this.#view(job), ...readOutput(job.ring, from, job.state !== 'running', this.#limits.partialLineBytes) };
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

  async stop(id: string, by: StopBy): Promise<JobView | undefined> {
    const job = this.#jobs.get(id);
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

  closeAll(): void {
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

  #data(job: Job, channel: Exclude<JobChannel, 'log'>, chunk: Buffer): void {
    this.#writeLog(job, channel === 'stderr' ? Buffer.concat([Buffer.from('[stderr] '), chunk]) : chunk);
    job.ring.append(job.decoders[channel].write(chunk), { channel }, this.#limits.ringBytes);
  }

  #writeLog(job: Job, chunk: Buffer): void {
    if (!job.log || job.logCut) return;
    if (job.logBytes + chunk.length > this.#limits.logBytes) {
      job.logCut = true;
      job.log.end(`\n[beat] Log stopped at ${this.#limits.logBytes} bytes; later output is kept in memory only.\n`);
      return;
    }
    job.logBytes += chunk.length;
    job.log.write(chunk);
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
    for (const channel of ['stdout', 'stderr'] as const) job.ring.append(job.decoders[channel].end(), { channel }, this.#limits.ringBytes);
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
    return {
      id: job.id, conversationId: job.conversationId, projectId: job.projectId, ...(job.taskId !== undefined ? { taskId: job.taskId } : {}),
      command: job.command, cwd: job.cwd, startedAt: job.startedAt, ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
      state: job.state, exitCode: job.exitCode, ...(job.stoppedBy ? { stoppedBy: job.stoppedBy } : {}), orphaned: job.orphaned,
      unread: job.ring.total > job.cursor, fetched: job.fetched, ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
      logPath: job.logPath, logCut: job.logCut,
    };
  }
}
