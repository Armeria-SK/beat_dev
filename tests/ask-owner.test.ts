import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App, builtinTools } from '../src/app.ts';
import type { AppConfig } from '../src/config/schema.ts';
import type { ChatMessage, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { isCore } from '../src/tools/registry.ts';
import type { PageNetwork, PageResponse } from '../src/tools/web/public-page.ts';
import { openAsk } from '../web/src/ui/ask.ts';
import { settled, startApp, waitFor } from './app-setup.ts';
import { FakeAdapter, offered, reply, tempDir, testConfig, type Script } from './helpers.ts';

const C = 'aaaaaaaa-0000-4000-8000-0000000000a1';

const ASK = {
  questions: [
    { question: 'Which storage should the app use?', header: 'Storage', options: [{ label: 'SQLite (Recommended)', description: 'One file next to the app' }, { label: 'JSON files' }] },
    { question: 'Which screens come first?', header: 'Screens', multiSelect: true, options: [{ label: 'List' }, { label: 'Detail' }, { label: 'Settings' }] },
  ],
};

let seq = 0;
const callOf = (name: string, args: unknown): ToolCall => ({ id: `call_${++seq}`, name, arguments: args });
const calls = (...list: Array<[string, unknown]>): Script => async function* () {
  for (const [name, args] of list) yield { type: 'tool_call', call: callOf(name, args) };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

const network: PageNetwork = {
  resolve: async () => ['93.184.216.34'],
  get: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body: Buffer.from('<!doctype html><html><head><title>t</title></head><body><main><p>page text</p></main></body></html>') }) as PageResponse,
};

async function setup(t: Parameters<typeof startApp>[0], configure?: (config: AppConfig) => void) {
  const s = await startApp(t, { models: [{ id: 'm1', provider: 'fake', model: 'm1-name', contextLength: 65536, maxOutputTokens: 1024, vision: false }], webNetwork: network, configure: c => { c.memory.review = false; configure?.(c); } });
  const send = (text: string, choice: Parameters<typeof s.app.engine.send>[4] = {}): string => {
    const outcome = s.app.engine.send(C, text, [], [], choice);
    assert.ok(outcome.ok && !outcome.queued, JSON.stringify(outcome));
    return outcome.runId;
  };
  const done = async (runId: string) => { await settled(s.app, runId); await s.app.engine.wait(runId); return s.app.runs.get(runId)!; };
  const toolMessages = () => s.app.conversations.messages(C).map(m => m.message).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
  return { ...s, send, done, toolMessages };
}

test('ask_owner is a core chat tool: offered in chat and plan mode, never in task / agent / review runs', async t => {
  const tool = builtinTools().find(x => x.name === 'ask_owner')!;
  assert.ok(tool, 'registered in builtinTools()');
  assert.deepEqual(tool.allowedIn, ['chat']);
  assert.equal(isCore(tool), true, 'core: never behind tool_search');
  assert.equal(tool.replayable, false);
  const s = await setup(t);
  for (const kind of ['task', 'agent', 'review'] as const) assert.ok(!s.app.tools.forRun(kind).some(x => x.name === 'ask_owner'), kind);
  s.adapter().scripts = [reply('hi')];
  await s.done(s.send('hello'));
  assert.ok(s.adapter().calls[0]!.tools.some(x => x.name === 'ask_owner'), 'sent with the tools of a chat run');
  s.adapter().scripts = [reply('planning')];
  await s.done(s.send('plan it', { permissionMode: 'plan' }));
  const planReq = s.adapter().calls.at(-1)!;
  assert.ok(planReq.tools.some(x => x.name === 'ask_owner'), 'sent in plan mode');
  assert.ok(!planReq.tools.some(x => x.name === 'file_write'), 'premise: plan mode really filters');
  assert.equal(offered(planReq).filter(n => n === 'ask_owner').length, 1, 'listed once (not also in the deferred list)');
});

test('a chat run ends right after the round that asked: no further model call, stop end_turn, flag asked_owner', async t => {
  const s = await setup(t);
  s.adapter().scripts = [calls(['ask_owner', ASK]), reply('must not be called')];
  const run = await s.done(s.send('build me an app'));
  assert.equal(s.adapter().calls.length, 1, 'the model is not called again in this run');
  assert.equal(run.ok, 1);
  assert.equal(run.stop, 'end_turn');
  assert.ok((JSON.parse(run.flags) as string[]).includes('asked_owner'));
  const [tool] = s.toolMessages();
  assert.equal(tool!.name, 'ask_owner');
  assert.ok(!tool!.isError);
  assert.match(tool!.content, /2 question\(s\)/u);
});

test('other calls issued in the same round still run; the run still ends after the round', async t => {
  const s = await setup(t);
  writeFileSync(join(s.paths.workspace, 'a.txt'), 'x');
  s.adapter().scripts = [calls(['ask_owner', ASK], ['file_read', { path: 'a.txt' }]), reply('must not be called')];
  const run = await s.done(s.send('go'));
  assert.equal(s.adapter().calls.length, 1);
  assert.deepEqual(s.toolMessages().map(m => [m.name, Boolean(m.isError)]), [['ask_owner', false], ['file_read', false]]);
  assert.ok((JSON.parse(run.flags) as string[]).includes('asked_owner'));
});

test('the next owner message is the answer: the provider sees tool_use -> tool result -> the answer text', async t => {
  const s = await setup(t);
  s.adapter().scripts = [calls(['ask_owner', ASK])];
  await s.done(s.send('build me an app'));
  s.adapter().scripts = [reply('Going with SQLite.')];
  const answer = 'Answers:\n- Storage: SQLite (Recommended)\n- Screens: List, Detail';
  const run = await s.done(s.send(answer));
  assert.equal(run.ok, 1);
  assert.ok(!(JSON.parse(run.flags) as string[]).includes('asked_owner'));
  const tail = s.adapter().calls.at(-1)!.messages.slice(-3);
  assert.equal(tail[0]!.role, 'assistant');
  assert.equal((tail[0] as Extract<ChatMessage, { role: 'assistant' }>).toolCalls?.[0]?.name, 'ask_owner');
  assert.equal(tail[1]!.role, 'tool');
  assert.equal(tail[2]!.role, 'user');
  assert.ok(JSON.stringify(tail[2]).includes('SQLite (Recommended)'));
});

const bad: Array<[string, unknown]> = [
  ['no questions', { questions: [] }],
  ['five questions', { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, header: `H${i}`, options: [{ label: 'a' }, { label: 'b' }] })) }],
  ['one option', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a' }] }] }],
  ['five options', { questions: [{ question: 'Q?', header: 'H', options: ['a', 'b', 'c', 'd', 'e'].map(label => ({ label })) }] }],
  ['duplicate question', { questions: [{ question: 'Same?', header: 'A', options: [{ label: 'a' }, { label: 'b' }] }, { question: 'same? ', header: 'B', options: [{ label: 'a' }, { label: 'b' }] }] }],
  ['duplicate label', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Yes' }, { label: 'yes' }] }] }],
  ['Other label', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Yes' }, { label: 'Other' }] }] }],
  ['Something else label', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Yes' }, { label: 'Something else' }] }] }],
  ['hidden tag characters in a label', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'Keep (Recommended)' + String.fromCodePoint(0xE0072, 0xE0075, 0xE006E) }, { label: 'b' }] }] }],
  ['zero-width character in a question', { questions: [{ question: 'Q​?', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }] }],
  ['bidi override in a header', { questions: [{ question: 'Q?', header: 'H‮', options: [{ label: 'a' }, { label: 'b' }] }] }],
  ['hidden character in a description', { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a', description: 'fine⁦' }, { label: 'b' }] }] }],
  ['whitespace-only label', { questions: [{ question: 'Q?', header: 'H', options: [{ label: ' ' }, { label: 'b' }] }] }],
  ['whitespace-only header', { questions: [{ question: 'Q?', header: '  ', options: [{ label: 'a' }, { label: 'b' }] }] }],
  ...['その他', 'そのほか', 'ほか', '他'].map((label, i): [string, unknown] => [`Japanese Other label ${i + 1}`, { questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a' }, { label }] }] }]),
];
for (const [label, input] of bad) {
  test(`bad input (${label}) is an error and the run goes on to the next model call`, async t => {
    const s = await setup(t);
    s.adapter().scripts = [calls(['ask_owner', input]), reply('asking in text then')];
    const run = await s.done(s.send('go'));
    assert.equal(s.adapter().calls.length, 2, 'the model is called again');
    assert.equal(s.toolMessages()[0]!.isError, true);
    assert.ok(!(JSON.parse(run.flags) as string[]).includes('asked_owner'));
  });
}

test('a second ask_owner in the same round is an error; the run still ends after the round', async t => {
  const s = await setup(t);
  s.adapter().scripts = [calls(['ask_owner', ASK], ['ask_owner', ASK]), reply('must not be called')];
  const run = await s.done(s.send('go'));
  assert.equal(s.adapter().calls.length, 1);
  assert.deepEqual(s.toolMessages().map(m => Boolean(m.isError)), [false, true]);
  assert.ok((JSON.parse(run.flags) as string[]).includes('asked_owner'));
});

test('a run that read outside text and then asked hands its taint to the answer run', async t => {
  const s = await setup(t);
  s.adapter().scripts = [calls(['web_fetch', { url: 'https://news.example.com/' }]), calls(['ask_owner', ASK])];
  const first = await s.done(s.send('read this page and ask me'));
  assert.equal(first.tainted, 1, 'premise: the asking run read outside text');
  assert.equal(first.ok, 1);
  s.adapter().scripts = [reply('ok')];
  const answer = await s.done(s.send('Answers:\n- Storage: JSON files'));
  assert.equal(answer.tainted, 1, 'the answer run starts as having read outside text');
});

test('a refused ask (policy block) does not end the run', async t => {
  const s = await setup(t, c => { c.tools.policies = { ask_owner: 'block' }; });
  s.adapter().scripts = [calls(['ask_owner', ASK]), reply('asking in text')];
  const run = await s.done(s.send('go'));
  assert.ok(!s.adapter().calls[0]!.tools.some(x => x.name === 'ask_owner'), 'premise: not offered when blocked');
  assert.equal(s.adapter().calls.length, 2, 'the run goes on');
  assert.equal(s.toolMessages()[0]!.isError, true);
  assert.ok(!(JSON.parse(run.flags) as string[]).includes('asked_owner'));
});

test('after a restart (new App over the same database) the answer starts a normal run that reads the asked round', async t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const databasePath = join(dir, 'beat.db');
  const open = (scripts: Script[]) => {
    let adapter!: FakeAdapter;
    const app = new App({ paths, databasePath, log: () => undefined, workerTimers: false, env: {}, adapterOverride: p => (adapter = new FakeAdapter(p, scripts)) });
    return { app, adapter: () => adapter };
  };
  const first = open([calls(['ask_owner', ASK])]);
  await first.app.status.probeAll(first.app.config());
  const out = first.app.engine.send(C, 'build me an app');
  assert.ok(out.ok && !out.queued);
  await settled(first.app, out.runId);
  assert.ok((JSON.parse(first.app.runs.get(out.runId)!.flags) as string[]).includes('asked_owner'));
  first.app.close();

  const second = open([reply('Going with SQLite.')]);
  try {
    await second.app.status.probeAll(second.app.config());
    const next = second.app.engine.send(C, 'Answers:\n- Storage: SQLite (Recommended)');
    assert.ok(next.ok && !next.queued, JSON.stringify(next));
    await settled(second.app, next.runId);
    const run = second.app.runs.get(next.runId)!;
    assert.equal(run.ok, 1);
    const roles = second.adapter().calls.at(-1)!.messages.slice(-3).map(m => m.role);
    assert.deepEqual(roles, ['assistant', 'tool', 'user']);
  } finally { second.app.close(); }
});

test('the conversation API returns a large ask_owner input whole (the card parses it)', async t => {
  const s = await setup(t);
  const long = (n: number) => `${'x'.repeat(n - 1)}?`;
  const big = { questions: Array.from({ length: 4 }, (_, i) => ({ question: `${i}${long(499)}`, header: `H${i}`, options: Array.from({ length: 4 }, (_, j) => ({ label: `L${j}`, description: 'd'.repeat(300) })) })) };
  s.adapter().scripts = [calls(['ask_owner', big])];
  await s.done(s.send('go'));
  const res = await s.json(`/api/conversations/${C}/messages`, 'GET');
  const call = (res.body.messages as Array<{ toolCalls?: Array<{ name: string; input: string }> }>).flatMap(m => m.toolCalls ?? []).find(c => c.name === 'ask_owner')!;
  assert.ok(call.input.length > 2000, 'premise: larger than the usual preview');
  assert.deepEqual(JSON.parse(call.input), big);
});

test('a message the owner queued during the asking run wins: it starts the next run and the card closes', async t => {
  const s = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slowAsk: Script = async function* () {
    await gate;
    yield { type: 'tool_call', call: callOf('ask_owner', ASK) };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  s.adapter().scripts = [slowAsk, reply('Doing it your way.')];
  const first = s.send('build me an app');
  const queued = s.app.engine.send(C, 'Never mind, use JSON files');
  assert.ok(queued.ok && queued.queued, 'premise: queued while the run is going');
  release();
  const run = await s.done(first);
  assert.ok((JSON.parse(run.flags) as string[]).includes('asked_owner'));
  await waitFor(() => s.adapter().calls.length === 2, 'the queued message starts the next run');
  const req = s.adapter().calls[1]!;
  assert.deepEqual(req.messages.slice(-3).map(m => m.role), ['assistant', 'tool', 'user']);
  const view = await s.json(`/api/conversations/${C}/messages`, 'GET');
  assert.equal(openAsk(view.body.messages), null, 'the card is closed');
});

test('only runs that have ask_owner are told to use it: a task run\'s system text never names it; the chat tool spec says to use it instead of listing options', async t => {
  const s = await setup(t, c => { c.routing = { chat: ['m1'], background: ['m1'], retriesPerModel: 0 }; c.worker.maxRunsPerHour = 100; });
  s.app.tasks.create({ title: 'Tidy the notes', origin: 'user', actor: 'user' });
  s.adapter().scripts = [calls(['task_complete', { summary: 'done' }])];
  assert.equal(await s.app.worker.tick(), 'ran');
  const taskReq = s.adapter().calls[0]!;
  assert.ok(!taskReq.tools.some(x => x.name === 'ask_owner'), 'premise: a task run does not have the tool');
  assert.ok(taskReq.system.frozen.includes('How you speak'), 'premise: the shared rules are in the frozen system');
  assert.doesNotMatch(`${taskReq.system.frozen}\n${taskReq.system.dynamic}`, /ask_owner/u);
  s.adapter().scripts = [reply('hi')];
  await s.done(s.send('hello'));
  const chatReq = s.adapter().calls.at(-1)!;
  assert.match(chatReq.tools.find(x => x.name === 'ask_owner')!.description, /instead of listing options/u);
});
