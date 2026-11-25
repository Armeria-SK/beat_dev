import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import { pendingNote } from '../src/pending/notes.ts';
import type { ToolDef } from '../src/tools/types.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { tempDir } from './helpers.ts';

async function rig(t: Parameters<typeof startApp>[0]) {
  const ran: string[] = [];
  const hold: ToolDef<{ text: string }> = {
    name: 'fake_hold', description: 'Test tool.', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat'],
    summarize: input => ({ title: 'Hold', body: input.text }),
    async execute(input) { ran.push(input.text); return { content: 'ran', exitCode: 0 }; },
  };
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: [...builtinTools(), hold as unknown as ToolDef] });
  const product = async (name: string) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const park = (p: { id: string; root: string }, text: string) => s.app.pending.park({
    tool: 'fake_hold', input: { text }, cwd: p.root, kind: 'judge', reason: 'Judge unsure', runId: 'run-1', runKind: 'chat', conversationId: 'conv-1', projectId: p.id,
  });
  const row = (id: number) => s.app.pending.row(id)!;
  const waiting = async (query = '') => (await s.json(`/api/pending?status=waiting${query}`, 'GET')).body.items.map((item: { id: number }) => item.id) as number[];
  return { ...s, ran, product, park, row, waiting };
}

test('製品をしまうと、その製品の待ちの行が理由つきで cancelled になり、一覧と数から消える。ほかの製品の行は残る', async t => {
  const s = await rig(t);
  const a = await s.product('a');
  const b = await s.product('b');
  const [a1, a2, b1] = [await s.park(a, 'a1'), await s.park(a, 'a2'), await s.park(b, 'b1')];
  assert.deepEqual((await s.json('/api/pending/counts', 'GET')).body.byProject, { [a.id]: 2, [b.id]: 1 }, '前提: 3 つとも待っている');

  const archived = await s.json(`/api/projects/${a.id}`, 'PATCH', { archived: true });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  for (const item of [a1, a2]) {
    const after = s.row(item.id);
    assert.equal(after.status, 'cancelled', `#${item.id}`);
    assert.match(after.reject_reason ?? '', /product it came from was archived or removed/u);
    assert.equal(after.input, '', '取り消した行は生の入力を持たない');
    assert.notEqual(after.decided_at, null);
    assert.equal(pendingNote(after, s.app.pending.view(item.id)!), undefined, '製品をしまって閉じた行は、担当に知らせを送らない');
  }
  assert.equal(s.row(b1.id).status, 'waiting', 'ほかの製品の行は残る');
  assert.deepEqual(await s.waiting(), [b1.id], '待ちの一覧にはほかの製品の行だけ');
  assert.deepEqual(await s.waiting(`&project=${a.id}`), [], 'しまった製品の待ちは 0');
  const counts = (await s.json('/api/pending/counts', 'GET')).body;
  assert.equal(counts.waiting, 1);
  assert.deepEqual(counts.byProject, { [b.id]: 1 });
});

test('取り消した行は承認として数えない: 承認しても 409 で動かず、動いた記録（owner-pending）も残らない', async t => {
  const s = await rig(t);
  const a = await s.product('a');
  const row = await s.park(a, 'a1');
  await s.json(`/api/projects/${a.id}`, 'PATCH', { archived: true });
  assert.equal(s.row(row.id).status, 'cancelled');

  const approve = await s.json(`/api/pending/${row.id}/approve`, 'POST', {});
  assert.equal(approve.status, 409, JSON.stringify(approve.body));
  assert.equal(s.row(row.id).status, 'cancelled', '承認の頼みでは変わらない');
  assert.deepEqual(s.ran, [], '動いていない');
  const owner = s.app.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-pending'").get() as { n: number };
  assert.equal(Number(owner.n), 0);
  const decided = (await s.json('/api/pending?status=decided&earlier=0', 'GET')).body.items as Array<{ id: number; status: string }>;
  assert.deepEqual(decided.filter(item => item.id === row.id).map(item => item.status), ['cancelled'], '決めた行の一覧では cancelled（ran・rejected ではない）');
});

test('動いている最中の行は、しまっても触らない。しまっていない製品の行は変わらない。戻しても cancelled は戻らない', async t => {
  const s = await rig(t);
  const a = await s.product('a');
  const running = await s.park(a, 'running');
  const waiting = await s.park(a, 'waiting');
  s.app.pending.claim(running.id);
  await s.json(`/api/projects/${a.id}`, 'PATCH', { name: 'renamed' });
  assert.equal(s.row(waiting.id).status, 'waiting', '名前を変えただけでは閉じない');

  await s.json(`/api/projects/${a.id}`, 'PATCH', { archived: true });
  assert.equal(s.row(running.id).status, 'running', '承認されて動いている行は止めない');
  assert.equal(s.row(waiting.id).status, 'cancelled');

  await s.json(`/api/projects/${a.id}`, 'PATCH', { archived: false });
  assert.equal(s.row(waiting.id).status, 'cancelled', '製品を戻しても、閉じた行は待ちに戻らない');
});
