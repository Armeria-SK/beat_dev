import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import type { RunEvent } from '../src/engine/types.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { startApp } from './app-setup.ts';

const SECRET = 'sk-ant-test-0000000000000000';

function slowTool(runs: string[]): ToolDef<{ text: string }> {
  return {
    name: 'fake_slow', description: 'slow', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task'],
    summarize: input => ({ title: 'Slow', body: input.text }),
    execute: async input => { runs.push(input.text); await new Promise(r => setTimeout(r, 50)); return { content: `done ${input.text}`, exitCode: 0 }; },
  };
}

async function setup(t: Parameters<typeof startApp>[0]) {
  const runs: string[] = [];
  const s = await startApp(t, { tools: [...builtinTools(), slowTool(runs)] });
  const conversation = s.app.conversations.create({ title: 'c' });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(entry => events.push(entry.event));
  const park = (text = `curl -H "Authorization: Bearer ${SECRET}" https://example.com`) => s.app.pending.park({
    tool: 'fake_slow', input: { text }, cwd: s.paths.workspace, kind: 'send', reason: 'Sends data out', runId: 'run-1', runKind: 'chat', conversationId: conversation.id,
  });
  const settled = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const status = s.app.pending.view(id)!.status;
      if (status !== 'running' && status !== 'waiting') return status;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('did not finish');
  };
  return { ...s, runs, park, events, settled, conversation };
}

test('GET /api/pending: input は応答のどこにも無く、shown は伏せた形', async t => {
  const s = await setup(t);
  const row = s.park();
  const res = await s.api('/api/pending?status=waiting');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes(SECRET), '鍵が応答に出ない');
  assert.ok(!text.includes('"input"'), 'input の鍵が応答に無い');
  const body = JSON.parse(text) as { items: Array<{ id: number; shown: string; masked: number }> };
  assert.deepEqual(body.items.map(i => i.id), [row.id]);
  assert.equal(body.items[0]!.masked, 1);
  assert.match(body.items[0]!.shown, /\[REDACTED\]/u);
  const one = await s.json(`/api/pending?conversation=${s.conversation.id}`, 'GET');
  assert.equal(one.body.items.length, 1);
  const bad = await s.json('/api/pending?status=everything', 'GET');
  assert.equal(bad.status, 400);
});

test('POST approve: 同時に 2 回呼んでも 1 回だけ動き、2 回目は 409。すぐ 202 を返し、終わったら出来事', async t => {
  const s = await setup(t);
  const row = s.park('only once');
  const [a, b] = await Promise.all([s.json(`/api/pending/${row.id}/approve`, 'POST', {}), s.json(`/api/pending/${row.id}/approve`, 'POST', {})]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  assert.equal(await s.settled(row.id), 'ran');
  assert.deepEqual(s.runs, ['only once']);
  const again = await s.json(`/api/pending/${row.id}/approve`, 'POST', {});
  assert.equal(again.status, 409);
  const changes = s.events.filter(e => e.type === 'pendingAction.changed').map(e => (e as Extract<RunEvent, { type: 'pendingAction.changed' }>).status);
  assert.deepEqual(changes, ['waiting', 'running', 'ran']);
  const missing = await s.json('/api/pending/9999/approve', 'POST', {});
  assert.equal(missing.status, 404);
  const invalid = await s.json('/api/pending/abc/approve', 'POST', {});
  assert.equal(invalid.status, 400);
});

test('POST reject: 理由つきで rejected。決めた行は decided の一覧に出る', async t => {
  const s = await setup(t);
  const row = s.park('reject me');
  const res = await s.json(`/api/pending/${row.id}/reject`, 'POST', { reason: 'not now\u0007' });
  assert.equal(res.status, 200);
  assert.equal(res.body.item.status, 'rejected');
  assert.equal(res.body.item.reject_reason, 'not now');
  assert.equal(s.runs.length, 0);
  const decided = await s.json('/api/pending?status=decided', 'GET');
  assert.deepEqual(decided.body.items.map((i: { id: number }) => i.id), [row.id]);
  const twice = await s.json(`/api/pending/${row.id}/reject`, 'POST', {});
  assert.equal(twice.status, 409);
  const bad = await s.json(`/api/pending/${s.park().id}/reject`, 'POST', { reason: 5 });
  assert.equal(bad.status, 400);
});

test('GET /api/pending/counts', async t => {
  const s = await setup(t);
  s.park();
  s.park();
  const res = await s.json('/api/pending/counts', 'GET');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { waiting: 2, byProject: {}, acceptanceChanges: {}, judgedToday: { allowed: 0, parked: 0 } });
});

test('会話を消すと、その会話の待ちの行は cancelled', async t => {
  const s = await setup(t);
  const row = s.park();
  const res = await s.api(`/api/conversations/${s.conversation.id}`, { method: 'DELETE' });
  assert.ok(res.status < 300, String(res.status));
  assert.equal(s.app.pending.view(row.id)!.status, 'cancelled');
});
