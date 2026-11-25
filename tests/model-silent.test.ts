import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, ModelConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations } from '../src/db/conversations.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { Runs } from '../src/db/runs.ts';
import { RunBus } from '../src/engine/bus.ts';
import { ChatEngine } from '../src/engine/chat.ts';
import { ModelStatus } from '../src/engine/status.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { ProviderError, providerError, type StreamEvent } from '../src/providers/types.ts';
import { engineText } from '../src/shared/messages/engine.ts';
import { serverText, warningText } from '../web/src/server-text.ts';
import { FakeAdapter, fail, fakeServer, reply, sse, tempDir, testConfig, type Script } from './helpers.ts';

// S2（beat self-fix）: 手元のモデルが黙るとき。
// 知らせるだけで打ち切らない（遅いだけのモデルを落とさない）。上限まで 1 つも出来事が来なかった呼び出しだけ、同じモデルで試し直さない。

const model = (id: string): ModelConfig => ({ id, provider: 'fake', model: id, contextLength: 65536, maxOutputTokens: 1024, vision: false });

// real: 偽の提供元の部品ではなく本物の openai_compatible の部品で、この URL・時間切れ（ミリ秒）に繋ぐ
async function setup(t: { after: (fn: () => void) => void }, options: { scripts?: Script[]; models?: ModelConfig[]; modelSilentMs?: number; real?: { baseUrl: string; timeoutMs: number } }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'SOUL.md'), '最初の SOUL');
  const models = options.models ?? [model('a'), model('b')];
  const config: AppConfig = parseConfig({
    ...testConfig(),
    providers: [{ id: 'fake', kind: 'openai_compatible', baseUrl: options.real?.baseUrl ?? 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: options.real?.timeoutMs ?? 600_000 }],
    models,
    routing: { chat: models.map(m => m.id), background: [] },
  });
  const db = openDatabase(':memory:', MIGRATIONS);
  const conversations = new Conversations(db);
  const runs = new Runs(db);
  const kv = new KV(db);
  const adapter = new FakeAdapter(config.providers[0]!, options.scripts ?? []);
  const registry = new ProviderRegistry(options.real ? {} : { override: () => adapter });
  registry.reload(config);
  const status = new ModelStatus({ registry, kv, baseTokens: () => 500 });
  await status.probeAll(config);
  const bus = new RunBus();
  const events: RunEvent[] = [];
  bus.subscribe(e => events.push(e.event));
  const sleeps: number[] = [];
  const engine = new ChatEngine({
    config: () => config, conversations, runs, kv, registry, status, bus, limiter: new EndpointLimiter(), paths,
    sleep: async ms => { sleeps.push(ms); },
    ...(options.modelSilentMs !== undefined ? { modelSilentMs: options.modelSilentMs } : {}),
  });
  t.after(() => engine.stopAll());
  const silentWarnings = () => events.flatMap(e => (e.type === 'warning' && e.code === 'model_silent' ? [e] : []));
  return { engine, adapter, events, sleeps, runs, silentWarnings };
}

async function sendAndWait(engine: ChatEngine, text = 'やあ') {
  const outcome = engine.send('c1', text);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  return engine.wait(outcome.runId)!;
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// 最初の出来事を ms 待ってから返事を返す台本（止められたら止まる）
function slowStart(ms: number, text = '遅くなりました'): Script {
  return async function* (req) {
    await pause(ms);
    req.signal.throwIfAborted();
    yield* reply(text)(req);
  };
}

// 出来事が 1 つも来ないまま、提供元の時間切れで終わる台本。silentFor が上限（modelSilentMs）より短い（すぐ失敗する）と、黙っていたことにならない
const timeoutError = (): ProviderError => providerError('timeout', 'timeout');
const undiciTimeout = (code: string): ProviderError => providerError('provider_error', 'connect.code', { code }, { retryable: true });
const failsAfter = (silentFor: number, error: Error): Script => async function* () {
  await pause(silentFor);
  throw error;
};
const timesOut = (): Script => fail(timeoutError());

test('最初の出来事が上限（modelSilentMs）まで来なければ model_silent を 1 回出す。打ち切らず、遅れて届いた返事を受け取る', async t => {
  const s = await setup(t, { scripts: [slowStart(1400)], modelSilentMs: 1000 });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.text, '遅くなりました');
  assert.equal(s.adapter.calls.length, 1, '同じ呼び出しのまま待つ（打ち切らない・試し直さない）');
  const warnings = s.silentWarnings();
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]!.params, { model: 'a', seconds: 1 });
  assert.equal(warnings[0]!.message, engineText('en', 'warn.model_silent', { model: 'a', seconds: 1 }));
  assert.equal(s.events.some(e => e.type === 'model.switch' || (e.type === 'warning' && e.code === 'retrying')), false);
  const types = s.events.map(e => (e.type === 'warning' ? `warning:${e.code}` : e.type));
  assert.ok(types.indexOf('warning:model_silent') > types.indexOf('run.start') && types.indexOf('warning:model_silent') < types.indexOf('text.delta'), '始まってから、返事が届く前');
  assert.equal(s.runs.get(result.runId)!.attempts, 1);
});

test('黙っている時間が上限の何倍になっても、知らせは 1 回だけ', async t => {
  const s = await setup(t, { scripts: [slowStart(450)], modelSilentMs: 80 });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(s.silentWarnings().length, 1);
});

test('上限より前に最初の出来事が届けば、知らせない（そのあと長く止まっても、考える部分だけが先に届いても）', async t => {
  const slowAfterFirst: Script = async function* (req) {
    yield { type: 'reasoning', delta: '考えています' };
    await pause(500);
    yield* reply('できました')(req);
  };
  const s = await setup(t, { scripts: [slowAfterFirst, reply('もう 1 回')], modelSilentMs: 250 });
  const first = await sendAndWait(s.engine);
  assert.ok(first.ok);
  assert.deepEqual(s.silentWarnings(), [], '考える部分の出来事も「届いた」に数える');
  const second = await sendAndWait(s.engine, 'もう 1 回');
  assert.ok(second.ok);
  await pause(400);
  assert.deepEqual(s.silentWarnings(), [], '終わった呼び出しの時計は残らない');
});

test('黙っているあいだに止めたら、あとから知らせが出ない（時計が片付く）', async t => {
  const hang: Script = async function* (req) {
    await new Promise((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }); });
    yield { type: 'done', stop: 'end_turn' };
  };
  const s = await setup(t, { scripts: [hang], modelSilentMs: 300 });
  const sent = s.engine.send('c1', 'やあ');
  assert.ok(sent.ok);
  await pause(20);
  assert.ok(s.engine.stop(sent.runId));
  const result = await s.engine.wait(sent.runId)!;
  assert.equal(result.ok, false);
  await pause(500);
  assert.deepEqual(s.silentWarnings(), []);
});

test('上限まで黙ったまま時間切れ: 同じモデルで試し直さず、次のモデルへ（待ちの時間を入れない）。分は待った時間から出す', async t => {
  const s = await setup(t, { scripts: [failsAfter(200, timeoutError()), reply('予備です')], modelSilentMs: 80 });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'b');
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'b'], 'a は 1 回だけ（既定の試し直し 2 回を使わない）');
  assert.deepEqual(s.sleeps, []);
  assert.equal(s.silentWarnings().length, 1);
  assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'retrying'), false);
  const switched = s.events.find(e => e.type === 'model.switch');
  assert.ok(switched?.type === 'model.switch');
  assert.equal(switched.reason, engineText('en', 'run.model_no_answer', { minutes: 0.1 }), '提供元の上限（10 分）ではなく、待った時間');
  assert.equal(s.runs.get(result.runId)!.attempts, 2);
});

test('次のモデルが無いときは「N 分何も届きませんでした」で、1 回で終わる', async t => {
  const s = await setup(t, { scripts: [failsAfter(200, timeoutError()), reply('届かないはず')], models: [model('a')], modelSilentMs: 80 });
  const result = await sendAndWait(s.engine);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(s.adapter.calls.length, 1);
  assert.equal(result.errorKind, 'timeout');
  assert.equal(result.errorCode, 'engine.run.model_no_answer');
  assert.deepEqual(result.errorParams, { minutes: 0.1 });
  assert.equal(result.errorMessage, engineText('en', 'run.model_no_answer', { minutes: 0.1 }));
  assert.equal(result.retryable, true, '送り直せることは今までどおり');
  assert.deepEqual(s.sleeps, []);
  const end = s.events.at(-1);
  assert.ok(end?.type === 'run.end' && end.errorCode === 'engine.run.model_no_answer');
  assert.equal(s.runs.get(result.runId)!.error_kind, 'timeout');
  assert.match(serverText('engine.run.model_no_answer', { minutes: 1.5 }, 'ja') ?? '', /1\.5 分.*何も届きませんでした/);
});

test('提供元の上限（10 分）より手前の、実際の標準の部品の時間切れ（undici の 300 秒）も、黙ったまま来たなら試し直さない', async t => {
  for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
    const s = await setup(t, { scripts: [failsAfter(200, undiciTimeout(code)), reply('届かないはず')], models: [model('a')], modelSilentMs: 80 });
    const result = await sendAndWait(s.engine);
    assert.equal(result.ok, false, code);
    if (result.ok) return;
    assert.equal(s.adapter.calls.length, 1, code);
    assert.equal(result.errorCode, 'engine.run.model_no_answer', code);
    assert.deepEqual(s.sleeps, [], code);
  }
});

test('上限より前の時間切れ（出来事なし）は、黙っていたことにならないので今までどおり試し直す。待ちの時間も入れる', async t => {
  const s = await setup(t, { scripts: [timesOut(), timesOut(), timesOut(), reply('予備です')] });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'b');
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'a', 'a', 'b']);
  assert.deepEqual(s.sleeps, [1000, 2000]);
  assert.equal(s.silentWarnings().length, 0);
  const only = await setup(t, { scripts: [timesOut(), timesOut(), timesOut()], models: [model('a')] });
  const failed = await sendAndWait(only.engine);
  assert.equal(failed.ok, false);
  if (failed.ok) return;
  assert.equal(failed.errorCode, 'provider.timeout', '「何も届きませんでした」とは言わない');
  assert.deepEqual(only.sleeps, [1000, 2000]);
});

test('黙ったあとの失敗でも、時間切れでないもの（接続のリセットなど）は今までどおり試し直す', async t => {
  const s = await setup(t, { scripts: [failsAfter(200, undiciTimeout('ECONNRESET')), reply('届きました')], modelSilentMs: 80 });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'a');
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'a']);
  assert.deepEqual(s.sleeps, [1000]);
});

test('出来事が届いてからの時間切れは今までどおり（同じモデルで試し直す）', async t => {
  const reasonedThenTimeout: Script = async function* () {
    yield { type: 'reasoning', delta: '考えています' };
    throw new ProviderError('timeout', 'did not respond in time');
  };
  const usageThenTimeout: Script = async function* () {
    yield { type: 'usage', usage: { inputTokens: 10 } };
    throw new ProviderError('timeout', 'did not respond in time');
  };
  const s = await setup(t, { scripts: [reasonedThenTimeout, usageThenTimeout, reply('3 回目で届きました')] });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'a');
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'a', 'a']);
  assert.deepEqual(s.sleeps, [1000, 2000]);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'retrying').length, 2);
});

test('黙って知らせが出たあとに出来事が届き、そのあと時間切れになったものは、出来事が届いてからの時間切れなので今までどおり試し直す', async t => {
  const lateThenTimeout: Script = async function* () {
    await pause(200);
    yield { type: 'reasoning', delta: '考えています' };
    throw timeoutError();
  };
  const s = await setup(t, { scripts: [lateThenTimeout, reply('届きました')], modelSilentMs: 80 });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'a');
  assert.equal(s.silentWarnings().length, 1);
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'a']);
  assert.deepEqual(s.sleeps, [1000]);
});

test('時間切れ以外（回数の制限・つながらない）は、出来事が無くても今までどおり試し直す', async t => {
  const s = await setup(t, { scripts: [
    fail(new ProviderError('rate_limit', '混んでいます', { retryAfterMs: 1500 })),
    fail(new ProviderError('provider_error', 'connect', { retryable: true })),
    reply('届きました'),
  ] });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.modelId, 'a');
  assert.deepEqual(s.adapter.calls.map(c => c.model.id), ['a', 'a', 'a']);
  assert.deepEqual(s.sleeps, [1500, 2000]);
});

test('画面: model_silent の警告が、画面の言語の文になる（文は表にあり、WARNING_KEY にも載っている）', () => {
  const params = { model: 'qwen', seconds: 60 };
  const en = warningText({ code: 'model_silent', message: 'x', params }, 'en');
  assert.equal(en, engineText('en', 'warn.model_silent', params));
  const ja = warningText({ code: 'model_silent', message: 'x', params }, 'ja');
  assert.notEqual(ja, en);
  assert.match(ja, /qwen/);
  assert.match(ja, /60 秒/);
});

test('本物の openai_compatible の部品: 返事を始めないサーバーは、知らせが 1 回出て、時間切れのあと同じモデルへ送り直さず終わる', async t => {
  const server = await fakeServer((req, _body, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'a' }] })); }
  });
  t.after(() => server.close());
  const s = await setup(t, { models: [model('a')], modelSilentMs: 300, real: { baseUrl: `${server.url}/v1`, timeoutMs: 1000 } });
  const result = await sendAndWait(s.engine);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errorCode, 'engine.run.model_no_answer');
  assert.equal(server.requests.filter(r => r.method === 'POST').length, 1, '送ったのは 1 回だけ（既定の試し直し 2 回を使わない）');
  assert.equal(s.silentWarnings().length, 1);
  assert.deepEqual(s.sleeps, []);
});

test('本物の openai_compatible の部品: 遅いだけのサーバーは、知らせは出るが打ち切られず、遅れて届いた返事を受け取る', async t => {
  const server = await fakeServer(async (req, _body, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'a' }] })); return; }
    await pause(700);
    sse(res, [{ choices: [{ delta: { content: '遅れて届きました' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
  });
  t.after(() => server.close());
  const s = await setup(t, { models: [model('a')], modelSilentMs: 250, real: { baseUrl: `${server.url}/v1`, timeoutMs: 5000 } });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.text, '遅れて届きました');
  assert.equal(server.requests.filter(r => r.method === 'POST').length, 1);
  assert.equal(s.silentWarnings().length, 1);
});

// 本文もツール呼び出しの完成も無いまま、断片だけが次々届くサーバー（弱い GPU で長いツール呼び出しを書いているときの形）
function trickle(options: { parts: number; gapMs: number; finish: 'tool_calls' | 'stop'; onDone?: () => void }) {
  return async (req: import('node:http').IncomingMessage, _body: unknown, res: import('node:http').ServerResponse): Promise<void> => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'a' }] })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < options.parts; i++) {
      const delta = i === 0 ? { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'memory_save', arguments: '{"body":"' } }] } : { tool_calls: [{ index: 0, function: { arguments: 'x' } }] };
      res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      await pause(options.gapMs);
    }
    options.onDone?.();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, finish_reason: options.finish }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

test('openai_compatible の部品: 本文が無く、ツール呼び出しの断片だけが届くあいだも、届いたことを出来事（progress）で知らせる', async t => {
  let writing = true;
  const server = await fakeServer(trickle({ parts: 5, gapMs: 120, finish: 'tool_calls', onDone: () => { writing = false; } }));
  t.after(() => server.close());
  const adapter = new OpenAiCompatibleAdapter({ id: 'fake', kind: 'openai_compatible', baseUrl: `${server.url}/v1`, maxParallel: 1, timeoutMs: 10_000 }, {});
  const seen: Array<{ type: string; whileWriting: boolean }> = [];
  const request = { model: model('a'), system: { frozen: 's', dynamic: '', tail: '' }, messages: [{ role: 'user' as const, content: 'こんにちは' }], tools: [], maxOutputTokens: 1024, signal: new AbortController().signal };
  for await (const event of adapter.stream(request)) seen.push({ type: event.type, whileWriting: writing });
  assert.ok(seen.some(e => e.type === 'progress' && e.whileWriting), 'サーバーが書き続けている間に、最初の出来事が届く');
  assert.equal(seen.filter(e => e.type === 'tool_call').length, 1, '組み立てた呼び出しは今までどおり 1 つ');
  assert.equal(seen.at(-1)!.type, 'done');
});

test('出来事の種類に progress が増えても、実行は何もせず数えるだけ（本文・使用量・終了の扱いは変わらない）', async t => {
  const withProgress: Script = async function* (req) {
    yield { type: 'progress' } as StreamEvent;
    yield* reply('届きました')(req);
  };
  const s = await setup(t, { scripts: [withProgress] });
  const result = await sendAndWait(s.engine);
  assert.ok(result.ok);
  assert.equal(result.text, '届きました');
});

test('実行全体: ツール呼び出しの断片が上限より長く届き続けても、model_silent を出さない（本物の部品）', async t => {
  const server = await fakeServer(trickle({ parts: 6, gapMs: 120, finish: 'stop' }));
  t.after(() => server.close());
  const s = await setup(t, { models: [model('a')], modelSilentMs: 300, real: { baseUrl: `${server.url}/v1`, timeoutMs: 10_000 } });
  await sendAndWait(s.engine);
  assert.equal(server.requests.filter(r => r.method === 'POST').length >= 1, true);
  assert.deepEqual(s.silentWarnings(), [], '断片が届いている間は、黙っているとは言わない');
});
