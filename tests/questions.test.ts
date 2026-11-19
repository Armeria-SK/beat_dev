import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { questionAdd, questionList } from '../src/tools/builtin/questions.ts';
import { planAllows } from '../src/tools/pipeline.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, tempDir, type Script, testConfig, withLoad, offered, reply } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-14T03:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const changes: unknown[] = [];
  app.bus.subscribe(e => { if (e.event.type === 'question.changed') changes.push(e.event); });
  t.after(() => app.close());
  const project = (name: string, checkCommand: string | null = null) => {
    const root = join(dir, name);
    mkdirSync(root, { recursive: true });
    if (checkCommand) writeFileSync(join(root, 'check.js'), 'process.exit(1)\n');
    return app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand });
  };
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(() => { web.server.closeAllConnections(); web.server.close(); });
  const http = async (path: string, body?: unknown) => {
    const res = await fetch(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() as any };
  };
  return { app, adapter: () => adapter, clock, changes, project, http };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function ctxFor(s: Setup, taskId: string, options: { tainted?: boolean; projectId?: string } = {}): ToolContext {
  return {
    runId: 'run-1', conversationId: 'conv-1', kind: 'task', signal: new AbortController().signal, config: s.app.config(), paths: s.app.paths,
    policy: undefined as never, workspace: '.', log: () => undefined,
    taint: { tainted: options.tainted === true, sources: options.tainted ? ['web'] : [] },
    ...(options.projectId ? { project: { id: options.projectId } } : {}),
    services: { db: s.app.db, memory: s.app.memory, emit: () => undefined, tasks: s.app.tasks, projects: s.app.projects, questions: s.app.questions },
    task: { id: taskId, control: { outcome: 'none' } },
  };
}

const ask = { question: 'Which date format?', why: 'The page shows dates', options: ['2026-11-14', '11/14'], chosen: 0 };

test('question_add: 記録して進む。control は変わらず、タスクはそのまま終わる。行は ai・open・仮の選択つきで、出来事が出る', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user', projectId: shop.id });
  s.adapter().scripts.push(toolCall('question_add', ask), toolCall('task_complete', { summary: 'done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done', 'blocking でない質問のあと、タスクは止まらずに終わる');
  const tools = offered(s.adapter().calls[0]!);
  assert.ok(tools.includes('question_add') && tools.includes('question_list'), 'タスクの実行には 2 つの道具が渡る');
  const result = JSON.stringify(s.adapter().calls[1]!.messages);
  assert.match(result, /Recorded as question #1\. Keep working with the option you chose: 2026-11-14/u);
  const [row] = s.app.questions.list({ status: 'open' });
  assert.equal(row!.kind, 'ai');
  assert.equal(row!.task_id, task.id);
  assert.equal(row!.project_id, shop.id);
  assert.equal(row!.product, 'shop');
  assert.equal(row!.task, 'Build the page');
  assert.deepEqual(row!.options, ['2026-11-14', '11/14']);
  assert.equal(row!.chosen, 0);
  assert.equal(row!.blocking, false);
  assert.equal(row!.why, 'The page shows dates');
  assert.deepEqual(s.changes, [{ type: 'question.changed', id: row!.id, projectId: shop.id, status: 'open' }]);
});

test('question_add: chosen が無く blocking でもない・範囲の外の chosen・選択肢の数・タスクの外は断る。同じ文の Open は断り、1 タスク 10 個まで', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const ctx = ctxFor(s, task.id);
  const run = (input: unknown, c = ctx) => questionAdd.execute(input as never, c);
  const noChosen = await run({ question: 'q?', why: 'w', options: ['a', 'b'] });
  assert.equal(noChosen.isError, true);
  assert.match(noChosen.content, /Give chosen/u);
  assert.equal((await run({ question: 'q?', why: 'w', options: ['a', 'b'], chosen: 2 })).isError, true);
  assert.equal((await run({ question: 'q?', why: 'w', options: ['a'], chosen: 0 })).isError, true);
  assert.equal((await run({ question: '​ ', why: 'w', options: ['a', 'b'], chosen: 0 })).isError, true);
  assert.equal((await run(ask, { ...ctx, task: undefined })).isError, true);
  assert.equal(s.app.questions.list({ status: 'open' }).length, 0);
  assert.equal((await run(ask)).isError, undefined);
  const dup = await run(ask);
  assert.equal(dup.isError, true);
  assert.match(dup.content, /already open/u);
  for (let i = 2; i <= 10; i++) assert.equal((await run({ ...ask, question: `q${i}` })).isError, undefined, `${i}`);
  const eleventh = await run({ ...ask, question: 'q11' });
  assert.equal(eleventh.isError, true);
  assert.match(eleventh.content, /10 questions/u);
  assert.equal(s.app.questions.list({ status: 'open' }).length, 10);
});

test('question_add: AI の道具から kind を選べない（入力の形が受けない）。鍵らしい文字は伏せ、幅の無い文字は外して保存する', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('question_add', { ...ask, kind: 'stuck' }), toolCall('task_complete', { summary: 'done', notify: false }));
  await s.app.worker.tick();
  assert.equal(s.app.questions.list({ status: 'open' }).length, 0, 'kind を入れた呼び出しは形で断られ、行はできない');
  const ctx = ctxFor(s, task.id);
  const key = `sk-ant-api03-${'a'.repeat(90)}`;
  await questionAdd.execute({ question: `Use key ${key}?`, why: 'w​', options: ['ye​s', `no ${key}`], chosen: 0 } as never, ctx);
  const [row] = s.app.questions.list({ status: 'open' });
  assert.equal(row!.kind, 'ai');
  assert.ok(!row!.question.includes(key) && row!.question.includes('[REDACTED]'), row!.question);
  assert.ok(!row!.options[1]!.includes(key));
  assert.equal(row!.options[0], 'yes');
  assert.equal(row!.why, 'w');
});

test('question_add と question_list は、会話・子の担当・振り返りには出ず、計画モードも通らない', async t => {
  const s = await setup(t);
  for (const kind of ['chat', 'agent', 'review'] as const) {
    const names = s.app.tools.forRun(kind).map(tool => tool.name);
    assert.ok(!names.includes('question_add') && !names.includes('question_list'), kind);
  }
  const task = s.app.tools.forRun('task').map(tool => tool.name);
  assert.ok(task.includes('question_add') && task.includes('question_list'));
  assert.equal(planAllows(questionAdd), false);
  assert.equal(planAllows(questionList), false);
});

test('blocking: タスクは返事待ちになり（文は質問のまま）、答えると実行待ちに戻って経過に答えが残る。2 回押しても 1 回', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Ship', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('question_add', { question: 'Which server?', why: 'Two exist', options: ['A', 'B'], blocking: true }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const waiting = s.app.tasks.get(task.id)!;
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waiting_text, 'Which server?');
  const [row] = s.app.questions.list({ status: 'open' });
  assert.equal(row!.blocking, true);
  assert.equal(row!.chosen, null);
  const first = await s.http(`/api/questions/${row!.id}/answer`, { choice: 1 });
  assert.equal(first.status, 200);
  assert.equal(first.body.kind, 'changed');
  assert.equal(first.body.fixTaskId, null, 'blocking の答えは、止まっていたタスクに返す（直しのタスクは作らない）');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'answer' && /B/u.test(e.content ?? '')));
  const again = await s.http(`/api/questions/${row!.id}/answer`, { choice: 0 });
  assert.equal(again.status, 200);
  assert.equal(again.body.question.answer, 'B', '2 回目は前の答えのまま');
  assert.equal(s.app.tasks.events(task.id).filter(e => e.kind === 'answer').length, 1);
  assert.equal(s.app.tasks.list().length, 1);
});

test('B5 (backlog 662): 動く前のタスクの、急ぎでない質問への違う答えは、そのタスクに返してすぐ動かす（新しいタスクを作らない）', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const build = s.app.tasks.create({ title: 'Build: shop', origin: 'user', actor: 'user', projectId: shop.id, runAt: s.clock.now + 240 * 60_000 });
  await questionAdd.execute(ask as never, ctxFor(s, build.id, { projectId: shop.id }));
  const [row] = s.app.questions.list({ status: 'open' });
  assert.equal(row!.blocking, false);
  assert.deepEqual((await s.http('/api/questions/counts')).body.byTask, { [build.id]: 1 });
  const answered = await s.http(`/api/questions/${row!.id}/answer`, { choice: 1 });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.kind, 'changed');
  assert.equal(s.app.tasks.list().length, 1, '「Answer to question」のタスクを作らない');
  assert.equal(answered.body.fixTaskId, null);
  assert.equal(answered.body.resumedTaskId, build.id);
  assert.equal(answered.body.question.fix_task_id, null);
  const after = s.app.tasks.get(build.id)!;
  assert.deepEqual([after.status, after.run_at], ['ready', null], '240 分待たずに、すぐ動ける');
  const events = s.app.tasks.events(build.id).filter(e => e.kind === 'answer');
  assert.equal(events.length, 1);
  assert.match(events[0]!.content ?? '', /Which date format\?[\s\S]*11\/14/u);
  assert.deepEqual((await s.http('/api/questions/counts')).body.byTask, {});
});

test('B5: 終わったタスクの質問への違う答えは、今までどおり直しのタスク。動いているタスクには経過に答えを書くだけ（断らない・直しのタスクは作らない）。仮の選択のままなら何も変えない', async t => {
  const s = await setup(t);
  const done = s.app.tasks.create({ title: 'Done one', origin: 'user', actor: 'user' });
  await questionAdd.execute(ask as never, ctxFor(s, done.id));
  s.app.tasks.finish(done.id, 'done', null, 'beat');
  const [late] = s.app.questions.list({ status: 'open' });
  const fixed = await s.http(`/api/questions/${late!.id}/answer`, { choice: 1 });
  assert.ok(fixed.body.fixTaskId, '終わったタスクには、直しのタスクを作る');
  assert.equal(fixed.body.resumedTaskId, null);
  assert.equal(s.app.tasks.get(fixed.body.fixTaskId)!.status, 'ready');

  const running = s.app.tasks.create({ title: 'Running one', origin: 'user', actor: 'user' });
  await questionAdd.execute({ ...ask, question: 'Which time format?' } as never, ctxFor(s, running.id));
  assert.equal(s.app.tasks.claim(running.id, 60_000, 'conv-r'), true);
  const [live] = s.app.questions.list({ status: 'open' });
  const count = s.app.tasks.list().length;
  const sent = await s.http(`/api/questions/${live!.id}/answer`, { choice: 1 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual([sent.body.fixTaskId, sent.body.resumedTaskId, sent.body.question.fix_task_id], [null, null, null], '答えは聞いたタスクに戻す（実行の終わりでもう一度動かす）');
  assert.equal(s.app.tasks.get(running.id)!.status, 'running', '動いているタスクはそのまま');
  assert.equal(s.app.tasks.events(running.id).filter(e => e.kind === 'answer').length, 1);
  assert.equal(s.app.tasks.list().length, count);

  const later = s.app.tasks.create({ title: 'Later one', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  await questionAdd.execute({ ...ask, question: 'Which zone?' } as never, ctxFor(s, later.id));
  const [zone] = s.app.questions.list({ status: 'open' });
  const kept = await s.http(`/api/questions/${zone!.id}/answer`, { choice: 0 });
  assert.deepEqual([kept.body.kind, kept.body.fixTaskId, kept.body.resumedTaskId], ['kept', null, null]);
  assert.equal(s.app.tasks.get(later.id)!.run_at, s.clock.now + 3_600_000, '仮の選択のままなら、時刻も変えない');
  assert.equal(s.app.tasks.events(later.id).filter(e => e.kind === 'answer').length, 0);
});

function answerMidRun(s: Setup, end: Script, sink: { res?: { status: number; body: any } }, body: unknown = { choice: 1 }, first?: (questionId: number) => void): Script {
  return async function* (req) {
    const [row] = s.app.questions.list({ status: 'open' });
    first?.(row!.id);
    sink.res = await s.http(`/api/questions/${row!.id}/answer`, body);
    yield* end(req);
  };
}

const promptOf = (req: { messages: unknown }): string => JSON.stringify(req.messages);
const ANSWER_IN_PROMPT = /answer: Reply to question #1 \\"Which date format\?\\": 11\/14/u;

test('実行の途中の答え: task_complete で終わっても終わらせず、同じタスクが答えを持ってすぐもう一度動く（直しのタスクは作らない）。2 回目で終わる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, toolCall('task_complete', { summary: 'done with 2026-11-14', notify: false }), sink));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200, JSON.stringify(sink.res?.body));
  assert.deepEqual([sink.res!.body.fixTaskId, sink.res!.body.question.fix_task_id], [null, null]);
  assert.equal(s.app.tasks.list().length, 1, '「Answer to question」のタスクを作らない');
  const after = s.app.tasks.get(task.id)!;
  assert.deepEqual([after.status, after.run_at], ['ready', s.clock.now], '終わらせずに、今すぐ動ける');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'requeued' && /answered a question while it was running/u.test(e.content ?? '')));
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'note' && e.content === 'done with 2026-11-14'), '1 回目の要約は経過に残す');

  const before = s.adapter().calls.length;
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'switched to 11/14', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(promptOf(s.adapter().calls[before]!), ANSWER_IN_PROMPT, '2 回目の実行は答えを読む');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done', '使った答えで、もう一度動かすことはしない');
  assert.deepEqual(s.app.db.prepare('SELECT id FROM tasks').all().map(r => r.id), [task.id], 'どの状態のタスクも増えていない');
});

test('実行の途中の答え: task_checkpoint で終わっても、先の時刻でなく今すぐもう一度動く', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c' }), sink));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200);
  const after = s.app.tasks.get(task.id)!;
  assert.deepEqual([after.status, after.run_at, after.next_action], ['ready', s.clock.now, 'c']);
  assert.equal(s.app.tasks.list().length, 1);
});

test('実行の途中の答え: 返事だけで終わっても、進展なしと数えずに今すぐもう一度動く', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, reply('thinking'), sink));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200);
  const after = s.app.tasks.get(task.id)!;
  assert.deepEqual([after.status, after.run_at], ['ready', s.clock.now]);
  assert.equal(s.app.kv.getJson(`task-idle:${task.id}`), undefined, '進展なしの数は増やさない');
  assert.equal(s.app.tasks.list().length, 1);
});

test('実行の途中に答えが無ければ、終わり方は答えの無い形（question_add だけの task_checkpoint・返事だけは、どちらも進展なし。どちらも休まない）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('question_add', ask), toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual([s.app.tasks.get(task.id)!.status, s.app.tasks.get(task.id)!.run_at], ['ready', s.clock.now]);
  assert.equal(s.app.tasks.events(task.id).find(e => e.kind === 'requeued')!.content, 'The run ended without progress, so it continues now in a new run (it stops after 3 such runs in a row)', 'question_add は仕事に数えない');
  assert.equal(s.app.kv.getJson(`task-idle:${task.id}`), 1);
  s.clock.now += 60 * 60_000;
  s.adapter().scripts.push(reply('thinking'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual([s.app.tasks.get(task.id)!.status, s.app.tasks.get(task.id)!.run_at], ['ready', s.clock.now]);
  assert.equal(s.app.kv.getJson(`task-idle:${task.id}`), 2);
  assert.equal(s.app.questions.list({ status: 'open' }).length, 1);
});

test('前の実行の間の答えは、次の実行のあとでもう一度動かす理由にならない（答えは実行の前に来ていた）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  await questionAdd.execute(ask as never, ctxFor(s, task.id));
  const [row] = s.app.questions.list({ status: 'open' });
  const res = await s.http(`/api/questions/${row!.id}/answer`, { choice: 1 });
  assert.equal(res.body.resumedTaskId, task.id);
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('実行の途中の答えのあとに経過が 10 個より多く積もっても、もう一度の実行は答えを読む', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  const notes = [2, 3, 4, 5, 6, 7, 8].map(n => toolCall('task_update', { id: task.id, note: `n${n}` }));
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, toolCall('task_update', { id: task.id, note: 'n1' }), sink), ...notes, toolCall('task_complete', { summary: 'done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  const before = s.adapter().calls.length;
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'switched', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.match(promptOf(s.adapter().calls[before]!), ANSWER_IN_PROMPT);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

const fixTasks = (s: Setup, taskId: string) => s.app.db.prepare('SELECT id FROM tasks WHERE id != ?').all(taskId).map(r => String(r.id));

async function endsWithoutRerun(t: { after: (fn: () => void) => void }, scripts: (s: Setup, sink: { res?: { status: number; body: any } }) => { taskId: string; scripts: Script[] }, status: string) {
  const s = await setup(t);
  const sink: { res?: { status: number; body: any } } = {};
  const made = scripts(s, sink);
  s.adapter().scripts.push(...made.scripts);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200, JSON.stringify(sink.res?.body));
  assert.equal(s.app.tasks.get(made.taskId)!.status, status);
  const fixes = fixTasks(s, made.taskId);
  assert.equal(fixes.length, 1, '答えを持つ直しのタスクを 1 つ作る（答えをなくさない）');
  const fix = s.app.tasks.get(fixes[0]!)!;
  assert.equal(fix.status, 'ready');
  assert.match(fix.body, /11\/14/u);
  const [row] = s.app.questions.list({ status: 'answered' });
  assert.equal(row!.fix_task_id, fix.id);
  assert.equal(s.app.kv.get(`task-owner-run:${fix.id}`), '1', '直しのタスクは持ち主の頼みとして回す');
  assert.equal(s.changes.filter(c => (c as { id: number }).id === row!.id).length, 3, 'open・答えた・直しのタスクの印、の 3 回を画面に知らせる');
  return { s, fix, taskId: made.taskId };
}

test('実行の途中の答え: 確かめが 3 回落ちて failed で終わったら、答えは直しのタスクに渡す', async t => {
  await endsWithoutRerun(t, (s, sink) => {
    const shop = s.project('shop', 'node check.js');
    const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user', projectId: shop.id });
    const done = toolCall('task_complete', { summary: 'done', notify: false });
    return { taskId: task.id, scripts: [toolCall('question_add', ask), answerMidRun(s, done, sink), done, done] };
  }, 'failed');
});

test('実行の途中の答え: やり直しを使い切って failed で終わったら、答えは直しのタスクに渡す', async t => {
  await endsWithoutRerun(t, (s, sink) => {
    const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
    s.app.db.prepare('UPDATE tasks SET max_attempts = 1 WHERE id = ?').run(task.id);
    const boom: Script = async function* () { throw new Error('boom'); };
    return { taskId: task.id, scripts: [toolCall('question_add', ask), answerMidRun(s, boom, sink)] };
  }, 'failed');
});

test('実行の途中の答え: モデルが自分のタスクを取り消して終わったら、答えは直しのタスクに渡す', async t => {
  await endsWithoutRerun(t, (s, sink) => {
    const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
    return { taskId: task.id, scripts: [toolCall('question_add', ask), answerMidRun(s, toolCall('task_update', { id: task.id, status: 'cancelled' }), sink)] };
  }, 'cancelled');
});

test('実行の途中の答え: 外を読んだ質問を選択肢で答えたら、直しのタスクに owner_request を入れず外の印。自分で書いた答えなら owner_request はその文', async t => {
  for (const [body, owner] of [[{ choice: 1 }, null], [{ choice: null, text: '11/14 by hand' }, '11/14 by hand']] as const) {
    const { s, fix } = await endsWithoutRerun(t, (s, sink) => {
      const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
      const taint = (id: number) => { s.app.db.prepare('UPDATE questions SET tainted = 1 WHERE id = ?').run(id); };
      const end = toolCall('task_update', { id: task.id, status: 'cancelled' });
      return { taskId: task.id, scripts: [toolCall('question_add', ask), answerMidRun(s, end, sink, body, taint)] };
    }, 'cancelled');
    const request = s.app.tasks.get(fix.id)!.owner_request;
    if (owner === null) assert.equal(request, null, JSON.stringify(body));
    else assert.equal(JSON.parse(request!).title, owner);
    assert.equal(s.app.tasks.textTainted(fix.id), true, JSON.stringify(body));
  }
});

test('実行の途中の答え: 前の実行で読んだ答えは、あとの実行が失敗で終わっても直しのタスクにしない（その実行の答えだけ）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, toolCall('task_complete', { summary: 'done', notify: false }), sink));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  s.clock.now += 1;
  s.app.db.prepare('UPDATE tasks SET max_attempts = 1 WHERE id = ?').run(task.id);
  const boom: Script = async function* () { throw new Error('boom'); };
  const sink2: { res?: { status: number; body: any } } = {};
  s.adapter().scripts.push(toolCall('question_add', { ...ask, question: 'Which time format?' }), answerMidRun(s, boom, sink2));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink2.res?.status, 200);
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
  const fixes = fixTasks(s, task.id);
  assert.equal(fixes.length, 1, JSON.stringify(fixes));
  const [q1, q2] = s.app.questions.list({ status: 'answered' }).sort((a, b) => a.id - b.id);
  assert.deepEqual([q1!.fix_task_id, q2!.fix_task_id], [null, fixes[0]]);
});

test('実行の途中の答えに、答えたときに直しのタスクができていたら、もう一度動かさない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const other = s.app.tasks.create({ title: 'Other', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  const sink: { res?: { status: number; body: any } } = {};
  const markFixed: Script = async function* (req) {
    s.app.db.prepare('UPDATE questions SET fix_task_id = ?').run(other.id);
    yield* toolCall('task_complete', { summary: 'done', notify: false })(req);
  };
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, markFixed, sink));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(sink.res?.status, 200);
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('直しのタスクに渡した答えは、もとのタスクを開き直しても、そのタスクの「読んでいない答え」には入れない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const sink: { res?: { status: number; body: any } } = {};
  const notes = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => toolCall('task_update', { id: task.id, note: `n${n}` }));
  s.adapter().scripts.push(toolCall('question_add', ask), answerMidRun(s, toolCall('task_update', { id: task.id, note: 'n1' }), sink), ...notes, toolCall('task_update', { id: task.id, status: 'cancelled' }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
  const [fix] = fixTasks(s, task.id);
  assert.ok(fix);
  s.app.tasks.finish(fix, 'cancelled', null, 'user');
  s.app.tasks.reopen(task.id, 'user');
  const before = s.adapter().calls.length;
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  const prompt = promptOf(s.adapter().calls[before]!);
  assert.doesNotMatch(prompt, ANSWER_IN_PROMPT, '答えは直しのタスクのもの');
  assert.match(prompt, /The reply to question #1 went to the follow-up task/u);
});

function answerByText(s: Setup, question: string, body: unknown, end: Script): Script {
  return async function* (req) {
    const row = s.app.questions.list({ status: 'open' }).find(q => q.question === question);
    const res = await s.http(`/api/questions/${row!.id}/answer`, body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    yield* end(req);
  };
}

async function laterRunFails(t: { after: (fn: () => void) => void }, first: { question: string; body: unknown }, second: { question: string; body: unknown }) {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(
    toolCall('question_add', { ...ask, question: first.question }), toolCall('question_add', { ...ask, question: second.question }),
    answerByText(s, first.question, first.body, toolCall('task_complete', { summary: 'done', notify: false })),
  );
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready', '1 回目の実行の間の答えで、もう一度動く');
  s.app.db.prepare('UPDATE tasks SET max_attempts = 1 WHERE id = ?').run(task.id);
  const boom: Script = async function* () { throw new Error('boom'); };
  s.adapter().scripts.push(answerByText(s, second.question, second.body, boom));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
  const fixes = fixTasks(s, task.id);
  assert.equal(fixes.length, 1, JSON.stringify(fixes));
  const byText = new Map(s.app.questions.list({ status: 'answered' }).map(q => [q.question, q.fix_task_id]));
  assert.deepEqual([byText.get(first.question), byText.get(second.question)], [null, fixes[0]], '直しのタスクは、失敗した実行の間に答えた質問だけ');
}

test('実行の途中の答え: 前の実行で答えた別の質問は、文が合わないので直しのタスクにしない（あとから答えた方だけ）', async t => {
  await laterRunFails(t, { question: 'Which time format?', body: { choice: 1 } }, { question: 'Which date format?', body: { choice: 1 } });
});

test('実行の途中の答え: 質問と答えの文をつないで同じ文になる 2 つの質問も、質問の番号で取り違えない', async t => {
  await laterRunFails(t, { question: 'Which": one?', body: { choice: null, text: 'yes' } }, { question: 'Which', body: { choice: null, text: 'one?": yes' } });
});

test('実行の途中の submit_refused の答えは、もう一度動かす理由にならない（ai の質問の答えだけ）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'Build the page', origin: 'user', actor: 'user' });
  const answerSubmit: Script = async function* (req) {
    const q = s.app.questions.add({ kind: 'submit_refused', taskId: task.id, question: 'Send the form?', options: ['Send it', 'Keep it'], chosen: 1 });
    const res = await s.http(`/api/questions/${q.id}/answer`, { choice: 0 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    yield* toolCall('task_complete', { summary: 'done', notify: false })(req);
  };
  s.adapter().scripts.push(answerSubmit);
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'answer'), '経過には書く');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done');
});

test('B5: 外を読んだ実行の質問の答えを返したタスクには、外の印を付ける（直しのタスクと同じ）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  await questionAdd.execute(ask as never, ctxFor(s, task.id, { tainted: true }));
  const [row] = s.app.questions.list({ status: 'open' });
  assert.equal(s.app.tasks.textTainted(task.id), false);
  const res = await s.http(`/api/questions/${row!.id}/answer`, { choice: 1 });
  assert.equal(res.body.resumedTaskId, task.id);
  assert.equal(s.app.tasks.textTainted(task.id), true);
  const typed = s.app.tasks.create({ title: 'T2', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  await questionAdd.execute({ ...ask, question: 'Which zone?' } as never, ctxFor(s, typed.id, { tainted: true }));
  const [zone] = s.app.questions.list({ status: 'open' });
  assert.equal((await s.http(`/api/questions/${zone!.id}/answer`, { choice: null, text: 'UTC' })).body.resumedTaskId, typed.id);
  const note = s.app.tasks.events(typed.id).find(e => e.kind === 'context')?.content ?? '';
  assert.match(note, /read text from elsewhere/u);
  assert.doesNotMatch(note, /owner answer is used as the owner request/u, 'もとのタスクの owner_request は変えないので、そうは書かない');
});

test('答え: 仮の選択 → kept でタスクなし。別の選択肢 → changed と user のタスク 1 つ（2 回押しても 1 つ）。owner_request に質問の文と Why は入らない', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user', projectId: shop.id });
  const ctx = ctxFor(s, task.id, { projectId: shop.id });
  await questionAdd.execute(ask as never, ctx);
  await questionAdd.execute({ ...ask, question: 'Which color?', why: 'Header color', options: ['blue', 'green'] } as never, ctx);
  const [colors, dates] = s.app.questions.list({ status: 'open' });
  const kept = await s.http(`/api/questions/${dates!.id}/answer`, { choice: 0 });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.kind, 'kept');
  assert.equal(kept.body.fixTaskId, null);
  assert.equal(s.app.tasks.list().length, 1, '仮の選択のままなら、タスクは増えない');
  s.app.tasks.finish(task.id, 'done', null, 'beat');
  const changed = await s.http(`/api/questions/${colors!.id}/answer`, { choice: 1 });
  assert.equal(changed.body.kind, 'changed');
  const fix = s.app.tasks.get(changed.body.fixTaskId)!;
  assert.equal(fix.origin, 'user');
  assert.equal(fix.status, 'ready');
  assert.equal(fix.project_id, shop.id);
  assert.match(fix.title, /Which color\?/u);
  assert.match(fix.body, /Which color\?[\s\S]*blue[\s\S]*green/u);
  assert.deepEqual(JSON.parse(fix.owner_request!), { title: 'green', body: '', doneCriteria: null });
  assert.equal(s.app.tasks.judgeRequest(fix.id), 'green');
  assert.ok(!s.app.tasks.judgeRequest(fix.id).includes('Header color'));
  const again = await s.http(`/api/questions/${colors!.id}/answer`, { choice: 0 });
  assert.equal(again.body.question.fix_task_id, fix.id);
  assert.equal(s.app.tasks.list().length, 1, '2 回押しても直しのタスクは 1 つ（終えたもとのタスクは一覧に無い）');
  const answered = (await s.http('/api/questions?status=answered')).body.items;
  assert.deepEqual(answered.map((q: { id: number; answer_kind: string; fix: string | null }) => [q.id, q.answer_kind, q.fix]), [[colors!.id, 'changed', 'queued'], [dates!.id, 'kept', null]]);
  assert.deepEqual((await s.http('/api/questions/counts')).body, { open: 0, byProject: {}, byTask: {}, answered: 2, changed: 1 });
});

test('答え: 持ち主が書いた文は owner_request に入る。外を読んだ実行の質問では、選んだ選択肢の文は入れず（NULL）、判定役の頼みは空になる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const ctx = ctxFor(s, task.id, { tainted: true });
  await questionAdd.execute({ ...ask, question: 'Q1' } as never, ctx);
  await questionAdd.execute({ ...ask, question: 'Q2' } as never, ctx);
  const [q2, q1] = s.app.questions.list({ status: 'open' });
  s.app.tasks.finish(task.id, 'done', null, 'beat');
  const picked = await s.http(`/api/questions/${q1!.id}/answer`, { choice: 1 });
  const pickedFix = s.app.tasks.get(picked.body.fixTaskId)!;
  assert.equal(pickedFix.owner_request, null);
  assert.equal(s.app.tasks.judgeRequest(pickedFix.id), '', '外を読んだ質問の選択肢（AI の文）は、判定役の頼みにならない');
  const written = await s.http(`/api/questions/${q2!.id}/answer`, { choice: null, text: '  Use DD.MM  ' });
  assert.equal(written.body.kind, 'changed');
  const writtenFix = s.app.tasks.get(written.body.fixTaskId)!;
  assert.deepEqual(JSON.parse(writtenFix.owner_request!), { title: 'Use DD.MM', body: '', doneCriteria: null });
  assert.equal(s.app.tasks.judgeRequest(writtenFix.id), 'Use DD.MM');
  assert.equal(s.app.tasks.textTainted(pickedFix.id), true);
  assert.equal(s.app.tasks.textTainted(writtenFix.id), true, '題と本文に外を読んだ実行の質問の文が入るので、持ち主が書いた答えでも直しのタスクは外の印を持つ');
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'a', notify: false }), toolCall('task_complete', { summary: 'b', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(pickedFix.id)!.status, 'done');
  assert.equal(s.app.tasks.get(writtenFix.id)!.status, 'done');
  const runs = s.app.db.prepare("SELECT tainted FROM engine_runs WHERE kind = 'task'").all() as Array<{ tainted: number }>;
  assert.deepEqual(runs.map(r => r.tainted), [1, 1], '直しのタスクの実行は、外を読んだ実行として始まる');
});

test('question_add: 外を読んだことのある会話・外の文が入ったタスクの質問も tainted になる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  await questionAdd.execute({ ...ask, question: 'clean' } as never, ctxFor(s, task.id));
  await questionAdd.execute({ ...ask, question: 'conversation' } as never, { ...ctxFor(s, task.id), conversationTainted: () => true });
  s.app.tasks.markUntrusted(task.id, 'test', 'read outside');
  await questionAdd.execute({ ...ask, question: 'task text' } as never, ctxFor(s, task.id));
  const rows = s.app.db.prepare('SELECT question, tainted FROM questions ORDER BY id').all() as Array<{ question: string; tainted: number }>;
  assert.deepEqual(rows.map(r => [r.question, r.tainted]), [['clean', 0], ['conversation', 1], ['task text', 1]]);
});

test('鍵を幅の無い文字で割っても、外してから伏せるので残らない', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const key = `sk-ant-api03-${'b'.repeat(45)}​${'b'.repeat(45)}`;
  await questionAdd.execute({ ...ask, question: `Key ${key}` } as never, ctxFor(s, task.id));
  const [row] = s.app.questions.list({ status: 'open' });
  assert.ok(!row!.question.includes('b'.repeat(45)) && row!.question.includes('[REDACTED]'), row!.question);
});

test('blocking: 別の質問を待っているタスクは、古い質問の答えでは戻らない（答えは経過に残る）。待っている質問の答えで戻る', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const q1 = s.app.questions.add({ taskId: task.id, question: 'First?', options: ['a', 'b'], blocking: true });
  const q2 = s.app.questions.add({ taskId: task.id, question: 'Second?', options: ['c', 'd'], blocking: true });
  s.app.tasks.setWaiting(task.id, 'question', 'Second?');
  const stale = await s.http(`/api/questions/${q1.id}/answer`, { choice: 0 });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.resumedTaskId, null);
  assert.equal(s.app.tasks.get(task.id)!.status, 'waiting', '待っているのは Second? なので戻さない');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'answer' && /First\?/u.test(e.content ?? '')), '古い質問の答えも経過に残る');
  const fresh = await s.http(`/api/questions/${q2.id}/answer`, { choice: 1 });
  assert.equal(fresh.body.resumedTaskId, task.id);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.ok(s.app.tasks.events(task.id).some(e => e.kind === 'answer' && /Second\?[\s\S]*d/u.test(e.content ?? '')));
});

test('blocking: 実行中のタスクの質問は 409 で断り、Open のまま。終わったタスクの質問に違う答えなら直しのタスク。承認待ちのタスクは戻さず経過に書く', async t => {
  const s = await setup(t);
  const running = s.app.tasks.create({ title: 'R', origin: 'user', actor: 'user' });
  const q = s.app.questions.add({ taskId: running.id, question: 'Now?', options: ['a', 'b'], blocking: true });
  assert.ok(s.app.tasks.claim(running.id, 60_000, 'conv-r'));
  const refused = await s.http(`/api/questions/${q.id}/answer`, { choice: 1 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'question.task_running');
  assert.equal(s.app.questions.get(q.id)!.status, 'open');
  s.app.tasks.setWaiting(running.id, 'question', 'Now?');
  assert.equal((await s.http(`/api/questions/${q.id}/answer`, { choice: 1 })).body.resumedTaskId, running.id);

  const finished = s.app.tasks.create({ title: 'F', origin: 'user', actor: 'user' });
  const late = s.app.questions.add({ taskId: finished.id, question: 'Late?', options: ['a', 'b'], blocking: true });
  const keptLate = s.app.questions.add({ taskId: finished.id, question: 'Late kept?', options: ['a', 'b'], chosen: 0, blocking: true });
  s.app.tasks.finish(finished.id, 'done', null, 'beat');
  const fixed = await s.http(`/api/questions/${late.id}/answer`, { choice: 1 });
  assert.equal(fixed.body.kind, 'changed');
  assert.ok(fixed.body.fixTaskId, '止まっていたタスクがもう終わっているなら、違う答えは直しのタスクになる');
  assert.equal(s.app.tasks.get(fixed.body.fixTaskId)!.status, 'ready');
  assert.equal((await s.http(`/api/questions/${keptLate.id}/answer`, { choice: 0 })).body.fixTaskId, null);

  const approval = s.app.tasks.create({ title: 'A', origin: 'user', actor: 'user' });
  const qa = s.app.questions.add({ taskId: approval.id, question: 'Which?', options: ['a', 'b'], blocking: true });
  s.app.tasks.setWaiting(approval.id, 'approval', '#3');
  const noted = await s.http(`/api/questions/${qa.id}/answer`, { choice: 0 });
  assert.equal(noted.body.resumedTaskId, null);
  assert.equal(noted.body.fixTaskId, null);
  assert.equal(s.app.tasks.get(approval.id)!.status, 'waiting');
  assert.ok(s.app.tasks.events(approval.id).some(e => e.kind === 'answer' && /Which\?/u.test(e.content ?? '')));
});

test('答えの口: 戻したタスクの分けの印を消し、動かすタスクをワーカーに回す。2 回目の答えでは回さない', async t => {
  const s = await setup(t);
  const calls: string[] = [];
  const original = s.app.worker.requestRun.bind(s.app.worker);
  s.app.worker.requestRun = (id: string) => { calls.push(id); original(id); };
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user', runAt: s.clock.now + 3_600_000 });
  const q = s.app.questions.add({ taskId: task.id, question: 'Go?', options: ['a', 'b'], blocking: true });
  s.app.tasks.setWaiting(task.id, 'question', 'Go?');
  s.app.kv.set(`task-split:${task.id}`, '1');
  await s.http(`/api/questions/${q.id}/answer`, { choice: 0 });
  assert.equal(s.app.kv.get(`task-split:${task.id}`), undefined);
  assert.deepEqual(calls, [task.id]);
  const other = s.app.questions.add({ taskId: task.id, question: 'Color?', options: ['a', 'b'], chosen: 0 });
  const changed = await s.http(`/api/questions/${other.id}/answer`, { choice: 1 });
  assert.equal(changed.body.resumedTaskId, task.id, '動く前のタスクの質問の違う答えは、そのタスクに返す（B5）');
  assert.deepEqual(calls, [task.id, task.id]);
  await s.http(`/api/questions/${other.id}/answer`, { choice: 1 });
  await s.http(`/api/questions/${q.id}/answer`, { choice: 1 });
  assert.deepEqual(calls, [task.id, task.id], '2 回目の答えでは、ワーカーに回し直さない');
});

test('答え: 入力の形を確かめる（選択肢の外・空・両方・知らない番号）', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  await questionAdd.execute(ask as never, ctxFor(s, task.id));
  const [row] = s.app.questions.list({ status: 'open' });
  for (const body of [{ choice: 2 }, { choice: -1 }, { choice: 0.5 }, { choice: null }, { choice: null, text: '   ' }, { choice: 0, text: 'x' }, { choice: '0' }]) {
    assert.equal((await s.http(`/api/questions/${row!.id}/answer`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await s.http('/api/questions/999/answer', { choice: 0 })).status, 404);
  assert.equal(s.app.questions.get(row!.id)!.status, 'open');
});

test('答え: stuck・check_failed の行は、選び直すと元のタスクを開き直す（新しいタスクは作らない）。submit_refused は直しのタスクを作らず、会話から自分で送るよう経過に書く', async t => {
  const s = await setup(t);
  const stuck = s.app.tasks.create({ title: 'Stuck one', origin: 'user', actor: 'user' });
  s.app.tasks.finish(stuck.id, 'failed', null, 'beat');
  const checkFailed = s.app.tasks.create({ title: 'Check one', origin: 'user', actor: 'user' });
  s.app.tasks.finish(checkFailed.id, 'failed', null, 'beat');
  const browse = s.app.tasks.create({ title: 'Browse', origin: 'user', actor: 'user' });
  const a = s.app.questions.add({ kind: 'stuck', taskId: stuck.id, question: 'Stuck one made no progress', options: ['Retry', 'Leave it'], chosen: 1 });
  const b = s.app.questions.add({ kind: 'check_failed', taskId: checkFailed.id, question: 'The check failed', options: ['Retry', 'Leave it'], chosen: 1 });
  const c = s.app.questions.add({ kind: 'submit_refused', taskId: browse.id, question: 'Send the form at https://example.com/form?', options: ['Send it', 'Do not send'], chosen: 1 });
  const total = () => (s.app.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  const before = total();
  const retried = await s.http(`/api/questions/${a.id}/answer`, { choice: 0 });
  assert.equal(retried.body.kind, 'changed');
  assert.equal(retried.body.reopenedTaskId, stuck.id);
  assert.equal(retried.body.fixTaskId, null);
  assert.equal(s.app.tasks.get(stuck.id)!.status, 'ready');
  assert.equal((await s.http(`/api/questions/${b.id}/answer`, { choice: 0 })).body.reopenedTaskId, checkFailed.id);
  assert.equal(s.app.tasks.get(checkFailed.id)!.status, 'ready');
  assert.equal(total(), before, '開き直しでタスクは増えない');
  const sent = await s.http(`/api/questions/${c.id}/answer`, { choice: 0 });
  assert.equal(sent.body.kind, 'changed');
  assert.equal(sent.body.fixTaskId, null);
  assert.equal(total(), before, '送ってよいと答えてもタスクは増えない');
  assert.ok(s.app.tasks.events(browse.id).some(e => e.kind === 'answer' && /https:\/\/example\.com\/form[\s\S]*opens a conversation/u.test(e.content ?? '')));
  const left = s.app.questions.add({ kind: 'stuck', taskId: stuck.id, question: 'again', options: ['Retry', 'Leave it'], chosen: 1 });
  s.app.tasks.finish(stuck.id, 'failed', null, 'beat');
  assert.equal((await s.http(`/api/questions/${left.id}/answer`, { choice: 1 })).body.kind, 'kept');
  assert.equal(s.app.tasks.get(stuck.id)!.status, 'failed', 'Leave it（仮の選択）では開き直さない');
});

test('数: 製品ごと・タスクごとに数え、別の製品の数に入らない。製品の行の questions は質問票の Open の数', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const blog = s.project('blog');
  const shopTask = s.app.tasks.create({ title: 'S', origin: 'user', actor: 'user', projectId: shop.id });
  const blogTask = s.app.tasks.create({ title: 'B', origin: 'user', actor: 'user', projectId: blog.id });
  await questionAdd.execute({ ...ask, question: 's1' } as never, ctxFor(s, shopTask.id, { projectId: shop.id }));
  await questionAdd.execute({ ...ask, question: 's2' } as never, ctxFor(s, shopTask.id, { projectId: shop.id }));
  await questionAdd.execute({ ...ask, question: 'b1' } as never, ctxFor(s, blogTask.id, { projectId: blog.id }));
  s.app.tasks.setWaiting(blogTask.id, 'question', 'old style question');
  s.app.questions.add({ question: 'no product', options: ['a', 'b'], chosen: 0 });
  const counts = (await s.http('/api/questions/counts')).body;
  assert.deepEqual(counts, { open: 4, byProject: { [shop.id]: 2, [blog.id]: 1 }, byTask: { [shopTask.id]: 2, [blogTask.id]: 1 }, answered: 0, changed: 0 });
  assert.equal(s.app.projects.counts(shop.id).questions, 2);
  assert.equal(s.app.projects.counts(blog.id).questions, 1, '返事待ちのタスクではなく、質問票の行を数える');
  const list = (await s.http(`/api/questions?projectId=${shop.id}`)).body.items;
  assert.deepEqual(list.map((q: { question: string }) => q.question), ['s2', 's1']);
});

test('一覧: Answered は id の続きでめくる', async t => {
  const s = await setup(t);
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user' });
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) {
    const row = s.app.questions.add({ taskId: task.id, question: `q${i}`, options: ['a', 'b'], chosen: 0 });
    s.app.questions.answer(row.id, { choice: 0 });
    ids.push(row.id);
  }
  const first = s.app.questions.list({ status: 'answered', limit: 2 });
  assert.deepEqual(first.map(q => q.id), [ids[4], ids[3]]);
  const next = (await s.http(`/api/questions?status=answered&before=${ids[3]}`)).body.items;
  assert.deepEqual(next.map((q: { id: number }) => q.id), [ids[2], ids[1], ids[0]]);
});

test('question_list: その製品の Open と最近の答えを返す。外を読んだ実行の質問が入るときは、外から読んだ印が付く', async t => {
  const s = await setup(t);
  const shop = s.project('shop');
  const other = s.project('other');
  const task = s.app.tasks.create({ title: 'T', origin: 'user', actor: 'user', projectId: shop.id });
  const ctx = ctxFor(s, task.id, { projectId: shop.id });
  await questionAdd.execute({ ...ask, question: 'Open one' } as never, ctx);
  await questionAdd.execute({ ...ask, question: 'Answered one' } as never, ctx);
  s.app.questions.add({ projectId: other.id, question: 'Elsewhere', options: ['a', 'b'], chosen: 0 });
  const answered = s.app.questions.list({ status: 'open', projectId: shop.id }).find(q => q.question === 'Answered one')!;
  s.app.questions.answer(answered.id, { choice: null, text: 'Use 14 Nov' });
  const clean = await questionList.execute({} as never, ctx);
  assert.match(clean.content, /Open questions:\n#\d+ Open one \(assumed: 2026-11-14\)/u);
  assert.match(clean.content, /Recent answers:\n#\d+ Answered one \(assumed: 2026-11-14; answer: Use 14 Nov\)/u);
  assert.ok(!clean.content.includes('Elsewhere'));
  assert.equal(clean.fetched, undefined);
  await questionAdd.execute({ ...ask, question: 'From the web' } as never, ctxFor(s, task.id, { projectId: shop.id, tainted: true }));
  assert.equal((await questionList.execute({} as never, ctx)).fetched, true);
});
