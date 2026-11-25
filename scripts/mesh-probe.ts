import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { builtinTools } from '../src/app.ts';
import type { AppConfig, Language, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { defaultConfig, findModel, parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { usualTools } from '../src/engine/chat.ts';
import { contextAvailable, maxOutputFor } from '../src/engine/context-budget.ts';
import { compactPrompt, compactSpeaker, compactSystem, summarySection } from '../src/engine/prompts.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import type { ChatMessage, ToolCall, ToolSpec } from '../src/engine/types.ts';
import { buildDynamic, buildSnapshot, ensureWorkspace } from '../src/engine/workspace.ts';
import { Mesh, meshIndexLimit, wrapMeshIndex } from '../src/mesh/index.ts';
import { type AppPaths, resolvePaths } from '../src/paths.ts';
import { AcceptanceStore } from '../src/projects/acceptance.ts';
import { instructionsBudget, instructionsSection, readInstructions } from '../src/projects/instructions.ts';
import { PlanStore } from '../src/projects/plan.ts';
import { projectDir } from '../src/projects/store.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { redactExact, redactSecrets } from '../src/shared/redaction.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { isBrowserTool } from '../src/tools/browser/names.ts';
import { fileList, fileRead } from '../src/tools/builtin/files.ts';
import { MEMORY_TOOL_NAMES } from '../src/tools/builtin/memory.ts';
import { meshRead, meshSearch } from '../src/tools/builtin/mesh.ts';
import { acceptanceAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { isCore, ToolRegistry } from '../src/tools/registry.ts';
import { effectivePolicy } from '../src/tools/tool-policy.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import {
  FILLER, MESH_QUESTIONS, PLAN_TEXT, PRODUCT_CHANGES, PRODUCT_FILES, PRODUCT_NAME, STATE_NOTES, type MeshQuestion,
} from '../tests/fixtures/mesh-questions.ts';

export type ProbeSet = 'a' | 'b';
export const PROBE_SETS: readonly ProbeSet[] = ['a', 'b'];
export const SET_LABELS: Record<ProbeSet, string> = {
  a: 'A: no mesh (summary only)',
  b: 'B: mesh index + STATE.md',
};

const PROJECT_ID = 'bbbbbbbb-0000-4000-8000-00000000b5b0';
const PROBE_CONVERSATION = 'bbbbbbbb-0000-4000-8000-00000000c0c0';
const MESH_FILES = ['plan.md', 'STATE.md', 'INDEX.md', 'DECISIONS.md', 'acceptance.json'];
const MESH_TOOLS: readonly ToolDef[] = [meshSearch, meshRead];
const ANSWER_SHOWN = 160;
const CELL_SHOWN = 60;
const NOW = new Date(Date.UTC(2026, 10, 14, 3, 0, 0));
const TIMEZONE = 'Asia/Tokyo';
const HTTP_VERB = /^(?:get|post|put|patch|delete|head|options)$/u;
const UNKNOWN = new RegExp([
  '[分わ]か(?:りません|らない)', '見つか(?:りません|らな)', '見つけられ(?:ません|なかった|ない)', '見当た(?:りません|らな)', '存在(?:しません|しない|していません|していない)',
  '(?:ファイル|部品|処理|もの|機能|コード|実装|場所)(?:は|が|も)?(?:まだ)?(?:ありません|ない|無い|なさそう)', 'なさそう', '[な無]いよう', '確認でき(?:ません|なかった|ない)', 'まだ[無な]い', '作られてい(?:ない|ません)',
  '(?:実装|作成)(?:さ|し)れ?てい(?:ません|ない)', '作(?:られ|っ)てい(?:ません|ない)', '不明', '(?:情報|記載|該当)[^。、\\n]{0,8}?(?:ありません|ない|なし)', '含まれてい(?:ません|ない)', 'できてい(?:ません|ない)',
  'desconozco', 'no tengo información', 'ningún', 'ninguna', 'no file', 'none of', "(?:isn't|is not) in",
  'no (?:se )?encuentr', 'no he encontrado', 'no (?:lo )?encontr', 'no exist(?:e|en)', 'no hay (?:ningún|ninguna|ningun|archivo|un archivo|tal)', '(?:todavía|aún) no (?:existe|hay)', 'no sé',
  'not found', "(?:does|do)(?:n't| not) exist", 'no such', "(?:couldn't|could not|can't|cannot) find", "(?:don't|do not) know", 'there is no',
].join('|'), 'iu');

export interface ProductEnv {
  set: ProbeSet;
  root: string;
  config: AppConfig;
  paths: AppPaths;
  tools: ToolDef[];
  frozen: string;
  request: ChatRequest;
  meshIndex: string;
  ctx: (signal: AbortSignal) => ToolContext;
  run: (call: ToolCall, ctx: ToolContext) => Promise<{ content: string; isError: boolean }>;
  close: () => void;
}

export interface ProbeRow {
  model: string;
  set: ProbeSet;
  question: string;
  kind: MeshQuestion['kind'];
  lang: MeshQuestion['lang'];
  correct: boolean;
  saidUnknown: boolean | null;
  firstSearchHit: boolean | null;
  madeUp: string[];
  trustedStale: boolean;
  toolCalls: number;
  tools: string[];
  inputTokens: number;
  measured: boolean;
  turns: number;
  answer: string;
  turnLimit: boolean;
  failed?: string;
}

const write = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
const norm = (text: string) => text.replaceAll('\\', '/').toLowerCase();
const oneLine = (text: string, secrets: readonly string[], max = ANSWER_SHOWN) => redactSecrets(redactExact(text, secrets)).replace(/\s+/gu, ' ').trim().slice(0, max);
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const FINAL_FILES = [...Object.keys(PRODUCT_FILES).filter(rel => !PRODUCT_CHANGES.some(c => c.from === rel)), ...PRODUCT_CHANGES.map(c => c.to)].map(norm);
const FINAL_FOLDERS = new Set(FINAL_FILES.flatMap(rel => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
const TOP_FOLDERS = new Set(FINAL_FILES.filter(rel => rel.includes('/')).map(rel => rel.split('/')[0]!));
const FILE_NAMES = new Set(FINAL_FILES.map(rel => posix.basename(rel)));
const OLD_FILES = PRODUCT_CHANGES.map(c => norm(c.from));
const OLD_FOLDERS = new Set(OLD_FILES.flatMap(rel => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
const OLD_NAMES = new Set([...OLD_FILES.map(rel => posix.basename(rel)), ...MESH_QUESTIONS.flatMap(q => (q.stale ? [norm(q.stale)] : []))]);
const CONTENTS = norm([...Object.values(PRODUCT_FILES), ...PRODUCT_CHANGES.map(c => c.content ?? '')].join('\n'));
const MESH_NAMES = new Set(MESH_FILES.map(norm));
const MESH_TOOL_PREFIX = 'mesh_';

export function probeConfig(model: ModelConfig, provider: ProviderConfig): AppConfig {
  const base = defaultConfig();
  return { ...base, timezone: TIMEZONE, providers: [provider], models: [model], routing: { ...base.routing, chat: [model.id], background: [model.id] } };
}

export interface ChatRequest { frozen: string; baseTools: string[]; meshTools: string[]; baseTokens: number; meshSpecTokens: number }

export function productChatRequest(config: AppConfig, paths: AppPaths, model: ModelConfig, root: string, language: Language, smallestAvailable?: number): ChatRequest {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) if (!MEMORY_TOOL_NAMES.includes(tool.name)) registry.register(tool);
  const usual = new Set(usualTools(registry.list(), true, 'auto', model, smallestAvailable));
  const exclude = (t: ToolDef) => (t.name === 'agent_run' && !config.tools.agent.enabled) || (isBrowserTool(t.name) && !config.tools.browser.enabled)
    || effectivePolicy(t.name, config) === 'block' || !acceptanceAllows(t, false) || !(isCore(t) || usual.has(t.name));
  const chat = registry.forRun('chat', { exclude });
  const base = chat.filter(t => !t.name.startsWith(MESH_TOOL_PREFIX));
  const instructions = instructionsSection(readInstructions(root, instructionsBudget(smallestAvailable)));
  const frozen = buildSnapshot(paths, { persona: false, ...(instructions ? { instructions } : {}) }, language).text;
  const size = (tools: readonly ToolDef[]) => estimateTextTokens(JSON.stringify(ToolRegistry.specs(tools, config)));
  const withMesh = size(chat);
  return {
    frozen, baseTools: base.map(t => t.name), meshTools: chat.filter(t => t.name.startsWith(MESH_TOOL_PREFIX)).map(t => t.name),
    baseTokens: estimateTextTokens(frozen) + size(base), meshSpecTokens: withMesh - size(base),
  };
}

export function addedTokens(set: ProbeSet, request: ChatRequest, meshIndex: string): number {
  if (set === 'a') return 0;
  return estimateTextTokens(meshIndex) + request.meshSpecTokens;
}

export async function buildProduct(base: string, set: ProbeSet, model: ModelConfig, provider: ProviderConfig, source?: AppConfig): Promise<ProductEnv> {
  const top = join(base, set);
  const root = join(top, PRODUCT_NAME);
  for (const [rel, content] of Object.entries(PRODUCT_FILES)) write(join(root, rel), content);
  const paths = resolvePaths(join(top, 'data'));
  ensureWorkspace(paths);
  const config = probeConfig(model, provider);
  const db = openDatabase(':memory:', MIGRATIONS);
  const plans = new PlanStore(new KV(db), { projects: paths.projects, backups: paths.backups });
  const acceptance = new AcceptanceStore(db, paths.projects);
  const mesh = set === 'a' ? undefined : new Mesh({ projectsDir: paths.projects, backupsDir: paths.backups, plans, acceptance, timezone: () => TIMEZONE, now: () => NOW.getTime() });
  if (mesh) {
    mkdirSync(projectDir(paths.projects, PROJECT_ID), { recursive: true });
    db.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at, project_id) VALUES (?, 'chat', 0, 0, ?)").run(PROBE_CONVERSATION, PROJECT_ID);
    plans.write(PROJECT_ID, PROBE_CONVERSATION, PLAN_TEXT, { by: 'owner', tainted: false, conversationId: null, runId: null });
    mesh.setState(PROJECT_ID, { ...STATE_NOTES }, { by: 'owner', external: false });
  }
  for (const change of PRODUCT_CHANGES) {
    const from = join(root, change.from);
    const to = join(root, change.to);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    if (change.content !== undefined) writeFileSync(to, change.content);
    try { rmSync(dirname(from)); } catch { }
  }
  if (mesh) {
    mesh.persist(PROJECT_ID);
  }
  const capacity = model.contextLength;
  if (capacity === undefined) throw new Error(`mesh-probe needs contextLength for model ${model.id} (write it in the config)`);
  const available = contextAvailable(capacity, maxOutputFor(model, capacity));
  const policy = buildPolicy(config, paths, { root });
  const tools: ToolDef[] = mesh ? [fileList, fileRead, ...MESH_TOOLS] : [fileList, fileRead];
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const approvals = new ApprovalBroker(db);
  const services = { db, memory: undefined as never, emit: () => undefined, plans, acceptance, ...(mesh ? { mesh } : {}) };
  const ctx = (signal: AbortSignal): ToolContext => ({
    runId: 'probe', conversationId: PROBE_CONVERSATION, kind: 'chat', signal, config, paths, policy, workspace: root, project: { id: PROJECT_ID, root },
    taint: { tainted: false, sources: [] }, log: () => undefined, services, contextAvailable: available, model: { id: model.id, vision: false },
  });
  const run = async (call: ToolCall, context: ToolContext) => {
    const outcome = await runToolCall(call, context, { registry, approvals, db, emit: () => undefined, permissionMode: () => 'auto', conversationTainted: () => false });
    return { content: outcome.output.content, isError: outcome.output.isError === true };
  };
  const body = mesh ? mesh.indexBody(PROJECT_ID, meshIndexLimit(available), PROBE_CONVERSATION) : '';
  const request = productChatRequest(source ? { ...config, tools: source.tools } : config, paths, model, root, 'en', available);
  return {
    set, root, config, paths, tools, run, ctx, request,
    frozen: request.frozen,
    meshIndex: body ? wrapMeshIndex(body, 'probe') : '',
    close: () => db.close(),
  };
}

function pathTokens(answer: string, root: string): string[] {
  const rootSlash = `${norm(root)}/`;
  const found = new Set<string>();
  for (const match of answer.matchAll(/[\w.@:\\/-]*[\\/][\w.@\\/-]+|[\w-]+\.(?:tsx?|jsx?|mjs|json|md|css|html)\b/gu)) {
    const before = answer.slice(0, match.index).match(/([A-Za-z]+)\s*$/u)?.[1];
    if (before && HTTP_VERB.test(before.toLowerCase())) continue;
    let path = norm(match[0]).replace(/[.,:;)]+$/u, '');
    if (/^[a-z]+:\/\//u.test(path)) continue;
    if (path.startsWith(rootSlash)) path = path.slice(rootSlash.length);
    path = path.replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
    if (!path || !/[a-z]/u.test(path)) continue;
    const hasExtension = /\.[a-z]+$/u.test(path);
    if (!hasExtension && !TOP_FOLDERS.has(path.split('/')[0]!)) continue;
    if (MESH_NAMES.has(posix.basename(path))) continue;
    found.add(path);
  }
  return [...found];
}

const inProduct = (path: string) => {
  if (FINAL_FILES.includes(path) || FINAL_FOLDERS.has(path)) return true;
  if (!path.includes('/')) return FILE_NAMES.has(path);
  return FINAL_FILES.some(rel => rel.endsWith(`/${path}`)) || [...FINAL_FOLDERS].some(rel => rel.endsWith(`/${path}`));
};

const wasInProduct = (path: string) => {
  if (OLD_FILES.includes(path) || OLD_FOLDERS.has(path)) return true;
  if (!path.includes('/')) return OLD_NAMES.has(path);
  return OLD_FILES.some(rel => rel.endsWith(`/${path}`)) || [...OLD_FOLDERS].some(rel => rel.endsWith(`/${path}`));
};

export function madeUpPaths(answer: string, root: string): string[] {
  return pathTokens(answer, root).filter(path => !CONTENTS.includes(path) && !inProduct(path) && !wasInProduct(path));
}

export function productPaths(answer: string, root: string): string[] {
  return pathTokens(answer, root).filter(inProduct);
}

export function scoreAnswer(question: MeshQuestion, answer: string, paths: { madeUp?: readonly string[]; named?: readonly string[] } = {}): { correct: boolean; saidUnknown: boolean | null; trustedStale: boolean } {
  const text = norm(answer);
  if (question.kind === 'control') {
    const saidUnknown = UNKNOWN.test(answer);
    return { correct: saidUnknown && !(paths.madeUp?.length) && !(paths.named?.length), saidUnknown, trustedStale: false };
  }
  const correct = question.answers.some(expected => text.includes(norm(expected)));
  const trustedStale = question.stale !== undefined && text.includes(norm(question.stale)) && !correct;
  return { correct, saidUnknown: null, trustedStale };
}

export function searchHit(question: MeshQuestion, result: string): boolean {
  const text = norm(result);
  if (question.answers.some(expected => text.includes(norm(expected)))) return true;
  return question.mapRow !== undefined && new RegExp(`(?<![\\w/.-])${escapeRe(norm(question.mapRow))}(?![\\w-])`, 'u').test(text);
}

interface CallResult { text: string; calls: ToolCall[]; inputTokens: number | undefined }

async function callModel(adapter: ProviderAdapter, model: ModelConfig, system: { frozen: string; dynamic: string }, messages: ChatMessage[], tools: ToolSpec[], maxTokens: number, timeoutMs: number): Promise<CallResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let text = '';
  const calls: ToolCall[] = [];
  let inputTokens: number | undefined;
  for await (const event of adapter.stream({ model, system: { ...system, tail: '' }, messages, tools, maxOutputTokens: Math.min(maxTokens, maxOutputFor(model, model.contextLength ?? Infinity)), signal })) {
    if (event.type === 'text') text += event.delta;
    else if (event.type === 'tool_call') calls.push(event.call);
    else if (event.type === 'usage' && event.usage.inputTokens !== undefined) inputTokens = event.usage.inputTokens;
  }
  return { text, calls, inputTokens };
}

const requestTokens = (system: { frozen: string; dynamic: string }, messages: ChatMessage[], tools: ToolSpec[]) =>
  estimateTextTokens(`${system.frozen}\n${system.dynamic}\n${JSON.stringify(messages)}\n${JSON.stringify(tools)}`);

export async function compactSummary(adapter: ProviderAdapter, model: ModelConfig, maxTokens: number, timeoutMs: number): Promise<string> {
  const transcript = FILLER.map(m => `${compactSpeaker({ role: m.role }, 'en')}: ${m.text}`).join('\n');
  const result = await callModel(adapter, model, { frozen: compactSystem('en'), dynamic: '' }, [{ role: 'user', content: compactPrompt({ previous: null, transcript }, 'en') }], [], maxTokens, timeoutMs);
  return result.text.trim();
}

export interface ProbeOptions {
  model: ModelConfig;
  adapter: ProviderAdapter;
  sets: readonly ProbeSet[];
  questions?: readonly MeshQuestion[] | undefined;
  base: string;
  maxTurns: number;
  maxTokens: number;
  timeoutMs: number;
  secrets?: readonly string[] | undefined;
  config?: AppConfig | undefined;
  onRow?: ((row: ProbeRow) => void) | undefined;
}

export interface AddedParts { index: number; meshTools: number }
export interface RequestSizes { base: number; added: Partial<Record<ProbeSet, number>>; parts: Partial<Record<ProbeSet, AddedParts>> }
export interface ProbeRun { rows: ProbeRow[]; notes: string[]; request: RequestSizes }

export async function runProbe(options: ProbeOptions): Promise<ProbeRun> {
  const { model, adapter } = options;
  const secrets = options.secrets ?? [];
  const questions = options.questions ?? MESH_QUESTIONS;
  const notes: string[] = [];
  const rows: ProbeRow[] = [];
  const request: RequestSizes = { base: 0, added: {}, parts: {} };
  let summary = '';
  try {
    summary = await compactSummary(adapter, model, options.maxTokens, options.timeoutMs);
    notes.push(`${model.id}: compaction summary ${estimateTextTokens(summary)} tokens`);
  } catch (error) {
    notes.push(`${model.id}: compaction failed (${oneLine(String((error as Error).message ?? error), secrets)}); questions are asked without a summary`);
  }
  for (const set of options.sets) {
    const env = await buildProduct(join(options.base, model.id.replace(/[^\w.-]+/gu, '_')), set, model, adapter.provider, options.config);
    try {
      if (!request.base) {
        request.base = env.request.baseTokens;
        notes.push(`${model.id}: product chat request without mesh ${request.base} tokens (frozen system text + specs of ${env.request.baseTools.length} tools, measured with the app's builders); mesh tools the chat passes: ${env.request.meshTools.join(', ') || 'none'}`);
      }
      const specs = ToolRegistry.specs(env.tools, env.config);
      const total = addedTokens(set, env.request, env.meshIndex);
      const index = set === 'a' ? 0 : estimateTextTokens(env.meshIndex);
      const meshTools = set === 'a' ? 0 : env.request.meshSpecTokens;
      request.parts[set] = { index, meshTools };
      request.added[set] = total;
      const dynamic = [buildDynamic(TIMEZONE, 'en', NOW, 'auto', { name: PRODUCT_NAME, root: env.root }), env.meshIndex, summarySection(summary, 'en')].filter(Boolean).join('\n\n');
      for (const question of questions) {
        const row = await ask(env, question, { frozen: env.frozen, dynamic }, specs, options);
        rows.push(row);
        options.onRow?.(row);
      }
    } finally { env.close(); }
  }
  return { rows, notes, request };
}

async function ask(env: ProductEnv, question: MeshQuestion, system: { frozen: string; dynamic: string }, specs: ToolSpec[], options: ProbeOptions): Promise<ProbeRow> {
  const secrets = options.secrets ?? [];
  const messages: ChatMessage[] = [{ role: 'user', content: question.text }];
  const used: string[] = [];
  let firstSearchHit: boolean | null = null;
  let inputTokens = 0;
  let measured = true;
  let answer = '';
  let turns = 0;
  let failed: string | undefined;
  let turnLimit = false;
  try {
    while (turns < options.maxTurns) {
      turns++;
      const estimate = requestTokens(system, messages, specs);
      const result = await callModel(options.adapter, options.model, system, messages, specs, options.maxTokens, options.timeoutMs);
      if (result.inputTokens === undefined) measured = false;
      inputTokens += result.inputTokens ?? estimate;
      if (!result.calls.length) { answer = result.text; break; }
      messages.push({ role: 'assistant', content: result.text, toolCalls: result.calls });
      for (const call of result.calls) {
        used.push(call.name);
        const output = await env.run(call, env.ctx(AbortSignal.timeout(options.timeoutMs)));
        if (call.name === meshSearch.name && firstSearchHit === null && question.kind === 'location') firstSearchHit = searchHit(question, output.content);
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output.content, ...(output.isError ? { isError: true } : {}) });
      }
      if (turns === options.maxTurns) turnLimit = true;
    }
  } catch (error) {
    failed = oneLine(String((error as Error).message ?? error), secrets, 120) || 'error';
  }
  const madeUp = madeUpPaths(answer, env.root);
  const { correct, saidUnknown, trustedStale } = scoreAnswer(question, answer, { madeUp, named: productPaths(answer, env.root) });
  return {
    model: options.model.id, set: env.set, question: question.id, kind: question.kind, lang: question.lang,
    correct, saidUnknown, firstSearchHit: env.set === 'a' || question.kind !== 'location' ? null : firstSearchHit ?? false,
    madeUp: madeUp.map(path => oneLine(path, secrets, CELL_SHOWN)), trustedStale, toolCalls: used.length, tools: used.map(name => oneLine(name, secrets, CELL_SHOWN)),
    inputTokens, measured, turns, answer: oneLine(answer, secrets, question.kind === 'control' ? Infinity : ANSWER_SHOWN), turnLimit, ...(failed ? { failed } : {}),
  };
}

const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface SetSummary {
  model: string; set: ProbeSet; questions: number; correct: number; location: number; plan: number; controlUnknown: number; controlConfident: number;
  firstSearchHits: number | null; madeUp: number; trustedStale: number; toolCalls: number; medianToolCalls: number | null; medianTokens: number | null; failed: number;
}

export function summarize(rows: readonly ProbeRow[]): SetSummary[] {
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) groups.set(`${row.model}\u0000${row.set}`, [...(groups.get(`${row.model}\u0000${row.set}`) ?? []), row]);
  return [...groups.values()].map(group => {
    const ok = (kind: ProbeRow['kind']) => group.filter(r => r.kind === kind && r.correct).length;
    const answered = group.filter(r => r.failed === undefined);
    const controls = answered.filter(r => r.kind === 'control');
    const searched = group.filter(r => r.kind === 'location' && r.firstSearchHit !== null);
    return {
      model: group[0]!.model, set: group[0]!.set, questions: group.length, correct: group.filter(r => r.correct).length,
      location: ok('location'), plan: ok('plan'), controlUnknown: controls.filter(r => r.saidUnknown).length, controlConfident: controls.filter(r => !r.saidUnknown).length,
      firstSearchHits: group[0]!.set === 'a' ? null : searched.filter(r => r.firstSearchHit).length,
      madeUp: group.reduce((n, r) => n + r.madeUp.length, 0), trustedStale: group.filter(r => r.trustedStale).length,
      toolCalls: group.reduce((n, r) => n + r.toolCalls, 0), medianToolCalls: median(answered.map(r => r.toolCalls)),
      medianTokens: median(answered.map(r => r.inputTokens)), failed: group.length - answered.length,
    };
  });
}

export interface Comparison { moreCorrect: number; madeUp: string; tokenRatio: number | null; verdict: string }

export function compareSets(base: SetSummary, next: SetSummary, request: { base: number; next: number }): Comparison {
  const moreCorrect = next.correct - base.correct;
  const madeUp = `${base.madeUp} -> ${next.madeUp}`;
  const tokenRatio = request.base > 0 ? Math.round((request.next / request.base) * 100) / 100 : null;
  if (base.failed || next.failed) return { moreCorrect, madeUp, tokenRatio, verdict: `n/a: ${base.failed + next.failed} failed questions` };
  if (tokenRatio === null) return { moreCorrect, madeUp, tokenRatio, verdict: 'n/a: no base request size' };
  const harms = [
    ...(moreCorrect < 0 ? ['correct fell'] : []),
    ...(next.madeUp > base.madeUp ? ['made-up paths rose'] : []),
    ...(tokenRatio > 1.2 ? [`tokens ${tokenRatio}x`] : []),
  ];
  if (harms.length) return { moreCorrect, madeUp, tokenRatio, verdict: `harm: ${harms.join(', ')}` };
  const helped = moreCorrect >= 3 && next.madeUp <= Math.floor(base.madeUp / 2);
  return { moreCorrect, madeUp, tokenRatio, verdict: helped ? 'helped' : 'no harm' };
}

const COMPARISONS: ReadonlyArray<[ProbeSet, ProbeSet]> = [['a', 'b']];
const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
const shown = (value: number | null) => (value === null ? 'n/a' : String(value));

export interface ReportMeta { title: string; notes: readonly string[]; requests: Record<string, RequestSizes> }

export function renderReport(rows: readonly ProbeRow[], meta: ReportMeta): string {
  const summary = summarize(rows);
  const lines = [`# ${meta.title}`, '', ...meta.notes.map(n => `- ${n}`), ''];
  lines.push('Sets: ' + PROBE_SETS.map(s => `(${s}) ${SET_LABELS[s]}`).join(', '), '');
  lines.push('## Summary', '', '| model | set | correct | location (of 6) | plan (of 3) | control said unknown (of 3) | control answered confidently | first mesh_search hit (of 6) | made-up paths | trusted a stale row | tool calls (total / median) | median input tokens per question | request tokens (base + added) | added: index + mesh tools | failed |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summary) {
    const request = meta.requests[s.model];
    const added = request?.added[s.set];
    const size = request && added !== undefined ? `${request.base + added} (${request.base} + ${added})` : 'n/a';
    const part = request?.parts[s.set];
    const parts = part ? `${part.index} + ${part.meshTools}` : 'n/a';
    lines.push(`| ${s.model} | ${s.set} | ${s.correct} / ${s.questions} | ${s.location} | ${s.plan} | ${s.controlUnknown} | ${s.controlConfident} | ${s.firstSearchHits ?? '-'} | ${s.madeUp} | ${s.trustedStale} | ${s.toolCalls} / ${shown(s.medianToolCalls)} | ${shown(s.medianTokens)} | ${size} | ${parts} | ${s.failed} |`);
  }
  lines.push('', '## Lines (mesh-plan.md section 6)', '', 'helped = at least 3 more correct than the base, made-up paths at most half, request tokens at most 1.2x. harm = fewer correct, more made-up paths, or request tokens above 1.2x. Request tokens = the product chat request without mesh (frozen system text + tool specs) plus what the set adds (mesh index + mesh tool specs). Correct counts a control only when it said unknown without naming any path. Hand-check the control answers (K1-K3, 3 per set) in the Answers table: the unknown check is a phrase list.', '');
  lines.push('| model | base -> set | more correct | made-up paths | request token ratio | verdict |', '|---|---|---|---|---|---|');
  for (const model of [...new Set(summary.map(s => s.model))]) {
    const request = meta.requests[model];
    for (const [from, to] of COMPARISONS) {
      const base = summary.find(s => s.model === model && s.set === from);
      const next = summary.find(s => s.model === model && s.set === to);
      if (!base || !next) continue;
      const sizes = { base: request ? request.base + (request.added[from] ?? 0) : 0, next: request ? request.base + (request.added[to] ?? 0) : 0 };
      const c = compareSets(base, next, sizes);
      lines.push(`| ${model} | ${from} -> ${to} | ${c.moreCorrect} | ${c.madeUp} | ${shown(c.tokenRatio)} | ${c.verdict} |`);
    }
  }
  lines.push('', '## Questions', '', '| id | kind | language | map row | stale row | question | expected |', '|---|---|---|---|---|---|---|');
  const asked = new Set(rows.map(r => r.question));
  for (const q of MESH_QUESTIONS.filter(q => asked.has(q.id))) lines.push(`| ${q.id} | ${q.kind} | ${q.lang} | ${q.mapRow ?? '-'} | ${q.stale ?? '-'} | ${cell(q.text)} | ${cell(q.answers.join(' / ') || 'unknown')} |`);
  lines.push('', '## Answers', '', '| model | set | question | correct | first search hit | made-up paths | stale | tools | input tokens | answer / failure |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const hit = r.firstSearchHit === null ? '-' : r.firstSearchHit ? 'yes' : 'no';
    const tokens = r.failed ? 'n/a' : `${r.inputTokens}${r.measured ? '' : ' (est.)'}`;
    lines.push(`| ${r.model} | ${r.set} | ${r.question} | ${r.correct ? 'yes' : 'no'} | ${hit} | ${cell(r.madeUp.join(', ') || '-')} | ${r.trustedStale ? 'yes' : '-'} | ${cell(r.tools.join(', ') || '-')} | ${tokens} | ${cell(r.failed ? `FAILED: ${r.failed}${r.answer ? ` / ${r.answer}` : ''}` : r.turnLimit ? `TURN LIMIT${r.answer ? ` / ${r.answer}` : ''}` : r.answer)} |`);
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = 'Usage: node scripts/mesh-probe.ts --config <settings.json> [--models id,id] [--sets a,b] [--questions L1,P1] [--turns 6] [--max-tokens 1500] [--timeout 120000] [--work <folder>] [--out <file.md>]';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' }, models: { type: 'string' }, sets: { type: 'string', default: PROBE_SETS.join(',') }, questions: { type: 'string' },
      turns: { type: 'string', default: '6' }, 'max-tokens': { type: 'string', default: '1500' }, timeout: { type: 'string', default: '120000' }, work: { type: 'string' }, out: { type: 'string' },
    },
  });
  if (!values.config) throw new Error(USAGE);
  const config = parseConfig(JSON.parse(readFileSync(resolve(values.config), 'utf8')));
  const sets = values.sets.split(',').map(s => s.trim()).filter((s): s is ProbeSet => (PROBE_SETS as readonly string[]).includes(s));
  const wanted = values.questions ? new Set(values.questions.split(',').map(s => s.trim())) : undefined;
  const questions = wanted ? MESH_QUESTIONS.filter(q => wanted.has(q.id)) : MESH_QUESTIONS;
  const maxTurns = Number(values.turns);
  const maxTokens = Number(values['max-tokens']);
  const timeoutMs = Number(values.timeout);
  if (!sets.length || !questions.length || ![maxTurns, maxTokens, timeoutMs].every(n => Number.isInteger(n) && n >= 1)) throw new Error(USAGE);
  const ids = values.models ? values.models.split(',').map(s => s.trim()).filter(Boolean) : config.models.map(m => m.id);
  const registry = new ProviderRegistry({ env: process.env });
  registry.reload(config);
  const secrets = registry.secrets();
  const parent = values.work ? resolve(values.work) : tmpdir();
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(realpathSync.native(parent), 'beat-mesh-probe-'));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  const interrupted = () => { try { cleanup(); } catch { } process.exit(130); };
  process.once('SIGINT', interrupted);
  const rows: ProbeRow[] = [];
  const notes = [`date: ${new Date().toISOString()}`, `max turns: ${maxTurns}, max output tokens: ${maxTokens}, timeout per call: ${timeoutMs} ms`, 'tools: file_list, file_read (all sets) + mesh_search, mesh_read (B); asked after compaction (the summary of a filled conversation is in the system text)', `models measured: ${ids.length}`];
  const requests: ReportMeta['requests'] = {};
  try {
    for (const id of ids) {
      const found = findModel(config, id);
      if (!found) { notes.push(`${oneLine(id, secrets, CELL_SHOWN)}: not in models, skipped`); continue; }
      const adapter = registry.get(found.provider.id);
      if (!adapter) { notes.push(`${id}: no adapter, skipped`); continue; }
      notes.push(redactSecrets(`${id}: ${found.provider.kind} ${found.provider.baseUrl ?? ''} model ${found.model.model}`, secrets));
      const result = await runProbe({
        model: found.model, adapter, sets, questions, base: work, maxTurns, maxTokens, timeoutMs, secrets, config,
        onRow: r => process.stderr.write(`${r.model} ${r.set} ${r.question}: ${r.correct ? 'correct' : 'wrong'}${r.failed ? ` (${r.failed})` : ''} tools ${r.toolCalls}\n`),
      });
      rows.push(...result.rows);
      notes.push(...result.notes);
      requests[id] = result.request;
    }
  } finally {
    process.off('SIGINT', interrupted);
    cleanup();
  }
  const report = renderReport(rows, { title: 'Mesh probe', notes, requests });
  if (values.out) writeFileSync(resolve(values.out), report);
  else process.stdout.write(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
