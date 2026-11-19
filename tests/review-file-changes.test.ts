import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { resolvePaths } from '../src/paths.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

interface Change { id: number | string; action: string; before: string | null; after: string | null; undone_at: number | null; source?: string; name?: string; summary?: string | null }

test('GET /api/reviews: changes include the product memory files a review created or rewrote (memory_file_events), so the Runs screen no longer says "No memory changes"', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(join(dir, 'data'));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'm', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.skills = { grow: false };
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const root = join(dir, 'product');
  mkdirSync(root);
  const real = realpathSync.native(root);
  const project = app.projects.create({ name: 'Demo', root: real, rootKey: rootKeyOf(real), checkCommand: null });
  adapter.scripts.push(reply('ok'));
  const sent = app.engine.send('c1', 'remember: we deploy on Fridays', [], [], { permissionMode: 'auto' }, { projectId: project.id });
  assert.ok(sent.ok);
  await app.engine.wait(sent.runId);

  app.reviews.enqueue('manual', 'manual:c1:1', { conversationId: 'c1' });
  adapter.scripts.push(
    toolCall('memory_save', { title: 'Deploy day', content: 'Deploy on Fridays.', why: 'Owner asked to remember' }),
    toolCall('memory_update', { name: 'deploy-day', content: 'Deploy on Friday mornings.', why: 'Clarified the time' }),
    reply('Saved one note'),
  );
  assert.equal(await app.worker.tick(), 'ran');
  // 何も変えなかった振り返り
  app.reviews.enqueue('manual', 'manual:c1:2', { conversationId: 'c1' });
  app.conversations.append('c1', { role: 'user', content: 'thanks' });
  adapter.scripts.push(reply('No changes'));
  assert.equal(await app.worker.tick(), 'ran');
  // 振り返りでない実行の書き込みは、どの振り返りの行にも出ない
  app.memoryFiles.save(project.id, { title: 'By chat', content: 'x' }, { actor: 'beat', tainted: false, runId: 'chat-run', conversationId: 'c1' });

  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const body = await (await fetch(`${origin}/api/reviews`, { headers: { Origin: origin } })).json() as { jobs: Array<{ dedup_key: string; changes: Change[] }> };
  const saved = body.jobs.find(j => j.dedup_key === 'manual:c1:1')!;
  assert.deepEqual(saved.changes.map(c => [c.action, c.after, c.before, c.undone_at, c.source, c.name, c.summary]), [
    ['create', 'memory/deploy-day.md', null, null, 'file', 'deploy-day', 'Owner asked to remember'],
    ['update', 'memory/deploy-day.md', null, null, 'file', 'deploy-day', 'Clarified the time'],
  ]);
  assert.equal(new Set(saved.changes.map(c => c.id)).size, 2, 'each entry has its own key');
  assert.ok(saved.changes.every(c => typeof c.id === 'string'), 'file entries use their own key space, apart from memory_events ids');
  assert.deepEqual(body.jobs.find(j => j.dedup_key === 'manual:c1:2')!.changes, []);
});
