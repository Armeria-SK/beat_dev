import { mcpEnvName } from '../../../src/shared/secret-slots.ts';
import type { PlainKey } from '../i18n/index.ts';
import type { McpAddInput, McpDiffView, McpEffect, McpServerState, McpShapeView, McpToolView } from '../api.ts';
import type { Config } from './model.ts';

// 設定の「MCP サーバー」の、画面を使わない部分。広がる変更を保存の前に数えるための「もし変えたら」の設定、追加フォームの組み立て、失敗の扱い、状態の見せ方。
// （保存はサーバーが行う。ここで作る設定は、確かめの対話に出す項目を数えるためだけに使い、どこにも書かない）

// 設定のスキーマ（src/config/schema.ts）と同じ名前の形。tests/mcp-ui.test.ts が一致を見張る（画面の側へ typebox を持ち込まないため、写してある）
export const PATTERNS = {
  id: /^[a-z][a-z0-9]{0,15}$/u,
  envName: /^[A-Za-z_][A-Za-z0-9_]{0,26}$/u,
  headerName: /^[A-Za-z][A-Za-z0-9-]{0,26}$/u,
} as const;

type Json = Record<string, any>;

// ---- 「もし変えたら」の設定（accessWidening に渡す） ----

function withServer(saved: Config, id: string, edit: (server: Json) => void): Config {
  const next = structuredClone(saved);
  const servers = (next.mcp?.servers ?? []) as Json[];
  const server = servers.find(s => s.id === id);
  if (server) edit(server);
  return next;
}

export function previewServer(saved: Config, id: string, patch: { enabled?: boolean; localOk?: boolean }): Config {
  return withServer(saved, id, server => {
    if (patch.enabled !== undefined) server.enabled = patch.enabled;
    if (patch.localOk !== undefined) server.localOk = patch.localOk;
  });
}

export interface ToolPatch { enabled?: boolean; effect?: McpEffect | null; sends?: boolean | null; removes?: boolean | null }

// null は「申告を消す」（サーバーの API と同じ）
export function previewTool(saved: Config, id: string, tool: string, patch: ToolPatch): Config {
  return withServer(saved, id, server => {
    const tools = (server.tools ??= {}) as Record<string, Json>;
    const entry: Json = Object.hasOwn(tools, tool) ? { ...tools[tool] } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete entry[key]; else if (value !== undefined) entry[key] = value;
    }
    tools[tool] = entry;
  });
}

export interface AddSpec { id: string; transport: 'stdio' | 'http'; command?: string[]; cwd?: string; url?: string; secretNames: readonly string[] }

// 追加の API が作るものと同じ形（enabled:true・localOk:false・道具は空・環境変数の名前は自動）
export function previewAdd(saved: Config, spec: AddSpec): Config {
  const next = structuredClone(saved);
  const mcp = (next.mcp ??= { servers: [] }) as Json;
  const refs = Object.fromEntries(spec.secretNames.map(name => [name, mcpEnvName(spec.id, spec.transport === 'stdio' ? 'env' : 'header', name)]));
  const server: Json = { id: spec.id, transport: spec.transport, enabled: true, localOk: false, tools: {}, env: {}, headers: {} };
  if (spec.command) server.command = [...spec.command];
  if (spec.cwd) server.cwd = spec.cwd;
  if (spec.url) server.url = spec.url;
  if (spec.transport === 'stdio') server.env = refs; else server.headers = refs;
  mcp.servers = [...((mcp.servers ?? []) as Json[]), server];
  return next;
}

// ---- 追加フォーム ----

export interface SecretRow { name: string; value: string }
export interface AddForm {
  name: string;
  id: string;
  // id を自分で直したら、名前を変えても作り直さない
  idTouched: boolean;
  transport: 'stdio' | 'http';
  program: string;
  args: string;
  cwd: string;
  url: string;
  rows: SecretRow[];
}

export const emptyAddForm = (): AddForm => ({ name: '', id: '', idTouched: false, transport: 'stdio', program: '', args: '', cwd: '', url: '', rows: [] });

// 引数は 1 行に 1 つ。空白・引用符・$・`・; は解釈せず、そのまま 1 つの引数にする（シェルを通さない）。空の行は読み飛ばす
export function argsFromText(text: string): string[] {
  return text.split(/\r?\n/u).filter(line => line.trim() !== '');
}

// 名前から id を作る（小文字と数字だけ・先頭は英字・16 字まで）。作れなければ空
export function idFromName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/gu, '').replace(/^[0-9]+/u, '');
  return cleaned.slice(0, 16);
}

const filled = (rows: readonly SecretRow[]): SecretRow[] => rows.filter(r => r.name.trim() !== '' || r.value !== '');

function urlAllowed(text: string): boolean {
  let url: URL;
  try { url = new URL(text); } catch { return false; }
  if (url.protocol === 'https:') return true;
  // http は、この PC の中（loopback）だけ
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/u.test(url.hostname));
}

export type AddProblem = 'id' | 'taken' | 'program' | 'url' | 'secret_name' | 'secret_value';

// 送る前の入力の誤り（最初の 1 つ）。サーバーも同じ検査をするので、ここは早く気づくためのもの
export function addProblem(form: AddForm, taken: readonly string[]): AddProblem | null {
  if (!PATTERNS.id.test(form.id)) return 'id';
  if (taken.includes(form.id)) return 'taken';
  if (form.transport === 'stdio' && form.program.trim() === '') return 'program';
  if (form.transport === 'http' && !urlAllowed(form.url.trim())) return 'url';
  const pattern = form.transport === 'stdio' ? PATTERNS.envName : PATTERNS.headerName;
  const seen = new Set<string>();
  for (const row of filled(form.rows)) {
    const name = row.name.trim();
    const key = form.transport === 'stdio' ? name : name.toLowerCase();
    if (!pattern.test(name) || seen.has(key)) return 'secret_name';
    seen.add(key);
    if (row.value === '') return 'secret_value';
  }
  return null;
}

export function addSpec(form: AddForm): AddSpec {
  const cwd = form.cwd.trim();
  return {
    id: form.id, transport: form.transport,
    ...(form.transport === 'stdio' ? { command: [form.program.trim(), ...argsFromText(form.args)], ...(cwd ? { cwd } : {}) } : { url: form.url.trim() }),
    secretNames: filled(form.rows).map(r => r.name.trim()),
  };
}

// 追加の API へ送る本文。秘密の値は、ここにだけ載る
export function addBody(form: AddForm): McpAddInput {
  const spec = addSpec(form);
  const rows = filled(form.rows);
  const values = Object.fromEntries(rows.map(r => [r.name.trim(), r.value]));
  return {
    id: spec.id, transport: spec.transport,
    ...(spec.command ? { command: spec.command } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.url ? { url: spec.url } : {}),
    ...(rows.length > 0 ? { secrets: spec.transport === 'stdio' ? { env: values } : { headers: values } } : {}),
  };
}

// 送ったあと・やめたときに、秘密の値を画面の状態から消す（名前は残す）。元の状態は書き換えない
export const scrubSecrets = (form: AddForm): AddForm => ({ ...form, rows: form.rows.map(r => ({ name: r.name, value: '' })) });

// ---- 失敗の扱い ----

// 操作を行う。失敗したら toast と誤りの欄の両方に出す（黙って戻さない）。スイッチは画面の状態ではなくサーバーの答えで決まるので、失敗すれば元の位置のまま
export async function attempt(
  run: () => Promise<unknown>,
  hooks: { describe: (failure: unknown) => string; onError: (message: string) => void; notify: (message: string) => void },
): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (failure) {
    const message = hooks.describe(failure);
    hooks.onError(message);
    hooks.notify(message);
    return false;
  }
}

// ---- 状態の見せ方 ----

export type Tone = 'ok' | 'busy' | 'bad' | 'off';
export const tone = (state: McpServerState): Tone => (state === 'ready' ? 'ok' : state === 'connecting' ? 'busy' : state === 'failed' ? 'bad' : 'off');

// 説明が変わって止まっている道具・maxTools で渡せていない道具・登録できている道具の数
export function summarize(server: { tools: ReadonlyArray<Pick<McpToolView, 'state'>> }): { changed: number; cut: number; registered: number } {
  const count = (state: McpToolView['state']): number => server.tools.filter(t => t.state === state).length;
  return { changed: count('changed'), cut: count('cut'), registered: count('registered') };
}

// サーバーが返す固定の理由の語を、画面の文言の鍵にする
export function reasonKey(reason: string | undefined): PlainKey {
  switch (reason) {
    case 'env_missing': return 'settings.mcp.reason.env_missing';
    case 'connect_failed': return 'settings.mcp.reason.connect_failed';
    case 'timeout': return 'settings.mcp.reason.timeout';
    case 'list_failed': return 'settings.mcp.reason.list_failed';
    case 'too_many_restarts': return 'settings.mcp.reason.too_many_restarts';
    case 'dropped': return 'settings.mcp.reason.dropped';
    case 'not_connected': return 'settings.mcp.reason.not_connected';
    default: return 'settings.mcp.reason.other';
  }
}

// 差分の「受け入れる」の前の確かめ用。見せた形と、押した時点の形が同じか（違えば受け入れず、見せ直す）
export const sameShape = (a: McpShapeView | undefined, b: McpShapeView | undefined): boolean =>
  a === undefined || b === undefined ? a === b : a.description === b.description && a.schema === b.schema && a.destructive === b.destructive;

// 前と今で、何が変わったか（長い文の後ろの変更を見落とさないための一言用）
export function shapeChanges(diff: McpDiffView): { description: boolean; schema: boolean; destructive: boolean } {
  const before = diff.before;
  if (!before) return { description: true, schema: true, destructive: diff.after.destructive };
  return { description: before.description !== diff.after.description, schema: before.schema !== diff.after.schema, destructive: before.destructive !== diff.after.destructive };
}