import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_LANGUAGE, type Language, type ModelConfig, type ProviderConfig } from '../config/schema.ts';
import type { ChatMessage, ImageRef, StopReason, ThinkingBlock } from '../engine/types.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { contextHint, errorProbeText, evaluateContext, serverNumber } from './context.ts';
import { checkBaseUrl, classifyHttpFailure, parseRetryAfter, providerSecrets, requireApiKey, UPSTREAM_KEEP } from './http.ts';
import { ProviderError, providerError, type Env, type FetchLike, type ModelRequest, type ProbeResult, type ProviderAdapter, type StreamEvent } from './types.ts';

type Block = Anthropic.ContentBlockParam;
const EPHEMERAL = { type: 'ephemeral' } as const;
const ANTHROPIC_URL = 'https://api.anthropic.com';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Models API の capabilities.effort から、そのモデルが受ける深さを弱い順に並べる。capabilities が無い（中継など）・effort.supported が偽なら undefined
function anthropicEfforts(capabilities: Anthropic.ModelCapabilities | null | undefined): string[] | undefined {
  const effort = capabilities?.effort;
  if (!effort?.supported) return undefined;
  const levels = EFFORT_LEVELS.filter(level => effort[level]?.supported === true);
  return levels.length ? levels : undefined;
}

const imageBlock = (img: ImageRef): Anthropic.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.data } });

const thinkingParam = ({ at: _at, lead: _lead, ...block }: ThinkingBlock): Block => block;

// 返事の考える部分を、受け取った並びに戻して置く（lead は文より前、ほかは at 個目の道具の呼び出しのあと）
function withThinking(text: Block[], calls: Block[], blocks: readonly ThinkingBlock[]): Block[] {
  const at = (n: number, lead?: boolean) => blocks.filter(b => b.at === n && (lead === undefined || (b.lead === true) === lead)).map(thinkingParam);
  const out = [...at(0, true), ...text, ...at(0, false)];
  calls.forEach((call, i) => out.push(call, ...at(i + 1)));
  out.push(...blocks.filter(b => b.at > calls.length).map(thinkingParam));
  return out;
}

// replay: 送る先の提供元とモデル。考える部分は、それを書いた提供元とモデルが同じときだけ、受け取ったまま送り返す（ほかのモデル・提供元には送らない）
export function toAnthropicMessages(messages: readonly ChatMessage[], vision: boolean, replay?: { provider: string; model: string }): Anthropic.MessageParam[] {
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks: Block[] = [];
      if (vision) for (const img of m.images ?? []) blocks.push(imageBlock(img));
      blocks.push({ type: 'text', text: m.content || '(empty message)' });
      push('user', blocks);
    } else if (m.role === 'assistant') {
      const text: Block[] = m.content ? [{ type: 'text', text: m.content }] : [];
      const calls: Block[] = (m.toolCalls ?? []).map(call => {
        const input = call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments as Record<string, unknown> : {};
        return { type: 'tool_use', id: call.id, name: call.name, input };
      });
      if (!text.length && !calls.length) text.push({ type: 'text', text: '(empty reply)' });
      const thinking = replay && m.thinking?.provider === replay.provider && m.thinking.model === replay.model ? m.thinking.blocks : [];
      push('assistant', thinking.length ? withThinking(text, calls, thinking) : [...text, ...calls]);
    } else {
      const images = vision ? m.images ?? [] : [];
      const content = images.length ? [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...images.map(imageBlock)] : m.content;
      push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content, ...(m.isError ? { is_error: true } : {}) }]);
    }
  }
  // 会話の末尾にキャッシュの区切りを置き、次のターンで前半を再利用できるようにする
  const lastBlock = out.at(-1)?.content.at(-1);
  if (lastBlock && lastBlock.type !== 'thinking' && lastBlock.type !== 'redacted_thinking') {
    (lastBlock as { cache_control?: typeof EPHEMERAL }).cache_control = EPHEMERAL;
  }
  return out;
}

function mapStop(reason: string | null | undefined): StopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
  return 'other';
}

export function classifyAnthropicError(error: unknown, signal: AbortSignal, secrets: readonly string[] = []): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError || signal.aborted) return providerError('cancelled', 'cancelled', {}, { retryable: false });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return providerError('timeout', 'anthropic.timeout');
  if (error instanceof Anthropic.APIConnectionError) return providerError('provider_error', 'anthropic.connect', {}, { retryable: true });
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    const body = error.error as { error?: { type?: string; message?: string } } | undefined;
    const message = body?.error?.message ?? error.message ?? '';
    if (error.status === 529 || body?.error?.type === 'overloaded_error') {
      const retryAfterMs = parseRetryAfter(error.headers?.get('retry-after'));
      return providerError('provider_error', 'anthropic.busy', {}, { retryable: true, status: error.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
    }
    return classifyHttpFailure(error.status, message, error.headers, secrets);
  }
  return providerError('internal', 'unexpected', {}, { retryable: false, upstream: redactSecrets(String((error as Error)?.message ?? error), secrets).slice(0, UPSTREAM_KEEP) });
}

// 送り返した考える部分を API が断った 400 か（署名が合わない・前の発言が変わって別の会話のものになった）
function thinkingRejected(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return false;
  const body = error.error as { error?: { message?: string } } | undefined;
  return /signature|thinking/i.test(body?.error?.message ?? error.message ?? '');
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider: ProviderConfig;
  readonly #env: Env;
  readonly #fetch: FetchLike | undefined;
  // 考える部分を送り返して断られたモデル（このプロセスのあいだ送り返さない。毎回 400 を挟まないため）
  readonly #noReplay = new Set<string>();
  #client: Anthropic | undefined;
  #clientKey: string | undefined;
  constructor(provider: ProviderConfig, env: Env, fetchImpl?: FetchLike) {
    this.provider = provider; this.#env = env; this.#fetch = fetchImpl;
  }

  #secrets(): string[] { return providerSecrets(this.provider, this.#env); }

  #clientFor(): Anthropic {
    if (this.provider.baseUrl !== undefined) {
      const checked = checkBaseUrl(this.provider.baseUrl, true);
      if ('problem' in checked) throw new ProviderError('provider_error', `providers.${this.provider.id}.baseUrl: ${checked.problem}`, { retryable: false });
    }
    const key = requireApiKey({ ...this.provider, apiKeyEnv: this.provider.apiKeyEnv ?? 'ANTHROPIC_API_KEY' }, this.#env);
    if (!this.#client || this.#clientKey !== key) {
      this.#client = new Anthropic({
        apiKey: key ?? null,
        authToken: null,
        maxRetries: 0, // 再試行はエンジン側で一本化する（試行回数を engine_runs に正しく残すため）
        timeout: this.provider.timeoutMs,
        baseURL: this.provider.baseUrl ?? ANTHROPIC_URL,
        fetchOptions: { redirect: 'error' },
        ...(this.#fetch ? { fetch: this.#fetch } : {}),
      });
      this.#clientKey = key;
    }
    return this.#client;
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    let client: Anthropic;
    try { client = this.#clientFor(); } catch (error) { throw classifyAnthropicError(error, req.signal, this.#secrets()); }
    const system: Anthropic.TextBlockParam[] = [];
    if (req.system.frozen) system.push({ type: 'text', text: req.system.frozen, cache_control: EPHEMERAL });
    if (req.system.dynamic) system.push({ type: 'text', text: req.system.dynamic });
    const tools: Anthropic.Tool[] = req.tools.map((t, i, all) => ({
      name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    const tooling: Record<string, { id: string; name: string; json: string }> = {};
    const thinking: Record<string, ThinkingBlock> = {};
    let calls = 0;
    let wrote = false;
    let stop: StopReason = 'other';
    try {
      const create = (replay: boolean) => client.messages.create({
        model: req.model.model,
        max_tokens: req.maxOutputTokens,
        system,
        messages: toAnthropicMessages(req.messages, req.model.vision, replay ? { provider: this.provider.id, model: req.model.model } : undefined),
        ...(tools.length ? { tools } : {}),
        ...(req.model.temperature === undefined ? {} : { temperature: req.model.temperature }),
        ...(req.effort ? { output_config: { effort: req.effort as NonNullable<Anthropic.OutputConfig['effort']> } } : {}),
        stream: true,
      }, { signal: req.signal });
      const replay = !this.#noReplay.has(req.model.model) && req.messages.some(m => m.role === 'assistant' && m.thinking?.provider === this.provider.id && m.thinking.model === req.model.model && m.thinking.blocks.length > 0);
      let stream;
      try { stream = await create(replay); } catch (error) {
        // 送り返した考える部分を断られたら（署名が合わない・前の発言が変わった）、このモデルには以後送り返さず、外して 1 回だけ送り直す
        if (!replay || !thinkingRejected(error)) throw error;
        this.#noReplay.add(req.model.model);
        stream = await create(false);
      }
      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            yield { type: 'usage', usage: {
              inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              ...(u.cache_read_input_tokens == null ? {} : { cacheReadTokens: u.cache_read_input_tokens }),
              ...(u.cache_creation_input_tokens == null ? {} : { cacheWriteTokens: u.cache_creation_input_tokens }),
            } };
            break;
          }
          case 'content_block_start': {
            const block = event.content_block;
            const place = { at: calls, ...(wrote ? {} : { lead: true as const }) };
            if (block.type === 'tool_use') { tooling[event.index] = { id: block.id, name: block.name, json: '' }; calls++; }
            else if (block.type === 'text') wrote = true;
            else if (block.type === 'thinking') thinking[event.index] = { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '', ...place };
            else if (block.type === 'redacted_thinking') thinking[event.index] = { type: 'redacted_thinking', data: block.data, ...place };
            break;
          }
          case 'content_block_delta': {
            const th = thinking[event.index];
            if (event.delta.type === 'text_delta') yield { type: 'text', delta: event.delta.text };
            else if (event.delta.type === 'input_json_delta') { const t = tooling[event.index]; if (t) t.json += event.delta.partial_json; }
            else if (event.delta.type === 'thinking_delta') { if (th?.type === 'thinking') th.thinking += event.delta.thinking; yield { type: 'reasoning', delta: event.delta.thinking }; }
            else if (event.delta.type === 'signature_delta') { if (th?.type === 'thinking') th.signature = event.delta.signature; }
            break;
          }
          case 'content_block_stop': {
            const th = thinking[event.index];
            if (th) { delete thinking[event.index]; yield { type: 'thinking', block: th }; }
            const t = tooling[event.index];
            if (t) {
              let args: unknown;
              try { args = t.json.trim() ? JSON.parse(t.json) : {}; } catch { args = undefined; }
              yield { type: 'tool_call', call: { id: t.id, name: t.name, arguments: args, raw: t.json } };
              delete tooling[event.index];
            }
            break;
          }
          case 'message_delta':
            stop = mapStop(event.delta.stop_reason);
            if (typeof event.usage?.output_tokens === 'number') yield { type: 'usage', usage: { outputTokens: event.usage.output_tokens } };
            break;
          default: break;
        }
      }
    } catch (error) { throw classifyAnthropicError(error, req.signal, this.#secrets()); }
    yield { type: 'done', stop };
  }

  async probe(model: ModelConfig, required: number, language: Language = DEFAULT_LANGUAGE): Promise<ProbeResult> {
    const facts = { modelId: model.id, server: 'anthropic', required, declared: model.contextLength, language };
    try {
      const info = await this.#clientFor().models.retrieve(model.model, undefined, { timeout: 10_000 });
      const modelMax = typeof info.max_input_tokens === 'number' ? info.max_input_tokens : undefined;
      const result = evaluateContext({ ...facts, modelMax, maxOutput: serverNumber(info.max_tokens), hint: contextHint(language, 'hosted', required), unmeasuredNote: modelMax === undefined ? 'probe.note.max_unavailable' : undefined });
      const efforts = anthropicEfforts(info.capabilities);
      return efforts ? { ...result, efforts } : result;
    } catch (error) {
      const e = classifyAnthropicError(error, new AbortController().signal, this.#secrets());
      const status = e.kind === 'auth' ? 'no_api_key' : e.status === 404 ? 'not_found' : e.status === undefined ? 'unreachable' : 'error';
      return { ...facts, status, ...errorProbeText(e, language), checkedAt: Date.now() };
    }
  }
}
