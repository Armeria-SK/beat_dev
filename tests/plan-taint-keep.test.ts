import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { PlanStore, type PlanMeta } from '../src/projects/plan.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, type Script } from './helpers.ts';

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000ab';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const OWNER = { by: 'owner' as const, tainted: false, conversationId: null, runId: null };
const AI_TAINTED = { by: 'ai' as const, tainted: true, conversationId: 'c1', runId: 'r1' };

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function storeFixture(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1_000;
  const now = () => clock++;
  const kv = new KV(db, now);
  const store = new PlanStore(kv, { projects: paths.projects, backups: paths.backups }, now);
  return { kv, store, file: join(paths.projects, PROJECT, 'plan.md') };
}

async function setup(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const product = async (name: string) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { ...(made.body.project as { id: string }), dir };
  };
  const plan = async (id: string) => (await s.json(`/api/projects/${id}/plan`, 'GET')).body.plan as { hash: string; tainted: boolean; updated_by: string; content: string };
  const build = async (id: string) => {
    const acceptance = (await s.json(`/api/projects/${id}/acceptance`, 'GET')).body.acceptance.hash;
    const built = await s.json(`/api/projects/${id}/build`, 'POST', { planHash: (await plan(id)).hash, acceptanceHash: acceptance });
    assert.equal(built.status, 201, JSON.stringify(built.body));
    return built.body.task.id as string;
  };
  const taintedAiPlan = async (id: string, conversation: string, content: string) => {
    s.adapter().scripts = [reply('hi'), call('plan_write', { content }), reply('ok')];
    const first = await s.json(`/api/conversations/${conversation}/messages`, 'POST', { text: 'hi', projectId: id });
    await settled(s.app, first.body.runId);
    s.app.conversations.markTainted(conversation);
    const second = await s.json(`/api/conversations/${conversation}/messages`, 'POST', { text: 'write the plan' });
    await settled(s.app, second.body.runId);
    assert.equal((await plan(id)).tainted, true, '前提: 外を読んだ実行が書いた計画書には印がある');
  };
  return { ...s, events, product, plan, build, taintedAiPlan };
}

test('4-K 計画書の印（置き場）: 外を読んだ AI の版を持ち主が 1 文字直して保存しても tainted のまま。書き手は owner', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, 'plan by ai', AI_TAINTED);
  const saved = f.store.write(PROJECT, 'plan by ai!', OWNER, sha('plan by ai'));
  assert.deepEqual([saved.updated_by, saved.tainted, saved.changed], ['owner', true, true]);
  assert.deepEqual([f.store.view(PROJECT).updated_by, f.store.view(PROJECT).tainted], ['owner', true]);
  const meta = f.kv.getJson<PlanMeta>(`plan:${PROJECT}`)!;
  assert.deepEqual([meta.by, meta.tainted, meta.runId], ['owner', true, 'r1'], '印の元の実行を記録に残す');
  const again = f.store.write(PROJECT, 'plan by ai!!', OWNER, saved.hash);
  assert.equal(again.tainted, true, '持ち主が何度保存しても印は残る');
});

test('4-K 計画書の印（置き場）: beat の外で 1 文字直されても、前が tainted なら tainted と読む。そのあとの持ち主の保存でも残る', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, 'plan by ai', AI_TAINTED);
  writeFileSync(f.file, 'plan by ai.');
  const outside = f.store.view(PROJECT);
  assert.deepEqual([outside.updated_by, outside.tainted], ['outside', true]);
  const saved = f.store.write(PROJECT, 'plan by ai..', OWNER, outside.hash);
  assert.deepEqual([saved.updated_by, saved.tainted], ['owner', true]);
  writeFileSync(f.file, 'clean');
  f.store.write(PROJECT, 'clean owner', OWNER, sha('clean'));
  f.kv.setJson(`plan:${PROJECT}`, { ...f.kv.getJson<PlanMeta>(`plan:${PROJECT}`)!, tainted: false });
  writeFileSync(f.file, 'outside on clean');
  assert.equal(f.store.view(PROJECT).tainted, false, '前に印が無ければ外の書き換えに印は付かない');
});

test('4-K 計画書の印（置き場）: 印つきの plan.md を消してから持ち主が新しく書いても tainted のまま。消した版は外せない', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, 'plan by ai', AI_TAINTED);
  unlinkSync(f.file);
  assert.throws(() => f.store.review(PROJECT, sha('plan by ai')), (e: Error & { code?: string }) => e.code === 'changed');
  const saved = f.store.write(PROJECT, 'owner from scratch', OWNER, null);
  assert.deepEqual([saved.updated_by, saved.tainted], ['owner', true]);
  assert.deepEqual([f.store.view(PROJECT).updated_by, f.store.view(PROJECT).tainted], ['owner', true]);
  assert.equal(f.kv.getJson<PlanMeta>(`plan:${PROJECT}`)!.runId, 'r1');
});

test('4-K 印を外す（置き場）: baseHash が合えば tainted が消えて reviewedAt を記録。違えば changed で変わらない。外で直された版も持ち主の版として外せる', t => {
  const f = storeFixture(t);
  const first = f.store.write(PROJECT, 'plan by ai', AI_TAINTED);
  assert.throws(() => f.store.review(PROJECT, sha('other')), (e: Error & { code?: string }) => e.code === 'changed');
  assert.equal(f.store.view(PROJECT).tainted, true);
  const reviewed = f.store.review(PROJECT, first.hash);
  assert.deepEqual([reviewed.tainted, reviewed.updated_by, reviewed.hash], [false, 'ai', first.hash]);
  const meta = f.kv.getJson<PlanMeta>(`plan:${PROJECT}`)!;
  assert.equal(meta.tainted, false);
  assert.equal(typeof meta.reviewedAt, 'number');

  f.store.write(PROJECT, 'second by ai', AI_TAINTED);
  writeFileSync(f.file, 'second by ai, edited');
  const outside = f.store.review(PROJECT, sha('second by ai, edited'));
  assert.deepEqual([outside.tainted, outside.updated_by], [false, 'owner']);
});

test('4-K 確かめ（本物の App）: 外を読んだ実行が書いた計画書を持ち主が 1 文字直して PUT → tainted のまま、Build のタスクの judgeRequest が空', async t => {
  const s = await setup(t);
  const product = await s.product('owner-edit');
  await s.taintedAiPlan(product.id, uuid(60), '# Plan by AI');
  const before = await s.plan(product.id);
  const put = await s.json(`/api/projects/${product.id}/plan`, 'PUT', { content: '# Plan by AI!', baseHash: before.hash });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.plan.updated_by, put.body.plan.tainted], ['owner', true]);
  assert.equal((await s.plan(product.id)).tainted, true);
  const taskId = await s.build(product.id);
  assert.equal(s.app.tasks.judgeRequest(taskId), '');
});

test('4-K 確かめ（本物の App）: 同じ計画書をファイルとして外で 1 文字直す → GET でも tainted', async t => {
  const s = await setup(t);
  const product = await s.product('outside-edit');
  await s.taintedAiPlan(product.id, uuid(61), '# Plan by AI');
  writeFileSync(join(s.paths.projects, product.id, 'plan.md'), '# Plan by AI.');
  const view = await s.plan(product.id);
  assert.deepEqual([view.content, view.updated_by, view.tainted], ['# Plan by AI.', 'outside', true]);
});

test('4-K 確かめ（本物の App）: reviewed を押す → tainted が消え plan.changed、Build の判定役の頼みが入る。baseHash が違えば 409 で印は残る', async t => {
  const s = await setup(t);
  const product = await s.product('reviewed');
  await s.taintedAiPlan(product.id, uuid(62), '# Plan by AI');
  const current = await s.plan(product.id);
  const stale = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: sha('nope') });
  assert.deepEqual([stale.status, stale.body.code], [409, 'plan.changed']);
  assert.equal((await s.plan(product.id)).tainted, true);
  for (const body of [{}, { baseHash: 3 }]) assert.equal((await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await s.json(`/api/projects/${uuid(99)}/plan/reviewed`, 'POST', { baseHash: current.hash })).status, 404);

  const before = s.events.filter(e => e.type === 'plan.changed').length;
  const done = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(Object.keys(done.body.plan).sort(), ['content', 'hash', 'tainted', 'updated_at', 'updated_by', 'writing']);
  assert.equal(done.body.plan.tainted, false);
  assert.equal((await s.plan(product.id)).tainted, false);
  assert.deepEqual(s.events.filter(e => e.type === 'plan.changed').slice(before), [{ type: 'plan.changed', projectId: product.id, hash: current.hash, by: 'owner' }]);
  const taskId = await s.build(product.id);
  assert.notEqual(s.app.tasks.judgeRequest(taskId), '');
});

test('4-K 印を外す口: しまった製品は 400 で印が残る', async t => {
  const s = await setup(t);
  const product = await s.product('archived');
  await s.taintedAiPlan(product.id, uuid(63), '# Plan by AI');
  const current = await s.plan(product.id);
  assert.equal((await s.json(`/api/projects/${product.id}`, 'PATCH', { archived: true })).status, 200);
  const refused = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash });
  assert.equal(refused.status, 400);
  assert.equal(s.app.plans.view(product.id).tainted, true);
});
