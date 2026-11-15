import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { App } from '../src/app.ts';
import { eraseConversation } from '../src/db/erase.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { growthStats } from '../src/growth/stats.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { questionAdd } from '../src/tools/builtin/questions.ts';
import { recordJudgeCall } from '../src/tools/judge-stats.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, type Script, testConfig } from './helpers.ts';

const NOV = Date.parse('2026-11-14T03:00:00Z');
const OCT = Date.parse('2026-10-10T03:00:00Z');

function toolCall(name: string, args: unknown): Script {
  return async function* () {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.timezone = 'UTC';
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: NOV };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const project = (name: string) => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    return app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand: null });
  };
  return { app, adapter: () => adapter, clock, project, dir };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function ctxFor(s: Setup, taskId: string, projectId: string, tainted = false): ToolContext {
  return {
    runId: 'run-1', conversationId: 'conv-1', kind: 'task', signal: new AbortController().signal, config: s.app.config(), paths: s.app.paths,
    policy: undefined as never, workspace: '.', log: () => undefined,
    taint: { tainted, sources: tainted ? ['web'] : [] },
    project: { id: projectId },
    services: { db: s.app.db, memory: s.app.memory, emit: () => undefined, tasks: s.app.tasks, projects: s.app.projects, questions: s.app.questions },
    task: { id: taskId, control: { outcome: 'none' } },
  };
}

const ask = (question: string, category?: string) => ({ question, why: 'Because', options: ['Keep it', 'Change it'], chosen: 0, ...(category ? { category } : {}) });

function skillRow(s: Setup, input: { conversationId: string | null; name: string; at: number; runKind?: string; ok?: number; tool?: string }) {
  const id = `tc-${Math.random().toString(36).slice(2)}`;
  const runId = `run-${id}`;
  s.app.db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES (?, ?, ?, ?)').run(runId, input.runKind ?? 'chat', input.conversationId, input.at);
  s.app.db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, ?, ?, ?, ?, 'allow', 'policy', ?, ?)")
    .run(id, runId, input.conversationId, input.tool ?? 'skill_view', JSON.stringify({ name: input.name }), input.ok ?? 1, input.at);
}

test('G-1: question_add は category を受けて行に残す。書かなければ other、一覧に無い名前は断る', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const task = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', projectId: shop.id });
  const ctx = ctxFor(s, task.id, shop.id);
  assert.equal((await questionAdd.execute(ask('Which color?', 'ui') as never, ctx)).isError, undefined);
  assert.equal((await questionAdd.execute(ask('Which word?') as never, ctx)).isError, undefined);
  const rows = s.app.db.prepare('SELECT question, category FROM questions ORDER BY id').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ question: 'Which color?', category: 'ui' }, { question: 'Which word?', category: 'other' }]);
  assert.equal(s.app.questions.view(1)!.category, 'ui');
  assert.equal(Value.Check(questionAdd.input, ask('q', 'security')), true);
  assert.equal(Value.Check(questionAdd.input, ask('q', 'colour')), false, 'the tool input rejects a name outside the list');
  assert.throws(() => s.app.questions.add({ ...ask('Direct?'), category: 'colour' as never, taskId: task.id, projectId: shop.id }), /category must be one of: scope, ui, data, naming, tech, security, other/u);
  assert.throws(() => s.app.db.prepare("UPDATE questions SET category = 'colour' WHERE id = 1").run(), /CHECK/u);
});

test('G-1: 質問の数・種類ごとの当たり率・判定役が聞いた数・Pending・Not enough の割合を、製品と月ごとに数える', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const blog = s.project('blog');
  const run = (title: string, projectId: string | null, at: number) => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user', projectId });
    s.app.db.prepare('UPDATE tasks SET conversation_id = ?, created_at = ? WHERE id = ?').run(`conv-${task.id}`, at, task.id);
    return task;
  };
  const a = run('Shop A', shop.id, NOV);
  run('Shop B', shop.id, NOV);
  const old = run('Shop old', shop.id, OCT);
  s.app.tasks.create({ title: 'Never ran', origin: 'user', actor: 'user', projectId: shop.id });

  const ctx = ctxFor(s, a.id, shop.id);
  await questionAdd.execute(ask('Q ui 1', 'ui') as never, ctx);
  await questionAdd.execute(ask('Q ui 2', 'ui') as never, ctx);
  await questionAdd.execute(ask('Q data', 'data') as never, ctx);
  await questionAdd.execute(ask('Q tainted', 'ui') as never, ctxFor(s, a.id, shop.id, true));
  s.app.questions.add({ kind: 'stuck', projectId: shop.id, taskId: a.id, question: 'Stuck?', options: ['Retry', 'Stop'], chosen: 0 });
  s.app.questions.answer(1, { choice: 0 });
  s.app.questions.answer(2, { choice: 1 });
  s.app.questions.answer(3, { choice: 0 });
  s.app.questions.answer(4, { choice: 0 });
  s.clock.now = OCT;
  await questionAdd.execute(ask('Q old', 'scope') as never, ctxFor(s, old.id, shop.id));
  s.clock.now = NOV;

  recordJudgeCall(s.app.db, { runId: 'j1', runKind: 'task', projectId: shop.id, tool: 'shell_run', reasonKeys: [], askKinds: [], outcome: 'ask', spend: { ms: 1 } }, NOV);
  recordJudgeCall(s.app.db, { runId: 'j2', runKind: 'task', projectId: shop.id, tool: 'shell_run', reasonKeys: [], askKinds: [], outcome: 'allow', spend: { ms: 1 } }, NOV);
  recordJudgeCall(s.app.db, { runId: 'j3', runKind: 'task', projectId: blog.id, tool: 'shell_run', reasonKeys: [], askKinds: [], outcome: 'ask', spend: { ms: 1 } }, NOV);

  const park = (projectId: string, at: number) => s.app.db.prepare(`INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, project_id, status, created_at)
    VALUES ('shell_run', 'rm -rf build', 'rm -rf build', 'delete', 'Deletes files', 'r', 'task', 'c', ?, 'waiting', ?)`).run(projectId, at);
  park(shop.id, NOV);
  park(shop.id, NOV);
  park(shop.id, OCT);
  park(shop.id, Date.parse('2026-10-31T20:00:00Z'));

  s.app.tasks.event(a.id, 'owner_check', 'user', JSON.stringify({ item: 'A-1', result: 'checked' }));
  s.app.tasks.event(a.id, 'owner_check', 'user', JSON.stringify({ item: 'A-2', result: 'insufficient', note: 'The owner note text' }));
  s.app.tasks.event(a.id, 'owner_check', 'user', JSON.stringify({ item: 'A-3', result: 'insufficient' }));
  s.app.tasks.event(a.id, 'owner_check', 'user', 'not json');

  const stats = growthStats(s.app.db, { timezone: 'UTC' });
  assert.deepEqual(stats.buckets.map(b => [b.month, b.projectId]), [...[blog.id, shop.id].sort().map(id => ['2026-11', id]), ['2026-10', shop.id]]);
  const nov = stats.buckets.find(b => b.month === '2026-11' && b.projectId === shop.id)!;
  assert.equal(nov.tasks, 2, 'only tasks that ran, not templates or never-run ones');
  assert.deepEqual(nov.questions, {
    asked: 5, perTask: 2.5, answered: 4, kept: 3, keptRate: 0.75,
    byCategory: [
      { category: 'ui', asked: 3, answered: 3, kept: 2, keptRate: 2 / 3 },
      { category: 'data', asked: 1, answered: 1, kept: 1, keptRate: 1 },
    ],
  });
  assert.equal(nov.judgeAsked, 1);
  assert.equal(nov.pending, 2);
  assert.deepEqual(nov.checks, { decisions: 3, notEnough: 2, notEnoughShare: 2 / 3 });
  assert.equal(stats.buckets.find(b => b.projectId === blog.id)!.judgeAsked, 1);
  const oct = stats.buckets.find(b => b.month === '2026-10')!;
  assert.deepEqual([oct.tasks, oct.questions.asked, oct.questions.keptRate, oct.pending, oct.questions.byCategory[0]!.category], [1, 1, null, 2, 'scope']);

  const filtered = growthStats(s.app.db, { timezone: 'UTC', project: shop.id, month: '2026-11' });
  assert.deepEqual(filtered.buckets, [nov]);
  assert.deepEqual(growthStats(s.app.db, { timezone: 'UTC', project: blog.id, month: '2026-10' }).buckets, []);
  const tokyo = growthStats(s.app.db, { timezone: 'Asia/Tokyo', month: '2026-11', project: shop.id }).buckets;
  assert.deepEqual(tokyo.map(b => [b.month, b.questions.asked, b.pending]), [['2026-11', 5, 3]], 'the month follows the timezone setting');
});

test('G-1: スキルを使ったタスクの成否は、実行の会話でタスクにつないで読むときに数える。会話での使用は回数だけ、振り返りは数えない、消した会話の分は落ちる', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  s.app.skills.write({ name: 'release-notes', description: 'Write release notes', body: 'Steps' });
  const done = s.app.tasks.create({ title: 'Write notes', origin: 'user', actor: 'user', projectId: shop.id });
  s.adapter().scripts.push(toolCall('skill_view', { name: 'release-notes' }), toolCall('skill_view', { name: 'release-notes' }), toolCall('task_complete', { summary: 'done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(done.id)!.status, 'done');
  const used = s.app.db.prepare("SELECT conversation_id FROM tool_calls WHERE tool = 'skill_view'").all() as Array<{ conversation_id: string }>;
  assert.equal(used.length, 2);
  assert.equal(used[0]!.conversation_id, s.app.tasks.get(done.id)!.conversation_id);

  const failed = s.app.tasks.create({ title: 'Fails', origin: 'user', actor: 'user', projectId: shop.id });
  s.app.db.prepare("UPDATE tasks SET conversation_id = 'conv-failed', status = 'failed' WHERE id = ?").run(failed.id);
  skillRow(s, { conversationId: 'conv-failed', name: 'release-notes', at: NOV, runKind: 'task' });
  const open = s.app.tasks.create({ title: 'Still going', origin: 'user', actor: 'user', projectId: shop.id });
  s.app.db.prepare("UPDATE tasks SET conversation_id = 'conv-open', status = 'running' WHERE id = ?").run(open.id);
  skillRow(s, { conversationId: 'conv-open', name: 'release-notes', at: NOV, runKind: 'task' });

  s.app.db.prepare("INSERT INTO conversations (id, kind, project_id, created_at, last_message_at) VALUES ('chat-1', 'chat', ?, ?, ?)").run(shop.id, NOV, NOV);
  skillRow(s, { conversationId: 'chat-1', name: 'release-notes', at: NOV });
  skillRow(s, { conversationId: 'chat-1', name: 'release-notes', at: NOV, runKind: 'review' });
  skillRow(s, { conversationId: 'chat-1', name: 'missing-skill', at: NOV, ok: 0 });
  skillRow(s, { conversationId: 'chat-1', name: 'Not A Name; rm -rf /', at: NOV });

  const skills = () => growthStats(s.app.db, { timezone: 'UTC', project: shop.id, month: '2026-11' }).buckets[0]!.skills;
  assert.deepEqual(skills(), [{ name: 'release-notes', uses: 5, taskUses: 4, chatUses: 1, tasks: 3, done: 1, failed: 1, cancelled: 0, unfinished: 1 }]);

  eraseConversation({ db: s.app.db, uploadsDir: join(s.dir, 'u'), toolOutputsDir: join(s.dir, 'o') }, 'conv-failed');
  eraseConversation({ db: s.app.db, uploadsDir: join(s.dir, 'u'), toolOutputsDir: join(s.dir, 'o') }, 'chat-1');
  assert.deepEqual(skills(), [{ name: 'release-notes', uses: 3, taskUses: 3, chatUses: 0, tasks: 2, done: 1, failed: 0, cancelled: 0, unfinished: 1 }]);
});

test('G-1: /api/growth/stats は製品と月で絞れ、持ち主の文や命令の文を返さない', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const task = s.app.tasks.create({ title: 'Secret task title', origin: 'user', actor: 'user', projectId: shop.id });
  s.app.db.prepare("UPDATE tasks SET conversation_id = 'conv-x' WHERE id = ?").run(task.id);
  await questionAdd.execute(ask('Owner question text', 'naming') as never, ctxFor(s, task.id, shop.id));
  s.app.questions.answer(1, { choice: null, text: 'Owner answer text' });
  s.app.tasks.event(task.id, 'owner_check', 'user', JSON.stringify({ item: 'A-1', result: 'insufficient', note: 'Owner note text' }));
  s.app.db.prepare(`INSERT INTO pending_actions (tool, input, shown, kind, reason, run_id, run_kind, conversation_id, project_id, status, created_at)
    VALUES ('shell_run', 'curl https://example.test/secret-command', 'curl https://example.test/secret-command', 'send', 'Sends', 'r', 'task', 'conv-x', ?, 'waiting', ?)`).run(shop.id, NOV);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const get = async (path: string) => { const res = await fetch(`${origin}${path}`, { headers: { Origin: origin } }); return { status: res.status, text: await res.text() }; };

  const all = await get('/api/growth/stats');
  assert.equal(all.status, 200);
  const body = JSON.parse(all.text);
  assert.equal(body.buckets.length, 1);
  assert.equal(body.buckets[0].questions.byCategory[0].category, 'naming');
  assert.equal(body.buckets[0].questions.kept, 0);
  assert.equal(body.buckets[0].pending, 1);
  assert.equal(body.buckets[0].checks.notEnough, 1);
  for (const text of ['Owner question text', 'Owner answer text', 'Owner note text', 'Secret task title', 'secret-command', 'Because', 'Keep it']) {
    assert.ok(!all.text.includes(text), `the response must not carry ${text}`);
  }
  assert.equal(JSON.parse((await get(`/api/growth/stats?project=${shop.id}&month=2026-11`)).text).buckets.length, 1);
  assert.equal(JSON.parse((await get('/api/growth/stats?month=2026-10')).text).buckets.length, 0);
  assert.equal(JSON.parse((await get('/api/growth/stats?project=none')).text).buckets.length, 0);
  assert.equal((await get('/api/growth/stats?month=2026-13')).status, 400);
  assert.equal((await get('/api/growth/stats?project=../x')).status, 400);
});
