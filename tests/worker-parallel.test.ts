import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { languageOf } from '../src/shared/language.ts';
import { taskText } from '../src/shared/messages/tasks.ts';
import { FakeAdapter, reply, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

async function waitFor(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`待ちきれませんでした: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// 壊れたときに、終わらない待ちでテスト全体が止まらないよう、待ちに上限を付ける
function within<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`待ちきれませんでした: ${label}`)), ms).unref(); })]);
}

// 返事を止めておき、release() で task_complete を返して終わらせる偽の提供元の台本
function gated(): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const script: Script = async function* (req) {
    yield { type: 'text', delta: '調べています…' };
    await new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      void gate.then(resolve);
    });
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name: 'task_complete', arguments: { summary: '終わりました', notify: false } };
    yield { type: 'tool_call', call };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  return { script, release };
}

// 振り返り用: 返事を止めておき、release() で文を返して終わらせる（abort されたら止まる）
function gatedReply(text = '変更なし'): { script: Script; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const script: Script = async function* (req) {
    yield { type: 'text', delta: '振り返っています…' };
    await new Promise<void>((resolve, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      void gate.then(resolve);
    });
    yield { type: 'text', delta: text };
    yield { type: 'done', stop: 'end_turn' as StopReason };
  };
  return { script, release };
}

function toolCallScript(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: '調べています…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

// 振り返りを有効にする（きっかけは手で積むので、会話の途切れでは勝手に積まれないようにする）
const reviewOn = (c: AppConfig): void => { c.memory.review = true; c.memory.reviewIdleMinutes = 1440; };

async function setup(t: { after: (fn: () => void) => void }, options: { workerMax: number; providerMax: number; timers?: boolean; edit?: (c: AppConfig) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: options.providerMax, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.worker.maxParallel = options.workerMax;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: options.timers ?? false,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => { app.worker.stop(); app.engine.stopAll(); });
  t.after(() => app.close());
  const userTask = (title: string) => app.tasks.create({ title, origin: 'user', actor: 'user' });
  return { app, adapter: () => adapter, clock, userTask };
}

test('worker.maxParallel が 2 なら、2 件のタスクが同時に動く', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2 });
  const a = s.userTask('A');
  const b = s.userTask('B');
  const g1 = gated();
  const g2 = gated();
  s.adapter().scripts.push(g1.script, g2.script);
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が同時に始まる');
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  assert.equal(s.app.tasks.get(b.id)!.status, 'running');
  const status = s.app.worker.status();
  assert.equal(status.runningAll.length, 2);
  assert.equal(status.running?.runId, status.runningAll[0]!.runId, '先頭は今までの running と同じ');
  g1.release(); g2.release();
  assert.deepEqual(await Promise.all([t1, t2]), ['ran', 'ran']);
  assert.equal(s.app.tasks.get(a.id)!.status, 'done');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
  assert.equal(s.app.worker.status().runningAll.length, 0);
});

test('提供元の maxParallel が 1 なら、ワーカーの枠が空いていても 2 件目を始めない', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1 });
  s.userTask('A');
  const b = s.userTask('B');
  const g1 = gated();
  s.adapter().scripts.push(g1.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  assert.equal(await s.app.worker.tick(), 'busy', '提供元が満杯なので 2 件目は選ばない');
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready', '選ばれなかったタスクは実行待ちのまま（claim しない）');
  g1.release();
  assert.equal(await t1, 'ran');
  assert.equal(await s.app.worker.tick(), 'ran', '空けば 2 件目が動く');
});

test('既定の 1 では、動いている最中の 2 回目の tick は busy（今までと同じ）', async t => {
  const s = await setup(t, { workerMax: 1, providerMax: 2 });
  s.userTask('A');
  s.userTask('B');
  const g1 = gated();
  s.adapter().scripts.push(g1.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  assert.equal(await s.app.worker.tick(), 'busy');
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.app.worker.status().runningAll.length, 1);
  g1.release();
  assert.equal(await t1, 'ran');
});

test('自動で動くとき、枠が残っていれば続けて始め、1 件終わると空いた枠で次が始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2, timers: true });
  s.userTask('A'); s.userTask('B'); s.userTask('C');
  const g = [gated(), gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  s.app.worker.start();
  await waitFor(() => s.adapter().calls.length === 2, '手で tick しなくても 2 件が始まる');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.adapter().calls.length, 2, '枠は 2 つまで');
  g[0]!.release();
  await waitFor(() => s.adapter().calls.length === 3, '終わった枠に 3 件目が入る');
  g[1]!.release(); g[2]!.release();
  await waitFor(() => s.app.tasks.list().every(x => x.status === 'done'), '全部終わる');
});

test('提供元が満杯でも、自動で動くなら、1 件終わった合図で待っていた 2 件目が始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1, timers: true });
  s.userTask('A');
  const b = s.userTask('B');
  const g = [gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  s.app.worker.start();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(s.adapter().calls.length, 1, '提供元が満杯なので 2 件目は待つ');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  g[0]!.release();
  await waitFor(() => s.adapter().calls.length === 2, '終わった合図で 2 件目が始まる', 6000);
  g[1]!.release();
  await waitFor(() => s.app.tasks.list().every(x => x.status === 'done'), '全部終わる');
});

test('「今すぐ実行」は、提供元が満杯のあいだ待ち、空いたら始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1 });
  s.userTask('A');
  const b = s.userTask('B');
  const g = [gated(), gated()];
  s.adapter().scripts.push(...g.map(x => x.script));
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  s.app.worker.requestRun(b.id);
  assert.equal(await s.app.worker.tick(), 'busy', '満杯のあいだは始めない');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  g[0]!.release();
  assert.equal(await t1, 'ran');
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '空いたら始まる');
  g[1]!.release();
  assert.equal(await t2, 'ran');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
});

test('stopTask は、止めると言われたタスクの実行だけを止める', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2 });
  const a = s.userTask('A');
  const b = s.userTask('B');
  s.adapter().scripts.push(hang(), hang());
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が動く');
  assert.equal(s.app.worker.stopTask(b.id), true);
  await waitFor(() => s.app.worker.status().runningAll.length === 1, '止めた方だけ抜ける');
  assert.equal(s.app.worker.status().runningAll[0]!.taskId, a.id);
  assert.equal(s.app.tasks.get(a.id)!.status, 'running');
  assert.equal(s.app.worker.stopTask(b.id), false, '止め終えたものは、もう動いていない');
  assert.equal(s.app.worker.stopTask(a.id), true);
  await Promise.all([t1, t2]);
});

test('1 時間の上限は、並列で動いている分も合計で数える', async t => {
  const s = await setup(t, { workerMax: 3, providerMax: 3, edit: c => { c.worker.maxRunsPerHour = 2; } });
  s.userTask('A'); s.userTask('B'); const c = s.userTask('C');
  const g1 = gated(); const g2 = gated();
  s.adapter().scripts.push(g1.script, g2.script);
  const t1 = s.app.worker.tick();
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 2, '2 件が動く');
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.equal(s.app.tasks.get(c.id)!.status, 'ready');
  g1.release(); g2.release();
  await Promise.all([t1, t2]);
});

test('worker.maxParallel は 1〜4 だけ受け付ける', async t => {
  for (const bad of [0, 5]) {
    await assert.rejects(() => setup(t, { workerMax: bad, providerMax: 1 }));
  }
});

type Rig = Awaited<ReturnType<typeof setup>>;

async function chat(s: Rig, conversationId: string, text: string): Promise<void> {
  s.adapter().scripts.push(reply('はい'));
  const outcome = s.app.engine.send(conversationId, text);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  await s.app.engine.wait(outcome.runId);
}

const jobOf = (s: Rig, id: number) => s.app.reviews.get(id)!;

test('並列 2 でも、同じ会話の振り返りは同時に 2 本動かさない。別の会話の分は飛ばされずに先へ進む', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2, edit: reviewOn });
  await chat(s, 'c1', '来週から大阪に出張です');
  await chat(s, 'c2', '犬を飼い始めました');
  s.app.engine.lastUserActivity = 0;
  const first = s.app.reviews.enqueue('heavy_run', 'run:c1', { conversationId: 'c1', kind: 'skill' })!;
  const second = s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' })!;
  const other = s.app.reviews.enqueue('manual', 'manual:c2', { conversationId: 'c2', kind: 'skill' })!;
  const base = s.adapter().calls.length;
  const g1 = gatedReply(); const g2 = gatedReply();
  s.adapter().scripts.push(g1.script, g2.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 1, 'c1 の振り返りが始まる');
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 2, '2 本目の振り返りが始まる');
  assert.equal(jobOf(s, first.id).status, 'running');
  assert.equal(jobOf(s, other.id).status, 'running', '別の会話 c2 の振り返りが、c1 の 2 本目に邪魔されず始まる');
  assert.equal(jobOf(s, second.id).status, 'pending', 'c1 の 2 本目は、c1 の振り返りが動いているあいだ実行待ちのまま');
  assert.match(String(s.adapter().calls[base]!.messages.at(-1)?.content), /大阪/u);
  assert.match(String(s.adapter().calls[base + 1]!.messages.at(-1)?.content), /犬/u);
  g1.release(); g2.release();
  assert.deepEqual(await Promise.all([t1, t2]), ['ran', 'ran']);
  assert.ok(s.app.kv.get('review:skill-upto:c1'), '先の振り返りが見た位置を進める');
  assert.equal(await s.app.worker.tick(), 'idle', '先の分が終われば c1 の 2 本目が選ばれ、見る発言が無いので何もせず終わる');
  assert.equal(jobOf(s, second.id).status, 'done');
  assert.equal(jobOf(s, second.id).note, taskText(languageOf(s.app.config()), 'review.nothing'));
  assert.equal(s.adapter().calls.length, base + 2, '同じ発言のための 2 本目のモデル呼び出しは無い');
});

test('道具を実行している最中の裏の実行（limiter の枠を返したあと）も、動いている数に入る', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1 });
  let entered!: () => void;
  const toolStarted = new Promise<void>(resolve => { entered = resolve; });
  let leave!: () => void;
  const toolGate = new Promise<void>(resolve => { leave = resolve; });
  s.app.tools.register({
    name: 'slow_probe', description: '遅い道具（試験用）', input: Type.Object({}), effect: 'read', allowedIn: ['task'],
    async execute() { entered(); await toolGate; return { content: '終わりました' }; },
  });
  s.userTask('A');
  const b = s.userTask('B');
  const complete = toolCallScript('task_complete', { summary: '終わりました', notify: false });
  s.adapter().scripts.push(toolCallScript('slow_probe', {}), complete, complete);
  const t1 = s.app.worker.tick();
  await toolStarted;
  const slot = await Promise.race([s.app.limiter.acquire('fake', () => 1), new Promise<null>(resolve => setTimeout(() => resolve(null), 500))]);
  assert.ok(slot, '前提: 道具を動かしているあいだ、モデルの呼び出しの枠は空いている');
  slot();
  assert.equal(await s.app.worker.tick(), 'busy', '枠が空いていても、道具を動かしている実行は動いている数に入る（提供元の maxParallel は 1）');
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready');
  leave();
  assert.equal(await t1, 'ran');
  assert.equal(await s.app.worker.tick(), 'ran', '終われば 2 件目が動く');
  assert.equal(s.app.tasks.get(b.id)!.status, 'done');
});

test('振り返りも、先に使う提供元が満杯なら始めず（claim せず）実行待ちのまま、空けば始まる', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1, edit: reviewOn });
  await chat(s, 'c1', '来週から大阪に出張です');
  s.app.engine.lastUserActivity = 0;
  const job = s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' })!;
  s.userTask('A');
  const g1 = gated();
  s.adapter().scripts.push(g1.script, reply('変更なし'));
  const base = s.adapter().calls.length;
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 1, 'タスクが始まる');
  const taskConversations = () => (s.app.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'task'").get() as { n: number }).n;
  const before = taskConversations();
  assert.equal(await within(s.app.worker.tick(), '満杯なら始めずに返る', 1500), 'busy', '提供元が満杯なので振り返りは始めない');
  assert.equal(s.adapter().calls.length, base + 1);
  assert.equal(jobOf(s, job.id).status, 'pending');
  assert.equal(jobOf(s, job.id).review_conversation_id, null, 'claim していない');
  assert.equal(taskConversations(), before, '振り返りの会話も作っていない');
  g1.release();
  assert.equal(await t1, 'ran');
  assert.equal(await s.app.worker.tick(), 'ran', '空いたら振り返りが始まる');
  assert.equal(s.adapter().calls.length, base + 2);
  assert.equal(jobOf(s, job.id).status, 'done');
});

test('会話の送信で動いている 2 本の振り返りが止められたら、どちらも実行待ちに戻り、見た位置は進めず、あとでやり直す', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2, edit: c => { reviewOn(c); c.worker.maxRunsPerHour = 100; } });
  await chat(s, 'c1', '来週から大阪に出張です');
  await chat(s, 'c2', '犬を飼い始めました');
  s.app.engine.lastUserActivity = 0;
  const j1 = s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' })!;
  const j2 = s.app.reviews.enqueue('manual', 'manual:c2', { conversationId: 'c2', kind: 'skill' })!;
  const base = s.adapter().calls.length;
  s.adapter().scripts.push(hang(), hang());
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 1, '1 本目が始まる');
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 2, '2 本目が始まる');
  const runs = s.app.worker.status().runningAll;
  assert.equal(runs.length, 2);
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c3', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.deepEqual(await within(Promise.all([t1, t2]), '2 本とも止められて戻る'), ['ran', 'ran']);
  for (const run of runs)assert.equal(s.app.engine.wasPreempted(run.runId), true, '2 本とも会話に譲って止められた');
  for (const job of [j1, j2]) {
    assert.equal(jobOf(s, job.id).status, 'pending', '失敗にも完了にもせず、実行待ちに戻す');
    assert.equal(jobOf(s, job.id).run_id, null);
  }
  assert.equal(s.app.kv.get('review:skill-upto:c1'), undefined);
  assert.equal(s.app.kv.get('review:skill-upto:c2'), undefined);
  assert.equal(s.app.worker.status().runningAll.length, 0);
  await s.app.engine.wait(sent.runId);
  s.app.engine.lastUserActivity = 0;
  s.adapter().scripts.push(reply('変更なし'), reply('変更なし'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(jobOf(s, j1.id).status, 'done');
  assert.equal(jobOf(s, j2.id).status, 'done');
  assert.ok(s.app.kv.get('review:skill-upto:c1') && s.app.kv.get('review:skill-upto:c2'), 'やり直しが終わって初めて位置が進む');
});

test('会話の送信は、同じ提供元で動いているタスクと振り返りの両方を止める（タスクは実行待ちへ、振り返りは積み直し）', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 2, edit: reviewOn });
  await chat(s, 'c1', '来週から大阪に出張です');
  const a = s.userTask('A');
  s.app.engine.lastUserActivity = 0;
  const job = s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' })!;
  const base = s.adapter().calls.length;
  s.adapter().scripts.push(hang(), hang());
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 1, 'タスクが始まる');
  const t2 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === base + 2, '振り返りが始まる');
  assert.deepEqual(s.app.worker.status().runningAll.map(r => r.kind), ['task', 'review']);
  const runIds = s.app.worker.status().runningAll.map(r => r.runId);
  s.adapter().scripts.push(reply('はい'));
  const sent = s.app.engine.send('c3', 'こんにちは');
  assert.ok(sent.ok, JSON.stringify(sent));
  assert.deepEqual(await within(Promise.all([t1, t2]), 'タスクも振り返りも止められて戻る'), ['ran', 'ran']);
  for (const runId of runIds)assert.equal(s.app.engine.wasPreempted(runId), true);
  assert.equal(s.app.tasks.get(a.id)!.status, 'ready');
  assert.equal(jobOf(s, job.id).status, 'pending');
  await s.app.engine.wait(sent.runId);
  assert.deepEqual(s.app.engine.activeRuns(), [], '会話も含め、動いている実行は残らない');
});

test('「今すぐ実行」が提供元の空き待ちのとき、1 時間の上限の知らせは出さない（上限を待つ別のタスクがあれば出す）', async t => {
  const s = await setup(t, { workerMax: 2, providerMax: 1, edit: c => { c.worker.maxRunsPerHour = 1; } });
  s.userTask('A');
  const b = s.userTask('B');
  const g1 = gated();
  s.adapter().scripts.push(g1.script);
  const t1 = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, '1 件目が始まる');
  const budgetNotices = () => s.app.notifications.list().filter(n => n.kind === 'info' && n.title === taskText(languageOf(s.app.config()), 'notify.budget.title'));
  s.app.worker.requestRun(b.id);
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.equal(s.app.tasks.get(b.id)!.status, 'ready', '空き待ちのまま');
  assert.equal(budgetNotices().length, 0, '上限のせいではなく提供元の空き待ちなので、上限の知らせは出さない');
  s.userTask('C');
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.equal(budgetNotices().length, 1, '上限で待たされているタスクが別にあれば、知らせる');
  g1.release();
  assert.equal(await t1, 'ran');
});
