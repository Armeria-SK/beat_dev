import { DEFAULT_LANGUAGE, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, ContextDetail, EngineErrorKind, StopReason, ThinkingBlock, ToolCall, ToolSpec, Usage } from '../engine/types.ts';
import type { MessageParams } from '../shared/messages/define.ts';
import { providerText, type ProviderMessageKey } from '../shared/messages/providers.ts';

export interface ModelRequest {
  model: ModelConfig;
  // frozen: 会話で固定の部分。dynamic: 1 つの実行のあいだ変わらない部分（日付まで）。tail: いまの時刻・Checklist・裏のコマンドの一覧の全体（毎回変わってよい）。
  // tail は、発言に付けた分（ChatMessage.tail）を送るときは使わず、最後が assistant のとき・古い考えるモデルのときだけ system の後ろに置く
  system: { frozen: string; dynamic: string; tail: string };
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  // 考える深さ（OpenAI 互換は reasoning_effort、Anthropic は output_config.effort）。無ければ何も送らない（モデルの既定）
  effort?: string | undefined;
  signal: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  // 考える部分のブロックが閉じたとき（署名つき）。送り返すために持つだけで、画面には出さない
  | { type: 'thinking'; block: ThinkingBlock }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  // 送り返した考える部分が断られ、外して送り直した（実行の印 thinking_replay_rejected）
  | { type: 'replay_rejected' }
  | { type: 'done'; stop: StopReason; refused?: true };

export type ProbeStatus =
  | 'ok'
  | 'too_small'
  | 'exceeds_model'
  | 'unknown'
  | 'unreachable'
  | 'no_api_key'
  | 'not_found'
  | 'error';

export interface ProbeResult {
  modelId: string;
  status: ProbeStatus;
  server: string;
  declared?: number | undefined;
  measured?: number | undefined;
  modelMax?: number | undefined;
  effective?: number | undefined;
  maxOutput?: number | undefined;
  required: number;
  message: string;
  messageCode?: string | undefined;
  messageParams?: MessageParams | undefined;
  hint?: string | undefined;
  capabilities?: string[] | undefined;
  // 提供元が知らせた、選べる考える深さ（OpenAI 互換は /v1/models の supported_reasoning_efforts、Anthropic は Models API の capabilities.effort）。知らせない提供元では無い
  efforts?: string[] | undefined;
  checkedAt: number;
}

export interface ProviderAdapter {
  readonly provider: ProviderConfig;
  stream(request: ModelRequest): AsyncIterable<StreamEvent>;
  probe(model: ModelConfig, required: number, language?: Language): Promise<ProbeResult>;
}

export class ProviderError extends Error {
  readonly kind: EngineErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  readonly detail: ContextDetail | undefined;
  readonly code: ProviderMessageKey | undefined;
  readonly params: MessageParams;
  // 相手のサーバーが返した本文など。画面には出さず、実行ログにだけ残す（message・params には入れない）
  readonly upstream: string | undefined;
  constructor(kind: EngineErrorKind, message: string, options: {
    retryable?: boolean; retryAfterMs?: number; status?: number; detail?: ContextDetail; code?: ProviderMessageKey; params?: MessageParams; upstream?: string;
  } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'rate_limit' || kind === 'timeout' || kind === 'provider_error');
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.detail = options.detail;
    this.code = options.code;
    this.params = options.params ?? {};
    this.upstream = options.upstream;
  }

  text(language: Language): string { return this.code ? providerText(language, this.code, this.params) : this.message; }
}

export function providerError(kind: EngineErrorKind, code: ProviderMessageKey, params: MessageParams = {}, options: { retryable?: boolean; retryAfterMs?: number; status?: number; detail?: ContextDetail; upstream?: string } = {}): ProviderError {
  return new ProviderError(kind, providerText(DEFAULT_LANGUAGE, code, params), { ...options, code, params });
}

export type FetchLike = typeof fetch;
export type Env = Readonly<Record<string, string | undefined>>;
