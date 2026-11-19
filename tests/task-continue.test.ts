// build-in-chat-2 A: タスクは区切りで休まない。長さの区切り（A-6）と、Build の仲間は 1 時間の上限で待たない（A-8）
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App, builtinTools } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { SPLIT_EXCHANGE_RATIO } from '../src/engine/context-budget.ts';
import { ContextOverflow, fitMessages, irreducibleEstimate } from '../src/engine/fit.ts';
import { estimateRequest } from '../src/engine/tokens.ts';
import type { ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { OWNER_FIX } from '../src/tasks/store.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

const CONTEXT_REASON = 'The work of this run grew long for the model, so it continues in a new run';

const bigTool: ToolDef<{ n: number }> = {
  name: 'fake_big', description: 'Test tool: returns n characters of text.', input: Type.Object({ n: Type.Integer({ minimum: 1 }) }), effect: 'read', allowedIn: ['task', 'chat'],
  async execute(input) { return { content: 'lorem ipsum dolor '.repeat(Math.ceil(input.n / 18)).slice(0, input.n) }; },
};

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

// 道具を渡さない呼び出し（要約）には要約の文を返し、それ以外は fake_big を呼ぶ
const big = (n: number): Script => async function* (req) {
  if (req.tools.length === 0) { yield { type: 'text', delta: 'Summary of the earlier work.' }; yield { type: 'done', stop: 'end_turn' as StopReason }; return; }
  yield* call('fake_big', { n })(req);
};

async function setup(t: { after: (fn: () => void) => void }, options: { capacity?: number; soul?: boolean; edit?: (c: AppConfig) => void } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', ...(options.capacity !== undefined ? { contextLength: options.capacity } : {}), vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  config.worker.maxRunsPerHour = 50;
  config.tools.policies = { fake_big: 'allow' };
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  // 固定の system を大きくする（32k のモデルで、固定の分が使える量の 4 割を超える形）
  if (options.soul) {
    mkdirSync(paths.workspace, { recursive: true });
    writeFileSync(join(paths.workspace, 'SOUL.md'), `# Soul\n\n${'Be calm and careful. '.repeat(1000)}`);
  }
  const clock = { now: Date.parse('2026-11-19T01:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false, tools: [...builtinTools(), bigTool as unknown as ToolDef], adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const lastRun = (kind = 'task') => app.db.prepare('SELECT * FROM engine_runs WHERE kind = ? ORDER BY rowid DESC LIMIT 1').get(kind) as { id: string; flags: string; iterations: number; ok: number; error_kind: string | null };
  const stored = (conversationId: string): ChatMessage[] => app.conversations.messages(conversationId).map(m => m.message);
  return { app, adapter: () => adapter, clock, lastRun, stored };
}

// エンジンと同じ数え方: 固定の分（system と道具の仕様）・使える量・いまのやり取り
function budgetOf(app: App, req: ModelRequest) {
  const system = `${req.system.frozen}\n${req.system.dynamic}`;
  const fixed = estimateRequest(system, [], req.tools).tokens;
  const { capacity, maxOutput } = app.status.limits(app.config().models[0]!);
  const available = Math.floor(capacity * 0.95) - maxOutput;
  const exchange = (messages: readonly ChatMessage[]) => irreducibleEstimate({ system, messages, tools: req.tools }).tokens - fixed;
  return { system, fixed, available, room: available - fixed, exchange };
}

test('A-6 タスクの実行は、いまのやり取りが余裕の 6 割を超えたら次の往復の頭で区切り（context）、ワーカーがすぐ続け、長く続いているの知らせには数えない', async t => {
  const s = await setup(t, { capacity: 32_000 });
  const task = s.app.tasks.create({ title: 'Long survey', origin: 'user', actor: 'user' });
  s.adapter().scripts = Array.from({ length: 40 }, () => big(6000));
  assert.equal(await s.app.worker.tick(), 'ran');
  const first = s.lastRun();
  assert.deepEqual(JSON.parse(first.flags), ['context_split']);
  assert.equal(first.ok, 1);
  const calls = s.adapter().calls.length;
  assert.ok(calls >= 2 && calls < 40, `区切るまでの呼び出し: ${calls}`);
  const after = s.app.tasks.get(task.id)!;
  assert.equal(after.status, 'ready');
  assert.equal(after.run_at, s.clock.now, '休まずにすぐ続ける');
  assert.equal(s.app.tasks.events(task.id).find(e => e.kind === 'requeued')?.content, CONTEXT_REASON);
  assert.equal(s.app.kv.get(`task-split:${task.id}`), undefined, '長さの区切りは SPLIT_LIMIT の数に入れない');
  assert.equal(s.app.kv.get(`task-idle:${task.id}`), undefined, '道具を使った区切りは進展なしに数えない');
  assert.equal(s.app.notifications.list().filter(n => n.kind === 'info').length, 0);

  // 境目: 最後に呼んだときのやり取りは余裕の 6 割以下、そのあと道具の結果を足したやり取り（区切った頭で見たもの）は 6 割を超える
  const conversationId = after.conversation_id!;
  const last = s.adapter().calls.at(-1)!;
  const b = budgetOf(s.app, last);
  assert.ok(b.exchange(last.messages) <= SPLIT_EXCHANGE_RATIO * b.room, `呼んだときは 6 割以下: ${b.exchange(last.messages)} / ${b.room}`);
  assert.ok(b.exchange(s.stored(conversationId)) > SPLIT_EXCHANGE_RATIO * b.room, `区切った頭では 6 割を超える: ${b.exchange(s.stored(conversationId))} / ${b.room}`);
  const firstRunEnd = s.app.conversations.messages(conversationId).at(-1)!.id;

  // 続きの回: 履歴は使える量を超えるが、前の回のやり取りが外れて（または要約されて）落ちない
  assert.equal(await s.app.worker.tick(), 'ran');
  const second = s.lastRun();
  assert.equal(second.ok, 1, `続きの回は落ちない（${second.error_kind}）`);
  const flags = JSON.parse(second.flags) as string[];
  assert.ok(flags.includes('context_trimmed') || flags.includes('compacted'), `前の回が外れるか要約される: ${second.flags}`);
  const all = s.stored(conversationId);
  const end = s.adapter().calls.filter(c => c.tools.length > 0).at(-1)!;
  const e = budgetOf(s.app, end);
  const fitted = fitMessages({ system: e.system, messages: all, tools: end.tools, available: e.available });
  assert.ok(fitted.removed > 0, '前の回のまとまりが外れる');
  // 対照: 区切らなかった（続きの回の始めの発言が無く、1 つのやり取りのまま）同じ履歴は入りきらない
  const prompt = s.app.conversations.messages(conversationId).find(m => m.id > firstRunEnd && m.message.role === 'user')!;
  const unsplit = s.app.conversations.messages(conversationId).filter(m => m.id !== prompt.id).map(m => m.message);
  assert.throws(() => fitMessages({ system: e.system, messages: unsplit, tools: end.tools, available: e.available }), ContextOverflow);
});

test('A-6 1 往復目では区切らない（始めの発言だけで余裕の 6 割を超えても、モデルを 1 回は呼ぶ）。区切るのは 2 往復目の頭', async t => {
  const s = await setup(t, { capacity: 32_000 });
  s.app.tasks.create({ title: 'Probe', origin: 'user', actor: 'user' });
  s.adapter().scripts = [call('task_complete', { summary: 'ok', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const probe = budgetOf(s.app, s.adapter().calls[0]!);
  const body = 'word '.repeat(Math.floor(probe.room * 0.75 * 3.5 / 5 / 1.1));
  const task = s.app.tasks.create({ title: 'Big brief', body, origin: 'user', actor: 'user' });
  const before = s.adapter().calls.length;
  s.adapter().scripts = [big(100), big(100), call('task_complete', { summary: 'ok', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  const req = s.adapter().calls[before]!;
  const b = budgetOf(s.app, req);
  assert.ok(b.exchange(req.messages) > SPLIT_EXCHANGE_RATIO * b.room && b.exchange(req.messages) < b.room, `始めの発言は余裕の 6 割〜10 割: ${b.exchange(req.messages)} / ${b.room}`);
  assert.equal(s.adapter().calls.length - before, 1, 'モデルは 1 回だけ呼ばれる');
  const run = s.lastRun();
  assert.deepEqual(JSON.parse(run.flags), ['context_split']);
  assert.equal(run.iterations, 2);
  assert.equal(s.app.tasks.get(task.id)!.status, 'ready');
});

test('A-6 容量 32k のモデルで固定の分が使える量の 4 割を超えていても、最初の数往復では区切らない（使える量の 6 割では決めない）', async t => {
  const s = await setup(t, { capacity: 32_000, soul: true });
  const task = s.app.tasks.create({ title: 'Small steps', origin: 'user', actor: 'user' });
  s.adapter().scripts = [big(600), big(600), big(600), call('task_complete', { summary: 'done', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done', '区切らずに終わる');
  assert.deepEqual(JSON.parse(s.lastRun().flags), []);
  const last = s.adapter().calls.at(-1)!;
  const b = budgetOf(s.app, last);
  assert.ok(b.fixed > 0.4 * b.available, `固定の分が使える量の 4 割を超える: ${b.fixed} / ${b.available}`);
  assert.ok(b.fixed + b.exchange(last.messages) > SPLIT_EXCHANGE_RATIO * b.available, '使える量の 6 割で決めていたら区切っていた');
});

// 容量が分からないと、今の組み立て（fitMessages）は 1 往復目から入りきらない扱いで落ちる（この変更の前から）。
// 区切りの判断が容量を見ることは、1 往復目のあとで容量が分からなくなった実行で確かめる
test('A-6 容量の分からないモデルでは区切らない（2 往復目の頭で容量が分からなくなった実行は、区切りではなく今の失敗で終わる）', async t => {
  const s = await setup(t);
  s.app.tasks.create({ title: 'Unknown size', origin: 'user', actor: 'user' });
  const forget: Script = async function* (req) {
    s.adapter().probeResult = { effective: undefined, declared: undefined };
    await s.app.status.probeAll(s.app.config());
    yield* big(100)(req);
  };
  s.adapter().scripts = [forget, big(100), call('task_complete', { summary: 'done', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.status.limits(s.app.config().models[0]!).capacity, 0);
  const run = s.lastRun();
  assert.ok(!JSON.parse(run.flags).includes('context_split'), run.flags);
  assert.equal(run.error_kind, 'context_overflow');
  assert.equal(s.adapter().calls.length, 1);
});

test('A-6 会話の実行は、やり取りが余裕の 6 割を超えても区切らない', async t => {
  const s = await setup(t, { capacity: 32_000, soul: true });
  s.app.conversations.create({ id: 'c1', kind: 'chat', title: 'Chat' });
  s.adapter().scripts = [big(6000), big(6000), big(6000), big(6000), big(6000), reply('done')];
  const sent = s.app.engine.send('c1', 'Read a lot, please');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  const run = s.lastRun('chat');
  assert.equal(run.ok, 1);
  assert.ok(!JSON.parse(run.flags).includes('context_split'));
  assert.equal(s.adapter().calls.length, 6, '最後の返事まで呼ぶ');
  const last = s.adapter().calls.at(-1)!;
  const b = budgetOf(s.app, last);
  assert.ok(b.exchange(last.messages) > SPLIT_EXCHANGE_RATIO * b.room, `タスクなら区切っている大きさ: ${b.exchange(last.messages)} / ${b.room}`);
});

test('A-8 Build の根とその子は、1 時間の回数が上限に達していても待たない。Build でないタスク・直しのタスクは今までどおり待つ', async t => {
  const s = await setup(t, { capacity: 65_536, edit: c => { c.worker.maxRunsPerHour = 1; } });
  const used = s.app.tasks.create({ title: 'Earlier', origin: 'user', actor: 'user' });
  s.adapter().scripts = [call('task_complete', { summary: 'ok', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(used.id)!.status, 'done');
  assert.equal(s.app.worker.runsLastHour(), 1);

  const plain = s.app.tasks.create({ title: 'Plain', origin: 'user', actor: 'user' });
  const build = s.app.tasks.create({ title: 'Build', origin: 'user', actor: 'user', acceptanceItems: ['A-1'] });
  const fix = s.app.tasks.create({ title: 'Fix', origin: 'user', actor: 'user', acceptanceItems: ['A-1'] });
  s.app.tasks.event(fix.id, OWNER_FIX, 'user', null);
  const waiting = s.app.worker.status().waiting;
  assert.equal(waiting[plain.id]?.kind, 'budget');
  assert.equal(waiting[fix.id]?.kind, 'budget', '直しのタスクは Build の仲間ではない');
  assert.equal(waiting[build.id], undefined, 'Build の根は上限で待たない');

  // Build の根: 上限を超えていても動く。道具を使った区切りのあとも、すぐもう一度動く（A-1 の Build の形）
  s.adapter().scripts = [big(100), call('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(build.id)!.run_at, s.clock.now);
  assert.equal(s.app.tasks.get(plain.id)!.status, 'ready', 'Build でないタスクは選ばれない');
  const child = s.app.tasks.create({ title: 'Child', origin: 'user', actor: 'beat', spawnedBy: build.id });
  assert.equal(s.app.worker.status().waiting[child.id], undefined, 'Build の子も上限で待たない');
  s.adapter().scripts = [call('task_complete', { summary: 'child ok', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(child.id)!.status, 'done');
  s.adapter().scripts = [call('task_complete', { summary: 'built', notify: false })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(build.id)!.status, 'done');
  assert.equal(s.app.worker.runsLastHour(), 4, 'Build の仲間の回も回数には数える');
  assert.equal(await s.app.worker.tick(), 'budget', '残りは上限で待つ');
  assert.equal(s.app.tasks.get(plain.id)!.status, 'ready');
});
