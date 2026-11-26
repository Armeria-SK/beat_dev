import type { RuntimeConfig } from '../../src/config/schema.ts';
import type { RuntimeFactory } from '../../src/runtimes/registry.ts';
import {
  PERMISSIONS, type AgentRuntime, type ApprovalDecision, type RuntimeCapabilities, type RuntimeEvent, type RuntimeInput, type RuntimeModel,
  type RuntimeRequest, type RuntimeSession, type RuntimeStatus,
} from '../../src/runtimes/types.ts';

// 台本どおりに出来事を返す、メモリの中だけの実行役の窓口（プロセスを起こさない）。会話をつなぐ段（src/engine/runtime-bridge.ts）の試験用
export interface Feed {
  push(event: RuntimeEvent): void;
  done(): void;
  // 止める（interrupt）が呼ばれたら解ける
  stopped: Promise<void>;
}

export type Script = (feed: Feed, text: string) => void | Promise<void>;

export const OK_STATUS: RuntimeStatus = { installed: true, version: '2.1.331', verified: true, auth: 'ok', login: 'subscription' };

export class ScriptedRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind: RuntimeConfig['kind'];
  readonly capabilities: RuntimeCapabilities;
  readonly starts: RuntimeRequest[] = [];
  readonly sent: string[] = [];
  readonly approvals: Array<{ requestId: string; decision: ApprovalDecision }> = [];
  interrupts = 0;
  closes = 0;
  probes = 0;
  status: RuntimeStatus = OK_STATUS;
  script: Script = feed => feed.done();
  startError: Error | undefined;
  // 応えない実行役（呼ばれても終わらない）を作る
  hang: { probe?: boolean; approve?: boolean; interrupt?: boolean; close?: boolean } = {};
  // 応えない呼び出しを、試験の終わりに解く（待っている確かめの時計も道連れに残さない）
  readonly release!: () => void;
  readonly #gate = new Promise<void>(resolve => { (this as { release: () => void }).release = resolve; });
  runtimeSession: string | undefined = 'sess-1';
  containReason: string | undefined;
  launch: unknown;
  #next = 0;
  readonly #open = new Map<string, { queue: RuntimeEvent[]; wake: (() => void) | undefined; ended: boolean; stop: () => void; stopped: Promise<void> }>();

  constructor(config: RuntimeConfig) {
    this.id = config.id;
    this.kind = config.kind;
    this.capabilities = {
      streaming: true, resume: true, interrupt: true, approvals: true, fileChanges: true, commandExecution: true, nativeTools: true,
      listsModels: true, externalApprovals: true, permissions: PERMISSIONS[config.kind],
    };
  }

  async probe(): Promise<RuntimeStatus> {
    this.probes += 1;
    if (this.hang.probe) await this.#gate;
    return this.status;
  }
  async models(): Promise<RuntimeModel[]> { return [{ id: 'sonnet' }]; }

  async start(request: RuntimeRequest): Promise<RuntimeSession> {
    this.starts.push(request);
    if (this.startError) throw this.startError;
    const id = `scripted-${this.#next += 1}`;
    let stop!: () => void;
    const stopped = new Promise<void>(resolve => { stop = resolve; });
    this.#open.set(id, { queue: [], wake: undefined, ended: false, stop, stopped });
    return { id, ...(this.runtimeSession !== undefined ? { runtimeSession: this.runtimeSession } : {}), ...(this.containReason !== undefined ? { containReason: this.containReason } : {}) };
  }

  launchOf(): unknown { return this.launch; }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    this.sent.push(input.text);
    const open = this.#open.get(sessionId)!;
    const feed: Feed = {
      push: event => { open.queue.push(event); open.wake?.(); },
      done: () => { open.queue.push({ type: 'done' }); open.ended = true; open.wake?.(); },
      stopped: open.stopped,
    };
    void Promise.resolve(this.script(feed, input.text)).catch(error => { open.queue.push({ type: 'failed', kind: 'process', message: String((error as Error).message) }); open.ended = true; open.wake?.(); });
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupts += 1;
    this.#open.get(sessionId)?.stop();
    if (this.hang.interrupt) await this.#gate;
  }

  async approve(_sessionId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    this.approvals.push({ requestId, decision });
    if (this.hang.approve) await this.#gate;
  }

  async *events(sessionId: string): AsyncIterable<RuntimeEvent> {
    const open = this.#open.get(sessionId)!;
    for (;;) {
      const next = open.queue.shift();
      if (next) {
        yield next;
        if (next.type === 'done' || next.type === 'failed') return;
        continue;
      }
      if (open.ended) return;
      await new Promise<void>(resolve => { open.wake = resolve; });
      open.wake = undefined;
    }
  }

  async close(sessionId: string): Promise<void> {
    this.closes += 1;
    this.#open.delete(sessionId);
    if (this.hang.close) await this.#gate;
  }
}

export function scriptedFactory(runtime: { current?: ScriptedRuntime }): RuntimeFactory {
  return (config: RuntimeConfig) => (runtime.current = runtime.current ?? new ScriptedRuntime(config));
}
