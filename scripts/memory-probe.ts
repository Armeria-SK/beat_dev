import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { App } from '../src/app.ts';
import type { AppConfig, ProviderConfig } from '../src/config/schema.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { checkWorkFolder } from '../src/projects/work-folder.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import { MEMORY_QUESTIONS, PASS_LINES, PROBE_NOTES, PROBE_PRODUCT, type MemoryQuestion, type MemoryQuestionKind } from '../tests/fixtures/memory-questions.ts';
import { readConfigFile } from './tool-tokens.ts';

// beat 10-4b: 登録されているモデルが、製品の記憶を読みに行くか・使うか・書けるかを数える。
// 写しの data/（使い捨ての一時フォルダ）に試しの製品と作り物の記憶を置き、問いごとに新しい会話で問う。出すのは数だけ（答え・記憶の中身は出さない）
const USAGE = 'usage: node scripts/memory-probe.ts --config <path to config.json> [--models id,id] [--questions D1,C1] [--timeout 180000] [--work <dir>] [--out <file>] [--json]';

export interface QuestionResult { id: string; kind: MemoryQuestionKind; read: boolean; readNote: boolean; searched: boolean; used: boolean; loaded: boolean; saved: boolean; english: boolean; failed: boolean; tools: number }
export interface ModelResult { modelId: string; results: QuestionResult[] }

export interface ProbeOptions {
  models?: readonly string[] | undefined;
  questions?: readonly string[] | undefined;
  timeoutMs?: number | undefined;
  work?: string | undefined;
  adapterOverride?: ((provider: ProviderConfig) => ProviderAdapter | undefined) | undefined;
  env?: Record<string, string | undefined> | undefined;
}

const MEMORY_FILE = /^memory\/([a-z0-9][a-z0-9-]*)\.md$/u;
const JAPANESE = /[぀-ヿ㐀-鿿]/u;

function fileOf(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as { file?: unknown };
    return typeof parsed.file === 'string' ? parsed.file.replaceAll('\\', '/').replace(/^\.\//u, '') : undefined;
  } catch { return undefined; }
}

// 子の担当を含めない（その会話の実行だけ）。道具の入力は伏せ字ずみの記録
function toolsOf(app: App, conversationId: string): Array<{ tool: string; input: string; ok: number | null }> {
  return app.db.prepare('SELECT tool, input, ok FROM tool_calls WHERE conversation_id = ? ORDER BY rowid').all(conversationId) as Array<{ tool: string; input: string; ok: number | null }>;
}

function answerOf(app: App, conversationId: string): string {
  const rows = app.db.prepare("SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id").all(conversationId) as Array<{ text: string }>;
  return rows.map(r => r.text).join('\n');
}

async function finish(app: App, runId: string, timeoutMs: number): Promise<boolean> {
  const done = app.engine.wait(runId);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    (done ?? Promise.resolve(undefined)).then(() => false),
    new Promise<boolean>(r => { timer = setTimeout(() => r(true), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (timedOut) { app.engine.stop(runId); await done?.catch(() => undefined); }
  for (let i = 0; i < 400 && app.runs.get(runId)?.ended_at == null; i++) await new Promise(r => setTimeout(r, 5));
  return !timedOut && app.runs.get(runId)?.ok === 1;
}

export function judge(question: MemoryQuestion, tools: ReadonlyArray<{ tool: string; input: string; ok: number | null }>, answer: string, before: ReadonlySet<string>, after: ReadonlyMap<string, string>, failed: boolean): QuestionResult {
  const reads = tools.filter(t => t.tool === 'mesh_read').map(t => fileOf(t.input)).filter((f): f is string => f !== undefined);
  const memoryReads = reads.map(f => MEMORY_FILE.exec(f)?.[1]).filter((n): n is string => n !== undefined);
  const nonMesh = tools.filter(t => t.tool !== 'mesh_read' && t.tool !== 'mesh_search').map(t => t.input).join('\n');
  const created = [...after.keys()].filter(name => !before.has(name));
  return {
    id: question.id, kind: question.kind, failed, tools: tools.length,
    read: memoryReads.length > 0,
    readNote: question.note !== undefined && memoryReads.includes(question.note),
    searched: tools.some(t => t.tool === 'mesh_search'),
    used: question.marker !== undefined && (question.marker.test(answer) || question.marker.test(nonMesh)),
    loaded: tools.some(t => t.tool === 'tool_search' && /memory_save/u.test(t.input)),
    saved: created.length > 0 && tools.some(t => t.tool === 'memory_save' && t.ok === 1),
    english: created.length > 0 && created.every(name => !JAPANESE.test(after.get(name) ?? '')),
  };
}

async function probeModel(source: AppConfig, modelId: string, questions: readonly MemoryQuestion[], options: ProbeOptions): Promise<ModelResult> {
  const base = options.work ? resolve(options.work) : tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = realpathSync.native(mkdtempSync(join(base, 'beat-memory-probe-')));
  let app: App | undefined;
  try {
    const paths = { ...resolvePaths(join(dir, 'home')), env: join(dir, '.env') };
    mkdirSync(paths.data, { recursive: true });
    const config: AppConfig = { ...source, tools: { ...source.tools, hooks: { preToolUse: [], postToolUse: [] } } };
    writeFileSync(paths.config, JSON.stringify(config));
    const products = join(dir, 'products');
    app = new App({
      paths, databasePath: join(paths.data, 'beat.db'), log: () => undefined, workerTimers: false, env: options.env ?? process.env, projectFolderExempt: [products],
      ...(options.adapterOverride ? { adapterOverride: options.adapterOverride } : {}),
    });
    const live = app;
    await live.status.probeAll(live.config());
    const root = join(products, PROBE_PRODUCT);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), `# ${PROBE_PRODUCT}\n\nLunch pre-orders for office teams.\n`);
    const checked = checkWorkFolder(root, { paths: live.paths, appRoot: APP_ROOT, config: live.config(), active: live.projects.list(), exempt: live.projectFolderExempt });
    if (!checked.ok) throw new Error(`could not register the probe product (${checked.reason})`);
    const project = live.projects.create({ name: PROBE_PRODUCT, root: checked.root, rootKey: checked.rootKey, checkCommand: null });
    for (const note of PROBE_NOTES) {
      const saved = live.memoryFiles.save(project.id, { title: note.title, content: note.content }, { actor: 'owner', tainted: false });
      if (saved.name !== note.name) throw new Error(`the probe note "${note.name}" was saved as "${saved.name}"`);
    }
    const results: QuestionResult[] = [];
    for (const question of questions) {
      const conversationId = randomUUID();
      const before = new Set(live.memoryFiles.list(project.id).map(n => n.name));
      const sent = live.engine.send(conversationId, question.text, [], [], { modelId, permissionMode: 'auto' }, { projectId: project.id });
      const ok = sent.ok ? await finish(live, sent.runId, options.timeoutMs ?? 180_000) : false;
      const after = new Map(live.memoryFiles.notesWithText(project.id).map(n => [n.name, n.text]));
      results.push(judge(question, toolsOf(live, conversationId), answerOf(live, conversationId), before, after, !ok));
    }
    return { modelId, results };
  } finally {
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function probe(source: AppConfig, options: ProbeOptions = {}): Promise<ModelResult[]> {
  const known = new Set(source.models.map(m => m.id));
  const models = options.models?.length ? [...options.models] : source.routing.chat.filter(id => known.has(id));
  const unknown = models.filter(id => !known.has(id));
  if (unknown.length) throw new Error(`unknown model(s): ${unknown.join(', ')}`);
  if (!models.length) throw new Error('no chat model in the config');
  const questions = options.questions?.length ? MEMORY_QUESTIONS.filter(q => options.questions!.includes(q.id)) : MEMORY_QUESTIONS;
  const out: ModelResult[] = [];
  for (const modelId of models) out.push(await probeModel(source, modelId, questions, options));
  return out;
}

export interface Summary { direct: number; directOf: number; indirect: number; indirectOf: number; controlReads: number; controlOf: number; write: number; writeOf: number; failed: number; pass: { direct: boolean; indirect: boolean; control: boolean; write: boolean } }

export function summarize(results: readonly QuestionResult[]): Summary {
  const of = (kind: MemoryQuestionKind) => results.filter(r => r.kind === kind);
  const direct = of('direct').filter(r => (r.read || r.searched) && r.used).length;
  const indirect = of('indirect').filter(r => (r.read || r.searched) && r.used).length;
  const controlReads = of('control').filter(r => r.read).length;
  const write = of('write').filter(r => r.saved).length;
  const s = { direct, directOf: of('direct').length, indirect, indirectOf: of('indirect').length, controlReads, controlOf: of('control').length, write, writeOf: of('write').length, failed: results.filter(r => r.failed).length };
  return {
    ...s,
    pass: {
      direct: s.directOf === 0 || direct >= Math.min(PASS_LINES.direct, s.directOf),
      indirect: s.indirectOf === 0 || indirect >= Math.min(PASS_LINES.indirect, s.indirectOf),
      control: controlReads <= s.controlOf / 2,
      write: s.writeOf === 0 || write >= Math.min(PASS_LINES.write, s.writeOf),
    },
  };
}

const yes = (v: boolean) => (v ? 'yes' : '-');
const verdict = (v: boolean) => (v ? 'pass' : 'BELOW');

export function renderTable(models: readonly ModelResult[]): string {
  const lines: string[] = [];
  for (const { modelId, results } of models) {
    const s = summarize(results);
    lines.push(`## ${modelId}`, '',
      '| line | count | needed | result |', '|---|---|---|---|',
      `| direct: read and used the note | ${s.direct}/${s.directOf} | ${PASS_LINES.direct}/5 | ${verdict(s.pass.direct)} |`,
      `| indirect: read and used the note | ${s.indirect}/${s.indirectOf} | ${PASS_LINES.indirect}/5 | ${verdict(s.pass.indirect)} |`,
      `| control: read a note anyway | ${s.controlReads}/${s.controlOf} | at most half | ${verdict(s.pass.control)} |`,
      `| write: saved a note | ${s.write}/${s.writeOf} | ${PASS_LINES.write}/3 | ${verdict(s.pass.write)} |`,
      `| runs that failed or timed out | ${s.failed} | | |`, '',
      '| question | kind | read memory | read the right note | mesh_search | used the note | loaded memory_save | saved | saved in English | tool calls | failed |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...results.map(r => `| ${r.id} | ${r.kind} | ${yes(r.read)} | ${r.kind === 'direct' || r.kind === 'indirect' ? yes(r.readNote) : ''} | ${yes(r.searched)} | ${r.kind === 'direct' || r.kind === 'indirect' ? yes(r.used) : ''} | ${r.kind === 'write' ? yes(r.loaded) : ''} | ${r.kind === 'write' ? yes(r.saved) : ''} | ${r.kind === 'write' ? yes(r.english) : ''} | ${r.tools} | ${yes(r.failed)} |`),
      '');
  }
  lines.push('Only counts are shown. Answers and note contents are not printed.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, models: { type: 'string' }, questions: { type: 'string' }, timeout: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(USAGE); return; }
  if (!values.config) throw new Error('--config is required');
  const list = (v: string | undefined) => v?.split(',').map(s => s.trim()).filter(Boolean);
  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000)) throw new Error('--timeout must be an integer of at least 1000 (ms)');
  const results = await probe(readConfigFile(values.config), { models: list(values.models), questions: list(values.questions), timeoutMs, work: values.work });
  const text = values.json ? JSON.stringify(results, null, 2) : renderTable(results);
  if (values.out) writeFileSync(resolve(values.out), `${text}\n`);
  console.log(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`memory-probe: ${(error as Error).message}`); console.error(USAGE); process.exitCode = 1; });
}
