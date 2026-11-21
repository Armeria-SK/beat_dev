import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import type { ModelRequest } from '../src/providers/types.ts';
import { EndpointLimiter } from '../src/providers/limiter.ts';
import { agentRun } from '../src/tools/builtin/agent.ts';
import { REASON_ORDER } from '../src/tools/hooks/decision-order.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import type { Script } from './helpers.ts';

const JUDGE_SYSTEM = /^You are a safety checker/u;
const isJudge = (req: ModelRequest): boolean => JUDGE_SYSTEM.test(req.system.frozen);
const lastUser = (req: ModelRequest): string => {
  const user = [...req.messages].reverse().find(m => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
};
const hasToolResult = (req: ModelRequest): boolean => req.messages.some(m => m.role === 'tool');

const ran: string[] = [];
const outsideRead: ToolDef<Record<string, never>> = {
  name: 'outside_read', description: 'reads outside (test)', input: Type.Object({}), effect: 'read', allowedIn: ['chat', 'task', 'agent'],
  preCheck: () => ({ decision: 'ask', reasons: ['reads outside the allowed folders'], askKinds: ['outside_read'] }),
  execute: async () => { ran.push('outside_read'); return { content: 'read it' }; },
};

const toolCall = (name: string, args: unknown): AsyncGenerator<any> => (async function* () {
  const call: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call };
  yield { type: 'done', stop: 'tool_use' as StopReason };
})();
const say = (text: string): AsyncGenerator<any> => (async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; })();

function router(handle: (req: ModelRequest) => AsyncGenerator<any>): Script[] {
  const one: Script = req => handle(req);
  return Array.from({ length: 50 }, () => one);
}

test('4-3a 判定役の順番待ち: 先頭に入る印のある待ちは、ふつうの待ちより先に枠を取る（印どうしは来た順）', async () => {
  const limiter = new EndpointLimiter();
  const order: string[] = [];
  const hold = await limiter.acquire('p', () => 1);
  const wait = (name: string, front: boolean) => limiter.acquire('p', () => 1, undefined, front).then(release => { order.push(name); release(); });
  const all = [wait('reply-1', false), wait('reply-2', false), wait('judge-1', true), wait('judge-2', true)];
  await new Promise(r => setTimeout(r, 10));
  hold();
  await Promise.all(all);
  assert.deepEqual(order, ['judge-1', 'judge-2', 'reply-1', 'reply-2']);
});

test('4-3a 判定役の順番待ち: 先頭の待ちを取り消すと、あとの待ちの順は崩れない', async () => {
  const limiter = new EndpointLimiter();
  const order: string[] = [];
  const hold = await limiter.acquire('p', () => 1);
  const cancel = new AbortController();
  const dropped = limiter.acquire('p', () => 1, cancel.signal, true).catch(() => 'cancelled');
  const later = [
    limiter.acquire('p', () => 1).then(release => { order.push('reply'); release(); }),
    limiter.acquire('p', () => 1, undefined, true).then(release => { order.push('judge'); release(); }),
  ];
  cancel.abort();
  assert.equal(await dropped, 'cancelled');
  hold();
  await Promise.all(later);
  assert.deepEqual(order, ['judge', 'reply']);
});

test('4-3a 判定役の順番待ち（実行）: 別の会話が返事を流しているあいだの判定役は、先に並んだ返事より先に枠を取り、答えの時間は枠を取ってから数える', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1')], tools: [outsideRead], judgeLimits: { chat: { answerMs: 300, slotWaitMs: 5_000 }, unattended: { answerMs: 300 } } });
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const [a, b, c] = [uuid(11), uuid(12), uuid(13)];
  for (const id of [a, b, c]) s.app.conversations.create({ id, title: id });
  const send = (id: string, text: string) => s.json(`/api/conversations/${id}/messages`, 'POST', { text });
  s.adapter().scripts = router(req => {
    if (isJudge(req)) { order.push('judge'); return say('{"decision":"allow","reason":"fits"}'); }
    const text = lastUser(req);
    if (text === 'hold the line') {
      order.push('A');
      return (async function* () { await gate; yield { type: 'text', delta: 'held' }; yield { type: 'done', stop: 'end_turn' as StopReason }; })();
    }
    if (text === 'third conversation') { order.push('C'); return say('done C'); }
    if (hasToolResult(req)) { order.push('B2'); return say('done B'); }
    order.push('B');
    return (async function* () {
      await send(a, 'hold the line');
      await send(c, 'third conversation');
      yield* toolCall('outside_read', {});
    })();
  });
  const sent = await send(b, 'please read the outside file');
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await waitFor(() => order.includes('A'), 'A holds the slot', 10_000);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(order.includes('judge'), false, '枠を持つ A が終わるまで判定役は始まらない');
  release();
  await settled(s.app, sent.body.runId);
  assert.deepEqual(order.slice(0, 4), ['B', 'A', 'judge', 'C'], order.join(','));
  assert.deepEqual(ran, ['outside_read'], '700 ms 待っても、答えの 300 ms は枠を取ってから数えるので時間切れにならない');
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
});

test('4-3a 判定役の順番待ち（実行）: 会話では枠を待つ上限を超えると judge_failed で Pending に積まれる', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1')], tools: [outsideRead], judgeLimits: { chat: { answerMs: 300, slotWaitMs: 200 }, unattended: { answerMs: 300 } } });
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const [a, b] = [uuid(21), uuid(22)];
  for (const id of [a, b]) s.app.conversations.create({ id, title: id });
  const send = (id: string, text: string) => s.json(`/api/conversations/${id}/messages`, 'POST', { text });
  let judged = 0;
  s.adapter().scripts = router(req => {
    if (isJudge(req)) { judged++; return say('{"decision":"allow","reason":"fits"}'); }
    const text = lastUser(req);
    if (text === 'hold the line') return (async function* () { await gate; yield { type: 'text', delta: 'held' }; yield { type: 'done', stop: 'end_turn' as StopReason }; })();
    if (hasToolResult(req)) return say('done B');
    return (async function* () { await send(a, 'hold the line'); yield* toolCall('outside_read', {}); })();
  });
  const sent = await send(b, 'please read the outside file');
  await waitFor(() => s.app.pending.list({ status: 'waiting' }).length > 0, 'parked', 10_000);
  release();
  await settled(s.app, sent.body.runId);
  assert.equal(judged, 0);
  assert.deepEqual(ran, []);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'judge_failed');
  assert.match(rows[0]!.reason, /could not start in time/u);
});

test('4-3a 判定役の時間（実行）: 枠を取ってから答えの上限を過ぎても答えなければ、judge_failed（時間切れ）で積まれる', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1')], tools: [outsideRead], judgeLimits: { chat: { answerMs: 200, slotWaitMs: 5_000 }, unattended: { answerMs: 200 } } });
  const id = uuid(51);
  s.app.conversations.create({ id, title: 'slow judge' });
  s.adapter().scripts = router(req => {
    if (isJudge(req)) return (async function* () { await new Promise<void>(resolve => req.signal?.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'done', stop: 'end_turn' as StopReason }; })();
    return hasToolResult(req) ? say('done') : toolCall('outside_read', {});
  });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'please read the outside file' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(ran, []);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.equal(rows[0]?.kind, 'judge_failed');
  assert.match(rows[0]!.reason, /did not answer in time/u);
});

test('4-3a routing.judge: 最初の判定役が時間内に答えなければ、次の判定役に聞く', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2'), fakeModel('m3')], tools: [outsideRead], judgeLimits: { chat: { answerMs: 200, slotWaitMs: 5_000 }, unattended: { answerMs: 200 } }, configure: c => { c.routing.judge = ['m2', 'm3']; } });
  const id = uuid(52);
  s.app.conversations.create({ id, title: 'next judge' });
  const judges: string[] = [];
  s.adapter().scripts = router(req => {
    if (isJudge(req)) {
      judges.push(req.model.id);
      if (req.model.id === 'm2') return (async function* () { await new Promise<void>(resolve => req.signal?.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'done', stop: 'end_turn' as StopReason }; })();
      return say('{"decision":"allow","reason":"fits"}');
    }
    return hasToolResult(req) ? say('done') : toolCall('outside_read', {});
  });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'please read the outside file' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(judges, ['m2', 'm3']);
  assert.deepEqual(ran, ['outside_read']);
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
});

test('深い審査 4b routing.judge: 最初の判定役のモデルが判定を断ったら、聞き直さず次の判定役にも回さず、judge_failed（judge_refused）', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2'), fakeModel('m3')], tools: [outsideRead], configure: c => { c.routing.judge = ['m2', 'm3']; } });
  const id = uuid(53);
  s.app.conversations.create({ id, title: 'refusing judge' });
  const judges: string[] = [];
  s.adapter().scripts = router(req => {
    if (isJudge(req)) {
      judges.push(req.model.id);
      if (req.model.id === 'm2') return (async function* () { yield { type: 'done', stop: 'end_turn' as StopReason, refused: true }; })();
      return say('{"decision":"allow","reason":"fits"}');
    }
    return hasToolResult(req) ? say('done') : toolCall('outside_read', {});
  });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'please read the outside file' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(judges, ['m2'], 'one call, the second judge is not asked');
  assert.deepEqual(ran, []);
  const rows = s.app.pending.list({ status: 'waiting' });
  assert.equal(rows[0]?.kind, 'judge_failed');
  assert.match(rows[0]!.reason, /refused to judge/u);
});

test('4-3a routing.judge: 別のモデルを入れるとそのモデルが判定役になり、空なら実行のモデル', async t => {
  for (const judge of [['m2'], []]) {
    ran.length = 0;
    const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2')], tools: [outsideRead], configure: c => { c.routing.judge = judge; } });
    const id = uuid(31);
    s.app.conversations.create({ id, title: 'judge route' });
    const judges: string[] = [];
    s.adapter().scripts = router(req => {
      if (isJudge(req)) { judges.push(req.model.id); return say('{"decision":"allow","reason":"fits"}'); }
      return hasToolResult(req) ? say('done') : toolCall('outside_read', {});
    });
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'please read the outside file' });
    await settled(s.app, sent.body.runId);
    assert.deepEqual(judges, [judge[0] ?? 'm1'], `routing.judge = ${JSON.stringify(judge)}`);
    assert.deepEqual(ran, ['outside_read']);
  }
});

test('4-1 routing.judge: この PC のモデルを選んだ会話でも、ほかの提供元のモデルが判定役になれる', async t => {
  ran.length = 0;
  const s = await startApp(t, {
    models: [fakeModel('m1'), fakeModel('ext1', { provider: 'ext' })], tools: [outsideRead],
    configure: c => {
      c.providers.push({ id: 'ext', kind: 'openai_compatible', baseUrl: 'https://models.example.test/v1', maxParallel: 1, timeoutMs: 10_000 });
      c.routing = { chat: ['m1'], background: [], judge: ['ext1'], retriesPerModel: 0 };
    },
  });
  const id = uuid(61);
  s.app.conversations.create({ id, title: 'outside judge' });
  s.app.conversations.setChoice(id, { modelId: 'm1' });
  const judges: string[] = [];
  s.adapters.get('ext')!.scripts = router(req => { judges.push(`${isJudge(req) ? 'judge' : 'run'}:${req.model.id}`); return say('{"decision":"allow","reason":"fits"}'); });
  s.adapter().scripts = router(req => hasToolResult(req) ? say('done') : toolCall('outside_read', {}));
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'please read the outside file' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(judges, ['judge:ext1']);
  assert.deepEqual(ran, ['outside_read']);
  assert.equal(s.app.pending.list({ status: 'waiting' }).length, 0);
});

test('4-3a: 子の担当の確かめで判定役が見る頼みは、親の会話の持ち主の言葉（子への依頼の文ではない）', async t => {
  ran.length = 0;
  const s = await startApp(t, { models: [fakeModel('m1')], tools: [outsideRead, agentRun as unknown as ToolDef], configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const id = uuid(41);
  s.app.conversations.create({ id, title: 'parent' });
  const prompts: string[] = [];
  let step = 0;
  s.adapter().scripts = router(req => {
    if (isJudge(req)) { prompts.push(lastUser(req)); return say('{"decision":"allow","reason":"fits"}'); }
    step++;
    if (step === 1) return toolCall('agent_run', { task: 'AI WRITTEN CHILD TASK', title: 'child' });
    if (step === 2) return toolCall('outside_read', {});
    return say('done');
  });
  const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', { text: 'OWNER PARENT REQUEST' });
  await settled(s.app, sent.body.runId);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /OWNER PARENT REQUEST/u);
  assert.doesNotMatch(prompts[0]!, /AI WRITTEN CHILD TASK/u);
  assert.deepEqual(ran, ['outside_read']);
});

test('4-3a 理由のキーと順の表: 見張りが出しうるキー（文の表のキーと、id で付ける細かいキー）はすべて表にある', () => {
  const root = join(import.meta.dirname, '..');
  const messages = readFileSync(join(root, 'src/shared/messages/guard.ts'), 'utf8');
  const fromMessages = [...messages.matchAll(/^ {2}'((?:ask|code|file|guard|list|scope|shape|lex|hard|web)\.[a-z_0-9]+)'/gmu)].map(m => m[1]!);
  const sources = ['src/tools/hooks/allowlist-core.ts', 'src/tools/hooks/allowlist-git.ts', 'src/tools/hooks/allowlist-tools.ts', 'src/tools/hooks/allowlist-ps.ts', 'src/tools/hooks/allowlist-pipe.ts', 'src/tools/hooks/shell-guard.ts', 'src/tools/hooks/code-guard.ts']
    .flatMap(file => { try { return [readFileSync(join(root, file), 'utf8')]; } catch { return []; } }).join('\n');
  const fromIds = [...sources.matchAll(/'((?:list|code|guard|file|scope)\.[a-z_]+)'/gu)].map(m => m[1]!);
  const missing = [...new Set([...fromMessages, ...fromIds])].filter(key => !REASON_ORDER.has(key));
  assert.deepEqual(missing, []);
  assert.equal(REASON_ORDER.get('list.form'), 5, '意味の広いキーは順 5');
  assert.equal(REASON_ORDER.get('list.git_moves'), 5);
  assert.equal(REASON_ORDER.get('list.npm_rc'), 5);
  assert.equal(REASON_ORDER.get('code.loopback'), 5);
  assert.equal(REASON_ORDER.get('code.git_config'), 3);
  assert.equal(REASON_ORDER.get('guard.write_instructions'), 3);
  assert.equal(REASON_ORDER.get('list.npm_script'), 4);
  assert.equal(REASON_ORDER.get('web.secret_text'), 1, '鍵らしい文字を外へ出すのはシェルと同じく断る');
  assert.equal(REASON_ORDER.get('web.long_query'), 1);
});
