import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { App } from '../src/app.ts';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import { contextAvailable, maxOutputFor } from '../src/engine/context-budget.ts';
import { estimateRequest, estimateToolTokens } from '../src/engine/tokens.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { checkWorkFolder } from '../src/projects/work-folder.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';

const USAGE = 'usage: node scripts/tool-tokens.ts [--config <path to config.json>] [--json]';

const PROVIDER: ProviderConfig = { id: 'measure', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
// 推奨の下限の 64k のローカルのモデル（返事の上限は自動）。持ち主の決め 2026-11-19「推奨は 128k 以上～下限 64k」
export const MEASURE_MODEL: ModelConfig = { id: 'measure', provider: 'measure', model: 'measure', contextLength: 65_536, vision: false };

export const MODES = ['product plan', 'plan (no product)', 'chat (no product)', 'chat (product)', 'task', 'review', 'agent child'] as const;
export type Mode = typeof MODES[number];

export interface ModeRow { mode: Mode; tools: number; toolTokens: number; request: number; percent: number }
export interface Measured { available: number; rows: ModeRow[]; off: Mode[] }

type Step = (request: ModelRequest) => StreamEvent[];
const text = (): StreamEvent[] => [{ type: 'text', delta: 'ok' }, { type: 'done', stop: 'end_turn' }];
const toolCall = (name: string, args: unknown): Step => () => [{ type: 'tool_call', call: { id: `call_${name}`, name, arguments: args } }, { type: 'done', stop: 'tool_use' }];

function recorder(): ProviderAdapter & { requests: ModelRequest[]; steps: Step[] } {
  const requests: ModelRequest[] = [];
  const steps: Step[] = [];
  return {
    provider: PROVIDER, requests, steps,
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      yield* (steps.shift() ?? text)(request);
    },
    async probe(model: ModelConfig, required: number) {
      return { modelId: model.id, server: 'generic', required, declared: model.contextLength, effective: model.contextLength!, status: 'ok' as const, message: '', checkedAt: Date.now() };
    },
  };
}

export function measureConfig(source: AppConfig): AppConfig {
  return {
    ...source,
    providers: [PROVIDER],
    models: [MEASURE_MODEL],
    routing: { chat: [MEASURE_MODEL.id], background: [], retriesPerModel: 0 },
    tools: { ...source.tools, hooks: { preToolUse: [], postToolUse: [] } },
  };
}

const rowOf = (mode: Mode, request: ModelRequest, available: number): ModeRow => {
  const { tokens } = estimateRequest(`${request.system.frozen}\n${request.system.dynamic}`, [], request.tools, 1, request.system.tail);
  return { mode, tools: request.tools.length, toolTokens: request.tools.length ? estimateToolTokens(request.tools) : 0, request: tokens, percent: Math.round((tokens / available) * 1000) / 10 };
};

async function settle(app: App, runId: string): Promise<void> {
  await app.engine.wait(runId);
  for (let i = 0; i < 400 && app.runs.get(runId)?.ended_at == null; i++) await new Promise(r => setTimeout(r, 5));
}

export async function measure(source: AppConfig): Promise<Measured> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-tool-tokens-')));
  const adapter = recorder();
  let app: App | undefined;
  try {
    const paths = { ...resolvePaths(join(dir, 'home')), env: join(dir, '.env') };
    mkdirSync(paths.data, { recursive: true });
    writeFileSync(paths.config, JSON.stringify(measureConfig(source)));
    const products = join(dir, 'products');
    app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, env: {}, adapterOverride: () => adapter, projectFolderExempt: [products] });
    const live = app;
    await live.status.probeAll(live.config());
    const available = contextAvailable(MEASURE_MODEL.contextLength!, maxOutputFor(MEASURE_MODEL, MEASURE_MODEL.contextLength!));
    const root = join(products, 'Demo');
    mkdirSync(root, { recursive: true });
    const checked = checkWorkFolder(root, { paths: live.paths, appRoot: APP_ROOT, config: live.config(), active: live.projects.list(), exempt: live.projectFolderExempt });
    if (!checked.ok) throw new Error(`could not register the measuring product (${checked.reason})`);
    const project = live.projects.create({ name: 'Demo', root: checked.root, rootKey: checked.rootKey, checkCommand: null });
    const rows: ModeRow[] = [];
    const off: Mode[] = [];
    let n = 0;
    const conversationId = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    const first = async (mode: Mode, start: () => string | undefined | Promise<string | undefined>, pick = (from: number) => adapter.requests[from]) => {
      const from = adapter.requests.length;
      const runId = await start();
      if (runId) await settle(live, runId);
      const request = pick(from);
      if (!request) throw new Error(`no request was made for "${mode}"`);
      rows.push(rowOf(mode, request, available));
    };
    const chat = (permissionMode: 'auto' | 'plan', projectId?: string, id = conversationId()) => () => {
      const sent = live.engine.send(id, 'x', [], [], { permissionMode }, { projectId });
      if (!sent.ok) throw new Error('could not start a conversation run');
      return sent.runId;
    };
    await first('product plan', chat('plan', project.id));
    await first('plan (no product)', chat('plan'));
    await first('chat (no product)', chat('auto'));
    await first('chat (product)', chat('auto', project.id));
    await first('task', async () => {
      live.tasks.create({ title: 'Measure', origin: 'user', actor: 'user', runAt: Date.now() - 1000 });
      await live.worker.tick();
      return undefined;
    });
    const reviewed = conversationId();
    await settle(live, chat('auto', undefined, reviewed)());
    await first('review', () => {
      const started = live.engine.runReview(reviewed, 'x');
      if (!started.ok) throw new Error('could not start a review run');
      return started.runId;
    });
    if (live.config().tools.agent.enabled) {
      adapter.steps.push(toolCall('tool_search', { query: 'agent_run' }), toolCall('agent_run', { task: 'x' }));
      await first('agent child', chat('auto'), from => adapter.requests[from + 2]);
    } else off.push('agent child');
    return { available, rows, off };
  } finally {
    app?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function renderTable(measured: Measured): string {
  return [
    `available: ${measured.available}`,
    '',
    '| mode | tools | tool tokens | first request | % of available |',
    '|---|---|---|---|---|',
    ...measured.rows.map(r => `| ${r.mode} | ${r.tools} | ${r.toolTokens} | ${r.request} | ${r.percent.toFixed(1)}% |`),
    ...measured.off.map(mode => `| ${mode} | off | - | - | - |`),
    '',
    'MCP servers are not connected while measuring, so their tools are not counted.',
  ].join('\n');
}

export function readConfigFile(path: string | undefined): AppConfig {
  if (!path) return defaultConfig();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(resolve(path), 'utf8')); } catch { throw new Error('could not read the config file as JSON'); }
  try { return parseConfig(raw); } catch { throw new Error('the config file is not valid'); }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) { console.log(USAGE); return; }
  const measured = await measure(readConfigFile(values.config));
  console.log(values.json ? JSON.stringify(measured, null, 2) : renderTable(measured));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`tool-tokens: ${(error as Error).message}`); console.error(USAGE); process.exitCode = 1; });
}
