// 外の実行役の置き場。種類（claude-code・codex）の名前は先に両方置いてあり、AR-4（Codex）・AR-5（Claude Code）は FACTORIES の自分の 1 行を埋めるだけ
// 1 つの実行役が止まっていても・作れなくても、ほかの実行役と提供元の道には触らない（Approach 9）
import { RUNTIME_KINDS, type AppConfig, type RuntimeConfig, type RuntimeKind } from '../config/schema.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { createCodexRuntime } from './codex/adapter.ts';
import type { ProcessManager } from './process-manager.ts';
import { permissionFor, type AgentRuntime, type RuntimePermission, type RuntimeRequest, type RuntimeSession } from './types.ts';
import { createClaudeCodeRuntime } from './claude-code/adapter.ts';

export interface RuntimeDeps {
  processes: ProcessManager;
  log: (line: string) => void;
  // いま環境に入っている API キーの値（提供元の secrets() と同じ出どころ）。実行役が言ってきた文・入力・出力から、鍵そのものを伏せるために使う
  secrets?: () => readonly string[];
}

export type RuntimeFactory = (config: RuntimeConfig, deps: RuntimeDeps) => AgentRuntime;

// まだ作っていない種類は undefined
export const FACTORIES: Readonly<Record<RuntimeKind, RuntimeFactory | undefined>> = {
  'claude-code': (config, deps) => createClaudeCodeRuntime(config, deps),
  codex: createCodexRuntime,
};

export type RuntimeLookup =
  | { ok: true; runtime: AgentRuntime; permission: RuntimePermission }
  | { ok: false; reason: 'unknown' | 'disabled' | 'not_built' | 'failed'; detail: string };

export class RuntimeUnavailable extends Error {
  readonly reason: Extract<RuntimeLookup, { ok: false }>['reason'];
  constructor(reason: RuntimeUnavailable['reason'], detail: string) {
    super(detail);
    this.name = 'RuntimeUnavailable';
    this.reason = reason;
  }
}

export class RuntimeRegistry {
  readonly #deps: RuntimeDeps;
  readonly #factories: Readonly<Record<RuntimeKind, RuntimeFactory | undefined>>;
  // 設定が変わったら作り直すため、作ったときの設定の写しを一緒に持つ
  readonly #built = new Map<string, { key: string; runtime: AgentRuntime }>();
  readonly #failed = new Map<string, { key: string; detail: string }>();

  constructor(deps: RuntimeDeps, factories: Readonly<Record<RuntimeKind, RuntimeFactory | undefined>> = FACTORIES) {
    this.#deps = deps;
    this.#factories = factories;
  }

  kinds(): readonly RuntimeKind[] { return RUNTIME_KINDS; }

  // 実行役が言ってきたものから伏せる鍵の値（出どころが無ければ空）
  secrets(): readonly string[] { return this.#deps.secrets?.() ?? []; }

  find(config: Pick<AppConfig, 'runtimes'>, id: string): RuntimeLookup {
    const runtime = config.runtimes?.find(candidate => candidate.id === id);
    if (!runtime) return { ok: false, reason: 'unknown', detail: `Runtime "${id}" is not in the settings` };
    if (!runtime.enabled) return { ok: false, reason: 'disabled', detail: `Runtime "${id}" is turned off` };
    const factory = this.#factories[runtime.kind];
    if (!factory) return { ok: false, reason: 'not_built', detail: `Runtime "${id}" (${runtime.kind}) is not supported yet` };
    const key = JSON.stringify(runtime);
    const failed = this.#failed.get(id);
    if (failed?.key === key) return { ok: false, reason: 'failed', detail: failed.detail };
    let built = this.#built.get(id);
    if (built?.key !== key) {
      try {
        built = { key, runtime: factory(runtime, this.#deps) };
        this.#built.set(id, built);
        this.#failed.delete(id);
      } catch (error) {
        const detail = redactSecrets(`Runtime "${id}" could not be set up: ${(error as Error).message}`);
        this.#built.delete(id);
        this.#failed.set(id, { key, detail });
        this.#deps.log(`[ERROR] ${detail}`);
        return { ok: false, reason: 'failed', detail };
      }
    }
    return { ok: true, runtime: built.runtime, permission: permissionFor(runtime.kind, runtime.permission) };
  }

  // 起こすたびに、設定から決めた許可の設定を必ず渡す（呼ぶ側は許可の設定を決めない。無い・知らない値は既定）
  // cautious: 設定の許可より厳しい側へ（実行役ごとの一覧の先頭。設定の値が先頭より緩くても、先頭で起こす）。計画モードの会話に使う
  async start(config: Pick<AppConfig, 'runtimes'>, id: string, request: Omit<RuntimeRequest, 'permission'> & { cautious?: true }): Promise<RuntimeSession> {
    const found = this.find(config, id);
    if (!found.ok) throw new RuntimeUnavailable(found.reason, found.detail);
    const { cautious, ...rest } = request;
    return found.runtime.start({ ...rest, permission: cautious ? permissionFor(found.runtime.kind, undefined) : found.permission });
  }
}
