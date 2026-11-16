import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { App } from '../../src/app.ts';
import type { AppConfig } from '../../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../../src/engine/types.ts';
import { resolvePaths } from '../../src/paths.ts';
import { createWebServer } from '../../src/web/server.ts';
import { FakeAdapter, tempDir, type Script, testConfig, withLoad } from '../helpers.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

// 偽の時計・偽のモデル・メモリの中の DB で App と Web サーバーを立てる（タスクの API のテスト用）
export async function taskApp(t: { after: (fn: () => void) => void }, edit: (config: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const logs: string[] = [];
  const app = new App({
    paths, databasePath: ':memory:', log: line => { logs.push(line); }, now: () => clock.now, workerTimers: false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); app.close(); });
  const api = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(`${origin}${path}`, { method, headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  const userTask = (title: string, extra: Partial<Parameters<typeof app.tasks.create>[0]> = {}) =>
    app.tasks.create({ title, origin: 'user', actor: 'user', ...extra });
  const count = (table: string, where = '1 = 1', ...args: Array<string | number>) =>
    (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n;
  // 会話で 1 回送り、実行が終わるまで待つ（モデルの台本は adapter().scripts に先に積む）
  const chat = async (text: string, conversationId = 'c1') => {
    const outcome = app.engine.send(conversationId, text);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome));
    await app.engine.wait(outcome.runId);
  };
  return { app, adapter: () => adapter, clock, events, logs, api, origin, userTask, count, chat };
}
