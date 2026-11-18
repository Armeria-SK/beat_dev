import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { FakeAdapter, reply, tempDir, testConfig } from './helpers.ts';
import { toolCall } from './helpers/task-app.ts';

// 考える実行（Scout）の考える深さ（scout.effort）が、まとめ役と子（agent_run）の要求に届くか。ふつうのタスクとその子には渡らないか

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'near', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'near', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false, efforts: ['low', 'high', 'xhigh'] }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0, scout: ['m'] };
  config.worker.enabled = true;
  config.memory.review = false;
  config.tools.agent.enabled = true;
  config.tools.agent.inTasks = true;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter: FakeAdapter | undefined;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => Date.parse('2026-11-19T03:00:00Z'), workerTimers: false,
    adapterOverride: p => { adapter ??= new FakeAdapter(p); return adapter; },
  });
  await app.status.probeAll(app.config());
  t.after(() => { app.worker.stop(); app.engine.stopAll(); app.close(); });
  const root = join(dir, 'shop');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  const projectId = app.projects.create({ name: 'shop', root, rootKey: rootKeyOf(root), checkCommand: null }).id;
  app.projects.update(projectId, { scoutMode: 'research' });
  const build = app.tasks.create({ title: 'build the shop', origin: 'user', actor: 'user', projectId, acceptanceItems: ['i1'] });
  app.tasks.finish(build.id, 'done', 'built', 'user');
  const runs = () => app.db.prepare('SELECT kind, flags FROM engine_runs ORDER BY started_at, rowid').all() as Array<{ kind: string; flags: string }>;
  return { app, projectId, adapter: () => adapter!, runs };
}

const scoutScript = [
  toolCall('agent_run', { task: 'Check the src folder', title: 'Check src' }),
  reply('area: src\nchecked: read a.ts\nresult: no problem'),
  reply('Checked src.'),
];

test('scout effort: scout.effort reaches the lead and its child agent_run when the model offers it, and both runs carry the flag', async t => {
  const s = await setup(t, c => { c.scout = { cloudRunsPerHour: 1, effort: 'xhigh' }; });
  s.adapter().scripts.push(...scoutScript);
  assert.equal(await s.app.worker.tick(), 'ran');
  const calls = s.adapter().calls;
  assert.equal(calls.length, 3, 'lead → child → lead');
  assert.deepEqual(calls.map(c => c.effort), ['xhigh', 'xhigh', 'xhigh']);
  const runs = s.runs();
  const lead = runs.filter(r => r.kind === 'task');
  const child = runs.filter(r => r.kind === 'agent');
  assert.equal(lead.length, 1);
  assert.equal(child.length, 1);
  assert.ok(JSON.parse(lead[0]!.flags).includes('effort:xhigh'), lead[0]!.flags);
  assert.ok(JSON.parse(child[0]!.flags).includes('effort:xhigh'), child[0]!.flags);
});

test('scout effort: a value the scout model does not offer is not sent to the lead or the child', async t => {
  const s = await setup(t, c => { c.scout = { cloudRunsPerHour: 1, effort: 'max' }; });
  s.adapter().scripts.push(...scoutScript);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 3);
  assert.deepEqual(s.adapter().calls.map(c => c.effort), [undefined, undefined, undefined]);
  for (const r of s.runs()) assert.ok(!r.flags.includes('effort:'), r.flags);
});

test('scout effort: unset means nothing is sent (the model default)', async t => {
  const s = await setup(t, () => undefined);
  s.adapter().scripts.push(...scoutScript);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 3);
  assert.deepEqual(s.adapter().calls.map(c => c.effort), [undefined, undefined, undefined]);
});

test('scout effort: an ordinary task and its child agent_run do not get scout.effort', async t => {
  const s = await setup(t, c => { c.scout = { cloudRunsPerHour: 1, effort: 'xhigh' }; });
  s.app.projects.update(s.projectId, { scoutMode: 'off' });
  s.app.tasks.create({ title: 'plain task', origin: 'user', actor: 'user', projectId: s.projectId });
  s.adapter().scripts.push(
    toolCall('agent_run', { task: 'look', title: 'Look' }),
    reply('child answer'),
    toolCall('task_complete', { summary: 'ok', notify: false }),
  );
  assert.equal(await s.app.worker.tick(), 'ran');
  const calls = s.adapter().calls;
  assert.equal(calls.length, 3);
  assert.ok(s.runs().some(r => r.kind === 'agent'), 'the child ran');
  assert.deepEqual(calls.map(c => c.effort), [undefined, undefined, undefined]);
});
