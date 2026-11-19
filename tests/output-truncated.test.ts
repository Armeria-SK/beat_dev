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
import type { ModelRequest, ProbeResult, StreamEvent } from '../src/providers/types.ts';
import { FakeAdapter, fail, fakeServer, reply, sse, tempDir, testConfig, type Script, withLoad } from './helpers.ts';
import type { SpeechRow } from '../src/db/conversations.ts';
import { prepareSpeech } from '../src/projects/acceptance.ts';
import { engineText } from '../src/shared/messages/engine.ts';
import { ContextOverflow, fitMessages, groupExchanges, irreducibleEstimate } from '../src/engine/fit.ts';

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

async function setup(t: { after: (fn: () => void) => void }, model?: ModelConfig, probe: Partial<ProbeResult> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [model ?? { id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  adapter.probeResult = probe;
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

test('切れた返事（本文だけ）: 続きを 3 回頼んでも切れたら、お知らせと実行の印を出し、結果に切れたと載せる', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('これは途中で'), cutText('まだ'), cutText('まだ'), cutText('まだ'));
  const { runId, result } = await s.run('書いて');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, true);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_limit').length, 1);
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

const streamModel: ModelConfig = { id: 'm', provider: 'p', model: 'test-model', contextLength: 65536, maxOutputTokens: 1024, vision: false };
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

// ── 文だけの返事が上限で切れたら、beat が続きを頼む（model-auto PR B） ──
const listCall: Script = async function* (req) {
  for (const c of withLoad({ id: `call_${Math.random().toString(36).slice(2)}`, name: 'file_list', arguments: {} }, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const continueText = engineText('en', 'message.continue');
const isContinue = (m: ChatMessage) => m.role === 'user' && m.note === 'continue';

test('B: 文だけ 1 回切れて次で終わる → 見えない一言で続きを頼み、実行は 1 つのまま成功し、結果の文は 2 つをつないだもの', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('前半は途中'), reply('で、後半はここまで'));
  const { runId, result } = await s.run('長く書いて');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, undefined, '最後まで書けたので切れたとは載せない');
  assert.equal(result.ok && result.text, '前半は途中で、後半はここまで');
  assert.equal(s.adapter().calls.length, 2);
  const lastSent = s.adapter().calls[1]!.messages.at(-1)!;
  assert.equal(lastSent.role, 'user');
  assert.equal(lastSent.role === 'user' && lastSent.content, continueText);
  const stored = s.app.conversations.messages('c1').map(m => m.message);
  assert.deepEqual(stored.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  const asked = stored[2]!;
  assert.ok(isContinue(asked), 'beat が足した印つき');
  assert.equal(asked.role === 'user' && asked.generated, true);
  assert.equal(asked.role === 'user' && 'fetched' in asked, false);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continued').length, 1);
  assert.equal(s.events.some(e => e.type === 'warning' && (e.code === 'output_truncated' || e.code === 'output_continue_limit')), false);
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), ['output_truncated'], '切れた印は残す（厳しい側）');
  assert.equal(new Set(s.app.conversations.messages('c1').filter(m => m.role !== 'user' || isContinue(m.message)).map(m => m.run_id)).size, 1, '1 つの実行');
});

test('B: 4 回続けて切れる → 一言は 3 つ、呼び出しは 4 回で 5 回目は無く、成功で truncated、3 回でも切れた知らせ', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('一'), cutText('二'), cutText('三'), cutText('四'), reply('五は呼ばれない'));
  const { result } = await s.run('長く書いて');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.text, '一二三四');
  assert.equal(s.adapter().calls.length, 4);
  assert.equal(s.app.conversations.messages('c1').filter(m => isContinue(m.message)).length, 3);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continued').length, 1, '続きの知らせは 1 回の実行で 1 回');
  const limit = s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_limit');
  assert.equal(limit.length, 1);
  assert.equal(limit[0]!.type === 'warning' && limit[0]!.message, engineText('en', 'warn.output_continue_limit', { count: 3 }));
});

test('B: 道具を挟む → 結果の文は最後の文だけ。続きは道具を挟んでも 1 回の実行で合計 3 回まで', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('切れた'), listCall, reply('最後の文'));
  const first = await s.run('調べて');
  assert.ok(first.result.ok);
  assert.equal(first.result.ok && first.result.text, '最後の文');
  s.adapter().calls.length = 0;
  s.adapter().scripts.push(cutText('a'), cutText('b'), listCall, cutText('c'), cutText('d'), reply('呼ばれない'));
  const second = await s.run('もう一度');
  assert.ok(second.result.ok);
  assert.equal(second.result.ok && second.result.truncated, true);
  assert.equal(second.result.ok && second.result.text, 'cd', '道具の前の切れた文は捨てる');
  assert.equal(s.adapter().calls.length, 5);
  assert.equal(s.app.conversations.messages('c1').filter(m => isContinue(m.message) && m.run_id === second.runId).length, 3);
});

test('B: 道具の呼び出しが切れたときの知らせに「continue」の語が無い', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutCall(undefined, CUT), reply('書き直します'));
  await s.run('hello.md を作って');
  const warned = s.events.filter(e => e.type === 'warning' && e.code === 'output_truncated');
  assert.equal(warned.length, 1);
  assert.doesNotMatch(warned[0]!.type === 'warning' ? warned[0]!.message : '', /continue/iu);
  assert.doesNotMatch(engineText('en', 'warn.output_truncated'), /continue/iu);
  assert.equal(s.app.conversations.messages('c1').some(m => isContinue(m.message)), false, '道具の側は一言を足さない');
});

test('B 安全: 続きの一言は受け入れの項目（持ち主の発言）に入らない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('途中'), reply('おわり'));
  await s.run('持ち主の頼み');
  const rows = s.app.conversations.db.prepare("SELECT id, conversation_id, role, text, COALESCE(json_extract(parts, '$.generated'), 0) IS 1 AS generated FROM messages WHERE conversation_id = 'c1' AND role = 'user' ORDER BY id").all() as unknown as SpeechRow[];
  assert.equal(rows.length, 2, '前提: 持ち主の発言と続きの一言');
  assert.deepEqual(prepareSpeech(rows).owner.map(o => o.raw), ['持ち主の頼み']);
});

test('B 量: 続きの一言は直前のやり取りと 1 つのまとまり。入りきらなければ一言だけを送らず ContextOverflow', () => {
  const request: ChatMessage = { role: 'user', content: 'あ'.repeat(3000) };
  const cut: ChatMessage = { role: 'assistant', content: 'い'.repeat(3000) };
  const ask: ChatMessage = { role: 'user', content: continueText, generated: true, note: 'continue' };
  assert.equal(groupExchanges([request, cut, ask]).length, 1);
  assert.throws(() => fitMessages({ system: '', messages: [request, cut, ask], tools: [], available: 5000 }), ContextOverflow);
  assert.equal(groupExchanges([request, cut, { role: 'user', content: 'next' }]).length, 2, '持ち主の発言は今どおり区切る');
});

test('B 量: 頼みと切れた文で残りが無いときは続きを頼まず、つないだ文で切れたとして終える（一言だけを送らない）', async t => {
  const s = await setup(t);
  const cut = `${'い'.repeat(25_000)} Visit https://example.com/a/b`;
  s.adapter().scripts.push(cutText(cut), reply('呼ばれない'));
  const { result } = await s.run('あ'.repeat(30_000));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.text, cut);
  assert.equal(s.adapter().calls.length, 1, '続きの呼び出しをしない');
  assert.equal(s.app.conversations.messages('c1').some(m => isContinue(m.message)), false, '一言を残さない');
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_no_room').length, 1);
  assert.equal(s.events.some(e => e.type === 'warning' && (e.code === 'output_continued' || e.code === 'output_continue_limit')), false);
});

test('B 量: 古いやり取りを外せば入るときは続きを頼み、送る履歴には持ち主の頼みと切れた文と一言が残る', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(reply('う'.repeat(45_000)));
  await s.run('old');
  s.adapter().scripts.push(cutText('お'.repeat(10_000)), reply('end'));
  const { result } = await s.run('え'.repeat(5000));
  assert.ok(result.ok);
  assert.equal(result.ok && result.text, `${'お'.repeat(10_000)}end`);
  const sent = s.adapter().calls.at(-1)!.messages;
  assert.equal(sent.length, 3, JSON.stringify(sent.map(m => m.role)));
  assert.equal(sent[0]!.role === 'user' && sent[0]!.content, 'え'.repeat(5000));
  assert.ok(isContinue(sent[2]!));
});

test('B 継ぎ目: 続きを頼む切れた文は最後の空白まで戻して保存し、モデルはそこから書く。続きの頭の改行は落とし、空白は前の文が空白で終わらないときだけ 1 つ残す（Qwen の空行・英語の語・日本語）', async t => {
  // 2 つ目の返事は、実際のモデルのように「保存された文（モデルに送った文）」の続きを書く
  const cases: Array<[cut: string, sent: string, next: string, joined: string]> = [
    ['\n\nThe quick bro', 'The quick ', 'brown fox jumps.', 'The quick brown fox jumps.'],
    ['The quick brown', 'The quick ', ' brown fox.', 'The quick brown fox.'],
    ['The quick ', 'The quick ', '\n\nbrown fox.', 'The quick brown fox.'],
    ['The quick bro', 'The quick ', '\n\n brown fox.', 'The quick brown fox.'],
    ['途中', '途中', '\n\nで、続き', '途中で、続き'],
    ['日本語の文 です途中', '日本語の文 です途中', '\n\nで、続き', '日本語の文 です途中で、続き'],
    ['see https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'see https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbb end', 'see https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbb end'],
    ['nospace', 'nospace', ' after', 'nospace after'],
  ];
  for (const [cut, sent, next, joined] of cases) {
    const s = await setup(t);
    s.adapter().scripts.push(cutText(cut), reply(next));
    const { result } = await s.run('Write a sentence');
    assert.equal(result.ok && result.text, joined, JSON.stringify(cut));
    const seen = s.adapter().calls[1]!.messages.filter(m => m.role === 'assistant').at(-1)!;
    assert.equal(seen.content, sent, `モデルに送った切れた文: ${JSON.stringify(cut)}`);
    const stored = s.app.conversations.messages('c1').map(m => m.message).filter(m => m.role === 'assistant').map(m => m.content).join('');
    assert.equal(stored, joined, '画面でつないだ文も同じ');
  }
});

test('B 継ぎ目: 続きを頼まないとき（上限まで頼んだあと）は切れた文を戻さない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('one '), cutText('two '), cutText('three '), cutText('four fiv'));
  const { result } = await s.run('Write');
  assert.equal(result.ok && result.text, 'one two three four fiv');
});

test('B 空の続き: 続きを頼んだ返事が空（end_turn）なら、黙って成功にせず切れたとして返し、知らせを出す', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('The forest behind me the'), reply(''));
  const { result } = await s.run('Write');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.text, 'The forest behind me the', '戻した語は失わない');
  assert.deepEqual(s.app.conversations.messages('c1').map(m => m.message).filter(m => m.role === 'assistant').map(m => m.content), ['The forest behind me ', 'the'], '画面でも戻した語が見える');
  assert.equal(s.adapter().calls.length, 2);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_empty').length, 1);
});

test('B 空の続き: 空白だけの続きも空として扱う（前の文が空白で終わらないときも）', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('nospace'), reply(' \n'));
  const { result } = await s.run('Write');
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.text, 'nospace');
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_empty').length, 1);
});

// ── 考えるだけで上限に達し、文も呼び出しも無い返事（F1）: 続きの一言を送らず、上限を上げて同じ呼び出しをやり直す ──
const thinkingOnly: Script = async function* () {
  yield { type: 'reasoning', delta: '' };
  yield { type: 'usage', usage: { outputTokens: 64_000 } };
  yield { type: 'done', stop: 'max_tokens' as StopReason };
};
const big = (contextLength: number): ModelConfig => ({ id: 'm', provider: 'fake', model: 'x', contextLength, vision: false });

test('F1: 考えるだけで上限に達した返事は、続きの一言を送らず、上げた上限で同じ呼び出しをやり直す。上げた上限は同じ実行の次の呼び出しにも効く', async t => {
  const s = await setup(t, big(1_000_000), { maxOutput: 128_000 });
  s.adapter().scripts.push(thinkingOnly, listCall, reply('おわり'));
  const { runId, result } = await s.run('作って');
  assert.ok(result.ok);
  assert.equal(result.ok && result.truncated, undefined);
  assert.equal(result.ok && result.text, 'おわり');
  const calls = s.adapter().calls;
  assert.deepEqual(calls.map(c => c.maxOutputTokens), [32_000, 128_000, 128_000]);
  assert.equal(calls.some(c => c.messages.some(isContinue)), false, '続きの一言は送らない');
  assert.equal(s.app.conversations.messages('c1').some(m => m.message.role === 'assistant' && !m.message.content && !m.message.toolCalls?.length), false, '空の返事は保存しない');
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), ['output_raised']);
  assert.equal(s.events.some(e => e.type === 'warning' && e.code === 'output_continued'), false);
});

test('F1: 上げられる上限が無ければ（提供元の上限に達している）やり直さず、続きも頼まず、知らせを出して切れたとして終える', async t => {
  const s = await setup(t, big(1_000_000), { maxOutput: 32_000 });
  s.adapter().scripts.push(thinkingOnly);
  const { result } = await s.run('作って');
  assert.equal(result.ok && result.truncated, true);
  assert.equal(s.adapter().calls.length, 1);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_thinking_only').length, 1);
  assert.equal(s.app.conversations.messages('c1').some(m => m.message.role === 'assistant' || isContinue(m.message)), false);
});

test('F1: 書いた上限（maxOutputTokens）は超えない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(thinkingOnly);
  const { result } = await s.run('作って');
  assert.equal(result.ok && result.truncated, true);
  assert.deepEqual(s.adapter().calls.map(c => c.maxOutputTokens), [1024]);
});

test('F1: 提供元の上限が分からなければ 2 倍（長さの半分まで）に 1 回上げ、それでも考えるだけなら止まる（繰り返さない）', async t => {
  const s = await setup(t, big(200_000));
  s.adapter().scripts.push(thinkingOnly, thinkingOnly, thinkingOnly);
  const { result } = await s.run('作って');
  assert.equal(result.ok && result.truncated, true);
  assert.deepEqual(s.adapter().calls.map(c => c.maxOutputTokens), [32_000, 64_000]);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_thinking_only').length, 1);
});

test('F1: 提供元の上限が分からず長さがとても大きくても、上げるのは 1 回だけ（2 倍）で、考えるだけが続いても繰り返さない', async t => {
  const s = await setup(t, big(1_000_000));
  s.adapter().scripts.push(thinkingOnly, thinkingOnly, thinkingOnly, thinkingOnly);
  const { result } = await s.run('作って');
  assert.equal(result.ok && result.truncated, true);
  assert.deepEqual(s.adapter().calls.map(c => c.maxOutputTokens), [32_000, 64_000]);
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_thinking_only').length, 1);
});

test('F1: 上げた上限は、同じ実行の次の組み立ての「使える量」にも効く（古い発言を外す境目が下がる）', async t => {
  const s = await setup(t, big(40_000));
  const huge = 'abcdefg '.repeat(8_000);
  s.adapter().scripts.push(reply('ok'));
  await s.run(huge);
  s.adapter().scripts.push(thinkingOnly, reply('おわり'));
  await s.run('続けて');
  const calls = s.adapter().calls;
  assert.deepEqual(calls.map(c => c.maxOutputTokens), [10_000, 10_000, 20_000]);
  assert.equal(calls[1]!.messages.some(m => m.content === huge), true, 'ふだんの上限なら古い発言は入る');
  assert.equal(calls[2]!.messages.some(m => m.content === huge), false, '上げた上限では古い発言を外す');
});

test('F1: 上げる上限は、いまのやり取りと合わせてコンテキストの 95% に入りきる量まで', async t => {
  const s = await setup(t, big(40_000));
  s.adapter().scripts.push(thinkingOnly, reply('おわり'));
  await s.run('abcdefg '.repeat(9_000));
  const calls = s.adapter().calls;
  assert.equal(calls.length, 2);
  const second = calls[1]!;
  assert.ok(second.maxOutputTokens > 10_000 && second.maxOutputTokens < 20_000, String(second.maxOutputTokens));
  const irreducible = irreducibleEstimate({ system: `${second.system.frozen}\n${second.system.dynamic}`, messages: second.messages, tools: second.tools }).tokens;
  assert.ok(irreducible + second.maxOutputTokens <= Math.floor(40_000 * 0.95), `${irreducible} + ${second.maxOutputTokens}`);
});

test('F1: 捨てた呼び出しの使用量も実行の使用量に入る（成功でも、そのあと失敗しても）', async t => {
  const s = await setup(t, big(200_000));
  s.adapter().scripts.push(thinkingOnly, reply('おわり', { outputTokens: 10 }));
  const ok = await s.run('作って');
  assert.equal(ok.result.ok && ok.result.usage.outputTokens, 64_010);
  assert.equal(s.app.runs.get(ok.runId)!.output_tokens, 64_010);
  s.adapter().scripts.push(thinkingOnly, fail(new Error('boom')));
  const failed = await s.run('もう一度');
  assert.equal(failed.result.ok, false);
  assert.equal(s.app.runs.get(failed.runId)!.output_tokens, 64_000);
});

test('F1: 続きを頼んだあとの返事が考えるだけで上限に達し、もう上げられなければ、続きの一言を重ねず、それまでの文で切れたとして終える', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(cutText('これは途中で'), thinkingOnly);
  const { result } = await s.run('書いて');
  assert.equal(result.ok && result.truncated, true);
  assert.equal(result.ok && result.text, 'これは途中で');
  assert.equal(s.adapter().calls.length, 2);
  assert.equal(s.app.conversations.messages('c1').filter(m => isContinue(m.message)).length, 1, '一言は最初の 1 回だけ');
  assert.equal(s.events.filter(e => e.type === 'warning' && e.code === 'output_continue_empty').length, 1);
});
