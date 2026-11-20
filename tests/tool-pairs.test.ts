import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { closeToolCalls } from '../src/engine/fit.ts';
import { estimateRequest } from '../src/engine/tokens.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, unpairedToolCall, type Script } from './helpers.ts';
import { fakeWeb } from './helpers/research-app.ts';

type ToolRow = Extract<ChatMessage, { role: 'tool' }>;
const NOT_RUN = 'The run stopped before this tool call, so it was not run';

// 実機の R の通し（B1）: 道具の呼び出しを保存したあと、道具を動かす前に止まると、結果の無い呼び出しが会話に残り、次の頼みが 400 で断られた

// 道具を 2 つ呼ぶ返事を出し切ってから、止められるまで待つ（止めは道具の輪の頭で効く）
export const callsThenWait = (onDone?: () => void): Script => async function* (req) {
  yield { type: 'tool_call', call: { id: 'call_a', name: 'web_search', arguments: { query: 'notes' } } };
  yield { type: 'tool_call', call: { id: 'call_b', name: 'web_search', arguments: { query: 'tags' } } };
  yield { type: 'done', stop: 'tool_use' };
  onDone?.();
  const signal = (req as { signal?: AbortSignal }).signal;
  await new Promise<void>(resolve => { if (!signal || signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
};

test('止める（B1）: 道具を動かす前に会話を止めても、呼び出しごとに結果の行が残り、次の送信が断られない', async t => {
  const s = await startApp(t, { tools: builtinTools() });
  s.adapter().strictToolPairs = true;
  s.adapter().scripts.push(callsThenWait(() => { for (const run of s.app.engine.activeRuns()) s.app.engine.stop(run.runId); }));
  const first = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'search please' });
  assert.equal(first.status, 202);
  const runId = first.body.runId as string;
  await settled(s.app, runId);
  assert.equal(s.app.runs.get(runId)!.error_kind, 'cancelled');
  const stored = s.app.conversations.messages(uuid(1)).map(m => m.message);
  const tools = stored.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
  assert.deepEqual(tools.map(m => [m.toolCallId, m.isError === true]), [['call_a', true], ['call_b', true]]);
  s.adapter().scripts.push(reply('fine'));
  const next = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'again' });
  await settled(s.app, next.body.runId);
  await waitFor(() => s.app.runs.get(next.body.runId)?.ended_at != null, 'second run ended');
  assert.equal(s.app.runs.get(next.body.runId)!.ok, 1, s.app.runs.get(next.body.runId)!.error_message ?? '');
});

test('組の直し（B1）: 前から履歴に残る結果の無い呼び出しと、組の無い結果の行があっても、送る前に組にして断られない。見積もりも送ったものを数える', async t => {
  const s = await startApp(t, { tools: builtinTools() });
  s.adapter().scripts.push(reply('ok'));
  const first = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'hello' });
  await settled(s.app, first.body.runId);
  // 前の不具合が書いた形（道具の途中で閉じたアプリも同じ形を残す）
  s.app.conversations.append(uuid(1), { role: 'assistant', content: '', toolCalls: [{ id: 'call_x', name: 'web_search', arguments: { query: 'notes' } }] });
  s.app.conversations.append(uuid(1), { role: 'user', content: 'still there?' });
  s.app.conversations.append(uuid(1), { role: 'tool', toolCallId: 'ghost', name: 'web_search', content: 'orphan' });
  s.adapter().strictToolPairs = true;
  s.adapter().scripts.push(reply('fine'));
  const next = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'again' });
  await settled(s.app, next.body.runId);
  await waitFor(() => s.app.runs.get(next.body.runId)?.ended_at != null, 'second run ended');
  const run = s.app.runs.get(next.body.runId)!;
  assert.equal(run.ok, 1, run.error_message ?? '');
  const sent = s.adapter().calls.at(-1)!;
  assert.equal(unpairedToolCall(sent.messages), undefined);
  const closed = sent.messages.filter((m): m is ToolRow => m.role === 'tool');
  assert.deepEqual(closed.map(m => [m.toolCallId, m.content, m.isError]), [['call_x', NOT_RUN, true]]);
  assert.equal(run.est_prompt_tokens, estimateRequest(`${sent.system.frozen}
${sent.system.dynamic}`, sent.messages, sent.tools).tokens, 'the estimate counts what was sent');
  // 保存した会話は書き換えない（送るときだけ組にする）
  assert.equal(s.app.conversations.messages(uuid(1)).some(m => m.message.role === 'tool' && m.message.toolCallId === 'ghost'), true);
});

test('組の直し: closeToolCalls は回の結果の行のあとに足し、組の無い行と重なる行を外し、組なら同じ配列を返す', () => {
  const call = (id: string) => ({ id, name: 'web_search', arguments: {} });
  const ok: ChatMessage[] = [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [call('a')] }, { role: 'tool', toolCallId: 'a', name: 'web_search', content: 'r' }];
  assert.equal(closeToolCalls(ok, 'n'), ok);
  const broken: ChatMessage[] = [
    { role: 'tool', toolCallId: 'z', name: 'web_search', content: 'orphan' },
    { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] },
    { role: 'tool', toolCallId: 'b', name: 'web_search', content: 'rb' },
    { role: 'tool', toolCallId: 'b', name: 'web_search', content: 'twice' },
    { role: 'user', content: 'next' },
  ];
  assert.deepEqual(closeToolCalls(broken, 'n'), [
    { role: 'assistant', content: '', toolCalls: [call('a'), call('b')] },
    { role: 'tool', toolCallId: 'b', name: 'web_search', content: 'rb' },
    { role: 'tool', toolCallId: 'a', name: 'web_search', content: 'n', isError: true },
    { role: 'user', content: 'next' },
  ]);
});

test('止める（B1）: 1 つ目の道具が動いているあいだに止めると、1 つ目は自分の結果、2 つ目は「動かしていない」の行になり、次の送信が断られない', async t => {
  const web = fakeWeb({ search: new Promise<void>(() => {}) });
  const s = await startApp(t, { tools: builtinTools(), webNetwork: web.network });
  s.adapter().strictToolPairs = true;
  s.adapter().scripts.push(async function* () {
    yield { type: 'tool_call', call: { id: 'call_a', name: 'web_search', arguments: { query: 'notes' } } };
    yield { type: 'tool_call', call: { id: 'call_b', name: 'web_search', arguments: { query: 'tags' } } };
    yield { type: 'done', stop: 'tool_use' };
  });
  const first = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'search please' });
  const runId = first.body.runId as string;
  await waitFor(() => web.asked.some(url => url.includes('duckduckgo')), 'the first search started');
  s.app.engine.stop(runId);
  await settled(s.app, runId);
  const tools = s.app.conversations.messages(uuid(1)).map(m => m.message).filter((m): m is ToolRow => m.role === 'tool');
  assert.equal(tools.length, 2, JSON.stringify(tools));
  assert.equal(tools[0]!.toolCallId, 'call_a');
  assert.notEqual(tools[0]!.content, NOT_RUN, 'call_a keeps its own (cancelled) output');
  assert.deepEqual([tools[1]!.toolCallId, tools[1]!.content, tools[1]!.isError], ['call_b', NOT_RUN, true]);
  assert.equal(web.asked.filter(url => url.includes('duckduckgo')).length, 1, 'call_b was not run');
  s.adapter().scripts.push(reply('fine'));
  const next = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'again' });
  await settled(s.app, next.body.runId);
  await waitFor(() => s.app.runs.get(next.body.runId)?.ended_at != null, 'second run ended');
  assert.equal(s.app.runs.get(next.body.runId)!.ok, 1, s.app.runs.get(next.body.runId)!.error_message ?? '');
});

test('止める（B1）: 道具の輪の途中で中の誤りが投げられても、残りの呼び出しを閉じてから誤りで終え、保存した会話が組のまま', async t => {
  const s = await startApp(t, { tools: builtinTools() });
  s.adapter().strictToolPairs = true;
  const store = s.app.conversations;
  const append = store.append.bind(store);
  let thrown = false;
  store.append = ((id, message, runId) => {
    if (!thrown && message.role === 'tool' && message.content !== NOT_RUN) { thrown = true; throw new Error('disk went away'); }
    return append(id, message, runId);
  }) as typeof store.append;
  s.adapter().scripts.push(async function* () {
    yield { type: 'tool_call', call: { id: 'call_a', name: 'tool_search', arguments: { query: 'files' } } };
    yield { type: 'tool_call', call: { id: 'call_b', name: 'tool_search', arguments: { query: 'web' } } };
    yield { type: 'done', stop: 'tool_use' };
  });
  const first = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'go' });
  await settled(s.app, first.body.runId);
  await waitFor(() => s.app.runs.get(first.body.runId)?.ended_at != null, 'first run ended');
  assert.equal(thrown, true);
  assert.equal(s.app.runs.get(first.body.runId)!.ok, 0);
  const tools = store.messages(uuid(1)).map(m => m.message).filter((m): m is ToolRow => m.role === 'tool');
  assert.deepEqual(tools.map(m => [m.toolCallId, m.content]), [['call_a', NOT_RUN], ['call_b', NOT_RUN]]);
  assert.equal(unpairedToolCall(store.messages(uuid(1)).map(m => m.message)), undefined);
});
