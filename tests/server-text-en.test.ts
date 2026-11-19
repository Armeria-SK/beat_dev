import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { AppConfig, ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { ProviderError, providerError } from '../src/providers/types.ts';
import { describeCron } from '../src/tasks/schedule.ts';
import { TaskError } from '../src/tasks/store.ts';
import { createWebServer } from '../src/web/server.ts';
import { contextHint, evaluateContext } from '../src/providers/context.ts';
import { classifyFetchError, classifyHttpFailure, requireApiKey } from '../src/providers/http.ts';
import { OpenAiCompatibleAdapter } from '../src/providers/openai-compatible.ts';
import { providerText } from '../src/shared/messages/providers.ts';
import { fail, fakeServer, FakeAdapter, reply, tempDir, type Script, testConfig, withLoad } from './helpers.ts';

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;
const MIN = 60_000;

function toolCall(name: string, args: unknown): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
}

function hang(): Script {
  return async function* (req) {
    yield { type: 'text', delta: 'working…' };
    await new Promise((_, reject) => {
      if (req.signal.aborted) reject(req.signal.reason);
      req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
    });
  };
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function startApp(t: { after: (fn: () => void | Promise<void>) => void }, options: { edit?: (c: AppConfig) => void } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  options.edit?.(config);
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-04T20:00:00Z') };
  let adapter!: FakeAdapter;
  const app = new App({
    paths, databasePath: ':memory:', log: () => undefined, now: () => clock.now, workerTimers: false,
    adapterOverride: provider => (adapter = new FakeAdapter(provider)),
  });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  return { app, paths, adapter: () => adapter, clock };
}

const noJapanese = (label: string, text: string | null | undefined) => assert.doesNotMatch(text ?? '', CJK, `${label}: ${text}`);
const filled = (label: string, text: string | null | undefined, ...values: Array<string | number>) => {
  assert.ok(typeof text === 'string' && text.trim() !== '', `${label}: empty`);
  assert.doesNotMatch(text, /[{}]/u, `${label}: ${text}`);
  for (const value of values) assert.ok(text.includes(String(value)), `${label}: ${value} in ${text}`);
};
const coded = (result: { message?: string | undefined; messageCode?: string | undefined }, code: string, ...values: string[]) => {
  assert.equal(result.messageCode, code);
  filled(code, result.message, ...values);
};

// ── 繰り返しの説明 ──

test('describeCron: 英語で説明する（言語を渡さなくても英語）', () => {
  const cases: Array<[string, string]> = [
    ['0 9 * * *', 'Every day at 09:00'],
    ['0 9 * * MON-FRI', 'Weekdays at 09:00'],
    ['15 10 * * TUE', 'Every Tuesday at 10:15'],
    ['15 10 * * SUN', 'Every Sunday at 10:15'],
    ['5 * * * *', 'Hourly at minute 5'],
    ['*/30 * * * *', 'Every 30 min'],
    ['0 0 1 * *', '0 0 1 * *'],
  ];
  for (const [cron, en] of cases) {
    assert.equal(describeCron(cron), en, cron);
    assert.equal(describeCron(cron, 'en'), en, cron);
  }
});

// ── タスクの経過・理由・通知を、作るときの言語で書く ──

test('タスクの経過と通知: 英語で書く', async t => {
  const s = await startApp(t);

  const stopped = s.app.tasks.create({ title: 'Stop me', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(hang());
  const ticking = s.app.worker.tick();
  await waitFor(() => s.adapter().calls.length === 1, 'run starts');
  assert.ok(s.app.engine.stop(s.app.worker.status().running!.runId));
  await ticking;
  const requeued = s.app.tasks.events(stopped.id).find(e => e.kind === 'requeued')!;
  assert.equal(requeued.content, 'It was stopped, so it will rest for a short while and then resume');

  s.clock.now += 20_000;
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'Finished', notify: true }));
  await s.app.worker.tick();
  const done = s.app.notifications.list()[0]!;
  assert.equal(done.kind, 'task_done');
  assert.equal(done.title, 'Task finished: Stop me');

  const asked = s.app.tasks.create({ title: 'Q', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('question_add', { question: 'What now?', why: 'w', options: ['a', 'b'], blocking: true }));
  await s.app.worker.tick();
  assert.equal(s.app.notifications.list()[0]!.title, 'I have a question: Q');
  assert.equal(s.app.tasks.get(asked.id)!.status, 'waiting');

  const retried = s.app.tasks.create({ title: 'R', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(fail(new ProviderError('provider_error', 'boom', { retryable: false })));
  await s.app.worker.tick();
  const retry = s.app.tasks.events(retried.id).find(e => e.kind === 'requeued')!;
  assert.equal(retry.content, 'It failed (boom). Will try again in 1 min');

  const checkpoint = s.app.tasks.create({ title: 'C', origin: 'user', actor: 'user' });
  s.clock.now += 2 * MIN;
  s.adapter().scripts.push(toolCall('task_checkpoint', { tried: 'a', result: 'b', next_action: 'c' }));
  await s.app.worker.tick();
  assert.equal(s.app.tasks.events(checkpoint.id).find(e => e.kind === 'requeued')!.content, 'The run ended without progress, so it continues now in a new run (it stops after 3 such runs in a row)');
  for (const n of s.app.notifications.list()) { noJapanese('notification title', n.title); noJapanese('notification body', n.body); }
});

test('進まないタスク: 3 回続けて決められなければ失敗にして質問票に行を足す（英語）', async t => {
  const s = await startApp(t);
  const task = s.app.tasks.create({ title: 'Vague job', origin: 'user', actor: 'user' });
  for (let i = 0; i < 3; i++) {
    s.adapter().scripts.push(reply(`thought ${i}`));
    await s.app.worker.tick();
    s.clock.now += 40 * MIN;
  }
  const stuck = s.app.tasks.get(task.id)!;
  assert.equal(stuck.status, 'failed');
  assert.equal(stuck.result_summary, 'Stopped after 3 runs in a row without progress. The owner is asked in Questions.');
  const [question] = s.app.questions.list({ status: 'open', taskId: task.id });
  assert.equal(question!.question, '"Vague job" ran 3 times in a row without making progress, so it was stopped. Run the task again?');
  assert.equal(question!.why, 'Each of those runs either ended with a reply only (without task_complete, task_checkpoint or a question), or ended without using any tool other than the task tools.');
  assert.deepEqual(s.app.notifications.list().map(n => n.title).slice(0, 2).sort(), ['Question recorded', 'Task failed: Vague job']);
  assert.match(stuck.body, /- Note: thought 0/u);
});

test('実行の上限・使えるモデルが無いときの通知（英語）', async t => {
  const s = await startApp(t, { edit: c => { c.worker.maxRunsPerHour = 1; } });
  s.app.tasks.create({ title: 'One', origin: 'user', actor: 'user' });
  s.adapter().scripts.push(toolCall('task_complete', { summary: 'ok', notify: false }));
  assert.equal(await s.app.worker.tick(), 'ran');
  s.app.tasks.create({ title: 'Two', origin: 'user', actor: 'user' });
  assert.equal(await s.app.worker.tick(), 'budget');
  const budget = s.app.notifications.list().find(n => n.kind === 'info')!;
  assert.equal(budget.title, 'The hourly run limit was reached, so tasks are being held back for a while');
  assert.equal(budget.body, 'The limit is 1 run(s) per hour (worker.maxRunsPerHour in the settings). Urgent tasks can be started with "Run now"');
});

test('ワーカーの題・理由（英語）: 振り返りの会話の題と、モデルが無いときの待ち', async t => {
  const s = await startApp(t, { edit: c => { c.memory.review = true; } });
  await s.app.worker.tick();
  s.adapter().scripts.push(reply('hello'));
  const sent = s.app.engine.send('c1', 'hello');
  assert.ok(sent.ok);
  await s.app.engine.wait(sent.runId);
  s.app.engine.lastUserActivity = 0;
  s.app.reviews.enqueue('manual', 'manual:c1', { conversationId: 'c1', kind: 'skill' });
  s.adapter().scripts.push(reply('No changes'));
  await s.app.worker.tick();
  const titles = (s.app.db.prepare("SELECT title FROM conversations WHERE kind = 'task'").all() as Array<{ title: string }>).map(r => r.title);
  assert.deepEqual(titles, ['Skill review: Manual']);
  assert.equal(s.app.reviews.list()[0]!.note, 'No changes');

  const idle = s.app.tasks.create({ title: 'Needs a model', origin: 'user', actor: 'user' });
  s.adapter().probeResult = { status: 'unreachable', message: 'no connection' };
  await s.app.status.probeAll(s.app.config());
  assert.equal(await s.app.worker.tick(), 'no_model');
  assert.equal(s.app.notifications.list().find(n => n.kind === 'health_alert')!.title, 'No model is available to run the task');
  assert.match(s.app.tasks.events(idle.id).find(e => e.kind === 'requeued')!.content ?? '', /^Waiting because no model is available: /u);
});

test('モデルの不調の通知（英語）と、提案の経過（英語）', async t => {
  const s = await startApp(t);
  const proposal = s.app.tasks.create({ title: 'B', origin: 'user', actor: 'user', propose: true });
  assert.equal(s.app.tasks.events(proposal.id)[0]!.content, 'Created as a proposal');

  s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  for (let i = 0; i < 2; i++) s.app.bus.publish({ type: 'model.switch', runId: 'r', conversationId: 'c', from: 'm', to: 'n', reason: 'timeout' });
  const alert = s.app.notifications.list().find(n => n.kind === 'health_alert')!;
  assert.equal(alert.title, 'Model "m" keeps failing (3 times)');
  assert.equal(alert.body, 'timeout\nFallback models will be tried first for 5 minutes.');
});

test('タスクの予定・復旧・エラー（英語）と、コード', async t => {
  const s = await startApp(t);
  const template = s.app.tasks.create({ title: 'Daily', origin: 'user', actor: 'user', cron: '0 9 * * *', timezone: 'UTC' });
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'Repeat: 0 9 * * *');
  const child = s.app.tasks.spawnNow(template.id)!;
  assert.equal(s.app.tasks.events(child.id)[0]!.content, 'Created from the schedule "Daily"');
  assert.equal(s.app.tasks.spawnNow(template.id), undefined);
  assert.equal(s.app.tasks.events(template.id)[0]!.content, 'The previous run has not finished yet, so none was created this time');

  const claimed = s.app.tasks.create({ title: 'Mid', origin: 'user', actor: 'user' });
  const conv = s.app.conversations.create({ kind: 'task' });
  assert.ok(s.app.tasks.claim(claimed.id, MIN, conv.id));
  s.app.tasks.recoverExpiredLeases({ all: true });
  assert.equal(s.app.tasks.events(claimed.id)[0]!.content, 'The previous run stopped midway, so it will run again');

  for (const [make, code] of [[() => s.app.tasks.create({ title: ' ', origin: 'user', actor: 'user' }), 'task.error.empty_title'], [() => s.app.tasks.approve(claimed.id), 'task.error.not_proposal']] as const) {
    try { make(); assert.fail('should throw'); } catch (error) {
      assert.ok(error instanceof TaskError);
      assert.equal(error.fullCode, code);
      filled(code, error.text('en'));
      assert.equal(error.message, error.text('en'), 'message is the English text');
    }
  }
  const empty = new TaskError('error.empty_title');
  assert.equal(empty.fullCode, 'task.error.empty_title');
  filled('empty', empty.text('en'));
  assert.equal(empty.message, empty.text('en'));
  const missing = new TaskError('error.not_found', { id: 'abc' });
  assert.equal(missing.fullCode, 'task.error.not_found');
  assert.deepEqual(missing.params, { id: 'abc' });
  filled('missing', missing.text('en'), 'abc');
});

test('API: タスクの操作の失敗は、コードとパラメータを添え、文は英語で書く', async t => {
  const s = await startApp(t);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin } });

  const task = s.app.tasks.create({ title: 'Ready one', origin: 'user', actor: 'user' });
  const res = await api(`/api/tasks/${task.id}/approve`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 409);
  const body = await res.json() as any;
  assert.equal(body.error, 'task', 'the existing error code is unchanged');
  assert.equal(body.code, 'task.error.not_proposal');
  filled('approve', body.message);

  const listed = await (await api('/api/tasks')).json() as any;
  assert.equal(listed.active.length, 1);
  const scheduled = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: 'Every day', repeat: { freq: 'daily', values: { time: '09:00' } } }) });
  assert.equal(((await scheduled.json()) as any).task.cron_text, 'Every day at 09:00');
  const again = await (await api('/api/tasks')).json() as any;
  assert.equal(again.active.find((x: any) => x.title === 'Every day').cron_text, 'Every day at 09:00');
});

// ── モデルの確認・プロバイダのエラー ──

const probeModel = (over: Partial<ModelConfig> = {}): ModelConfig => ({ id: 'm', provider: 'p', model: 'test-model', contextLength: 8192, maxOutputTokens: 512, vision: false, ...over });
const compatProvider = (baseUrl: string, over: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: 'p', kind: 'openai_compatible', baseUrl, maxParallel: 1, timeoutMs: 10_000, ...over });

test('モデルの確認: 言語を渡さない呼び出しは英語の文', () => {
  const facts = { modelId: 'm', server: 'generic', required: 65536 };
  const tooSmall = evaluateContext({ ...facts, measured: 4096, hint: contextHint('en', 'generic', 65536) });
  coded(tooSmall, 'provider.probe.too_small', '4,096', '65,536', providerText('en', 'probe.source.measured', { n: '4,096' }));
  assert.equal(tooSmall.hint, 'Set the context length on the server to 65,536 or more, and set contextLength in the config to match');
  coded(evaluateContext({ ...facts, declared: 8192, hint: 'x' }), 'provider.probe.too_small', '8,192', '65,536', providerText('en', 'probe.source.declared', { n: '8,192' }));
  coded(evaluateContext({ ...facts, modelMax: 4096, hint: 'x' }), 'provider.probe.too_small', '4,096', '65,536', providerText('en', 'probe.source.limit', { n: '4,096' }));
  const exceeds = evaluateContext({ ...facts, declared: 200000, modelMax: 131072 });
  coded(exceeds, 'provider.probe.exceeds_model', '200,000', '131,072');
  assert.equal(exceeds.hint, 'Set contextLength to 131,072 or less');
  const unknown = evaluateContext(facts);
  coded(unknown, 'provider.probe.unknown');
  assert.equal(unknown.hint, 'Enter the length you set on the server in Settings › Models › Advanced › Context length');
  coded(evaluateContext({ ...facts, declared: 70000 }), 'provider.probe.ok', '70,000');
  coded(evaluateContext({ ...facts, declared: 70000, unmeasuredNote: 'probe.note.use_config' }), 'provider.probe.ok', '70,000', providerText('en', 'probe.note.use_config'));
  assert.equal(contextHint('en', 'hosted', 65536), 'Choose a model whose context length is 65,536 or more');
  assert.equal(contextHint('en', 'lmstudio', 65536), 'Reload the model in LM Studio with a Context Length of 65,536 or more, and set contextLength to match');
  assert.equal(contextHint('en', 'llamacpp', 65536), 'Start llama-server with -c so that each slot has 65,536 or more (raising the slots with -np splits -c)');
  assert.equal(contextHint('en', 'vllm', 65536), 'Start vLLM with --max-model-len 65,536 or more');
  assert.equal(contextHint('en', 'tabbyapi', 65536), 'Set max_seq_len (under model) in the TabbyAPI config.yml to 65,536 or more, reload the model, and set contextLength to match (and make cache_size the same or larger)');
});

test('モデルの確認: messageParams には言語で書いた文を入れず、小さなコードと値を入れる', () => {
  const facts = { modelId: 'm', server: 'generic', required: 65536 };
  for (const language of ['en'] as const) {
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 8192, hint: 'x' }).messageParams, { effective: '8,192', required: '65,536', sourceKind: 'declared', n: '8,192' });
    assert.deepEqual(evaluateContext({ ...facts, language, modelMax: 4096, hint: 'x' }).messageParams, { effective: '4,096', required: '65,536', sourceKind: 'limit', n: '4,096' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 70000 }).messageParams, { effective: '70,000' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 70000, unmeasuredNote: 'probe.note.use_config' }).messageParams, { effective: '70,000', noteCode: 'provider.probe.note.use_config' });
    assert.deepEqual(evaluateContext({ ...facts, language, declared: 200000, modelMax: 131072 }).messageParams, { declared: '200,000', modelMax: '131,072' });
  }
});

test('プロバイダのエラー: 文は英語で、コードと値を添える', () => {
  const cases: Array<[ProviderError, string, ...string[]]> = [
    [classifyHttpFailure(401, 'bad key'), 'http.auth', '401'],
    [classifyHttpFailure(429, ''), 'http.rate_limit', '429'],
    [classifyHttpFailure(404, ''), 'http.not_found', '404'],
    [classifyHttpFailure(503, 'down'), 'http.server', '503'],
    [classifyHttpFailure(400, ''), 'http.rejected', '400'],
    [classifyHttpFailure(400, 'maximum context length exceeded'), 'http.context_overflow', '400'],
    [classifyFetchError(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }), new AbortController().signal), 'connect.code', 'ECONNREFUSED'],
    [classifyFetchError(new Error('x'), new AbortController().signal), 'connect'],
  ];
  for (const [error, code, ...values] of cases) {
    assert.equal(error.code, code);
    filled(code, error.message, ...values);
    assert.equal(error.text('en'), error.message);
  }
  assert.deepEqual(cases[0]![0].params, { status: 401 }, '相手のサーバーの本文は値にも入らない');
  assert.equal(cases[0]![0].upstream, 'bad key', '実行ログ用の本文だけ別に持つ');
  assert.throws(() => requireApiKey(compatProvider('http://127.0.0.1:1/v1', { apiKeyEnv: 'NOPE_KEY' }), {}), (e: unknown) => {
    const error = e as ProviderError;
    assert.equal(error.code, 'key.missing');
    filled('key.missing', error.message, 'NOPE_KEY');
    return error.text('en') === error.message;
  });
});

test('モデルの確認（英語）: 接続先ごとの message / hint / code', async t => {
  const tabby = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ id: 'other-model', parameters: { max_seq_len: 4096 } })); });
  const vllm = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ data: [{ id: 'another' }] })); });
  const small = await fakeServer((_req, _body, res) => { res.writeHead(200); res.end(JSON.stringify({ default_generation_settings: { n_ctx: 2048 } })); });
  t.after(async () => { for (const s of [tabby, vllm, small]) await s.close(); });

  const tabbyResult = await new OpenAiCompatibleAdapter(compatProvider(`${tabby.url}/v1`, { server: 'tabbyapi' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(tabbyResult.status, 'not_found');
  coded(tabbyResult, 'provider.probe.tabby_other', 'other-model', 'test-model');
  assert.equal(tabbyResult.hint, 'Load the model you want in TabbyAPI, or make models[].model match');
  assert.deepEqual(tabbyResult.messageParams, { current: 'other-model', model: 'test-model' });
  const tabbyDefault = await new OpenAiCompatibleAdapter(compatProvider(`${tabby.url}/v1`, { server: 'tabbyapi' }), {}).probe(probeModel(), 65536);
  assert.equal(tabbyDefault.message, tabbyResult.message, '言語を渡さなくても英語');
  assert.equal(tabbyDefault.hint, 'Load the model you want in TabbyAPI, or make models[].model match');

  const vllmResult = await new OpenAiCompatibleAdapter(compatProvider(`${vllm.url}/v1`, { server: 'vllm' }), {}).probe(probeModel(), 65536, 'en');
  coded(vllmResult, 'provider.probe.vllm_missing', 'test-model');

  const tooSmall = await new OpenAiCompatibleAdapter(compatProvider(`${small.url}/v1`, { server: 'llamacpp' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(tooSmall.status, 'too_small');
  coded(tooSmall, 'provider.probe.too_small', '2,048', '65,536');
  assert.deepEqual(tooSmall.messageParams, { effective: '2,048', required: '65,536', sourceKind: 'measured', n: '2,048' }, 'messageParams hold a sub-code, not language-written text');
  assert.equal(tooSmall.hint, 'Start llama-server with -c so that each slot has 65,536 or more (raising the slots with -np splits -c)');

  const noKey = await new OpenAiCompatibleAdapter(compatProvider('http://127.0.0.1:9/v1', { apiKeyEnv: 'NOPE_KEY' }), {}).probe(probeModel(), 65536, 'en');
  assert.equal(noKey.status, 'no_api_key');
  coded(noKey, 'provider.key.missing', 'NOPE_KEY');
  for (const r of [tabbyResult, vllmResult, tooSmall, noKey]) { noJapanese('probe message', r.message); noJapanese('probe hint', r.hint); }
});

test('モデルの確認: アダプタの確認には英語が届く', async t => {
  const s = await startApp(t);
  assert.deepEqual(s.adapter().probeLanguages, ['en']);
});

// ── エンジンの失敗・警告 ──

function collect(app: App): RunEvent[] {
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  return events;
}

test('エンジンの失敗と警告（英語）: 文は英語で、コードと値を添える', async t => {
  const s = await startApp(t, { edit: c => { c.routing.retriesPerModel = 1; } });
  const events = collect(s.app);
  const send = async (id: string, text: string) => {
    const outcome = s.app.engine.send(id, text);
    assert.ok(outcome.ok);
    return s.app.engine.wait(outcome.runId)!;
  };

  // 再試行 → 失敗
  const down = () => fail(providerError('provider_error', 'http.server', { status: 503 }, { retryable: true, status: 503, retryAfterMs: 1 }));
  s.adapter().scripts.push(down(), down());
  const failed = await send('c1', 'hi');
  assert.ok(!failed.ok);
  const retrying = events.find(e => e.type === 'warning' && e.code === 'retrying' && e.conversationId === 'c1') as Extract<RunEvent, { type: 'warning' }>;
  assert.ok(retrying, 'retrying on c1');
  filled('retrying', retrying.message, '503', '1/1');
  assert.deepEqual(retrying.params, { seconds: 1, attempt: 1, retries: 1, errorCode: 'provider.http.server', errorParams: { status: 503 } }, 'language-written text is not in params');
  const end = events.findLast(e => e.type === 'run.end') as Extract<RunEvent, { type: 'run.end' }>;
  assert.equal(end.errorKind, 'provider_error');
  filled('run.end', end.errorMessage, '503');
  assert.equal(end.errorCode, 'provider.http.server');
  assert.deepEqual(end.errorParams, { status: 503 });
  if (!failed.ok) assert.equal(failed.errorCode, 'provider.http.server');

  // 途中まで書いて失敗
  s.adapter().scripts.push(fail(providerError('provider_error', 'http.rejected', { status: 400 }, { retryable: false }), 'partial text'));
  await send('c2', 'hi');
  const discarded = events.find(e => e.type === 'warning' && e.code === 'partial_discarded' && e.conversationId === 'c2') as Extract<RunEvent, { type: 'warning' }>;
  assert.ok(discarded, 'partial_discarded on c2');
  filled('partial_discarded', discarded.message);

  // 止められた返事（途中まで保存される）
  s.adapter().scripts.push(hang());
  const outcome = s.app.engine.send('c4', 'hi');
  assert.ok(outcome.ok);
  await waitFor(() => s.adapter().calls.length >= 4, 'hang starts');
  await new Promise(r => setTimeout(r, 30));
  s.app.engine.stop(outcome.runId);
  const cancelled = await s.app.engine.wait(outcome.runId);
  assert.ok(cancelled && !cancelled.ok);
  if (cancelled && !cancelled.ok) { filled('cancelled', cancelled.errorMessage); assert.equal(cancelled.errorCode, 'provider.cancelled'); }
  assert.equal(s.app.conversations.messages('c4').at(-1)!.text, 'working…\n\n(stopped partway)');

  // 忙しい・やり直す発言が無い
  s.adapter().scripts.push(hang());
  const running = s.app.engine.send('c5', 'hi');
  assert.ok(running.ok);
  // 実行中の送信は待たせる（tests/queued-send.test.ts）。実行中のやり直しは断る
  const busy = s.app.engine.retry('c5');
  assert.ok(!busy.ok);
  if (!busy.ok) {
    filled('busy', busy.errorMessage);
    assert.equal(busy.errorCode, 'engine.send.busy');
  }
  s.app.engine.stop(running.runId);
  await s.app.engine.wait(running.runId);
  const nothing = s.app.engine.retry('c-none');
  assert.ok(!nothing.ok);
  if (!nothing.ok) assert.equal(nothing.errorCode, 'engine.send.nothing_to_retry');
});

test('エンジンの失敗（英語）: 使えるモデルが無い・ツールを正しく呼べない・内部エラー', async t => {
  const s = await startApp(t);
  s.adapter().probeResult = { status: 'too_small', message: 'x' };
  await s.app.status.probeAll(s.app.config());
  const blocked = s.app.engine.send('c1', 'hi');
  assert.ok(!blocked.ok);
  if (!blocked.ok) {
    assert.equal(blocked.errorCode, 'engine.no_usable');
    filled('no usable model', blocked.errorMessage);
    assert.match(blocked.errorMessage, /\n- m: x$/u, 'the model id and its probe message are listed after the sentence');
    noJapanese('no usable model', blocked.errorMessage);
  }
  s.adapter().probeResult = {};
  await s.app.status.probeAll(s.app.config());

  const events = collect(s.app);
  for (let i = 0; i < 3; i++) s.adapter().scripts.push(toolCall('no_such_tool', {}));
  const outcome = s.app.engine.send('c2', 'hi');
  assert.ok(outcome.ok);
  const result = await s.app.engine.wait(outcome.runId)!;
  assert.ok(result && !result.ok);
  if (result && !result.ok) {
    filled('invalid_streak', result.errorMessage, '3');
    assert.equal(result.errorCode, 'engine.tool.invalid_streak');
    assert.equal(result.detail?.hint, 'Turn off tools you do not use');
  }
  const toolResults = events.filter(e => e.type === 'tool.result');
  assert.ok(toolResults.length >= 1);
});

// ── API のエラー ──

async function serve(t: { after: (fn: () => void | Promise<void>) => void }) {
  const s = await startApp(t);
  const web = createWebServer(s.app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); });
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  const api = (path: string, init: RequestInit = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Origin: origin, ...init.headers } });
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  return { ...s, api, post, origin };
}

const SHAPES = 'pebble / triangle / diamond / bean / cloud / droplet / heart / star / crescent / capsule / square / puddle / ghost / bunny / cat / bear / mushroom / bell / peanut / comet';

test('API のエラー: 今までの error / field に code と params を添え、message は英語で書く', async t => {
  const s = await serve(t);
  const expectProblem = async (res: Response, status: number, expected: { error: string; code: string; field?: string; params?: Record<string, unknown> }) => {
    assert.equal(res.status, status);
    const body = await res.json() as any;
    assert.equal(body.error, expected.error);
    assert.equal(body.code, expected.code);
    filled(expected.code, body.message, ...Object.values(expected.params ?? {}).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number'));
    assert.equal(body.field, expected.field);
    assert.deepEqual(body.params, expected.params);
  };

  await expectProblem(await s.post('/api/conversations/c1/messages', {}), 400, { error: 'invalid_field', code: 'http.required', field: 'text', params: { field: 'text' } });
  await expectProblem(await s.post('/api/conversations/c1/messages', { text: 'x'.repeat(100_001) }), 400, { error: 'invalid_field', code: 'http.too_long', field: 'text', params: { field: 'text', max: 100000 } });
  await expectProblem(await s.api('/api/conversations/c1/messages', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } }), 400, { error: 'invalid_json', code: 'http.invalid_json' });
  await expectProblem(await s.api('/api/conversations/c1/messages', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }), 415, { error: 'unsupported_media_type', code: 'http.unsupported_media_type' });
  await expectProblem(await s.api('/api/conversations/nope/messages'), 404, { error: 'not_found', code: 'http.conversation_missing' });
  await expectProblem(await s.api('/api/tasks/nope'), 404, { error: 'not_found', code: 'http.task_missing' });
  await expectProblem(await s.post('/api/tasks', { title: 'x', priority: 9 }), 400, { error: 'invalid_field', code: 'http.bad_priority', field: 'priority' });
  await expectProblem(await s.post('/api/tasks', { title: 'x', when: 'tomorrow' }), 400, { error: 'invalid_field', code: 'http.bad_when', field: 'when' });
  await expectProblem(await s.api('/api/profile', { method: 'PATCH', body: JSON.stringify({ shape: 'nope' }) }), 400, { error: 'invalid_field', code: 'http.bad_enum', field: 'shape', params: { field: 'shape', values: SHAPES } });
  await expectProblem(await s.post('/api/memories', { book: 'x', content: 'a' }), 400, { error: 'invalid_field', code: 'http.bad_book', field: 'book' });
  await expectProblem(await s.post('/api/worker', { paused: 'yes' }), 400, { error: 'invalid_field', code: 'http.bad_bool', field: 'paused', params: { field: 'paused' } });

  await expectProblem(await s.post('/api/memories', { book: 'user', content: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }), 400, { error: 'memory', code: 'store.memory.secret' });
  await expectProblem(await s.api('/api/memories/999', { method: 'PATCH', body: JSON.stringify({ content: 'x' }) }), 400, { error: 'memory', code: 'store.memory.not_found', params: { id: 999 } });
  assert.equal((await s.post('/api/curiosity', { topic: 'Tea' })).status, 201);
  await expectProblem(await s.post('/api/curiosity', { topic: 'Tea' }), 400, { error: 'invalid', code: 'store.curiosity.duplicate', params: { id: 1 } });
  await expectProblem(await s.api('/api/uploads?name=a.txt', { method: 'POST', body: Buffer.alloc(0), headers: { 'Content-Type': 'text/plain' } }), 400, { error: 'upload', code: 'store.upload.empty' });

  s.app.reviews.enqueue('manual', 'manual:x', {});
  const reviews = await (await s.api('/api/reviews')).json() as any;
  assert.equal(reviews.jobs[0].trigger, 'manual');
  filled('triggerLabel', reviews.jobs[0].triggerLabel);
});

test('API: 添付だけの発言の目印と、記憶の削除の理由は英語で書く', async t => {
  const s = await serve(t);
  const uploaded = await (await s.api('/api/uploads?name=a.txt', { method: 'POST', body: 'file body', headers: { 'Content-Type': 'text/plain' } })).json() as any;
  s.adapter().scripts.push(reply('ok'));
  const sent = await s.post(`/api/conversations/00000000-0000-4000-8000-000000000001/messages`, { text: '', attachments: [uploaded.upload.id] });
  assert.equal(sent.status, 202);
  await s.app.engine.wait(((await sent.json()) as any).runId);
  const stored = s.app.conversations.messages('00000000-0000-4000-8000-000000000001')[0]!.message;
  assert.equal(stored.role, 'user');
  if (stored.role === 'user') {
    assert.ok(stored.content.startsWith('(A file was attached)\n\n<<<Attachment: a.txt (text)>>>'), stored.content);
    assert.ok(stored.content.endsWith('<<<End of attachment>>>'));
  }
  assert.equal(s.app.conversations.get('00000000-0000-4000-8000-000000000001')!.title, 'a.txt', '添付の目印は題にしない');
  const history = await (await s.api(`/api/conversations/00000000-0000-4000-8000-000000000001/messages`)).json() as any;
  assert.equal(history.messages[0].text, '(A file was attached)', '画面には囲みの中身を出さない');

  const memory = await (await s.post('/api/memories', { book: 'user', content: 'tea' })).json() as any;
  const removed = await (await s.api(`/api/memories/${memory.memory.id}`, { method: 'DELETE' })).json() as any;
  const events = s.app.memory.events(memory.memory.id);
  assert.equal(events.find(e => e.id === removed.eventId)!.reason, 'Deleted from the screen');
});

test('再起動で中断した実行の記録は、英語で書く', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  writeFileSync(paths.config, JSON.stringify(config));
  const first = new App({ paths, log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  first.runs.start('r1', 'chat', 'c1');
  first.close();
  const second = new App({ paths, log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  const row = second.runs.get('r1')!;
  assert.equal(row.error_kind, 'cancelled');
  assert.equal(row.error_message, 'Interrupted by an app restart');
  second.close();
});
