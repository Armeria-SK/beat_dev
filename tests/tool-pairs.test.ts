import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { ChatMessage } from '../src/engine/types.ts';
import { settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, type Script } from './helpers.ts';

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
