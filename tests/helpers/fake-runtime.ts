import { fileURLToPath } from 'node:url';
import type { RuntimeConfig, RuntimeKind } from '../../src/config/schema.ts';
import type { ProcessManager, ProcessScope, RuntimeProcess } from '../../src/runtimes/process-manager.ts';
import type { RuntimeDeps } from '../../src/runtimes/registry.ts';
import {
  PERMISSIONS, type AgentRuntime, type ApprovalDecision, type RuntimeCapabilities, type RuntimeEvent, type RuntimeInput, type RuntimeModel,
  type RuntimeRequest, type RuntimeSession, type RuntimeStatus,
} from '../../src/runtimes/types.ts';

export const FAKE_RUNTIME_SCRIPT = fileURLToPath(new URL('./fake-runtime-script.mjs', import.meta.url));

// 窓口（AgentRuntime）を、にせの実行役のスクリプトの上に作ったもの。本物の実行役の作り手（AR-4・AR-5）も同じ道（ProcessManager）を通る
export class FakeRuntime implements AgentRuntime {
  readonly id: string;
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  // レジストリが渡した許可の設定つきの求めを、そのまま残す
  readonly starts: RuntimeRequest[] = [];
  readonly #processes: ProcessManager;
  readonly #extra: string[];
  readonly #sessions = new Map<string, { scope: ProcessScope; process: RuntimeProcess }>();
  #next = 0;

  constructor(config: RuntimeConfig, deps: Pick<RuntimeDeps, 'processes'>, extra: string[] = []) {
    this.id = config.id;
    this.kind = config.kind;
    this.#processes = deps.processes;
    this.#extra = extra;
    this.capabilities = {
      streaming: true, resume: false, interrupt: true, approvals: false, fileChanges: false, commandExecution: false, nativeTools: false,
      listsModels: true, externalApprovals: false, permissions: PERMISSIONS[config.kind],
    };
  }

  // 1 回きりの問い（一覧・状態）: 起こす → 1 行書く → 1 行読む → 閉じる
  async query(message: unknown, args: string[] = []): Promise<{ reply: any; record: RuntimeProcess['record'] }> {
    const scope = await this.#processes.open();
    try {
      const process = scope.spawn({ file: globalThis.process.execPath, args: [FAKE_RUNTIME_SCRIPT, ...this.#extra, ...args], cwd: globalThis.process.cwd() });
      process.writeLine(JSON.stringify(message));
      for await (const line of process.lines()) return { reply: JSON.parse(line), record: process.record };
      throw new Error('the fake runtime said nothing');
    } finally { await scope.finish(); }
  }

  async probe(): Promise<RuntimeStatus> {
    const { reply } = await this.query({ type: 'probe' });
    return { installed: reply.installed, version: reply.version, auth: reply.auth };
  }

  async models(): Promise<RuntimeModel[]> {
    const { reply } = await this.query({ type: 'models' });
    return reply.models;
  }

  async start(request: RuntimeRequest): Promise<RuntimeSession> {
    this.starts.push(request);
    const scope = await this.#processes.open();
    let process: RuntimeProcess;
    try {
      process = scope.spawn({ file: globalThis.process.execPath, args: [FAKE_RUNTIME_SCRIPT, '--permission', request.permission, ...this.#extra], cwd: request.cwd, signal: request.signal });
    } catch (error) {
      await scope.finish();
      throw error;
    }
    const id = `fake-${this.#next += 1}`;
    this.#sessions.set(id, { scope, process });
    return { id };
  }

  async send(sessionId: string, input: RuntimeInput): Promise<void> {
    this.#session(sessionId).process.writeLine(JSON.stringify({ type: 'user', text: input.text }));
  }

  async interrupt(sessionId: string): Promise<void> { this.#session(sessionId).process.kill(); }

  async approve(_sessionId: string, _requestId: string, _decision: ApprovalDecision): Promise<void> { throw new Error('the fake runtime has no approvals'); }

  async *events(sessionId: string): AsyncIterable<RuntimeEvent> {
    for await (const line of this.#session(sessionId).process.lines()) {
      let parsed: any;
      try { parsed = JSON.parse(line); } catch { yield { type: 'unknown', raw: line }; continue; }
      if (parsed.type === 'text' || parsed.type === 'done' || parsed.type === 'failed') { yield parsed as RuntimeEvent; if (parsed.type !== 'text') return; } else yield { type: 'unknown', raw: line };
    }
  }

  async close(sessionId: string): Promise<void> {
    const { scope } = this.#session(sessionId);
    this.#sessions.delete(sessionId);
    await scope.finish();
  }

  #session(sessionId: string) {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`no session ${sessionId}`);
    return session;
  }
}
