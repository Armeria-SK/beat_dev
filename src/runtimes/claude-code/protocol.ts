// Claude Code（Agent SDK）が流す出来事を、窓口の共通の出来事（RuntimeEvent）に写すだけの部品。beat は Claude Code との取り決めを自分では話さない（SDK を通す。PLAN.md「第 5 版の決め」の 1）。
// 知らない出来事は捨てずに unknown として残す。認証の出どころと許可のモードが頼んだものと違えば、その番は続けない
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { redactSecrets } from '../../shared/redaction.ts';
import type { RuntimeEvent } from '../types.ts';
import { unreviewedTools } from './permissions.ts';

type Failed = Extract<RuntimeEvent, { type: 'failed' }>;

// 使う機能（initializationResult）が要る本体のいちばん低い版（SDK の文書: 2.1.296 以上）
export const MIN_CLAUDE_CODE_VERSION = '2.1.296';

// beat が本物で確かめた本体の版（AR-0・AR-5 の確かめ）。ほかの版は、動いても「確かめていない版」と画面に出す
export const VERIFIED_CLAUDE_CODE_VERSION = '2.1.331';

const MAX_MESSAGE = 2000;
const MAX_RAW = 4000;
const MAX_OUTPUT = 20_000;

export function versionParts(text: string | undefined): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

// 版が読めないものは「低い」として扱う（確かめられない版で動かさない）
export function versionAtLeast(version: string | undefined, minimum: string = MIN_CLAUDE_CODE_VERSION): boolean {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i += 1) {
    if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  }
  return true;
}

// 契約のログインで使うとき、API キーの出どころがあってはならない。SDK の文書: 'none' = API キーを使っていない（claude.ai のログインなど）。
// initializationResult().account には、キーを使っていないとき apiKeySource が付かない（本物で見た）
export function apiKeyInUse(source: string | undefined): boolean {
  return source !== undefined && source !== 'none';
}

export function failureKind(error: string | undefined): Failed['kind'] {
  switch (error) {
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'account_on_hold': case 'verification_required': case 'cloud_credential_error': return 'auth';
    case 'rate_limit': case 'billing_error': case 'overloaded': return 'rate_limit';
    default: return 'process';
  }
}

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);
export const safeText = (text: string, max: number = MAX_MESSAGE): string => cut(redactSecrets(text), max);

// ツールの結果は、鍵らしい文字を伏せてから出す（読んだファイルや実行の出力に鍵が入ることがある）。伏せたあとで長さを切る。行は残す
function safeOutput(text: string): string {
  const clean = redactSecrets(text, [], { keepLines: true });
  return clean.length > MAX_OUTPUT ? `${clean.slice(0, MAX_OUTPUT)}\n[output cut at ${MAX_OUTPUT} characters]` : clean;
}

// ツールの結果は文字列か、文・画像などの並び。画像などの中身は写さない
function resultText(content: unknown): string {
  if (typeof content === 'string') return safeOutput(content);
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : safeOutput(JSON.stringify(content));
  return safeOutput(content.map(block => {
    const item = block as { type?: string; text?: unknown };
    return item.type === 'text' && typeof item.text === 'string' ? item.text : `[${typeof item.type === 'string' ? item.type : 'content'}]`;
  }).join('\n'));
}

// 流れとして出さない、知っている出来事（版が上がっても増える種類）
const IGNORED_TYPES = new Set(['rate_limit_event', 'tool_progress', 'auth_status', 'tool_use_summary', 'prompt_suggestion', 'keep_alive']);

export interface TranslatorOptions {
  // 起こすときに頼んだ許可のモード。system/init が違うモードを言ってきたら続けない
  expectedMode: string;
  // 頼んだ番が中断されたあとの result は、失敗にしない
  interrupted: () => boolean;
  onSession: (id: string) => void;
}

export class EventTranslator {
  readonly #options: TranslatorOptions;
  // 文を流しで出した assistant メッセージの id（あとから来る完成形の文を二重に出さない）
  readonly #streamed = new Set<string>();
  #streamingId: string | undefined;
  #lastError: string | undefined;
  #sawInit = false;
  #guarded = false;

  constructor(options: TranslatorOptions) { this.#options = options; }

  // 始まりの知らせが頼んだものと違った（API キー・許可のモード）。この番はすぐ止める
  get guarded(): boolean { return this.#guarded; }

  translate(message: SDKMessage): RuntimeEvent[] {
    switch (message.type) {
      case 'system': return this.#system(message);
      case 'stream_event': return this.#stream(message);
      case 'assistant': return this.#assistant(message);
      case 'user': return this.#user(message);
      case 'result': return this.#result(message);
      default: {
        const type = (message as { type: string }).type;
        if (IGNORED_TYPES.has(type)) return [];
        return [{ type: 'unknown', raw: safeText(JSON.stringify(message), MAX_RAW) }];
      }
    }
  }

  #system(message: Extract<SDKMessage, { type: 'system' }>): RuntimeEvent[] {
    if (message.subtype === 'api_retry') {
      this.#lastError = message.error;
      return [];
    }
    if (message.subtype !== 'init') return [];
    this.#sawInit = true;
    this.#options.onSession(message.session_id);
    // 契約のつもりが API キーの課金になっていたら、番を続けない（環境の絞りが破られたときの最後の関門）。ログインなら 'none' が付く。付いていない（読めない）ときも確かめられていないので続けない
    if (message.apiKeySource !== 'none') {
      this.#guarded = true;
      const reason = apiKeyInUse(message.apiKeySource)
        ? 'Claude Code reported that it is using an API key, not the Claude login. The reply was stopped so it is not billed to an API key.'
        : 'Claude Code did not report that it is using the Claude login, so the reply was stopped.';
      return [{ type: 'failed', kind: 'auth', message: reason }];
    }
    if (message.permissionMode !== this.#options.expectedMode) {
      this.#guarded = true;
      return [{ type: 'failed', kind: 'process', message: `Claude Code started in the "${safeText(String(message.permissionMode), 40)}" permission mode, not the requested "${this.#options.expectedMode}". The reply was stopped.` }];
    }
    // 使う人の claude.exe が更新されて、見直していない組み込みの道具を足したら、続けない（基本の一覧を tools で固定しているので、普通は来ない。来たら止める）。tools が読めないときも確かめられない
    const unreviewed = unreviewedTools(message.tools);
    if (unreviewed === undefined || unreviewed.length > 0) {
      this.#guarded = true;
      return [{
        type: 'failed', kind: 'process',
        message: unreviewed === undefined
          ? 'Claude Code did not report its list of tools, so the reply was stopped.'
          : `Claude Code reported tools that beat has not reviewed (${safeText(unreviewed.slice(0, 5).join(', '), 200)}${unreviewed.length > 5 ? ', ...' : ''}), so the reply was stopped. This version of Claude Code needs a newer beat.`,
      }];
    }
    return [];
  }

  #stream(message: Extract<SDKMessage, { type: 'stream_event' }>): RuntimeEvent[] {
    if (message.parent_tool_use_id !== null) return [];
    const event = message.event;
    if (event.type === 'message_start') { this.#streamingId = event.message.id; return []; }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (this.#streamingId !== undefined) this.#streamed.add(this.#streamingId);
      return event.delta.text === '' ? [] : [{ type: 'text', delta: event.delta.text }];
    }
    return [];
  }

  #assistant(message: Extract<SDKMessage, { type: 'assistant' }>): RuntimeEvent[] {
    if (message.error) this.#lastError = message.error;
    const events: RuntimeEvent[] = [];
    const id = message.message.id;
    for (const block of message.message.content) {
      if (block.type === 'text' && message.parent_tool_use_id === null && !this.#streamed.has(id) && block.text !== '') events.push({ type: 'text', delta: block.text });
      else if (block.type === 'tool_use') events.push({ type: 'tool_start', id: block.id, name: block.name, input: block.input });
    }
    return events;
  }

  #user(message: Extract<SDKMessage, { type: 'user' }>): RuntimeEvent[] {
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const events: RuntimeEvent[] = [];
    for (const block of content) {
      if (block.type === 'tool_result') events.push({ type: 'tool_end', id: block.tool_use_id, output: resultText(block.content), isError: block.is_error === true });
    }
    return events;
  }

  // 失敗は subtype ではなく is_error で見る（認証の失敗も subtype は success で返る）。種類は直前の api_retry / assistant の error から
  #result(message: Extract<SDKMessage, { type: 'result' }>): RuntimeEvent[] {
    if (message.is_error || message.subtype !== 'success') {
      if (this.#options.interrupted()) return [{ type: 'done' }];
      const detail = message.subtype === 'success' ? message.result : message.errors.join('; ');
      return [{ type: 'failed', kind: failureKind(this.#lastError), message: safeText(detail === '' ? 'Claude Code ended the reply with an error.' : detail) }];
    }
    // 始まりの知らせ（認証の出どころと許可のモード）を見ないまま終わった返事は、確かめられていないので成功にしない
    if (!this.#sawInit) return [{ type: 'failed', kind: 'process', message: 'Claude Code ended the reply before it reported how it started.' }];
    return [{ type: 'done' }];
  }
}
