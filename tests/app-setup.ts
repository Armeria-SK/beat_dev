import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import type { McpConnect } from '../src/mcp/manager.ts';
import type { FolderDialogOptions } from '../src/projects/folder-dialog.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import type { BrowserDriver } from '../src/tools/browser/driver.ts';
import type { ToolDef } from '../src/tools/types.ts';
import type { JudgeLimitSet } from '../src/tools/pipeline.ts';
import type { DownloadNetwork, PageNetwork } from '../src/tools/web/public-page.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, JudgeAdapter, removeDir, testConfig } from './helpers.ts';

export function fakeModel(id: string, over: Partial<ModelConfig> = {}): ModelConfig {
  return { id, provider: 'fake', model: `${id}-name`, contextLength: 65536, maxOutputTokens: 1024, vision: false, ...over };
}

// 本物の App と Web サーバーを、偽のモデルの提供元で立ち上げる（ランダムなポート）。api() は Origin つきで呼ぶ
export async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { models?: ModelConfig[]; tools?: ToolDef[]; configure?: (config: ReturnType<typeof testConfig>) => void; env?: Record<string, string | undefined>; agentTimeoutMs?: number; judgeLimits?: JudgeLimitSet; judge?: string; fetch?: typeof fetch; mcpConnect?: McpConnect; browserDriver?: BrowserDriver; browserDisplay?: boolean; projectFolderExempt?: readonly string[]; downloadNetwork?: DownloadNetwork; webNetwork?: PageNetwork; now?: () => number; paths?: (paths: AppPaths) => AppPaths; botMemory?: boolean; folderDialog?: FolderDialogOptions } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beat-test-'));
  let stop = async (): Promise<void> => undefined;
  t.after(async () => { await stop(); await removeDir(dir); });
  // .env は、本物の置き場所（製品のフォルダ）ではなく、この試験の一時フォルダに置く
  const base = { ...resolvePaths(dir), env: join(dir, '.env') };
  const paths = options.paths ? options.paths(base) : base;
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FAKE_KEY', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = options.models ?? [fakeModel('m1'), fakeModel('m2')];
  config.routing = { chat: config.models.map(m => m.id), background: [], retriesPerModel: 0 };
  options.configure?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const adapters = new Map<string, FakeAdapter>();
  const logs: string[] = [];
  const app = new App({
    paths, databasePath: ':memory:', log: line => { logs.push(line); }, workerTimers: false, ...(options.env ? { env: options.env } : {}),
    adapterOverride: provider => { const made = options.judge === undefined ? new FakeAdapter(provider) : Object.assign(new JudgeAdapter(provider), { judgeAnswer: options.judge }); adapters.set(provider.id, made); return made; },
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.agentTimeoutMs !== undefined ? { agentTimeoutMs: options.agentTimeoutMs } : {}),
    ...(options.judgeLimits ? { judgeLimits: options.judgeLimits } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.mcpConnect ? { mcpConnect: options.mcpConnect } : {}),
    ...(options.browserDriver ? { browserDriver: options.browserDriver } : {}),
    ...(options.browserDisplay !== undefined ? { browserDisplay: options.browserDisplay } : {}),
    ...(options.projectFolderExempt ? { projectFolderExempt: options.projectFolderExempt } : {}),
    ...(options.downloadNetwork ? { downloadNetwork: options.downloadNetwork } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.botMemory ? { botMemory: true } : {}),
    ...(options.folderDialog ? { folderDialog: options.folderDialog } : {}),
  });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const port = (web.server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  web.setOrigins([origin]);
  stop = async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); };
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, {
    ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers },
  });
  const json = async (path: string, method: string, body?: unknown) => {
    const res = await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => ({})) as any };
  };
  return { app, web, adapter: () => adapters.get('fake')!, adapters, origin, api, json, paths, logs };
}

export const CONVERSATION = 'aaaaaaaa-0000-4000-8000-000000000001';
export const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 実行が終わるまで待つ（wait() は終わったあとだと undefined を返すので、実行の記録で見る）
export async function settled(app: App, runId: string): Promise<void> {
  await waitFor(() => app.runs.get(runId)?.ended_at != null, `run ${runId} ended`);
}

export async function waitFor(check: () => boolean, label = 'condition', ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

export function planChat(app: App, projectId: string): string {
  const chats = app.db.prepare("SELECT id FROM conversations WHERE project_id = ? AND kind = 'chat' AND parent_run_id IS NULL ORDER BY last_message_at DESC, rowid DESC").all(projectId) as Array<{ id: string }>;
  const planned = chats.find(row => app.plans.read(projectId, row.id) !== undefined);
  return planned?.id ?? chats[0]?.id ?? app.conversations.create({ projectId, ...(app.conversations.get(uuid(1)) ? {} : { id: uuid(1) }) }).id;
}

export function planFile(app: App, projectId: string): string {
  const dir = join(app.paths.projects, projectId, 'conversation-plans');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${planChat(app, projectId)}.md`);
}
