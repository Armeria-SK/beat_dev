import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { ChatMessage, StopReason, ThinkingBlock, ThinkingRecord } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { AnthropicAdapter, toAnthropicMessages } from '../src/providers/anthropic.ts';
import { toOpenAiMessages } from '../src/providers/openai-compatible.ts';
import type { ModelRequest, StreamEvent } from '../src/providers/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { FakeAdapter, reply, tempDir, testConfig, withLoad, type Script } from './helpers.ts';

// 返事の考える部分（thinking / redacted_thinking と署名）を、同じ提供元・同じモデルへの次の呼び出しで、受け取ったまま送り返す（F3）

const provider: ProviderConfig = { id: 'claude', kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', maxParallel: 1, timeoutMs: 10_000 };
const model = (name: string): ModelConfig => ({ id: 'm', provider: 'claude', model: name, contextLength: 200_000, maxOutputTokens: 1024, vision: false });
const request = (name: string, messages: ChatMessage[]): ModelRequest => ({
  model: model(name), system: { frozen: 's', dynamic: '' }, messages, tools: [], maxOutputTokens: 1024, signal: new AbortController().signal,
});
const sseBody = (events: unknown[]) => events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const okStream = () => new Response(sseBody([
  { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
]), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });

function capturing(responses: Array<() => Response>) {
  const bodies: Array<{ messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return (responses.shift() ?? okStream)();
  }) as typeof fetch;
  return { bodies, adapter: new AnthropicAdapter(provider, { ANTHROPIC_API_KEY: 'sk-ant-test' }, fetchImpl) };
}

async function drain(adapter: AnthropicAdapter, req: ModelRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of adapter.stream(req)) events.push(e);
  return events;
}

const blocks: ThinkingBlock[] = [
  { type: 'thinking', thinking: '', signature: 'SIG-1', at: 0, lead: true },
  { type: 'redacted_thinking', data: 'REDACTED-1', at: 0, lead: true },
  { type: 'thinking', thinking: 'progress', signature: 'SIG-2', at: 1 },
];
const record = (over: Partial<ThinkingRecord> = {}): ThinkingRecord => ({ provider: 'claude', model: 'claude-a', blocks, ...over });
const history = (thinking?: ThinkingRecord): ChatMessage[] => [
  { role: 'user', content: '作って' },
  { role: 'assistant', content: '見ます', toolCalls: [{ id: 'tu_1', name: 'file_list', arguments: {} }, { id: 'tu_2', name: 'file_read', arguments: { path: 'a' } }], ...(thinking ? { thinking } : {}) },
  { role: 'tool', toolCallId: 'tu_1', name: 'file_list', content: 'a' },
  { role: 'tool', toolCallId: 'tu_2', name: 'file_read', content: 'x' },
];
const assistantTypes = (body: { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> }) => body.messages.find(m => m.role === 'assistant')!.content.map(b => b.type);

test('F3 Anthropic: 考える部分のブロックを署名つきで受け取り、並びの位置（文より前・何個目の呼び出しのあと）を付けて渡す', async () => {
  const body = sseBody([
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'abc' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-A' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'RED' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '見ます' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu_1', name: 'file_list', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'content_block_start', index: 4, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 4, delta: { type: 'signature_delta', signature: 'SIG-B' } },
    { type: 'content_block_stop', index: 4 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 500 } },
    { type: 'message_stop' },
  ]);
  const { adapter } = capturing([() => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } })]);
  const events = await drain(adapter, request('claude-a', [{ role: 'user', content: 'hi' }]));
  assert.deepEqual(events.filter(e => e.type === 'thinking').map(e => e.type === 'thinking' && e.block), [
    { type: 'thinking', thinking: 'abc', signature: 'SIG-A', at: 0, lead: true },
    { type: 'redacted_thinking', data: 'RED', at: 0, lead: true },
    { type: 'thinking', thinking: '', signature: 'SIG-B', at: 1 },
  ]);
});

test('F3 Anthropic: 同じ提供元・同じモデルへの次の呼び出しでは、考える部分を受け取ったまま（署名も redacted も）元の並びで送り返す', async () => {
  const { adapter, bodies } = capturing([]);
  await drain(adapter, request('claude-a', history(record())));
  assert.deepEqual(assistantTypes(bodies[0]!), ['thinking', 'redacted_thinking', 'text', 'tool_use', 'thinking', 'tool_use']);
  const sent = bodies[0]!.messages.find(m => m.role === 'assistant')!.content;
  assert.deepEqual(sent[0], { type: 'thinking', thinking: '', signature: 'SIG-1' }, '中身も署名もそのまま。beat の印（at・lead）は付けない');
  assert.deepEqual(sent[1], { type: 'redacted_thinking', data: 'REDACTED-1' });
  assert.deepEqual(sent[4], { type: 'thinking', thinking: 'progress', signature: 'SIG-2' });
});

test('F3 Anthropic: モデルが替わったら（同じ提供元でも）・提供元が違えば・送り先の指定が無ければ、考える部分は送らない', async () => {
  const { adapter, bodies } = capturing([]);
  await drain(adapter, request('claude-b', history(record())));
  await drain(adapter, request('claude-a', history(record({ provider: 'other' }))));
  for (const body of bodies) assert.deepEqual(assistantTypes(body), ['text', 'tool_use', 'tool_use']);
  for (const replay of [undefined, { provider: 'claude', model: 'claude-b' }, { provider: 'other', model: 'claude-a' }]) {
    const plain = toAnthropicMessages(history(record()), false, replay).find(m => m.role === 'assistant')!;
    assert.deepEqual((plain.content as Array<{ type: string }>).map(b => b.type), ['text', 'tool_use', 'tool_use'], JSON.stringify(replay));
  }
});

test('F3 Anthropic: 送り返した考える部分を API が 400 で断ったら、外して 1 回だけ送り直し、そのモデルには以後送り返さない', async () => {
  const rejected = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_400' } });
  const { adapter, bodies } = capturing([rejected]);
  const events = await drain(adapter, request('claude-a', history(record())));
  assert.deepEqual(events.at(-1), { type: 'done', stop: 'end_turn' });
  assert.equal(bodies.length, 2);
  assert.deepEqual(assistantTypes(bodies[0]!), ['thinking', 'redacted_thinking', 'text', 'tool_use', 'thinking', 'tool_use']);
  assert.deepEqual(assistantTypes(bodies[1]!), ['text', 'tool_use', 'tool_use']);
  await drain(adapter, request('claude-a', history(record())));
  assert.equal(bodies.length, 3, '次は 400 を挟まない');
  assert.deepEqual(assistantTypes(bodies[2]!), ['text', 'tool_use', 'tool_use']);
});

test('F3 Anthropic: 考える部分と関係の無い 400 は送り直さず、そのまま失敗にする', async () => {
  const other = () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } }), { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req_400' } });
  const { adapter, bodies } = capturing([other]);
  await assert.rejects(drain(adapter, request('claude-a', history(record()))));
  assert.equal(bodies.length, 1);
});

test('F3 OpenAI 互換: 考える部分を持つ発言も、持たない発言と同じ内容を送る', () => {
  assert.deepEqual(toOpenAiMessages('s', history(record()), false), toOpenAiMessages('s', history(), false));
});

test('F3 エンジン: 考える部分を返事と一緒に保存し、同じ実行の次の呼び出しに渡す。画面の API には出さない', async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  t.after(async () => { web.server.closeAllConnections(); await new Promise(r => web.server.close(r)); app.close(); });
  mkdirSync(paths.workspace, { recursive: true });
  const think: ThinkingBlock = { type: 'thinking', thinking: '', signature: 'SIG-ENGINE', at: 0, lead: true };
  const thinkThenList: Script = async function* (req) {
    yield { type: 'thinking', block: think };
    for (const c of withLoad({ id: 'call_1', name: 'file_list', arguments: {} }, req)) yield { type: 'tool_call', call: c };
    yield { type: 'usage', usage: { outputTokens: 900 } };
    yield { type: 'done', stop: 'tool_use' as StopReason };
  };
  adapter.scripts.push(thinkThenList, reply('おわり'));
  const outcome = app.engine.send('c1', '見て');
  assert.ok(outcome.ok);
  const result = await app.engine.wait(outcome.runId)!;
  assert.ok(result.ok);
  const saved = app.conversations.messages('c1').map(m => m.message).find(m => m.role === 'assistant' && m.thinking);
  assert.ok(saved && saved.role === 'assistant');
  assert.equal(saved.thinking!.provider, 'fake');
  assert.equal(saved.thinking!.model, 'x');
  assert.deepEqual(saved.thinking!.blocks, [think]);
  const carried = adapter.calls[1]!.messages.find((m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant' && m.thinking !== undefined);
  assert.deepEqual(carried?.thinking?.blocks, [think], '次の呼び出しに渡る');
  const listed = await (await fetch(`${origin}/api/conversations/c1/messages`, { headers: { Origin: origin } })).text();
  assert.equal(listed.includes('SIG-ENGINE'), false);
  assert.equal(listed.includes('thinking'), false);
});
