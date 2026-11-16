import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { RunBus } from '../src/engine/bus.ts';
import { LiveStreams } from '../src/web/sse.ts';
import { EMPTY, reduce } from '../web/src/ui/live-state.ts';
import type { Draft } from '../web/src/events.ts';

const R = { runId: 'r1', conversationId: 'c1' };

function started(): RunBus {
  const bus = new RunBus();
  bus.publish({ type: 'run.start', ...R, modelId: 'm' });
  return bus;
}

const call = (callId: string, name = 'shell_run', input = '{"command":"npm test"}') => ({ type: 'tool.call' as const, ...R, callId, name, input });
const result = (callId: string, name = 'shell_run') => ({ type: 'tool.result' as const, ...R, callId, name, ok: true, decision: 'allow' as const, preview: '' });

test('bus: tool.call のあと、サーバーの下書きが今の道具（名前・伏せたあとの入力・callId・始めた時刻）を覚える', () => {
  const bus = started();
  const before = Date.now();
  bus.publish(call('x'));
  const d = bus.drafts()[0]!;
  assert.equal(d.activeTool, 'shell_run');
  assert.equal(d.activeInput, '{"command":"npm test"}');
  assert.equal(d.toolCallId, 'x');
  assert.ok(typeof d.toolStartedAt === 'number' && d.toolStartedAt >= before);
});

test('bus: 同じ callId の tool.result で今の道具が消え、違う callId の tool.result では消えない', () => {
  const bus = started();
  bus.publish(call('x'));
  bus.publish(result('other'));
  assert.equal(bus.drafts()[0]!.activeTool, 'shell_run', 'a result for another call keeps the current tool');
  bus.publish(result('x'));
  const d = bus.drafts()[0]!;
  assert.deepEqual([d.activeTool, d.activeInput, d.toolCallId, d.toolStartedAt], [undefined, undefined, undefined, undefined]);
  assert.ok(!('activeTool' in JSON.parse(JSON.stringify(d))));
});

test('bus: model.switch で今の道具が消える（画面の live-state.ts は model.switch で道具を消さない。サーバーは消す。繋ぎ直しのあとは次の tool.call で戻る）', () => {
  const bus = started();
  bus.publish(call('x'));
  assert.equal(bus.drafts()[0]!.activeTool, 'shell_run');
  bus.publish({ type: 'model.switch', ...R, from: 'm', to: 'n', reason: 'fallback' });
  const d = bus.drafts()[0]!;
  assert.equal(d.activeTool, undefined);
  assert.equal(d.toolCallId, undefined);
  assert.equal(d.modelId, 'n');
});

test('bus（回帰の守り）: 文の流れ（text.delta・message.saved）は前と同じ。道具を覚えても文は変わらない', () => {
  const bus = started();
  bus.publish({ type: 'text.delta', ...R, text: 'he' });
  bus.publish(call('x'));
  bus.publish({ type: 'text.delta', ...R, text: 'llo' });
  assert.equal(bus.drafts()[0]!.text, 'hello');
  bus.publish({ type: 'message.saved', ...R, messageId: 1, role: 'assistant' });
  assert.equal(bus.drafts()[0]!.text, '');
  bus.publish({ type: 'run.end', ...R, ok: true });
  assert.deepEqual(bus.drafts(), []);
});

function hello(bus: RunBus): { drafts: Draft[] } {
  const chunks: string[] = [];
  const req = { headers: {}, socket: { setTimeout() {}, setKeepAlive() {} }, once() {} } as unknown as IncomingMessage;
  const res = { writeHead() {}, write(t: string) { chunks.push(t); }, once() {}, end() {}, writableEnded: false, destroyed: false, writableLength: 0 } as unknown as ServerResponse;
  const streams = new LiveStreams(bus);
  streams.open(req, res, new URL('http://x/api/events'));
  streams.close();
  const block = chunks.find(c => c.startsWith('event: hello'));
  assert.ok(block, 'hello is sent');
  return JSON.parse(block.split('\ndata: ')[1]!.trim()) as { drafts: Draft[] };
}

test('bus: 繋ぎ直し（SSE の hello）の drafts に今の道具が入り、画面の resync のあとも今の道具と始めた時刻が残る（画面の変更なし）', () => {
  const bus = started();
  bus.publish(call('x'));
  const startedAt = bus.drafts()[0]!.toolStartedAt;
  const { drafts } = hello(bus);
  assert.equal(drafts[0]!.activeTool, 'shell_run');
  assert.equal(drafts[0]!.activeInput, '{"command":"npm test"}');
  const state = reduce(EMPTY, { type: 'resync', drafts }).state;
  const d = state.drafts[0]!;
  assert.equal(d.activeTool, 'shell_run');
  assert.equal(d.toolCallId, 'x');
  assert.equal(d.toolStartedAt, startedAt);
  const after = reduce(state, { type: 'event', event: result('x'), hidden: false, now: 1 }).state.drafts[0]!;
  assert.equal(after.activeTool, undefined, 'the restored tool settles on its own tool.result');
  assert.equal(after.settled?.[0]?.name, 'shell_run');
});

test('bus: 判定役に聞いている印（tool.auto）と子の担当（agent.state）も覚え、hello → resync のあとも checking と子の担当の数・リンクが戻る。終われば消える', () => {
  const bus = started();
  bus.publish(call('a', 'agent_run', '{"task":"x"}'));
  bus.publish({ type: 'tool.auto', ...R, callId: 'a', name: 'agent_run', state: 'checking' });
  assert.equal(bus.drafts()[0]!.autoChecking, true);
  bus.publish({ type: 'tool.auto', ...R, callId: 'a', name: 'agent_run', state: 'allowed' });
  assert.equal(bus.drafts()[0]!.autoChecking, undefined);
  bus.publish({ type: 'tool.auto', ...R, callId: 'a', name: 'agent_run', state: 'checking' });
  bus.publish({ type: 'agent.state', ...R, callId: 'a', childRunId: 'cr', childConversationId: 'child', state: 'running', toolCalls: 3 });
  const { drafts } = hello(bus);
  const d = reduce(EMPTY, { type: 'resync', drafts }).state.drafts[0]!;
  assert.equal(d.autoChecking, true);
  assert.deepEqual(d.agent, { conversationId: 'child', toolCalls: 3 });
  bus.publish({ type: 'agent.state', ...R, callId: 'a', childRunId: 'cr', childConversationId: 'child', state: 'done', toolCalls: 4 });
  assert.equal(bus.drafts()[0]!.agent, undefined);
  bus.publish({ type: 'agent.state', ...R, callId: 'a', childRunId: 'cr', childConversationId: 'child', state: 'running', toolCalls: 4 });
  bus.publish(result('a', 'agent_run'));
  assert.deepEqual([bus.drafts()[0]!.agent, bus.drafts()[0]!.autoChecking], [undefined, undefined]);
});
