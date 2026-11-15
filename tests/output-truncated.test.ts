import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { ChatMessage, RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { AnthropicAdapter, toAnthropicMessages } from '../src/providers/anthropic.ts';
import { OpenAiCompatibleAdapter, toOpenAiMessages } from '../src/providers/openai-compatible.ts';
import type { ModelRequest, StreamEvent } from '../src/providers/types.ts';
import { FakeAdapter, fakeServer, reply, sse, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

// 出力の上限で切れた返事（停止理由が max_tokens）を、成功として扱わない（AU-1）

const CUT = '{"path":"hello.md","content":"途中で切れ';

function cutCall(args: unknown = undefined, raw: string | undefined = CUT, name = 'file_write'): Script {
  return async function* (req) {
    const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args, ...(raw === undefined ? {} : { raw }) };
    for (const c of withLoad(call, req)) yield { type: 'tool_call', call: c };
    yield { type: 'done', stop: 'max_tokens' as StopReason };
  };
}
const cutText = (text: string): Script => async function* () {
  yield { type: 'text', delta: text };
  yield { type: 'done', stop: 'max_tokens' as StopReason };
};

async function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const events: RunEvent[] = [];
  app.bus.subscribe(e => events.push(e.event));
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  const run = async (text: string) => {
    const outcome = app.engine.send('c1', text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const result = await app.engine.wait(outcome.runId)!;
    return { runId: outcome.runId, result };
  };
  return { app, adapter: () => adapter, events, run, paths };
}

test('切れた返事（本文だけ）: お知らせと実行の印を出し、結果に切れたと載せる', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('これは途中で'));
  const { runId, result } = await s.run('書いて');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, true);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_truncated').length, 1);
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), ['output_truncated']);
});

test('切れていない返事には印を付けない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('おわり'));
  const { runId, result } = await s.run('書いて');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, undefined);
  assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'output_truncated'), false);
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), []);
});

test('切れたツール呼び出しは動かさず、誤りの結果を返す。会話には {} で残し、切れた文字は残さない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutCall(undefined, CUT), reply('書き直します'));
  const { runId, result } = await s.run('hello.md を作って');
  assert.ok(result.ok);
  assert.equal(existsSync(join(s.paths.workspace, 'hello.md')), false);

  const stored = s.app.conversations.messages('c1').map(m => m.message);
  const assistant = stored.find(m => m.role === 'assistant' && m.toolCalls?.length) as Extract<ChatMessage, { role: 'assistant' }>;
  assert.deepEqual(assistant.toolCalls![0]!.arguments, {});
  assert.equal('raw' in assistant.toolCalls![0]!, false);
  const tool = stored.find(m => m.role === 'tool') as Extract<ChatMessage, { role: 'tool' }>;
  assert.equal(tool.isError, true);
  assert.match(tool.content, /cut off|output limit|shorter/u);

  // 次の呼び出しには {} のまま渡る（切れた文字を送り返さない）
  const second = s.adapter().calls[1]!.messages.find(m => m.role === 'assistant' && m.toolCalls?.length) as Extract<ChatMessage, { role: 'assistant' }>;
  assert.deepEqual(second.toolCalls![0]!.arguments, {});
  assert.equal(second.toolCalls![0]!.raw, undefined);

  // 記録には deny で残り、切れた元の文字は入力欄に残る
  const row = s.app.conversations.db.prepare('SELECT decision, ok, input FROM tool_calls WHERE run_id = ?').get(runId) as { decision: string; ok: number; input: string };
  assert.equal(row.decision, 'deny');
  assert.equal(row.ok, 0);
  assert.match(row.input, /途中で切れ/u);
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), ['output_truncated']);
});

test('引数が最後まで読めても、切れた返事に付いた呼び出しは動かさない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutCall({ path: 'hello.md', content: 'やあ' }, undefined), reply('やり直します'));
  const { result } = await s.run('hello.md を作って');
  assert.ok(result.ok);
  assert.equal(existsSync(join(s.paths.workspace, 'hello.md')), false);
  const tool = s.app.conversations.messages('c1').map(m => m.message).find(m => m.role === 'tool') as Extract<ChatMessage, { role: 'tool' }>;
  assert.equal(tool.isError, true);
});

test('本文に書かれたツール呼び出しも、切れた返事なら動かさない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('```json\n{"name":"file_write","arguments":{"path":"hello.md","content":"やあ"}}\n```'), reply('やり直します'));
  const { result } = await s.run('hello.md を作って');
  assert.ok(result.ok);
  assert.equal(existsSync(join(s.paths.workspace, 'hello.md')), false);
});

test('3 回続けて切れたら止める。誤った形の連続（invalid_streak）とは別の文', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutCall(), cutCall(), cutCall(), reply('ここには来ない'));
  const { result } = await s.run('書いて');
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.errorCode, 'engine.tool.truncated_streak');
  assert.equal(s.adapter().calls.length, 3);
});

test('切れた呼び出しのあとに正しく終われば、続けて切れた数は 0 に戻る', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutCall(), cutCall(), reply('書けました'));
  const { result } = await s.run('書いて');
  assert.ok(result.ok);
  assert.equal(result.text, '書けました');
});

// ── 提供元 ───────────────────────────────────────────────

const streamModel: ModelConfig = { id: 'm', provider: 'p', model: 'test-model', contextLength: 65536, minContext: 4096, maxOutputTokens: 1024, vision: false };
const streamRequest: ModelRequest = {
  model: streamModel, system: { frozen: 'あなたは beat', dynamic: '' }, messages: [{ role: 'user', content: 'こんにちは' }],
  tools: [], maxOutputTokens: 1024, signal: new AbortController().signal,
};

test('OpenAI 互換: finish_reason が length なら、途中のツール呼び出しがあっても max_tokens を返す', async t => {
  const server = await fakeServer((_req, _body, res) => sse(res, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'file_write', arguments: '{"path":"a' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
  ]));
  t.after(() => server.close());
  const provider: ProviderConfig = { id: 'p', kind: 'openai_compatible', baseUrl: `${server.url}/v1`, maxParallel: 1, timeoutMs: 10_000 };
  const events: StreamEvent[] = [];
  for await (const e of new OpenAiCompatibleAdapter(provider, {}).stream(streamRequest)) events.push(e);
  assert.equal(events.some(e => e.type === 'tool_call'), true, '途中の呼び出しは届いている');
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'max_tokens' });
});

test('Anthropic: stop_reason が max_tokens なら、途中のツール呼び出しがあっても max_tokens を返す', async () => {
  const body = [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'file_write', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 1024 } },
    { type: 'message_stop' },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const fetchImpl = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } })) as typeof fetch;
  const provider: ProviderConfig = { id: 'p', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 1, timeoutMs: 10_000 };
  const events: StreamEvent[] = [];
  for await (const e of new AnthropicAdapter(provider, { ANTHROPIC_API_KEY: 'sk-ant-test' }, fetchImpl).stream(streamRequest)) events.push(e);
  assert.equal(events.some(e => e.type === 'tool_call'), true, '途中の呼び出しは届いている');
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'max_tokens' });
});

test('2 つの提供元とも、会話に残した {} の呼び出しをそのまま送り返せる', () => {
  const saved: ChatMessage[] = [
    { role: 'user', content: '書いて' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'file_write', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 'file_write', content: '切れました', isError: true },
  ];
  const openai = toOpenAiMessages('s', saved, false).find(m => m.role === 'assistant') as { tool_calls: Array<{ function: { arguments: string } }> };
  assert.equal(openai.tool_calls[0]!.function.arguments, '{}');
  const anth = toAnthropicMessages(saved, false).find(m => m.role === 'assistant')!;
  const block = (anth.content as Array<{ type: string; input?: unknown }>).find(b => b.type === 'tool_use')!;
  assert.deepEqual(block.input, {});
});
