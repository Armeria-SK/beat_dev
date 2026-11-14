import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { defaultConfig, findModel, parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { contextAvailable } from '../src/engine/context-budget.ts';
import { compactPrompt, compactSpeaker, compactSystem, summarySection } from '../src/engine/prompts.ts';
import { estimateTextTokens } from '../src/engine/tokens.ts';
import type { ChatMessage, ToolCall, ToolSpec } from '../src/engine/types.ts';
import { buildDynamic, buildSnapshot, ensureWorkspace } from '../src/engine/workspace.ts';
import { Mesh, meshIndexLimit, wrapMeshIndex } from '../src/mesh/index.ts';
import { resolvePaths } from '../src/paths.ts';
import { AcceptanceStore } from '../src/projects/acceptance.ts';
import { PlanStore } from '../src/projects/plan.ts';
import { projectDir } from '../src/projects/store.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { redactExact, redactSecrets } from '../src/shared/redaction.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileList, fileRead } from '../src/tools/builtin/files.ts';
import { meshRead, meshSearch } from '../src/tools/builtin/mesh.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import {
  FILLER, GLOSSARY_ROWS, MAP_ROWS, MESH_QUESTIONS, PLAN_TEXT, PRODUCT_CHANGES, PRODUCT_FILES, PRODUCT_NAME, STATE_NOTES, type MeshQuestion,
} from '../tests/fixtures/mesh-questions.ts';

export type ProbeSet = 'a' | 'b' | 'bg' | 'c' | 'cg';
export const PROBE_SETS: readonly ProbeSet[] = ['a', 'b', 'bg', 'c', 'cg'];
export const SET_LABELS: Record<ProbeSet, string> = {
  a: 'A: no mesh (summary only)',
  b: 'B: mesh index + STATE.md',
  bg: 'B + GLOSSARY.md',
  c: 'C: B + MAP.md',
  cg: 'C + GLOSSARY.md',
};

const PROJECT_ID = 'bbbbbbbb-0000-4000-8000-00000000b5b0';
const MESH_FILES = ['plan.md', 'STATE.md', 'MAP.md', 'GLOSSARY.md', 'INDEX.md', 'DECISIONS.md', 'acceptance.json'];
const ANSWER_SHOWN = 160;
const NOW = new Date(Date.UTC(2026, 10, 14, 3, 0, 0));
const TIMEZONE = 'Asia/Tokyo';

export interface ProductEnv {
  set: ProbeSet;
  root: string;
  config: AppConfig;
  tools: ToolDef[];
  frozen: string;
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
  firstSearchHit: boolean | null;
  madeUp: string[];
  trustedStale: boolean;
  toolCalls: number;
  tools: string[];
  inputTokens: number;
  measured: boolean;
  turns: number;
  answer: string;
  failed?: string;
}

const write = (file: string, content: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); };
const norm = (text: string) => text.replaceAll('\\', '/').toLowerCase();
const oneLine = (text: string, secrets: readonly string[], max = ANSWER_SHOWN) => redactSecrets(redactExact(text, secrets)).replace(/\s+/gu, ' ').trim().slice(0, max);

export function probeConfig(model: ModelConfig, provider: ProviderConfig): AppConfig {
  const base = defaultConfig();
  return { ...base, timezone: TIMEZONE, providers: [provider], models: [model], routing: { ...base.routing, chat: [model.id], background: [model.id] } };
}

export async function buildProduct(base: string, set: ProbeSet, model: ModelConfig, provider: ProviderConfig): Promise<ProductEnv> {
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
    plans.write(PROJECT_ID, PLAN_TEXT, { by: 'owner', tainted: false, conversationId: null, runId: null });
    mesh.setState(PROJECT_ID, { ...STATE_NOTES }, { by: 'owner', external: false });
    if (set === 'c' || set === 'cg') for (const row of MAP_ROWS) await mesh.setMapRow(PROJECT_ID, root, row, { by: 'task', external: false });
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
    if (set === 'bg' || set === 'cg') for (const row of GLOSSARY_ROWS) mesh.setGlossary(PROJECT_ID, root, row, { by: 'task', external: false });
    await mesh.refreshMap(PROJECT_ID, root);
    mesh.persist(PROJECT_ID);
  }
  const capacity = model.contextLength ?? model.minContext;
  const available = contextAvailable(capacity, model);
  const policy = buildPolicy(config, paths, { root });
  const tools: ToolDef[] = mesh ? [fileList, fileRead, meshSearch, meshRead] : [fileList, fileRead];
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  const approvals = new ApprovalBroker(db);
  const services = { db, memory: undefined as never, emit: () => undefined, plans, acceptance, ...(mesh ? { mesh } : {}) };
  const ctx = (signal: AbortSignal): ToolContext => ({
    runId: 'probe', conversationId: 'probe', kind: 'chat', signal, config, paths, policy, workspace: root, project: { id: PROJECT_ID, root },
    taint: { tainted: false, sources: [] }, log: () => undefined, services, contextAvailable: available, model: { id: model.id, vision: false },
  });
  const run = async (call: ToolCall, context: ToolContext) => {
    const outcome = await runToolCall(call, context, { registry, approvals, db, emit: () => undefined, permissionMode: () => 'auto', conversationTainted: () => false });
    return { content: outcome.output.content, isError: outcome.output.isError === true };
  };
  const body = mesh ? mesh.indexBody(PROJECT_ID, meshIndexLimit(available)) : '';
  return {
    set, root, config, tools, run, ctx,
    frozen: buildSnapshot(paths, {}, 'en').text,
    meshIndex: body ? wrapMeshIndex(body, 'probe') : '',
    close: () => db.close(),
  };
}

export function madeUpPaths(answer: string, root: string): string[] {
  const rootSlash = `${norm(root)}/`;
  const found = new Set<string>();
  for (const raw of answer.match(/[\w.@:\\/-]*[\\/][\w.@\\/-]+|[\w-]+\.(?:tsx?|jsx?|mjs|json|md|css|html)\b/gu) ?? []) {
    let path = norm(raw).replace(/[.,:;)]+$/u, '');
    if (/^[a-z]+:\/\//u.test(path)) continue;
    if (path.startsWith(rootSlash)) path = path.slice(rootSlash.length);
    path = path.replace(/^\.\//u, '').replace(/^\/+/u, '').replace(/\/+$/u, '');
    if (!path || !/[a-z]/u.test(path)) continue;
    if (!/\.[a-z]+$/u.test(path) && path.split('/').some(part => part.length < 2)) continue;
    found.add(path);
  }
  const existing = new Set<string>([...Object.keys(PRODUCT_FILES).filter(rel => !PRODUCT_CHANGES.some(c => c.from === rel)), ...PRODUCT_CHANGES.map(c => c.to)].map(norm));
  const folders = new Set<string>([...existing].flatMap(rel => rel.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  const names = new Set<string>([...existing].map(rel => posix.basename(rel)));
  const meshNames = new Set(MESH_FILES.map(norm));
  return [...found].filter(path => {
    if (existing.has(path) || folders.has(path) || meshNames.has(path)) return false;
    if (!path.includes('/')) return !names.has(path);
    const tail = existing.has(path) || [...existing].some(rel => rel.endsWith(`/${path}`)) || [...folders].some(rel => rel.endsWith(`/${path}`));
    return !tail;
  });
}

export function scoreAnswer(question: MeshQuestion, answer: string): { correct: boolean; trustedStale: boolean } {
  const text = norm(answer);
  const correct = question.answers.some(expected => text.includes(norm(expected)));
  const trustedStale = question.stale !== undefined && text.includes(norm(question.stale)) && !correct;
  return { correct, trustedStale };
}

interface CallResult { text: string; calls: ToolCall[]; inputTokens: number | undefined }

async function callModel(adapter: ProviderAdapter, model: ModelConfig, system: { frozen: string; dynamic: string }, messages: ChatMessage[], tools: ToolSpec[], maxTokens: number, timeoutMs: number): Promise<CallResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let text = '';
  const calls: ToolCall[] = [];
  let inputTokens: number | undefined;
  for await (const event of adapter.stream({ model, system, messages, tools, maxOutputTokens: Math.min(maxTokens, model.maxOutputTokens), signal })) {
    if (event.type === 'text') text += event.delta;
    else if (event.type === 'tool_call') calls.push(event.call);
    else if (event.type === 'usage' && event.usage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + event.usage.inputTokens;
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
  onRow?: ((row: ProbeRow) => void) | undefined;
}

export interface ProbeRun { rows: ProbeRow[]; notes: string[]; added: Partial<Record<ProbeSet, number>> }

export async function runProbe(options: ProbeOptions): Promise<ProbeRun> {
  const { model, adapter } = options;
  const secrets = options.secrets ?? [];
  const questions = options.questions ?? MESH_QUESTIONS;
  const notes: string[] = [];
  const rows: ProbeRow[] = [];
  const added: Partial<Record<ProbeSet, number>> = {};
  let summary = '';
  try {
    summary = await compactSummary(adapter, model, options.maxTokens, options.timeoutMs);
    notes.push(`${model.id}: compaction summary ${estimateTextTokens(summary)} tokens`);
  } catch (error) {
    notes.push(`${model.id}: compaction failed (${oneLine(String((error as Error).message ?? error), secrets)}); questions are asked without a summary`);
  }
  const fileSpecs = ToolRegistry.specs([fileList, fileRead]);
  for (const set of options.sets) {
    const env = await buildProduct(join(options.base, model.id.replace(/[^\w.-]+/gu, '_')), set, model, adapter.provider);
    try {
      const specs = ToolRegistry.specs(env.tools, env.config);
      const dynamic = [buildDynamic(TIMEZONE, 'en', NOW, 'auto', { name: PRODUCT_NAME, root: env.root }), env.meshIndex, summarySection(summary, 'en')].filter(Boolean).join('\n\n');
      added[set] = estimateTextTokens(env.meshIndex) + estimateTextTokens(JSON.stringify(specs)) - estimateTextTokens(JSON.stringify(fileSpecs));
      for (const question of questions) {
        const row = await ask(env, question, { frozen: env.frozen, dynamic }, specs, options);
        rows.push(row);
        options.onRow?.(row);
      }
    } finally { env.close(); }
  }
  return { rows, notes, added };
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
        if (call.name === meshSearch.name && firstSearchHit === null && question.kind !== 'plan') firstSearchHit = question.answers.some(expected => norm(output.content).includes(norm(expected)));
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output.content, ...(output.isError ? { isError: true } : {}) });
      }
      if (turns === options.maxTurns) failed = 'turn limit';
    }
  } catch (error) {
    failed = oneLine(String((error as Error).message ?? error), secrets, 120) || 'error';
  }
  const { correct, trustedStale } = scoreAnswer(question, answer);
  return {
    model: options.model.id, set: env.set, question: question.id, kind: question.kind, lang: question.lang,
    correct, firstSearchHit: env.set === 'a' || question.kind === 'plan' ? null : firstSearchHit ?? false,
    madeUp: madeUpPaths(answer, env.root), trustedStale, toolCalls: used.length, tools: used, inputTokens, measured, turns,
    answer: oneLine(answer, secrets), ...(failed ? { failed } : {}),
  };
}

const median = (values: readonly number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface SetSummary {
  model: string; set: ProbeSet; questions: number; correct: number; location: number; plan: number; screen: number;
  firstSearchHits: number | null; madeUp: number; trustedStale: number; toolCalls: number; medianToolCalls: number; medianTokens: number; failed: number;
}

export function summarize(rows: readonly ProbeRow[]): SetSummary[] {
  const groups = new Map<string, ProbeRow[]>();
  for (const row of rows) groups.set(`${row.model}\u0000${row.set}`, [...(groups.get(`${row.model}\u0000${row.set}`) ?? []), row]);
  return [...groups.values()].map(group => {
    const ok = (kind: ProbeRow['kind']) => group.filter(r => r.kind === kind && r.correct).length;
    const searched = group.filter(r => r.kind === 'location' && r.firstSearchHit !== null);
    return {
      model: group[0]!.model, set: group[0]!.set, questions: group.length, correct: group.filter(r => r.correct).length,
      location: ok('location'), plan: ok('plan'), screen: ok('screen'),
      firstSearchHits: group[0]!.set === 'a' ? null : searched.filter(r => r.firstSearchHit).length,
      madeUp: group.reduce((n, r) => n + r.madeUp.length, 0), trustedStale: group.filter(r => r.trustedStale).length,
      toolCalls: group.reduce((n, r) => n + r.toolCalls, 0), medianToolCalls: median(group.map(r => r.toolCalls)),
      medianTokens: median(group.map(r => r.inputTokens)), failed: group.filter(r => r.failed !== undefined).length,
    };
  });
}

export type Verdict = 'helped' | 'no harm' | 'harm';

export function compareSets(base: SetSummary, next: SetSummary): { moreCorrect: number; madeUp: string; tokenRatio: number; verdict: Verdict } {
  const tokenRatio = base.medianTokens > 0 ? Math.round((next.medianTokens / base.medianTokens) * 100) / 100 : 0;
  const tokensOk = base.medianTokens > 0 && tokenRatio <= 1.2;
  const moreCorrect = next.correct - base.correct;
  const harm = moreCorrect < 0 || next.madeUp > base.madeUp || !tokensOk;
  const helped = !harm && moreCorrect >= 3 && next.madeUp <= Math.floor(base.madeUp / 2);
  return { moreCorrect, madeUp: `${base.madeUp} -> ${next.madeUp}`, tokenRatio, verdict: harm ? 'harm' : helped ? 'helped' : 'no harm' };
}

const COMPARISONS: ReadonlyArray<[ProbeSet, ProbeSet]> = [['a', 'b'], ['a', 'c'], ['b', 'c'], ['b', 'bg'], ['c', 'cg']];
const cell = (text: string) => text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

export interface ReportMeta { title: string; notes: readonly string[]; added: Record<string, Partial<Record<ProbeSet, number>>> }

export function renderReport(rows: readonly ProbeRow[], meta: ReportMeta): string {
  const summary = summarize(rows);
  const lines = [`# ${meta.title}`, '', ...meta.notes.map(n => `- ${n}`), ''];
  lines.push('Sets: ' + PROBE_SETS.map(s => `(${s}) ${SET_LABELS[s]}`).join(', '), '');
  lines.push('## Summary', '', '| model | set | correct | location (of 6) | plan (of 3) | screen (of 3) | first mesh_search hit (of 6) | made-up paths | trusted a stale row | tool calls (total / median) | median input tokens | added per request | failed |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summary) {
    const added = meta.added[s.model]?.[s.set];
    lines.push(`| ${s.model} | ${s.set} | ${s.correct} / ${s.questions} | ${s.location} | ${s.plan} | ${s.screen} | ${s.firstSearchHits ?? '-'} | ${s.madeUp} | ${s.trustedStale} | ${s.toolCalls} / ${s.medianToolCalls} | ${s.medianTokens} | ${added ?? '-'} | ${s.failed} |`);
  }
  lines.push('', '## Lines (mesh-plan.md section 6)', '', 'helped = at least 3 more correct than the base, made-up paths at most half, median tokens at most 1.2x. harm = fewer correct, more made-up paths, or tokens above 1.2x.', '');
  lines.push('| model | base -> set | more correct | made-up paths | token ratio | verdict |', '|---|---|---|---|---|---|');
  for (const model of [...new Set(summary.map(s => s.model))]) {
    for (const [from, to] of COMPARISONS) {
      const base = summary.find(s => s.model === model && s.set === from);
      const next = summary.find(s => s.model === model && s.set === to);
      if (!base || !next) continue;
      const c = compareSets(base, next);
      lines.push(`| ${model} | ${from} -> ${to} | ${c.moreCorrect} | ${c.madeUp} | ${c.tokenRatio} | ${c.verdict} |`);
    }
  }
  lines.push('', '## Questions', '', '| id | kind | language | stale row | question | expected |', '|---|---|---|---|---|---|');
  const asked = new Set(rows.map(r => r.question));
  for (const q of MESH_QUESTIONS.filter(q => asked.has(q.id))) lines.push(`| ${q.id} | ${q.kind} | ${q.lang} | ${q.stale ?? '-'} | ${cell(q.text)} | ${cell(q.answers.join(' / '))} |`);
  lines.push('', '## Answers', '', '| model | set | question | correct | first search hit | made-up paths | stale | tools | input tokens | answer / failure |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const hit = r.firstSearchHit === null ? '-' : r.firstSearchHit ? 'yes' : 'no';
    const tokens = `${r.inputTokens}${r.measured ? '' : ' (est.)'}`;
    lines.push(`| ${r.model} | ${r.set} | ${r.question} | ${r.correct ? 'yes' : 'no'} | ${hit} | ${cell(r.madeUp.join(', ') || '-')} | ${r.trustedStale ? 'yes' : '-'} | ${cell(r.tools.join(', ') || '-')} | ${tokens} | ${cell(r.failed ? `FAILED: ${r.failed}${r.answer ? ` / ${r.answer}` : ''}` : r.answer)} |`);
  }
  return `${lines.join('\n')}\n`;
}

const USAGE = 'Usage: node scripts/mesh-probe.ts --config <settings.json> [--models id,id] [--sets a,b,bg,c,cg] [--questions L1,P1] [--turns 6] [--max-tokens 1500] [--timeout 120000] [--work <folder>] [--out <file.md>]';

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
  const rows: ProbeRow[] = [];
  const notes = [`date: ${new Date().toISOString()}`, `max turns: ${maxTurns}, max output tokens: ${maxTokens}, timeout per call: ${timeoutMs} ms`, 'tools: file_list, file_read (all sets) + mesh_search, mesh_read (B and C); asked after compaction (the summary of a filled conversation is in the system text)', `models measured: ${ids.length}`];
  const added: ReportMeta['added'] = {};
  try {
    for (const id of ids) {
      const found = findModel(config, id);
      if (!found) { notes.push(`${id}: not in models, skipped`); continue; }
      const adapter = registry.get(found.provider.id);
      if (!adapter) { notes.push(`${id}: no adapter, skipped`); continue; }
      notes.push(redactSecrets(`${id}: ${found.provider.kind} ${found.provider.baseUrl ?? ''} model ${found.model.model}`, secrets));
      const result = await runProbe({
        model: found.model, adapter, sets, questions, base: work, maxTurns, maxTokens, timeoutMs, secrets,
        onRow: r => process.stderr.write(`${r.model} ${r.set} ${r.question}: ${r.correct ? 'correct' : 'wrong'}${r.failed ? ` (${r.failed})` : ''} tools ${r.toolCalls}\n`),
      });
      rows.push(...result.rows);
      notes.push(...result.notes);
      added[id] = result.added;
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const report = renderReport(rows, { title: 'Mesh probe', notes, added });
  if (values.out) writeFileSync(resolve(values.out), report);
  else process.stdout.write(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
}
