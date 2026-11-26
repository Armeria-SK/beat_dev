import { createInterface } from 'node:readline';
import type { Options, PermissionResult, PermissionUpdate, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeSdk } from '../../src/runtimes/claude-code/adapter.ts';
import type { SdkSpawnedProcess } from '../../src/runtimes/process-manager.ts';
import { FAKE_RUNTIME_SCRIPT } from './fake-runtime.ts';

// AR-5 の試験用の、にせの Agent SDK。本物の SDK と同じく、query() の中で spawnClaudeCodeProcess を呼んで子を起こす（子は AR-3 のにせの実行役のスクリプト）。
// 流れる出来事は、試験が書く script（async generator）が決める。本物の Claude Code は起こさない

export const SESSION_ID = '11111111-2222-4333-8444-555555555555';

export const sdkMessage = (message: object): SDKMessage => message as unknown as SDKMessage;

export const initMessage = (over: Record<string, unknown> = {}): SDKMessage =>
  sdkMessage({ type: 'system', subtype: 'init', apiKeySource: 'none', permissionMode: 'default', tools: ['Read', 'Bash', 'Task', 'mcp__someserver__sometool'], session_id: SESSION_ID, ...over });

export const textMessage = (id: string, text: string, over: Record<string, unknown> = {}): SDKMessage =>
  sdkMessage({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: SESSION_ID, ...over });

export const resultMessage = (over: Record<string, unknown> = {}): SDKMessage =>
  sdkMessage({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION_ID, ...over });

export interface FakeContext {
  readonly options: Options;
  // 起こした子（起こせなかったときは undefined）
  readonly child: SdkSpawnedProcess | undefined;
  nextUser(): Promise<SDKUserMessage | undefined>;
  // 子に 1 行書いて、1 行返してもらう
  ask(message: unknown): Promise<any>;
  // 本物の SDK が canUseTool を呼ぶのと同じ呼び方
  requestPermission(tool: string, input: Record<string, unknown>, extra?: { toolUseID?: string; suggestions?: PermissionUpdate[]; suppressAlwaysAllowRule?: boolean }): Promise<PermissionResult | null>;
  // requestPermission に渡す信号（試験が abort すると、本物の SDK が求めを取り下げるのと同じ）
  readonly permissionAbort: AbortController;
  // interrupt() が呼ばれたら解ける
  readonly interrupted: Promise<void>;
}

export type FakeScript = (ctx: FakeContext) => AsyncGenerator<SDKMessage, void, unknown>;

export interface FakeSdkConfig {
  version?: string;
  // initializationResult().account.apiKeySource。本物はキーを使っていないとき付けない
  apiKeySource?: string;
  // initializationResult().account.apiProvider（送り先の種類。本物は firstParty・bedrock・vertex など。付けないときは言ってこない）
  apiProvider?: string;
  // initializationResult() が落ちる
  initError?: Error;
  // initializationResult() が返らない
  initHangs?: boolean;
  // initializationResult() が返るまでの待ち（起動の途中で止められる場面の試験用）
  initDelayMs?: number;
  childArgs?: string[];
}

// 初期の流れ: 始まりの知らせ → 発言を 1 つ待つ → 文 → 終わり
export const echoScript: FakeScript = async function* (ctx) {
  yield initMessage();
  const user = await ctx.nextUser();
  const text = ((user?.message.content as Array<{ text?: string }>)[0]?.text) ?? '';
  yield textMessage('m1', `echo: ${text}`);
  yield resultMessage();
};

export class FakeQuery {
  readonly ctx: FakeContext;
  readonly spawnError: Error | undefined;
  readonly config: FakeSdkConfig;
  interrupts = 0;
  closed = false;
  readonly #generator: AsyncGenerator<SDKMessage, void, unknown>;
  readonly #abort = new AbortController();
  readonly #users: SDKUserMessage[] = [];
  readonly #waiting: Array<(message: SDKUserMessage | undefined) => void> = [];
  #inputEnded = false;
  #resolveInterrupted: () => void = () => undefined;

  constructor(prompt: AsyncIterable<SDKUserMessage> | string, options: Options, script: FakeScript, config: FakeSdkConfig) {
    this.config = config;
    let child: SdkSpawnedProcess | undefined;
    let spawnError: Error | undefined;
    try {
      child = options.spawnClaudeCodeProcess?.({
        command: options.pathToClaudeCodeExecutable as string,
        args: [FAKE_RUNTIME_SCRIPT, ...(config.childArgs ?? []), '--permission-mode', String(options.permissionMode), ...(Array.isArray(options.tools) ? [`--tools=${options.tools.join(',')}`] : []), ...(options.disallowedTools?.length ? [`--disallowedTools=${options.disallowedTools.join(',')}`] : [])],
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: options.env ?? {},
        signal: this.#abort.signal,
      }) as SdkSpawnedProcess | undefined;
    } catch (error) { spawnError = error as Error; }
    this.spawnError = spawnError;
    // 本物の SDK は、入力が閉じたら子の標準入力を閉じる
    if (typeof prompt !== 'string') {
      void (async () => {
        for await (const message of prompt) {
          const waiter = this.#waiting.shift();
          if (waiter) waiter(message); else this.#users.push(message);
        }
        this.#inputEnded = true;
        for (const waiter of this.#waiting.splice(0)) waiter(undefined);
        child?.stdin.end();
      })();
    }
    const interrupted = new Promise<void>(resolve => { this.#resolveInterrupted = resolve; });
    let lines: AsyncIterator<string> | undefined;
    const permissionAbort = new AbortController();
    this.ctx = {
      options, child, interrupted, permissionAbort,
      nextUser: () => {
        const message = this.#users.shift();
        if (message) return Promise.resolve(message);
        if (this.#inputEnded) return Promise.resolve(undefined);
        return new Promise(resolve => this.#waiting.push(resolve));
      },
      ask: async message => {
        if (!child) throw new Error('no child');
        lines ??= createInterface({ input: child.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
        child.stdin.write(`${JSON.stringify(message)}\n`);
        const next = await lines.next();
        return next.done ? undefined : JSON.parse(next.value);
      },
      requestPermission: (tool, input, extra = {}) => {
        const canUseTool = options.canUseTool;
        if (!canUseTool) throw new Error('no canUseTool');
        const toolUseID = extra.toolUseID ?? `toolu_${tool}`;
        return canUseTool(tool, input, { signal: permissionAbort.signal, toolUseID, requestId: `req_${toolUseID}`, ...(extra.suggestions ? { suggestions: extra.suggestions } : {}), ...(extra.suppressAlwaysAllowRule ? { suppressAlwaysAllowRule: true } : {}) });
      },
    };
    this.#generator = script(this.ctx);
  }

  next(): Promise<IteratorResult<SDKMessage, void>> { return this.#generator.next(); }
  return(value?: void): Promise<IteratorResult<SDKMessage, void>> { return this.#generator.return(value); }
  throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> { return this.#generator.throw(error); }
  [Symbol.asyncIterator](): this { return this; }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.#resolveInterrupted();
  }

  close(): void {
    // 本物の SDK は close() で子も止めるが、ここでは止めない。止めるのはアダプター（process-manager）の仕事だと確かめるため
    this.closed = true;
  }

  async initializationResult(): Promise<unknown> {
    if (this.config.initHangs) return new Promise(() => undefined);
    if (this.config.initDelayMs !== undefined) await new Promise(resolve => setTimeout(resolve, this.config.initDelayMs));
    if (this.config.initError) throw this.config.initError;
    if (this.spawnError) throw this.spawnError;
    return { claude_code_version: this.config.version ?? '2.1.331', account: { ...(this.config.apiKeySource === undefined ? {} : { apiKeySource: this.config.apiKeySource }), ...(this.config.apiProvider === undefined ? {} : { apiProvider: this.config.apiProvider }) }, models: [] };
  }

  async supportedModels(): Promise<unknown> {
    if (this.spawnError) throw this.spawnError;
    return [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] }, { value: 'haiku', displayName: 'Haiku' }];
  }
}

export class FakeClaudeSdk implements ClaudeCodeSdk {
  readonly queries: FakeQuery[] = [];
  readonly #script: FakeScript;
  readonly #config: FakeSdkConfig;

  constructor(script: FakeScript = echoScript, config: FakeSdkConfig = {}) {
    this.#script = script;
    this.#config = config;
  }

  query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
    const fake = new FakeQuery(params.prompt, params.options ?? {}, this.#script, this.#config);
    this.queries.push(fake);
    return fake as unknown as Query;
  }

  get last(): FakeQuery {
    const query = this.queries.at(-1);
    if (!query) throw new Error('the SDK was not called');
    return query;
  }
}
