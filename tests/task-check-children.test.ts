import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { CHECK_FAIL_LIMIT, runProductCheck } from '../src/projects/check-run.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { selfTarget } from '../src/tools/hooks/self-port.ts';
import { FakeAdapter, tempDir, type Script, testConfig } from './helpers.ts';

function toolCall(name: string, args: unknown, before?: () => void): Script {
  return async function* () {
    before?.();
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

const CHECK_JS = [
  "const fs = require('fs');",
  "fs.appendFileSync('runs.log', 'x\\n');",
  "const ok = fs.existsSync('fixed');",
  "if (!ok) { console.log('1 test failed'); console.error('assertion failed near sk-' + 'ant-' + 'A'.repeat(30)); }",
  'process.exit(ok ? 0 : 1);',
].join('\n');

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 2, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const product = (name: string, checkCommand: string | null = 'node check.js') => {
    const root = join(tempDir(t), name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'check.js'), CHECK_JS);
    return { row: app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand }), root };
  };
  const runs = (root: string) => (existsSync(join(root, 'runs.log')) ? readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n').length : 0);
  const toolTexts = (taskId: string) => {
    const cid = app.tasks.get(taskId)!.conversation_id!;
    return app.conversations.messages(cid).filter(m => m.role === 'tool').map(m => ({ text: m.text, isError: (m.message as { isError?: boolean }).isError === true }));
  };
  const events = (taskId: string, kind: string) => app.tasks.events(taskId).filter(e => e.kind === kind);
  return { app, adapter: () => adapter, clock, product, runs, toolTexts, events };
}

async function runTask(s: Awaited<ReturnType<typeof setup>>, id: string, scripts: Script[]) {
  s.adapter().scripts.push(...scripts);
  s.app.worker.requestRun(id);
  assert.equal(await s.app.worker.tick(), 'ran');
}

test('5-3a: check_command の失敗は同じ実行の作る役に返り、直して通ると完了。確かめは 1 回ずつ数える', async t => {
  const s = await setup(t);
  const { row, root } = s.product('shop');
  const task = s.app.tasks.create({ title: 'build it', origin: 'user', projectId: row.id, actor: 'user' });
  await runTask(s, task.id, [
    toolCall('task_complete', { summary: 'first try', notify: false }),
    toolCall('task_complete', { summary: 'fixed', notify: false }, () => writeFileSync(join(root, 'fixed'), '')),
  ]);
  const done = s.app.tasks.get(task.id)!;
  assert.equal(done.status, 'done');
  assert.equal(done.result_summary, 'fixed');
  assert.equal(s.runs(root), 2);
  const [first, second] = s.toolTexts(task.id);
  assert.equal(first!.isError, true);
  assert.match(first!.text, /check command failed \(exit code 1\)/u);
  assert.match(first!.text, /failure 1 of 3/u);
  assert.match(first!.text, /1 test failed/u);
  assert.doesNotMatch(first!.text, /AAAAAAAAAAAAAAAAAAAA/u);
  assert.equal(second!.isError, false);
  assert.match(second!.text, /check command passed: node check\.js/u);
  assert.equal(s.events(task.id, 'check_failed').length, 1);
  assert.equal(s.events(task.id, 'check_passed').length, 1);
  assert.equal(done.attempts, 0);
});

test('5-3a: check_command が 3 回続けて落ちると failed と質問票の行（check_failed・Retry / Leave it）。Retry でもとのタスクが開き直され、数え直す', async t => {
  const s = await setup(t);
  const { row, root } = s.product('shop');
  const task = s.app.tasks.create({ title: 'build it', origin: 'user', projectId: row.id, actor: 'user' });
  await runTask(s, task.id, [
    toolCall('task_complete', { summary: 'a', notify: false }),
    toolCall('task_complete', { summary: 'b', notify: false }),
  ]);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.equal(s.app.tasks.checkFailures(task.id).count, 2);
  await runTask(s, task.id, [toolCall('task_complete', { summary: 'c', notify: false })]);
  const failed = s.app.tasks.get(task.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.result_summary ?? '', new RegExp(`failed ${CHECK_FAIL_LIMIT} times in a row \\(exit code 1\\)`, 'u'));
  assert.equal(s.runs(root), 3);
  const last = s.toolTexts(task.id).at(-1)!;
  assert.match(last.text, /closed as failed/u);
  const questions = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.equal(questions.length, 1);
  const q = questions[0]!;
  assert.equal(q.kind, 'check_failed');
  assert.equal(q.project_id, row.id);
  assert.deepEqual(q.options, ['Retry', 'Leave it']);
  assert.equal(q.chosen, 1);
  assert.equal(q.blocking, false);
  assert.match(q.why ?? '', /exit code 1/u);
  assert.doesNotMatch(q.why ?? '', /AAAAAAAAAAAAAAAAAAAA/u);
  assert.equal(s.app.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'task_failed'").get()!.n, 1);
  const answered = s.app.questions.answer(q.id, { choice: 0 })!;
  assert.equal(answered.reopenedTaskId, task.id);
  assert.equal(answered.fixTaskId, null);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.equal(s.app.tasks.checkFailures(task.id).count, 0);
  await runTask(s, task.id, [toolCall('task_complete', { summary: 'again', notify: false })]);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
  assert.match(s.toolTexts(task.id).at(-1)!.text, /failure 1 of 3/u);
});

test('5-3a: Leave it（仮の選択のまま）ではタスクは失敗のまま', async t => {
  const s = await setup(t);
  const { row } = s.product('shop');
  const task = s.app.tasks.create({ title: 'build it', origin: 'user', projectId: row.id, actor: 'user' });
  await runTask(s, task.id, [1, 2, 3].map(n => toolCall('task_complete', { summary: `try ${n}`, notify: false })));
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
  const q = s.app.questions.list({ status: 'open', taskId: task.id })[0]!;
  const answered = s.app.questions.answer(q.id, { choice: 1 })!;
  assert.equal(answered.kind, 'kept');
  assert.equal(s.app.tasks.get(task.id)!.status, 'failed');
});

test('5-3a: check_command の無い製品・製品に属さないタスクは今までどおり完了する（確かめを動かさない）', async t => {
  const s = await setup(t);
  const { row, root } = s.product('plain', null);
  const inProduct = s.app.tasks.create({ title: 'no check', origin: 'user', projectId: row.id, actor: 'user' });
  await runTask(s, inProduct.id, [toolCall('task_complete', { summary: 'ok', notify: false })]);
  const loose = s.app.tasks.create({ title: 'loose', origin: 'user', actor: 'user' });
  await runTask(s, loose.id, [toolCall('task_complete', { summary: 'ok', notify: false })]);
  for (const id of [inProduct.id, loose.id]) {
    assert.equal(s.app.tasks.get(id)!.status, 'done');
    assert.equal(s.events(id, 'check_passed').length + s.events(id, 'check_failed').length, 0);
    assert.doesNotMatch(s.toolTexts(id)[0]!.text, /check command/u);
  }
  assert.equal(s.runs(root), 0);
});

test('5-3a: 子が 2 つ。親は子が終わるまで区切って選ばれず、子では確かめを動かさず、最後に 1 回だけ動く', async t => {
  const s = await setup(t);
  const { row, root } = s.product('shop');
  writeFileSync(join(root, 'fixed'), '');
  const parent = s.app.tasks.create({ title: 'parent', origin: 'user', projectId: row.id, actor: 'user' });
  await runTask(s, parent.id, [
    toolCall('task_create', { title: 'child A' }),
    toolCall('task_create', { title: 'child B' }),
    toolCall('task_complete', { summary: 'parent waits', notify: false }),
  ]);
  const children = s.app.db.prepare('SELECT * FROM tasks WHERE spawned_by = ? ORDER BY title').all(parent.id) as Array<{ id: string; origin: string; parent_id: string | null; status: string }>;
  assert.equal(children.length, 2);
  assert.deepEqual(children.map(c => [c.origin, c.parent_id, c.status]), [['user', null, 'ready'], ['user', null, 'ready']]);
  const yielded = s.app.tasks.get(parent.id)!;
  assert.equal(yielded.status, 'ready');
  assert.equal(yielded.run_at, null);
  assert.equal(yielded.attempts, 0);
  assert.match(s.toolTexts(parent.id).at(-1)!.text, /2 task\(s\) you made from this task are not finished/u);
  assert.equal(s.runs(root), 0);
  assert.equal(s.app.tasks.openChildren(parent.id), 2);

  const order: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const next = s.app.tasks.pickNext({ allowSelf: false });
    assert.ok(next);
    assert.notEqual(next.id, parent.id);
    order.push(next.id);
    s.adapter().scripts.push(toolCall('task_complete', { summary: `child ${i}`, notify: false }));
    assert.equal(await s.app.worker.tick(), 'ran');
    assert.equal(s.app.tasks.get(next.id)!.status, 'done');
  }
  assert.equal(s.runs(root), 0);
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, parent.id);
  s.app.tasks.reopen(order[0]!, 'beat', 'approved Pending item failed');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, order[0]);
  s.app.tasks.finish(order[0]!, 'done', 'again', 'beat');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, parent.id);
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'all done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(parent.id)!.status, 'done');
  assert.equal(s.runs(root), 1);
  assert.equal(s.events(parent.id, 'check_passed').length, 1);
  s.app.tasks.reopen(order[1]!, 'beat', 'approved Pending item failed');
  assert.equal(s.app.tasks.get(parent.id)!.status, 'done');
});

test('5-3a: 子が failed / cancelled でも親は選ばれる。repeat と inbox の子は親を止めない', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'parent', origin: 'user', actor: 'user' });
  const child = (title: string, extra: Partial<Parameters<typeof s.app.tasks.create>[0]> = {}) => s.app.tasks.create({ title, origin: 'user', actor: 'beat', spawnedBy: parent.id, ...extra });
  const a = child('fails');
  const b = child('cancelled');
  child('repeat', { cron: '0 9 * * *' });
  child('proposal', { propose: true });
  assert.equal(s.app.tasks.openChildren(parent.id), 2);
  assert.notEqual(s.app.tasks.pickNext({ allowSelf: false })?.id, parent.id);
  s.app.tasks.finish(a.id, 'failed', 'x', 'worker');
  assert.equal(s.app.tasks.openChildren(parent.id), 1);
  s.app.tasks.finish(b.id, 'cancelled', 'x', 'user');
  assert.equal(s.app.tasks.openChildren(parent.id), 0);
  assert.equal(s.app.tasks.pickNext({ allowSelf: false })?.id, parent.id);
});

test('5-3a: 子が Pending の承認待ち・返事待ちでも親は選ばれない。子が待ちの時間にいるあいだ、ワーカーは busy にならない', async t => {
  const s = await setup(t);
  const parent = s.app.tasks.create({ title: 'parent', origin: 'user', actor: 'user' });
  const kid = s.app.tasks.create({ title: 'kid', origin: 'user', actor: 'beat', spawnedBy: parent.id });
  s.app.tasks.setWaiting(kid.id, 'approval', '#12');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false }), undefined);
  s.app.tasks.setWaiting(kid.id, 'question', 'which?');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false }), undefined);
  assert.equal(await s.app.worker.tick(), 'idle');
  s.app.tasks.setReady(kid.id, { runAt: s.clock.now + 60 * 60_000 });
  s.app.tasks.update(parent.id, { runAt: s.clock.now + 5 * 60_000 }, 'user');
  assert.equal(s.app.tasks.pickNext({ allowSelf: false }), undefined);
  assert.equal(s.app.tasks.nextWakeAt({ allowSelf: false }), s.clock.now + 60 * 60_000);
  assert.equal(await s.app.worker.tick(), 'idle');
});

test('5-3a: 持ち主の「今すぐ実行」で親を動かしても区切りで終わり、失敗の数に入らない', async t => {
  const s = await setup(t);
  const { row, root } = s.product('shop');
  const parent = s.app.tasks.create({ title: 'parent', origin: 'user', projectId: row.id, actor: 'user' });
  const kid = s.app.tasks.create({ title: 'kid', origin: 'user', actor: 'beat', spawnedBy: parent.id, projectId: row.id, runAt: s.clock.now + 60 * 60_000 });
  await runTask(s, parent.id, [toolCall('task_complete', { summary: 'early', notify: false })]);
  const after = s.app.tasks.get(parent.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.attempts, 0);
  assert.equal(s.runs(root), 0);
  assert.equal(s.app.kv.get(`task-idle:${parent.id}`), undefined);
  assert.equal(s.events(parent.id, 'requeued').at(0)?.content, 'Waiting for 1 task(s) it made to finish');
  assert.equal(s.app.tasks.get(kid.id)!.parent_id, null);
});

test('5-3a: 1 つの製品で同時に動くタスクは 1 つ（ほかの製品・製品の無いタスクは動く）。今すぐ実行も同じ枠', async t => {
  const s = await setup(t, c => { c.worker.maxParallel = 2; });
  const { row: shop } = s.product('shop', null);
  const { row: blog } = s.product('blog', null);
  const a = s.app.tasks.create({ title: 'a', origin: 'user', projectId: shop.id, actor: 'user' });
  const b = s.app.tasks.create({ title: 'b', origin: 'user', projectId: shop.id, actor: 'user' });
  assert.ok(s.app.tasks.claim(a.id, 60_000, 'conv-a'));
  assert.equal(s.app.tasks.pickNext({ allowSelf: false }), undefined);
  assert.equal(s.app.tasks.productBusy(s.app.tasks.get(b.id)!), true);
  const c = s.app.tasks.create({ title: 'c', origin: 'user', projectId: blog.id, actor: 'user' });
  const d = s.app.tasks.create({ title: 'd', origin: 'user', actor: 'user' });
  assert.deepEqual([c.id, d.id].includes(s.app.tasks.pickNext({ allowSelf: false })!.id), true);
  s.app.tasks.update(b.id, { runAt: s.clock.now + 60_000 }, 'user');
  s.app.tasks.update(c.id, { runAt: s.clock.now + 120_000 }, 'user');
  assert.equal(s.app.tasks.nextWakeAt({ allowSelf: false }), s.clock.now + 120_000);
  s.app.tasks.update(b.id, { runAt: null }, 'user');
  s.app.tasks.finish(c.id, 'cancelled', null, 'user');
  s.app.tasks.finish(d.id, 'cancelled', null, 'user');
  s.app.worker.requestRun(b.id);
  assert.equal(await s.app.worker.tick(), 'busy');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  s.app.tasks.finish(a.id, 'done', 'x', 'user');
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'b done', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
});

test('5-3a: 洗った環境で動く（鍵は渡らない）。30 分の上限の代わりに短い上限で止まり、子のプロセスも残らない。取り消しも中まで届く', async t => {
  const s = await setup(t);
  const root = join(tempDir(t), 'env');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'env.js'), "require('fs').writeFileSync('env.json', JSON.stringify(process.env))");
  writeFileSync(join(root, 'hang.js'), [
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['-e', \"setTimeout(() => require('fs').writeFileSync('late.txt', 'x'), 2500)\"], { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak-0123456789';
  process.env.MY_SERVICE_TOKEN = 'token-should-not-leak';
  const config = s.app.config();
  config.tools.shell.envAllow = [...config.tools.shell.envAllow, 'MY_SERVICE_TOKEN'];
  try {
    const ok = await runProductCheck({ command: 'node env.js', root }, { config, signal: new AbortController().signal });
    assert.equal(ok.ok, true);
  } finally {
    for (const key of ['ANTHROPIC_API_KEY', 'MY_SERVICE_TOKEN']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
  const env = readFileSync(join(root, 'env.json'), 'utf8');
  assert.doesNotMatch(env, /should-not-leak/u);
  assert.match(env, /PATH/iu);
  writeFileSync(join(root, 'check.js'), CHECK_JS);
  const failed = await runProductCheck({ command: 'node check.js', root }, { config, signal: new AbortController().signal });
  assert.equal(!failed.ok && failed.reason, 'failed');
  assert.match(!failed.ok && failed.reason !== 'aborted' ? failed.tail : '', /1 test failed[\s\S]*\[stderr\][\s\S]*assertion failed near/u);
  assert.doesNotMatch(!failed.ok && failed.reason !== 'aborted' ? failed.tail : '', /AAAAAAAAAAAAAAAAAAAA/u);

  const timed = await runProductCheck({ command: 'node hang.js', root }, { config, signal: new AbortController().signal, timeoutMs: 1500 });
  assert.equal(timed.ok, false);
  assert.equal(!timed.ok && timed.reason, 'timeout');
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 800);
  const stopped = await runProductCheck({ command: 'node hang.js', root }, { config, signal: stop.signal });
  assert.equal(!stopped.ok && stopped.reason, 'aborted');
  await new Promise(r => setTimeout(r, 3500));
  assert.equal(existsSync(join(root, 'late.txt')), false);
});

test('5-3a: 持ち主がタスクを取り消すと、動いている確かめが止まり、タスクは取り消しのまま', async t => {
  const s = await setup(t);
  const { row, root } = s.product('shop', 'node hang.js');
  writeFileSync(join(root, 'hang.js'), "require('fs').writeFileSync('started', ''); setInterval(() => {}, 1000);");
  const task = s.app.tasks.create({ title: 'slow', origin: 'user', projectId: row.id, actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'done?', notify: false }));
  s.app.worker.requestRun(task.id);
  const ticking = s.app.worker.tick();
  const start = Date.now();
  while (!existsSync(join(root, 'started'))) {
    assert.ok(Date.now() - start < 15_000, 'check started');
    await new Promise(r => setTimeout(r, 20));
  }
  s.app.tasks.finish(task.id, 'cancelled', 'stop', 'user');
  assert.equal(s.app.worker.stopTask(task.id), true);
  assert.equal(await ticking, 'ran');
  assert.ok(Date.now() - start < 15_000);
  assert.equal(s.app.tasks.get(task.id)!.status, 'cancelled');
  assert.equal(s.events(task.id, 'check_failed').length, 0);
});

test('5-3a: AI が check_command を書き換える道が無い: シェルから beat 自身の製品の設定の口へは届かない', () => {
  const server = { host: '127.0.0.1', port: 4851, origins: [] as string[] };
  for (const command of [
    'curl -X PATCH http://127.0.0.1:4851/api/projects/abc -d "{\\"checkCommand\\":\\"exit 0\\"}"',
    'Invoke-WebRequest -Method Patch http://localhost:4851/api/projects/abc',
  ]) assert.notEqual(selfTarget(command, server as never), undefined, command);
});
