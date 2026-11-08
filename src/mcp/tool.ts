// MCP サーバーの道具 1 つを、Clive の道具（ToolDef）にする。
// 外のサーバーが書いた説明・入力の形・答えは「外から来た文」として扱う: 説明には決まった前置きを付け、答えは [外部の内容] の枠で包む。
// 効果・外へ送るか・消すかは、持ち主が設定（mcp.servers[].tools）に書いた申告だけを使う。サーバーの申告（annotations）は、厳しい向き（消す・外へ出る）にしか使わない
import { Kind, TypeRegistry, type TSchema } from '@sinclair/typebox';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type { Language, McpConfig, McpServerConfig, McpToolEntry } from '../config/schema.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { toolText } from '../shared/messages/tools.ts';
import type { PreCheck, ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { mcpToolName } from './names.ts';

export const DESCRIPTION_MAX = 1024;
export const INPUT_SCHEMA_MAX = 16 * 1024;

// サーバーが答えた道具の 1 件（SDK の Tool のうち使う部分だけ）
export interface McpRemoteTool {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
  annotations?: { destructiveHint?: boolean | undefined; openWorldHint?: boolean | undefined; readOnlyHint?: boolean | undefined } | undefined;
}

// 道具を呼ぶ口（SDK の Client の一部。試験は偽物を渡す）
export interface McpCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>;
}

// ---- 入力の形の検査 ----
// サーバーが答えた入力の形（素の JSON Schema）は、TypeBox の Value.Check にそのまま渡すと「Unknown type」で落ちる。
// そこで、TypeBox の部品として登録した型 McpInput にして、中身の検査は ajv（SDK が使うもの）に任せる。
// モデルへ送る仕様は JSON にされるので、Kind の印（Symbol）は付かず、サーバーが書いた形がそのまま出る
const KIND = 'McpInput';
const validators = new WeakMap<object, JsonSchemaValidator<unknown>>();
TypeRegistry.Set(KIND, (schema, value) => validators.get(schema as object)?.(value).valid === true);

export type InputSchemaResult = { ok: true; schema: TSchema } | { ok: false; reason: string };

// 見えない文字: 制御文字と書式文字（Unicode の Cc と Cf: 文字の向きを変えるもの・ゼロ幅・タグ文字など）、行・段落の区切り、
// 割り当て前を含むタグ文字の範囲、異体字選択子（絵文字の後ろに隠して文を運べる）
const INVISIBLE_ONE = /[\p{Cc}\p{Cf}\u{2028}\u{2029}\u{e0000}-\u{e007f}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/gu;
const INVISIBLE_RUN = new RegExp(`(?:${INVISIBLE_ONE.source})+`, 'gu');

// 落とした数: 改行・タブ・復帰は説明にふつうに入るので、見えない文字には数えない（数が常に 0 でないと、差分の注意が埋もれる）
export function hiddenCount(text: string | undefined): number {
  let count = 0;
  for (const m of (text ?? '').matchAll(INVISIBLE_ONE)) if (m[0] !== '\n' && m[0] !== '\t' && m[0] !== '\r') count += 1;
  return count;
}

export const SCHEMA_DEPTH_MAX = 64;

export interface ScrubbedSchema {
  value: unknown;
  // 落とした見えない文字の数（hiddenCount と同じ数え方）
  stripped: number;
  // 使えない形だったときの理由（深すぎる・落とした後にキーがぶつかる）。ある間も value は返す（固定と差分の表示は止めない）
  problem?: string;
}

// 入力の形の中の文字列は、すべてモデルに渡る。説明・題・enum・既定値・キーを含め、どの文字列からも見えない文字を落とす
// （続く見えない文字は空白 1 つにする。説明文と同じ規則）。見えない文字だけで隠した指示を、持ち主の目にもモデルにも通さない
export function scrubSchema(raw: unknown): ScrubbedSchema {
  let stripped = 0;
  let problem: string | undefined;
  const text = (s: string): string => { stripped += hiddenCount(s); return s.replace(INVISIBLE_RUN, ' '); };
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object' || value === null) return value;
    if (depth >= SCHEMA_DEPTH_MAX) { problem ??= 'too deep'; return null; }
    if (Array.isArray(value)) return value.map(item => walk(item, depth + 1));
    const seen = new Set<string>();
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const clean = text(key);
      if (seen.has(clean)) problem ??= 'duplicate key after removing invisible characters';
      seen.add(clean);
      entries.push([clean, walk(item, depth + 1)]);
    }
    return Object.fromEntries(entries);
  };
  const out = walk(raw, 0);
  return { value: out, stripped, ...(problem ? { problem } : {}) };
}

export function inputSchemaOf(raw: unknown): InputSchemaResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const copy: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (copy['type'] !== 'object') return { ok: false, reason: 'type is not object' };
  // メタスキーマの指定（$schema）は、ajv が知らない版だと落ちるので外す。検査には要らない
  delete copy['$schema'];
  const scrubbed = scrubSchema(copy);
  if (scrubbed.problem) return { ok: false, reason: scrubbed.problem };
  let text: string;
  try { text = JSON.stringify(scrubbed.value); } catch { return { ok: false, reason: 'not JSON' }; }
  if (text.length > INPUT_SCHEMA_MAX) return { ok: false, reason: 'too large' };
  let validate: JsonSchemaValidator<unknown>;
  try { validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(text) as never); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  const schema = { ...(JSON.parse(text) as Record<string, unknown>), [Kind]: KIND } as unknown as TSchema;
  validators.set(schema, validate);
  return { ok: true, schema };
}

// 説明文: 見えない文字（INVISIBLE。制御文字・文字の向きを変えるもの・ゼロ幅・タグ文字・異体字選択子など）を空白にし、長さを切る（改行も空白にする）
export function cleanDescription(text: string | undefined): string {
  const flat = (text ?? '').replace(INVISIBLE_RUN, ' ').replace(/\s{2,}/gu, ' ').trim();
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX)}…` : flat;
}

// 答えの本文の中の区切り（<<< と >>>）は全角にして、枠を偽装されないようにする
export function neutralizeFence(text: string): string {
  return text.replace(/<{3,}/gu, m => '＜'.repeat(m.length)).replace(/>{3,}/gu, m => '＞'.repeat(m.length));
}

interface ContentPart { type?: unknown; text?: unknown; resource?: { text?: unknown } | undefined }

// 答えの本文を取り出す。文字（text と、文字の resource）だけ。画像・音声などは数えて、省いたと書く
export function textOfResult(result: unknown): { text: string; media: number; isError: boolean } {
  const r = (typeof result === 'object' && result !== null ? result : {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  const parts: string[] = [];
  let media = 0;
  if (Array.isArray(r.content)) {
    for (const raw of r.content as ContentPart[]) {
      if (raw?.type === 'text' && typeof raw.text === 'string') parts.push(raw.text);
      else if (raw?.type === 'resource' && typeof raw.resource?.text === 'string') parts.push(raw.resource.text);
      else media += 1;
    }
  }
  let text = parts.join('\n');
  if (!text.trim() && r.structuredContent !== undefined) {
    try { text = JSON.stringify(r.structuredContent); } catch { /* 文字にできない答えは空とみなす */ }
  }
  return { text, media, isError: r.isError === true };
}

export interface BuildToolParams {
  server: Pick<McpServerConfig, 'id' | 'localOk'>;
  remote: McpRemoteTool;
  entry: McpToolEntry;
  language: Language;
  limits: Pick<McpConfig['limits'], 'callTimeoutMs' | 'resultMaxChars'>;
  // いま使える呼び出し口（切れていれば undefined）
  caller: () => McpCaller | undefined;
  // このサーバーへ渡した秘密の値（env・headers）。答え・エラーの文から、一般の形に当たらなくても伏せる
  secrets?: () => readonly string[];
}

export type BuildToolResult = { ok: true; tool: ToolDef } | { ok: false; reason: string };

export function buildMcpTool(p: BuildToolParams): BuildToolResult {
  const { server, remote, entry, language, limits } = p;
  const schema = inputSchemaOf(remote.inputSchema);
  if (!schema.ok) return schema;
  const name = mcpToolName(server.id, remote.name);
  const effect = entry.effect ?? 'network';
  // 外へ送るか: 持ち主の申告が無ければ送るとみなす。サーバーが openWorld と言ったら、持ち主が「送らない」と書いても送る（サーバーの申告は、聞く向きにだけ働く）
  const sends = (entry.sends ?? true) || remote.annotations?.openWorldHint === true;
  // 消すか: 持ち主が「消す」と書いたか、サーバーが destructive と言ったら消す（どちらも聞く向きにだけ働く）
  const removes = entry.removes === true || remote.annotations?.destructiveHint === true;
  const redact = (text: string): string => redactSecrets(text, p.secrets?.() ?? []);
  const label = { server: server.id, tool: remote.name };

  const preCheck = (): PreCheck => {
    if (sends) return { decision: 'ask', reasons: [toolText(language, 'mcp.ask_sends', label)], sends: true, removes };
    if (removes) return { decision: 'ask', reasons: [toolText(language, 'mcp.ask_removes', label)], sends: false, removes: true };
    if (effect === 'write') return { decision: 'ask', reasons: [toolText(language, 'mcp.ask_write', label)], askKinds: [], sends: false, removes: false };
    return { decision: 'allow', reasons: [], sends: false, removes: false };
  };

  const tool: ToolDef = {
    name,
    description: `${toolText(language, 'mcp.description_prefix', { server: server.id })} ${cleanDescription(remote.description)}`.trim(),
    input: schema.schema,
    effect,
    allowedIn: ['chat'],
    escalateOnTaint: true,
    networkCall: () => true,
    ...(removes ? { removes: true as const } : {}),
    mcp: { server: server.id, tool: remote.name, localOk: server.localOk },
    preCheck,
    summarize: (input, lang) => ({ title: toolText(lang, 'mcp.summary_title', label), body: redact(safeJson(input)).slice(0, 2000) }),
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
      const lang = languageOf(ctx.config);
      const caller = p.caller();
      if (!caller) return { content: toolText(lang, 'mcp.unavailable', label), isError: true, noRemoteContent: true };
      let result: unknown;
      try {
        result = await caller.callTool({ name: remote.name, arguments: input }, { signal: ctx.signal, timeout: limits.callTimeoutMs });
      } catch (e) {
        // 失敗の文にもサーバーが書いた文字が入りうるので、答えと同じ枠で包み、外から読んだ印を付ける
        const reason = neutralizeFence(redact(e instanceof Error ? e.message : String(e))).slice(0, 300);
        const failure = toolText(lang, 'mcp.failed_call', { server: server.id, reason });
        return { content: [toolText(lang, 'mcp.external', { server: server.id }), '<<<', failure, '>>>'].join('\n'), isError: true, fetched: true };
      }
      const { text, media, isError } = textOfResult(result);
      let body = neutralizeFence(redact(text));
      let cut = false;
      if (body.length > limits.resultMaxChars) { body = body.slice(0, limits.resultMaxChars); cut = true; }
      const lines = [
        toolText(lang, 'mcp.external', { server: server.id }),
        '<<<',
        body.trim() ? body : toolText(lang, 'mcp.empty'),
        '>>>',
        cut ? toolText(lang, 'mcp.truncated') : '',
        media ? toolText(lang, 'mcp.media_omitted', { count: media }) : '',
      ].filter(Boolean);
      return { content: lines.join('\n'), isError, fetched: true };
    },
  };
  return { ok: true, tool };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return ''; }
}