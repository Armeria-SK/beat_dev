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
import { OUTSIDE_PLAN_NOTE, PLAN_GIST_LABEL } from '../src/tasks/store.ts';
import { fakeModel, settled, startApp, uuid, planChat, planFile } from './app-setup.ts';
import { reply, tempDir, type Script, withLoad } from './helpers.ts';

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000ab';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const OWNER = { by: 'owner' as const, tainted: false, conversationId: null, runId: null };
const CONV = 'cccccccc-0000-4000-8000-0000000000c1';
const AI_TAINTED = { by: 'ai' as const, tainted: true, conversationId: CONV, runId: 'r1' };

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function storeFixture(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1_000;
  const now = () => clock++;
  const kv = new KV(db, now);
  db.prepare("INSERT INTO conversations (id, kind, created_at, last_message_at, project_id) VALUES (?, 'chat', 0, 0, ?)").run(CONV, PROJECT);
  mkdirSync(join(paths.projects, PROJECT, 'conversation-plans'), { recursive: true });
  const store = new PlanStore(kv, { projects: paths.projects, backups: paths.backups }, now);
  return { kv, store, file: join(paths.projects, PROJECT, 'conversation-plans', `${CONV}.md`) };
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
  const plan = async (id: string) => (await s.json(`/api/projects/${id}/plan?conversationId=${planChat(s.app, id)}`, 'GET')).body.plan as { hash: string; tainted: boolean; updated_by: string; content: string };
  const build = async (id: string) => {
    const acceptance = (await s.json(`/api/projects/${id}/acceptance`, 'GET')).body.acceptance.hash;
    const built = await s.json(`/api/projects/${id}/build`, 'POST', { planHash: (await plan(id)).hash, acceptanceHash: acceptance, conversationId: planChat(s.app, id) });
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
  f.store.write(PROJECT, CONV, 'plan by ai', AI_TAINTED);
  const saved = f.store.write(PROJECT, CONV, 'plan by ai!', OWNER, sha('plan by ai'));
  assert.deepEqual([saved.updated_by, saved.tainted, saved.changed], ['owner', true, true]);
  assert.deepEqual([f.store.view(PROJECT, CONV).updated_by, f.store.view(PROJECT, CONV).tainted], ['owner', true]);
  const meta = f.kv.getJson<PlanMeta>(`plan:${PROJECT}:${CONV}`)!;
  assert.deepEqual([meta.by, meta.tainted, meta.runId], ['owner', true, 'r1'], '印の元の実行を記録に残す');
  const again = f.store.write(PROJECT, CONV, 'plan by ai!!', OWNER, saved.hash);
  assert.equal(again.tainted, true, '持ち主が何度保存しても印は残る');
});

test('4-K 計画書の印（置き場）: beat の外で 1 文字直されても、前が tainted なら tainted と読む。そのあとの持ち主の保存でも残る', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, CONV, 'plan by ai', AI_TAINTED);
  writeFileSync(f.file, 'plan by ai.');
  const outside = f.store.view(PROJECT, CONV);
  assert.deepEqual([outside.updated_by, outside.tainted], ['outside', true]);
  const saved = f.store.write(PROJECT, CONV, 'plan by ai..', OWNER, outside.hash);
  assert.deepEqual([saved.updated_by, saved.tainted], ['owner', true]);
  writeFileSync(f.file, 'clean');
  f.store.write(PROJECT, CONV, 'clean owner', OWNER, sha('clean'));
  f.kv.setJson(`plan:${PROJECT}:${CONV}`, { ...f.kv.getJson<PlanMeta>(`plan:${PROJECT}:${CONV}`)!, tainted: false });
  writeFileSync(f.file, 'outside on clean');
  assert.equal(f.store.view(PROJECT, CONV).tainted, false, '前に印が無ければ外の書き換えに印は付かない');
});

test('4-K 計画書の印（置き場）: 印つきの plan.md を消してから持ち主が新しく書いても tainted のまま。消した版は外せない', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, CONV, 'plan by ai', AI_TAINTED);
  unlinkSync(f.file);
  assert.throws(() => f.store.review(PROJECT, CONV, sha('plan by ai')), (e: Error & { code?: string }) => e.code === 'changed');
  const saved = f.store.write(PROJECT, CONV, 'owner from scratch', OWNER, null);
  assert.deepEqual([saved.updated_by, saved.tainted], ['owner', true]);
  assert.deepEqual([f.store.view(PROJECT, CONV).updated_by, f.store.view(PROJECT, CONV).tainted], ['owner', true]);
  assert.equal(f.kv.getJson<PlanMeta>(`plan:${PROJECT}:${CONV}`)!.runId, 'r1');
});

test('4-K 印を外す（置き場）: baseHash が合えば tainted が消えて reviewedAt を記録。違えば changed で変わらない。外で直された版も持ち主の版として外せる', t => {
  const f = storeFixture(t);
  const first = f.store.write(PROJECT, CONV, 'plan by ai', AI_TAINTED);
  assert.throws(() => f.store.review(PROJECT, CONV, sha('other')), (e: Error & { code?: string }) => e.code === 'changed');
  assert.equal(f.store.view(PROJECT, CONV).tainted, true);
  const reviewed = f.store.review(PROJECT, CONV, first.hash);
  assert.deepEqual([reviewed.tainted, reviewed.updated_by, reviewed.hash], [false, 'ai', first.hash]);
  const meta = f.kv.getJson<PlanMeta>(`plan:${PROJECT}:${CONV}`)!;
  assert.equal(meta.tainted, false);
  assert.equal(typeof meta.reviewedAt, 'number');

  f.store.write(PROJECT, CONV, 'second by ai', AI_TAINTED);
  writeFileSync(f.file, 'second by ai, edited');
  const outside = f.store.review(PROJECT, CONV, sha('second by ai, edited'));
  assert.deepEqual([outside.tainted, outside.updated_by], [false, 'owner']);
});

test('4-K 確かめ（本物の App、AP-1a で反転: Build を押した計画は外を読んでいても持ち主の頼み、Q3）: 外を読んだ実行が書いた計画書を持ち主が 1 文字直して PUT → tainted のまま、Build のタスクの judgeRequest に要点と外を読んだ計画の注記が入る', async t => {
  const s = await setup(t);
  const product = await s.product('owner-edit');
  await s.taintedAiPlan(product.id, uuid(60), '# Plan by AI');
  const before = await s.plan(product.id);
  const put = await s.json(`/api/projects/${product.id}/plan`, 'PUT', { content: '# Plan by AI!', baseHash: before.hash, conversationId: planChat(s.app, product.id) });
  assert.equal(put.status, 200);
  assert.deepEqual([put.body.plan.updated_by, put.body.plan.tainted], ['owner', true]);
  assert.equal((await s.plan(product.id)).tainted, true);
  const taskId = await s.build(product.id);
  assert.equal(s.app.tasks.judgeRequest(taskId), `Build: owner-edit\n${OUTSIDE_PLAN_NOTE}\n${PLAN_GIST_LABEL}\n# Plan by AI!`);
  assert.equal(s.app.tasks.textTainted(taskId), true, 'タスクの実行は外を読んだ扱い');
});

test('4-K 確かめ（本物の App）: 同じ計画書をファイルとして外で 1 文字直す → GET でも tainted', async t => {
  const s = await setup(t);
  const product = await s.product('outside-edit');
  await s.taintedAiPlan(product.id, uuid(61), '# Plan by AI');
  writeFileSync(planFile(s.app, product.id), '# Plan by AI.');
  const view = await s.plan(product.id);
  assert.deepEqual([view.content, view.updated_by, view.tainted], ['# Plan by AI.', 'outside', true]);
});

test('4-K 確かめ（本物の App）: reviewed を押す → tainted が消え plan.changed、Build の判定役の頼みが入る。baseHash が違えば 409 で印は残る', async t => {
  const s = await setup(t);
  const product = await s.product('reviewed');
  await s.taintedAiPlan(product.id, uuid(62), '# Plan by AI');
  const current = await s.plan(product.id);
  const stale = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: sha('nope'), conversationId: planChat(s.app, product.id) });
  assert.deepEqual([stale.status, stale.body.code], [409, 'plan.changed']);
  assert.equal((await s.plan(product.id)).tainted, true);
  for (const body of [{}, { baseHash: 3 }]) assert.equal((await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', body)).status, 400, JSON.stringify(body));
  assert.equal((await s.json(`/api/projects/${uuid(99)}/plan/reviewed`, 'POST', { baseHash: current.hash })).status, 404);

  const before = s.events.filter(e => e.type === 'plan.changed').length;
  const done = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash, conversationId: planChat(s.app, product.id) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(Object.keys(done.body.plan).sort(), ['built_hash', 'content', 'hash', 'reviewLocked', 'tainted', 'updated_at', 'updated_by', 'writing']);
  assert.equal(done.body.plan.tainted, false);
  assert.equal((await s.plan(product.id)).tainted, false);
  assert.deepEqual(s.events.filter(e => e.type === 'plan.changed').slice(before), [{ type: 'plan.changed', projectId: product.id, conversationId: planChat(s.app, product.id), hash: current.hash, by: 'owner' }]);
  const taskId = await s.build(product.id);
  assert.notEqual(s.app.tasks.judgeRequest(taskId), '');
  assert.ok(!s.app.tasks.judgeRequest(taskId).includes(OUTSIDE_PLAN_NOTE), '見たと押した計画には外を読んだ注記が付かない');
});

test('4-4 印を外す口: 計画モードの会話が計画書を書いているあいだは 409 plan.writing で印が残る（持ち主が見ていない文の印を外さない）', async t => {
  const s = await setup(t);
  const product = await s.product('writing');
  await s.taintedAiPlan(product.id, uuid(64), '# Plan by AI');
  const current = await s.plan(product.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let answer: { status: number; body: { code?: string } } | null = null;
  s.adapter().scripts = [async function* () {
    answer = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash, conversationId: planChat(s.app, product.id) });
    await gate;
    yield { type: 'text', delta: 'done' };
    yield { type: 'done', stop: 'end_turn' as StopReason };
  }];
  const sent = await s.json(`/api/conversations/${uuid(64)}/messages`, 'POST', { text: 'plan more', permissionMode: 'plan' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  while (!answer) await new Promise(r => setTimeout(r, 5));
  release();
  await settled(s.app, sent.body.runId);
  const got = answer as { status: number; body: { code?: string } };
  assert.deepEqual([got.status, got.body.code], [409, 'plan.writing']);
  assert.equal((await s.plan(product.id)).tainted, true);
  const after = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash, conversationId: planChat(s.app, product.id) });
  assert.equal(after.status, 200, '書き終われば外せる');
});

test('4-4 印を外す口: plan_write はどのモードの会話でも使えるので、Normal（auto）の会話が動いているあいだも reviewLocked で 409 plan.writing。writing（書いている最中・Edit と Build を止める）は計画モードだけで、Normal では立てない', async t => {
  const s = await setup(t);
  const product = await s.product('normal');
  await s.taintedAiPlan(product.id, uuid(66), '# Plan by AI');
  const current = await s.plan(product.id);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen: { writing: boolean; reviewLocked: boolean; status: number; code?: string } | null = null;
  s.adapter().scripts = [async function* () {
    const plan = await s.json(`/api/projects/${product.id}/plan?conversationId=${planChat(s.app, product.id)}`, 'GET');
    const got = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash, conversationId: planChat(s.app, product.id) });
    seen = { writing: plan.body.plan.writing, reviewLocked: plan.body.plan.reviewLocked, status: got.status, code: got.body.code };
    await gate;
    yield { type: 'text', delta: 'done' };
    yield { type: 'done', stop: 'end_turn' as StopReason };
  }];
  const sent = await s.json(`/api/conversations/${uuid(66)}/messages`, 'POST', { text: 'go on', permissionMode: 'auto' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  while (!seen) await new Promise(r => setTimeout(r, 5));
  release();
  await settled(s.app, sent.body.runId);
  assert.deepEqual(seen, { writing: false, reviewLocked: true, status: 409, code: 'plan.writing' });
  assert.equal((await s.plan(product.id)).tainted, true);
  assert.equal((await s.json(`/api/projects/${product.id}/plan?conversationId=${planChat(s.app, product.id)}`, 'GET')).body.plan.reviewLocked, false, '終われば reviewLocked は false');
});

test('4-K 印を外す口: しまった製品は 400 で印が残る', async t => {
  const s = await setup(t);
  const product = await s.product('archived');
  await s.taintedAiPlan(product.id, uuid(63), '# Plan by AI');
  const current = await s.plan(product.id);
  assert.equal((await s.json(`/api/projects/${product.id}`, 'PATCH', { archived: true })).status, 200);
  const refused = await s.json(`/api/projects/${product.id}/plan/reviewed`, 'POST', { baseHash: current.hash, conversationId: planChat(s.app, product.id) });
  assert.equal(refused.status, 400);
  assert.equal(s.app.plans.view(product.id, planChat(s.app, product.id)).tainted, true);
});
