import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import { conversationWindow, REVIEW_WINDOW_CHARS, reviewPolicyLines, reviewPrompt, reviewWindowLimits } from '../src/memory/review.ts';
import { resolvePaths } from '../src/paths.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { FakeAdapter, reply, type Script, tempDir, testConfig, withLoad } from './helpers.ts';

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

async function setup(t: { after: (fn: () => void) => void }, edit: (c: AppConfig) => void = () => undefined, timers = false) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = true;
  config.memory.reviewIdleMinutes = 1440;
  config.worker.maxRunsPerHour = 100;
  edit(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-05T01:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: timers, botMemory: true,
    adapterOverride: p => (adapter = new FakeAdapter(p)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  await app.worker.tick();
  const chat = async (conversationId: string, text: string) => {
    adapter.scripts.push(reply('はい'));
    const outcome = app.engine.send(conversationId, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    await app.engine.wait(outcome.runId);
  };
  const reviewPrompts = () => adapter.calls.map(c => String(c.messages.at(-1)?.content)).filter(text => text.startsWith('[Review]'));
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      if (!app.reviews.next()) return;
      adapter.scripts.push(reply('No changes'));
      await app.worker.tick();
    }
    throw new Error('reviews did not settle');
  };
  const goQuiet = async () => {
    clock.now += 1441 * 60_000;
    adapter.scripts.push(reply('No changes'));
    await app.worker.tick();
    await drain();
  };
  return { app, adapter: () => adapter, clock, chat, reviewPrompts, drain, goQuiet };
}

const mark = (i: number) => `<m${String(i).padStart(4, '0')}>`;

function fill(app: App, conversationId: string, count: number, body: (i: number) => string = () => 'x'.repeat(200)) {
  if (!app.conversations.get(conversationId)) app.conversations.create({ id: conversationId });
  for (let i = 1; i <= count; i++) {
    app.conversations.append(conversationId, i % 2 ? { role: 'user', content: `${mark(i)} ${body(i)}` } : { role: 'assistant', content: `${mark(i)} ${body(i)}` });
  }
}

const occurrences = (prompts: readonly string[], text: string) => prompts.reduce((n, p) => n + p.split(text).length - 1, 0);

test('10-1 振り返りの方針: 行ごとに印があり、道具の名前は道具の行だけ。スキルの行は残り、持ち主の事実の行と「3 件まで」は無い', () => {
  const lines = reviewPolicyLines('en');
  const tools = /\b(?:memory_\w+|skill_draft)\b/u;
  for (const line of lines) {
    assert.ok(['memory', 'skill', 'format', 'language', 'guide'].includes(line.tag), line.text);
    if (line.tag === 'guide') assert.doesNotMatch(line.text, tools, `手引きの行に道具の名前が混ざらない: ${line.text}`);
    if (tools.test(line.text)) assert.ok(line.tag === 'memory' || line.tag === 'skill', `道具の名前の行は道具の印: ${line.text}`);
  }
  assert.equal(lines.filter(line => line.tag === 'skill').length, 1);
  const withMemory = reviewPrompt({ trigger: 'idle', forgotten: [], kind: 'memory' });
  const skillOnly = reviewPrompt({ trigger: 'idle', forgotten: [], kind: 'skill' });
  for (const prompt of [withMemory, skillOnly]) {
    assert.doesNotMatch(prompt, /book=user|Facts about the user/u, '持ち主についての事実の行は無い');
    assert.doesNotMatch(prompt, /at most 3/iu, '「1 つの記録から 3 件まで」は無い');
  }
  assert.match(skillOnly, /skill_draft/u, 'スキルの行はスキルの見直しにある');
  assert.doesNotMatch(withMemory, /skill_draft/u, 'S-1: 記憶の振り返りはスキルの行を持たない');
  assert.match(withMemory, /Unverified:/u);
  for (const line of lines.filter(l => l.tag === 'memory' || l.memoryOnly)) assert.equal(skillOnly.includes(line.text), false, `記憶の無い振り返りに記憶の行が出ない: ${line.text}`);
  for (const line of lines.filter(l => l.tag === 'skill' || l.skillOnly)) assert.equal(withMemory.includes(line.text), false, `記憶の振り返りにスキルの行が出ない: ${line.text}`);
  const auto = reviewPrompt({ trigger: 'idle', forgotten: [], skillsAutoRegister: true, kind: 'skill' });
  assert.match(auto, /registered right away/u, 'スキルの行の差し替えは印で決まる');
});

test('10-1 道具を多く使った実行のあとではなく、upto より後が窓に収まらない会話に、チャットの実行の終わりで 1 本だけ積む', async t => {
  const s = await setup(t);
  await s.chat('c1', 'こんにちは');
  assert.deepEqual(s.app.reviews.list().filter(j => j.trigger === 'heavy_run'), [], '短い会話には積まない');
  fill(s.app, 'c1', 120);
  await s.chat('c1', 'つづき');
  await s.chat('c1', 'さらに');
  assert.deepEqual(s.app.reviews.list().filter(j => j.trigger === 'heavy_run').map(j => j.dedup_key), ['conv:c1:0'], '同じ upto では 2 本目を積まない');
});

for (const withIdle of [false, true]) {
  test(`10-1 飛ばしが無い: upto より後に 300 件を超える発言がある会話を、続けて振り返ると、どの発言もちょうど 1 回ずつ入る${withIdle ? '（heavy_run の 1 本目のあとに idle が並んでいても）' : ''}`, async t => {
    const s = await setup(t);
    s.app.conversations.create({ id: 'c1' });
    s.app.kv.set('review:upto:c1', '0');
    fill(s.app, 'c1', 320);
    await s.chat('c1', '<m9999> 最後の発言');
    const first = s.app.reviews.list().filter(j => j.trigger === 'heavy_run');
    assert.equal(first.length, 1);
    if (withIdle) {
      const last = s.app.conversations.messages('c1', 1).at(-1)!.id;
      assert.ok(s.app.reviews.enqueue('idle', `idle:c1:${last}`, { conversationId: 'c1' }));
    }
    await s.drain();
    if (!withIdle) {
      assert.equal(occurrences(s.reviewPrompts(), '<m9999>'), 0, '窓 1 つに満たない残りは、たまった分では読まない');
      await s.goQuiet();
    }
    const prompts = s.reviewPrompts();
    assert.ok(prompts.length >= 4, `窓は何本にも分かれる (${prompts.length})`);
    for (let i = 1; i <= 320; i++) assert.equal(occurrences(prompts, mark(i)), 1, mark(i));
    assert.equal(occurrences(prompts, '<m9999>'), 1);
    const lastId = s.app.conversations.messages('c1', 1).at(-1)!.id;
    assert.equal(s.app.kv.get('review:upto:c1'), String(lastId), '最後まで読み終えた');
    assert.equal(s.app.reviews.list().filter(j => j.status === 'pending').length, 0);
  });
}

test('10-1 持ち主の発言の無い窓は、モデルを呼ばずに upto を窓の最後まで進め、続きを積む', async t => {
  const s = await setup(t);
  s.app.conversations.create({ id: 'c1' });
  for (let i = 1; i <= 100; i++) s.app.conversations.append('c1', { role: 'assistant', content: `${mark(i)} ${'y'.repeat(300)}` });
  s.app.conversations.append('c1', { role: 'user', content: '<m9999> 持ち主の発言' });
  assert.ok(s.app.reviews.enqueueIfPiled('c1', reviewWindowLimits(s.app.engine.backgroundAvailable())));
  const calls = s.adapter().calls.length;
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.adapter().calls.length, calls, 'モデルを呼ばない');
  const upto = Number(s.app.kv.get('review:upto:c1'));
  assert.ok(upto > 0, '見た位置が進む');
  const pending = s.app.reviews.list().filter(j => j.status === 'pending');
  assert.deepEqual(pending.map(j => [j.trigger, j.dedup_key]), [['heavy_run', `conv:c1:${upto}`]], '続きを積む');
  await s.drain();
  await s.goQuiet();
  assert.equal(occurrences(s.reviewPrompts(), '<m9999>'), 1, '会話が途切れたときの振り返りが、残りの持ち主の発言を読む');
  assert.equal(occurrences(s.reviewPrompts(), mark(1)), 0, '持ち主の発言の無い窓はモデルに送らない');
  assert.equal(occurrences(s.reviewPrompts(), mark(100)), 1, '持ち主の発言と同じ窓の分は送る');
});

test('10-1 窓がモデルに入る: 日本語 20,000 文字の会話を、使える量が 12,000 ほどのモデルで振り返っても、どの回も context_overflow にならない', async t => {
  const s = await setup(t, c => { c.models[0]!.contextLength = 15_000; });
  const available = s.app.engine.backgroundAvailable()!;
  assert.ok(available > 10_000 && available < 13_500, `前提: 使える量 ${available}`);
  s.app.conversations.create({ id: 'c1' });
  s.app.kv.set('review:upto:c1', '0');
  fill(s.app, 'c1', 20, () => 'あ'.repeat(1000));
  await s.chat('c1', 'まとめて');
  await s.drain();
  const runs = s.app.db.prepare("SELECT ok, error_message FROM engine_runs WHERE kind = 'review'").all() as Array<{ ok: number; error_message: string | null }>;
  assert.deepEqual(runs.filter(r => r.ok !== 1), [], JSON.stringify(runs));
  assert.ok(runs.length >= 2, `窓は何本かに分かれる (${runs.length})`);
  assert.deepEqual(s.app.reviews.list().filter(j => j.status === 'failed'), []);
});

test('10-1 容量の分からないモデルでは、窓は 15,000 文字だけで決まる', () => {
  assert.deepEqual(reviewWindowLimits(undefined), { maxChars: REVIEW_WINDOW_CHARS });
  assert.deepEqual(reviewWindowLimits(12_000), { maxChars: REVIEW_WINDOW_CHARS, maxTokens: 4800 });
});

test('10-1 1 時間の上限: maxRunsPerHour 6 で直近 1 時間に 3 本動いたあと、heavy_run は始まらず、idle とタスクは始まる', async t => {
  const s = await setup(t, c => { c.worker.maxRunsPerHour = 6; });
  for (const id of ['a', 'b', 'c']) {
    s.app.conversations.create({ id });
    s.app.conversations.append(id, { role: 'user', content: `${id} の話` });
    s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  }
  await s.drain();
  assert.equal(s.app.worker.runsLastHour(), 3);
  fill(s.app, 'long', 120);
  const heavy = s.app.reviews.enqueueIfPiled('long', reviewWindowLimits(s.app.engine.backgroundAvailable()))!;
  s.app.conversations.create({ id: 'quiet' });
  s.app.conversations.append('quiet', { role: 'user', content: '静かな会話' });
  const idle = s.app.reviews.enqueue('idle', 'idle:quiet:1', { conversationId: 'quiet' })!;
  s.adapter().scripts.push(reply('No changes'));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.reviews.get(idle.id)!.status, 'done', 'idle は始まる');
  assert.equal(s.app.reviews.get(heavy.id)!.status, 'pending', 'heavy_run は待つ');
  const calls = s.adapter().calls.length;
  assert.equal(await s.app.worker.tick(), 'budget');
  assert.equal(s.adapter().calls.length, calls);
  const task = s.app.tasks.create({ title: '調べもの', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'わかった', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(task.id)!.status, 'done', 'ready のタスクは始まる');
  assert.equal(s.app.reviews.get(heavy.id)!.status, 'pending');
  s.clock.now += 3_600_001;
  await s.drain();
  assert.equal(s.app.reviews.get(heavy.id)!.status, 'done', '1 時間たてば動く');
});

test('10-1 heavy_run を待つあいだも、それより早い予定のタスクの時刻に起きる', async t => {
  const s = await setup(t, c => { c.worker.maxRunsPerHour = 6; }, true);
  t.after(() => s.app.worker.stop());
  for (const id of ['a', 'b', 'c']) {
    s.app.conversations.create({ id });
    s.app.conversations.append(id, { role: 'user', content: `${id} の話` });
    s.app.reviews.enqueue('manual', `manual:${id}`, { conversationId: id });
  }
  await s.drain();
  fill(s.app, 'long', 120);
  const heavy = s.app.reviews.enqueueIfPiled('long', reviewWindowLimits(s.app.engine.backgroundAvailable()))!;
  s.app.tasks.create({ title: 'あとで', origin: 'user', actor: 'user', runAt: s.clock.now + 120_000 });
  const calls = s.adapter().calls.length;
  s.app.worker.start();
  for (let i = 0; i < 200 && (s.app.worker.status().nextWakeAt ?? s.clock.now) === s.clock.now; i++) await new Promise(resolve => setTimeout(resolve, 10));
  s.app.worker.stop();
  assert.equal(s.app.reviews.get(heavy.id)!.status, 'pending', '前提: heavy_run は待っている');
  assert.equal(s.adapter().calls.length, calls);
  assert.equal(s.app.worker.status().nextWakeAt, s.clock.now + 120_000, '2 分後のタスクの時刻に起きる');
});

test('10-1 Pending の注記と道具の結果だけの窓は、持ち主の発言が無いものとして、モデルを呼ばずに進める', async t => {
  const s = await setup(t);
  s.app.conversations.create({ id: 'c1' });
  s.app.conversations.append('c1', { role: 'user', content: 'held call', generated: true, note: 'pending', fetched: true });
  s.app.conversations.append('c1', { role: 'tool', toolCallId: 'call_1', name: 'calculate', content: '2' });
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1' });
  const calls = s.adapter().calls.length;
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.adapter().calls.length, calls, 'モデルを呼ばない');
  assert.equal(s.app.kv.get('review:upto:c1'), String(s.app.conversations.messages('c1', 1).at(-1)!.id));
});

test('10-1 窓は upto の次から古い順に取る（新しい方の 200 件に限らない）', async t => {
  const s = await setup(t);
  fill(s.app, 'c1', 400, () => 'z');
  const window = conversationWindow(s.app.db, 'c1', 0, { maxChars: REVIEW_WINDOW_CHARS });
  assert.equal(window.full, false, '短い発言なら 400 件でも窓 1 つ');
  assert.equal(window.messages.length, 400);
  assert.match(window.transcript, /^\[User\] <m0001> z/u);
});
