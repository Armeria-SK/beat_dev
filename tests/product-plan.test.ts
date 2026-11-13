import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent, StopReason, ToolCall } from '../src/engine/types.ts';
import { buildDynamic } from '../src/engine/workspace.ts';
import { resolvePaths } from '../src/paths.ts';
import { PLAN_BACKUPS, PLAN_MAX_CHARS, PlanStore } from '../src/projects/plan.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { PendingStore } from '../src/pending/store.ts';
import { planWrite } from '../src/tools/builtin/plan.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { planAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script } from './helpers.ts';

type Options = NonNullable<Parameters<typeof startApp>[1]>;

const PROJECT = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

function storeFixture(t: { after: (fn: () => void) => void }, io?: ConstructorParameters<typeof PlanStore>[3]) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const db = openDatabase(':memory:', MIGRATIONS);
  let clock = 1_000;
  const now = () => clock++;
  const kv = new KV(db, now);
  const store = new PlanStore(kv, { projects: paths.projects, backups: paths.backups }, now, io);
  const backups = () => existsSync(join(paths.backups, 'mesh', PROJECT)) ? readdirSync(join(paths.backups, 'mesh', PROJECT)).sort() : [];
  const backupTexts = () => backups().map(name => readFileSync(join(paths.backups, 'mesh', PROJECT, name), 'utf8'));
  return { paths, db, kv, store, backups, backupTexts, file: join(paths.projects, PROJECT, 'plan.md') };
}

const AI = { by: 'ai' as const, tainted: false, conversationId: 'c1', runId: 'r1' };

test('3-1a 計画書の置き場: plan_write の中身が data/projects/<id>/plan.md に入り、ハッシュと書き手を覚える。無い間は空の形', t => {
  const f = storeFixture(t);
  assert.deepEqual(f.store.view(PROJECT), { content: null, hash: null, updated_at: null, updated_by: null, tainted: false });
  assert.equal(f.store.has(PROJECT), false);
  const view = f.store.write(PROJECT, '# Goal\nShip it\n', AI);
  assert.equal(readFileSync(f.file, 'utf8'), '# Goal\nShip it\n');
  assert.deepEqual(view, { content: '# Goal\nShip it\n', hash: sha('# Goal\nShip it\n'), updated_at: view.updated_at, updated_by: 'ai', tainted: false, changed: true });
  assert.equal(typeof view.updated_at, 'number');
  assert.equal(f.store.has(PROJECT), true);
  assert.deepEqual(f.kv.getJson(`plan:${PROJECT}`), { hash: sha('# Goal\nShip it\n'), updatedAt: view.updated_at, by: 'ai', tainted: false, conversationId: 'c1', runId: 'r1' });
  assert.deepEqual(readdirSync(join(f.paths.projects, PROJECT)), ['plan.md'], '一時ファイルが残らない');
  assert.deepEqual(f.backups(), [], '初めての書き込みには控えが無い');
});

test('3-1a 計画書の控え: 書き換える前の版を data/backups/mesh/<id>/ に置き、新しい順に 20 まで（21 個目で古いものが消える）', t => {
  const f = storeFixture(t);
  for (let i = 0; i <= PLAN_BACKUPS + 1; i++) f.store.write(PROJECT, `v${i}`, { ...AI, runId: `r${i}` });
  assert.equal(PLAN_BACKUPS, 20);
  assert.equal(f.backups().length, 20);
  assert.deepEqual(f.backupTexts(), Array.from({ length: 20 }, (_, i) => `v${i + 1}`), 'v0 が消え、v1〜v20 が残る');
  assert.equal(readFileSync(f.file, 'utf8'), 'v21');
});

test('3-1a 計画書の書き込み: 書く途中で落ちても前の中身のままで、一時ファイルが残らない', t => {
  let failing = false;
  const f = storeFixture(t, {
    writeFileSync: (path, data) => {
      if (failing) { writeFileSync(path, String(data).slice(0, 3)); throw new Error('disk full'); }
      writeFileSync(path, data);
    },
  });
  f.store.write(PROJECT, 'first version', AI);
  failing = true;
  assert.throws(() => f.store.write(PROJECT, 'second version', AI), /disk full/u);
  assert.equal(readFileSync(f.file, 'utf8'), 'first version');
  assert.deepEqual(readdirSync(join(f.paths.projects, PROJECT)), ['plan.md']);
  assert.equal(f.store.view(PROJECT).hash, sha('first version'));
});

test('3-1a 計画書の中身: 見えない文字は取り除き、鍵らしい文字と上限越えは断ってファイルを変えない', t => {
  const f = storeFixture(t);
  const view = f.store.write(PROJECT, 'Ste\u200Bp\u202E 1\uFEFF', AI);
  assert.equal(view.content, 'Step 1');
  assert.equal(readFileSync(f.file, 'utf8'), 'Step 1');
  assert.throws(() => f.store.write(PROJECT, 'use sk-abcdefghijklmnop as the key', AI), (e: Error & { code?: string }) => e.code === 'secret');
  assert.throws(() => f.store.write(PROJECT, 'x'.repeat(PLAN_MAX_CHARS + 1), AI), (e: Error & { code?: string }) => e.code === 'too_long');
  assert.equal(PLAN_MAX_CHARS, 64_000);
  assert.equal(readFileSync(f.file, 'utf8'), 'Step 1');
  f.store.write(PROJECT, 'x'.repeat(PLAN_MAX_CHARS), AI);
});

test('3-1a 計画書: beat の外（エクスプローラー）で直されたら updated_by は outside。baseHash が今と違えば断る', t => {
  const f = storeFixture(t);
  const first = f.store.write(PROJECT, 'one', { ...AI, tainted: true });
  assert.equal(first.tainted, true);
  writeFileSync(f.file, 'edited by hand');
  const outside = f.store.view(PROJECT);
  assert.equal(outside.updated_by, 'outside');
  assert.equal(outside.hash, sha('edited by hand'));
  assert.equal(outside.tainted, true, '4-K: 前が tainted なら外の書き換えも tainted');
  assert.throws(() => f.store.write(PROJECT, 'stale', { by: 'owner', tainted: false, conversationId: null, runId: null }, first.hash), (e: Error & { code?: string }) => e.code === 'changed');
  assert.equal(readFileSync(f.file, 'utf8'), 'edited by hand');
  const owner = f.store.write(PROJECT, 'fresh', { by: 'owner', tainted: false, conversationId: null, runId: null }, outside.hash);
  assert.equal(owner.updated_by, 'owner');
  assert.throws(() => f.store.write(PROJECT, 'x', { by: 'owner', tainted: false, conversationId: null, runId: null }, null), (e: Error & { code?: string }) => e.code === 'changed', 'null は「まだ無い」の意味');
});

test('3-1a 道具の印: planOk の道具は計画モードでも通り、projectOnly の道具は製品の外では断られる（パイプラインの二重の拒否）', async t => {
  assert.equal(planWrite.planOk, true);
  assert.equal(planWrite.projectOnly, true);
  assert.equal(planWrite.effect, 'meta');
  assert.deepEqual([...planWrite.allowedIn], ['chat']);
  assert.equal(planAllows(planWrite), true);
  assert.equal(planAllows(fileWrite), false);

  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const plans = new PlanStore(new KV(db), { projects: paths.projects, backups: paths.backups });
  const registry = new ToolRegistry().register(planWrite).register(fileWrite);
  const policy = buildPolicy(config, paths);
  const events: RunEvent[] = [];
  const base: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'plan',
    services: { db, memory: undefined as never, emit: e => events.push(e), plans },
  };
  const run = (name: string, args: unknown, ctx: ToolContext) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending: new PendingStore(db, { tools: registry, dataDir: paths.data }), db, emit: () => undefined, permissionMode: () => ctx.permissionMode ?? 'auto',
  });

  const outside = await run('plan_write', { content: 'x' }, base);
  assert.equal(outside.decision, 'deny');
  assert.equal(outside.decidedBy, 'registry');
  assert.match(outside.output.content, /belongs to a product/u);
  assert.equal(existsSync(join(paths.projects, PROJECT, 'plan.md')), false);

  const product = { ...base, project: { id: PROJECT } };
  const written = await run('plan_write', { content: '# Plan\n1. Do it' }, product);
  assert.equal(written.decision, 'allow', written.output.content);
  assert.equal(readFileSync(join(paths.projects, PROJECT, 'plan.md'), 'utf8'), '# Plan\n1. Do it');
  assert.deepEqual(events.filter(e => e.type === 'plan.changed'), [{ type: 'plan.changed', projectId: PROJECT, hash: sha('# Plan\n1. Do it'), by: 'ai' }]);
  const blocked = await run('file_write', { path: 'x.txt', content: 'x' }, product);
  assert.equal(blocked.decidedBy, 'mode', '計画モードで projectOnly でない書き込みの道具は今までどおり断る');

  const tainted = await run('plan_write', { content: 'after web' }, { ...product, runId: 'r2', taint: { tainted: true, sources: ['web'] } });
  assert.equal(tainted.decision, 'allow', 'よそから来た文を読んだ実行の plan_write は止めない');
  assert.equal(plans.view(PROJECT).tainted, true);
  assert.equal(new KV(db).getJson<{ runId: string }>(`plan:${PROJECT}`)?.runId, 'r2');

  const secret = await run('plan_write', { content: 'token sk-abcdefghijklmnop' }, product);
  assert.equal(secret.output.isError, true);
  assert.equal(readFileSync(join(paths.projects, PROJECT, 'plan.md'), 'utf8'), 'after web');
});

test('3-1a 守り: ふつうのファイルの道具とシェルからは plan.md を読めない・書けない（判定役が許すと答えても）', async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const dir = join(paths.projects, PROJECT);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'plan.md');
  writeFileSync(file, 'secret plan\n');
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const policy = buildPolicy(config, paths);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto', project: { id: PROJECT },
  };
  const run = (name: string, args: unknown) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending: new PendingStore(db, { tools: registry, dataDir: paths.data }), db, emit: () => undefined, permissionMode: () => 'auto', lastUserRequest: () => 'read the plan',
    conversationTainted: () => false, autoClassify: async () => '{"decision":"allow","reason":"ok"}',
  });
  for (const [name, args] of [['file_read', { path: file }], ['file_write', { path: file, content: 'x' }], ['file_edit', { path: file, old: 'secret', new: 'x' }], ['shell_run', { command: `cat "${file.replaceAll('\\', '/')}"` }]] as const) {
    const result = await run(name, args);
    assert.equal(result.decision, 'deny', name);
    assert.doesNotMatch(result.output.content, /secret plan/u, name);
  }
  assert.equal(readFileSync(file, 'utf8'), 'secret plan\n');
});

test('3-1a 毎回の system: 製品の計画モードの会話にだけ plan_write の指示が入る（3-2-s で要件の聞き取りの文に置き換わった）', () => {
  const at = new Date('2026-11-12T00:00:00Z');
  const product = { name: 'Shop', root: 'C:/shop' };
  const line = 'Write the plan with plan_write.';
  assert.match(buildDynamic('UTC', 'en', at, 'plan', product, line), /\nWrite the plan with plan_write\.$/u);
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'plan', undefined, line), /plan_write/u);
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'auto', product, line), /plan_write/u);
  assert.doesNotMatch(buildDynamic('UTC', 'en', at, 'plan', product), /plan_write/u, '子の担当（plan_write が無い）には入れない');
  assert.equal(buildDynamic('UTC', 'en', at, 'plan', undefined), buildDynamic('UTC', 'en', at, 'plan', undefined, line), '製品に属さない会話の計画モードは今のまま');
});

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(), ...options });
  const events: RunEvent[] = [];
  s.app.bus.subscribe(e => events.push(e.event));
  const folder = (name: string) => { const dir = join(products, name); mkdirSync(dir, { recursive: true }); return dir; };
  const product = async (name: string) => {
    const made = await s.json('/api/projects', 'POST', { root: folder(name) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string; name: string; root: string; has_plan: boolean };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    if (sent.status === 202) await settled(s.app, sent.body.runId);
    return sent;
  };
  const names = (index = -1) => s.adapter().calls.at(index)!.tools.map(tool => tool.name);
  return { ...s, products, events, folder, product, send, names };
}

test('3-1a 道具の一覧: 製品の会話には plan_write と mesh_read、製品に属さない会話（どのモードでも）には無い。製品のタスクには mesh_read だけ、振り返りにはどちらも無い。子の担当には mesh_read だけ', async t => {
  const s = await setup(t, { configure: c => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b'), reply('c'), reply('d')];
  await s.send(uuid(1), { text: 'plan it', projectId: shop.id, permissionMode: 'plan' });
  assert.ok(s.names().includes('plan_write') && s.names().includes('mesh_read'), s.names().join());
  await s.send(uuid(2), { text: 'do it', projectId: shop.id, permissionMode: 'auto' });
  assert.ok(s.names().includes('plan_write') && s.names().includes('mesh_read'));
  for (const [n, mode] of [[3, 'auto'], [4, 'plan']] as const) {
    await s.send(uuid(n), { text: 'hi', permissionMode: mode });
    assert.ok(!s.names().some(name => name.startsWith('plan_') || name.startsWith('mesh_')), mode);
  }

  s.adapter().scripts = [call('agent_run', { task: 'look' }), reply('child'), reply('parent')];
  await s.send(uuid(6), { text: 'delegate', projectId: shop.id, permissionMode: 'auto' });
  const child = s.adapter().calls.at(-2)!.tools.map(tool => tool.name);
  assert.ok(child.includes('mesh_read') && !child.includes('plan_write'), child.join());

  const made = await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(s.names().includes('mesh_read') && !s.names().includes('plan_write'), s.names().join());

  s.app.reviews.enqueue('manual', 'manual:shop', { conversationId: uuid(1) });
  s.adapter().scripts = [reply('No changes')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.ok(!s.names().some(name => name.startsWith('plan_') || name.startsWith('mesh_')), s.names().join());
});

test('3-1a 登録の順（maxTools: 12）: (a) 製品の計画モードに plan_write / mesh_read が残る (b) 製品のタスクとふつうの会話に task_complete・file_read・file_edit・shell_run が残る (c) 製品に属さない会話の一覧は今と同じ', async t => {
  const s = await setup(t, { models: [fakeModel('m1', { maxTools: 12 })] });
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b')];
  await s.send(uuid(1), { text: 'plan', projectId: shop.id, permissionMode: 'plan' });
  assert.ok(s.names().includes('plan_write') && s.names().includes('mesh_read'), s.names().join());
  await s.send(uuid(2), { text: 'work', projectId: shop.id, permissionMode: 'auto' });
  for (const name of ['file_read', 'file_edit', 'shell_run']) assert.ok(s.names().includes(name), `${name}: ${s.names().join()}`);
  await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  for (const name of ['task_complete', 'file_read', 'file_edit', 'shell_run']) assert.ok(s.names().includes(name), `${name}: ${s.names().join()}`);

  const plain = await setup(t, { models: [fakeModel('m1', { maxTools: 12 })], tools: builtinTools().filter(tool => !tool.projectOnly) });
  for (const [n, mode] of [[3, 'auto'], [4, 'plan']] as const) {
    s.adapter().scripts = [reply('x')];
    plain.adapter().scripts = [reply('x')];
    await s.send(uuid(n), { text: 'hi', permissionMode: mode });
    await plain.send(uuid(n), { text: 'hi', permissionMode: mode });
    assert.deepEqual(s.names(), plain.names(), mode);
  }
});

test('3-1a 毎回の system（本物の App）: 製品の計画モードの会話にだけ plan_write の 1 行。自動承認のモードと製品に属さない計画モードには無い', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('a'), reply('b'), reply('c')];
  await s.send(uuid(1), { text: 'plan', projectId: shop.id, permissionMode: 'plan' });
  assert.match(s.adapter().calls.at(-1)!.system.dynamic, /plan_write/u);
  await s.send(uuid(2), { text: 'work', projectId: shop.id, permissionMode: 'auto' });
  assert.doesNotMatch(s.adapter().calls.at(-1)!.system.dynamic, /plan_write/u);
  await s.send(uuid(3), { text: 'plan', permissionMode: 'plan' });
  assert.doesNotMatch(s.adapter().calls.at(-1)!.system.dynamic, /plan_write/u);
});

test('3-1a 製品の会話を計画モードで始める: 計画書の無い製品の新しい会話は、指定なしなら plan、auto を付ければ auto。どちらも INSERT の値で決まり UPDATE が無い', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.app.db.exec("CREATE TEMP TABLE mode_updates (id TEXT); CREATE TEMP TRIGGER mode_updated AFTER UPDATE OF permission_mode ON main.conversations BEGIN INSERT INTO mode_updates VALUES (new.id); END;");
  s.adapter().scripts = [reply('a'), reply('b'), reply('c'), reply('d'), reply('e'), reply('f')];
  await s.send(uuid(1), { text: 'build a shop', projectId: shop.id });
  assert.equal(s.app.conversations.modeOf(uuid(1)), 'plan');
  await s.send(uuid(2), { text: 'just chat', projectId: shop.id, permissionMode: 'auto' });
  assert.equal(s.app.conversations.modeOf(uuid(2)), 'auto');
  await s.send(uuid(3), { text: 'auto', projectId: shop.id, permissionMode: 'auto', modelId: 'm1' });
  assert.equal(s.app.conversations.modeOf(uuid(3)), 'auto');
  assert.equal(s.app.conversations.get(uuid(3))?.model_id, 'm1', 'モデルの選びも INSERT で入る');
  assert.deepEqual(s.app.db.prepare('SELECT id FROM temp.mode_updates').all(), [], '新しい会話のモードは UPDATE しない');

  await s.send(uuid(4), { text: 'hello' });
  assert.equal(s.app.conversations.modeOf(uuid(4)), 'auto', '製品に属さない会話は今までどおり');
  await s.send(uuid(1), { text: 'more' });
  assert.equal(s.app.conversations.modeOf(uuid(1)), 'plan', '前からある会話はそのまま');

  const put = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: '# Plan', baseHash: null });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await s.send(uuid(5), { text: 'next idea', projectId: shop.id });
  assert.equal(s.app.conversations.modeOf(uuid(5)), 'auto', '計画書のある製品の新しい会話は今までどおり');
});

test('3-1a 計画書の口: GET は無い間は空の形、PUT は baseHash が合えば書けて updated_by owner と plan.changed、合わなければ 409 plan.changed で変わらない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  assert.equal(shop.has_plan, false);
  const empty = await s.json(`/api/projects/${shop.id}/plan`, 'GET');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { plan: { content: null, hash: null, updated_at: null, updated_by: null, tainted: false, writing: false, reviewLocked: false } });

  const put = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: '# Plan\nv1', baseHash: null });
  assert.equal(put.status, 200);
  assert.deepEqual(Object.keys(put.body.plan).sort(), ['content', 'hash', 'reviewLocked', 'tainted', 'updated_at', 'updated_by', 'writing']);
  assert.equal(put.body.plan.updated_by, 'owner');
  assert.equal(put.body.plan.hash, sha('# Plan\nv1'));
  assert.deepEqual(s.events.filter(e => e.type === 'plan.changed'), [{ type: 'plan.changed', projectId: shop.id, hash: sha('# Plan\nv1'), by: 'owner' }]);
  assert.equal(readFileSync(join(s.paths.projects, shop.id, 'plan.md'), 'utf8'), '# Plan\nv1');
  const listed = await s.json('/api/projects', 'GET');
  assert.equal(listed.body.projects[0].has_plan, true);

  const stale = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'other', baseHash: null });
  assert.deepEqual([stale.status, stale.body.code], [409, 'plan.changed']);
  const wrong = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'other', baseHash: sha('nope') });
  assert.deepEqual([wrong.status, wrong.body.code], [409, 'plan.changed']);
  assert.equal(readFileSync(join(s.paths.projects, shop.id, 'plan.md'), 'utf8'), '# Plan\nv1');
  const next = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'v2', baseHash: put.body.plan.hash });
  assert.equal(next.status, 200);
  assert.equal((await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan.content, 'v2');

  const secret = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'sk-abcdefghijklmnop', baseHash: next.body.plan.hash });
  assert.deepEqual([secret.status, secret.body.code], [400, 'plan.secret']);
  const long = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'x'.repeat(64_001), baseHash: next.body.plan.hash });
  assert.deepEqual([long.status, long.body.code], [400, 'plan.too_long']);
  for (const body of [{ content: 1, baseHash: null }, { content: 'x' }, { content: 'x', baseHash: 3 }]) {
    assert.equal((await s.json(`/api/projects/${shop.id}/plan`, 'PUT', body)).status, 400, JSON.stringify(body));
  }
});

test('3-1a 計画書の口: 無い ID・形の合わない ID は 404 でフォルダに触らない。しまった製品は PUT が 400', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const before = readdirSync(s.paths.projects).sort();
  for (const id of ['aaaaaaaa-0000-4000-8000-999999999999', '..', 'a b', '%2e%2e']) {
    assert.equal((await s.json(`/api/projects/${id}/plan`, 'GET')).status, 404, id);
    assert.equal((await s.json(`/api/projects/${id}/plan`, 'PUT', { content: 'x', baseHash: null })).status, 404, id);
  }
  assert.deepEqual(readdirSync(s.paths.projects).sort(), before);
  assert.equal((await s.json(`/api/projects/${shop.id}`, 'PATCH', { archived: true })).status, 200);
  const archived = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: 'x', baseHash: null });
  assert.deepEqual([archived.status, archived.body.code], [400, 'project.archived']);
  assert.equal(existsSync(join(s.paths.projects, shop.id, 'plan.md')), false);
  assert.equal((await s.json(`/api/projects/${shop.id}/plan`, 'GET')).status, 200, 'しまった製品も読める');
});

test('3-1a 計画書の口: AI の plan_write で plan.changed（by ai）、計画モードの会話が動いているあいだ writing が true。外の文を読んだ実行なら tainted', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: boolean[] = [];
  s.adapter().scripts = [
    call('plan_write', { content: '# Plan by AI' }),
    async function* () {
      seen.push((await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan.writing);
      await gate;
      yield { type: 'text', delta: 'done' };
      yield { type: 'done', stop: 'end_turn' as StopReason };
    },
  ];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'plan', projectId: shop.id });
  assert.equal(sent.status, 202);
  while (!seen.length) await new Promise(r => setTimeout(r, 5));
  release();
  await settled(s.app, sent.body.runId);
  assert.deepEqual(seen, [true]);
  const after = (await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan;
  assert.deepEqual({ ...after, updated_at: 0 }, { content: '# Plan by AI', hash: sha('# Plan by AI'), updated_at: 0, updated_by: 'ai', tainted: false, writing: false, reviewLocked: false });
  assert.deepEqual(s.events.filter(e => e.type === 'plan.changed'), [{ type: 'plan.changed', projectId: shop.id, hash: sha('# Plan by AI'), by: 'ai' }]);

  const upload = await (await s.api('/api/uploads?name=notes.txt', { method: 'POST', body: 'outside text', headers: { 'Content-Type': 'text/plain' } })).json() as { upload: { id: string } };
  s.adapter().scripts = [call('plan_write', { content: '# Plan after attachment' }), reply('ok')];
  await s.send(uuid(1), { text: 'see attached', attachments: [upload.upload.id] });
  const tainted = (await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan;
  assert.equal(tainted.content, '# Plan after attachment');
  assert.equal(tainted.tainted, true);
});

function toolHarness(t: { after: (fn: () => void) => void }, archived = false) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.projects, PROJECT), { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const plans = new PlanStore(new KV(db), { projects: paths.projects, backups: paths.backups }, Date.now, { archived: () => archived });
  const registry = new ToolRegistry().register(planWrite);
  const policy = buildPolicy(config, paths);
  const events: RunEvent[] = [];
  const ctxOf = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy, project: { id: PROJECT },
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory: undefined as never, emit: e => events.push(e), plans }, ...over,
  });
  const run = (name: string, args: unknown, ctx: ToolContext) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending: new PendingStore(db, { tools: registry, dataDir: paths.data }), db, emit: () => undefined, permissionMode: () => ctx.permissionMode ?? 'auto',
    conversationTainted: () => false,
  });
  return { paths, plans, events, ctxOf, run, file: join(paths.projects, PROJECT, 'plan.md') };
}

test('3-1a 審査 S2: この実行が外を読んでいなくても、会話が前の実行で外を読んでいれば plan_write は tainted。会話の印が読めなければ tainted', async t => {
  const h = toolHarness(t);
  await h.run('plan_write', { content: '# One' }, h.ctxOf({ conversationTainted: () => true }));
  assert.equal(h.plans.view(PROJECT).tainted, true);
  await h.run('plan_write', { content: '# Two' }, h.ctxOf({ conversationTainted: () => false }));
  assert.equal(h.plans.view(PROJECT).tainted, false);
  await h.run('plan_write', { content: '# Three' }, h.ctxOf({ conversationTainted: () => { throw new Error('db closed'); } }));
  assert.equal(h.plans.view(PROJECT).tainted, true);
});

test('3-1a 審査 S2（本物の App）: 1 回目の実行で添付を読み、2 回目の実行で plan_write すると tainted', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const upload = await (await s.api('/api/uploads?name=notes.txt', { method: 'POST', body: 'outside text', headers: { 'Content-Type': 'text/plain' } })).json() as { upload: { id: string } };
  s.adapter().scripts = [reply('read it')];
  await s.send(uuid(1), { text: 'see attached', attachments: [upload.upload.id], projectId: shop.id });
  s.adapter().scripts = [call('plan_write', { content: '# Plan in run 2' }), reply('ok')];
  await s.send(uuid(1), { text: 'now write the plan' });
  const plan = (await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan;
  assert.equal(plan.content, '# Plan in run 2');
  assert.equal(plan.tainted, true);
});

test('3-1a 審査 S3: 1 つの AI の実行が何度書いても控えは 1 つ。持ち主の最後の版は、AI の実行がいくつ続いても控えから消えない', t => {
  const f = storeFixture(t);
  const OWNER = { by: 'owner' as const, tainted: false, conversationId: null, runId: null };
  f.store.write(PROJECT, 'owner version', OWNER);
  for (let i = 0; i < 21; i++) f.store.write(PROJECT, `ai ${i}`, AI);
  assert.deepEqual(f.backupTexts(), ['owner version'], '同じ実行の書き直しは控えない');
  for (let i = 0; i < 25; i++) f.store.write(PROJECT, `run ${i}`, { ...AI, runId: `r-${i}` });
  assert.ok(f.backupTexts().includes('owner version'), f.backupTexts().join());
  assert.ok(f.backups().length <= PLAN_BACKUPS + 1, String(f.backups().length));
  assert.ok(f.backupTexts().includes('run 23'));
});

test('3-1a 審査 S4: planOk は効果が meta / read で、ファイルも書く・送信になる・MCP の道具でないときだけ効く', () => {
  const base = { planOk: true as const };
  assert.equal(planAllows({ ...base, effect: 'meta' }), true);
  assert.equal(planAllows({ ...base, effect: 'read' }), true);
  for (const effect of ['write', 'exec'] as const) assert.equal(planAllows({ ...base, effect }), false, effect);
  assert.equal(planAllows({ ...base, effect: 'meta', writesFiles: true }), false);
  assert.equal(planAllows({ ...base, effect: 'meta', submits: true }), false);
});

test('3-1a 審査 S5: 制御文字（タブ・改行を除く）と U+2028 / U+2029 も取り除く', t => {
  const f = storeFixture(t);
  assert.equal(f.store.write(PROJECT, 'a\u0001b\u0007c\u001Bd\u2028e\u2029f\tg\r\nh\u007F', AI).content, 'abcdef\tg\r\nh');
});

test('3-1a 審査 S7: plan.md がふつうのファイルでない（フォルダ・リンク）なら、読まず書かない', t => {
  const f = storeFixture(t);
  mkdirSync(f.file);
  assert.throws(() => f.store.write(PROJECT, 'x', AI), (e: Error & { code?: string }) => e.code === 'not_file');
  assert.throws(() => f.store.view(PROJECT), (e: Error & { code?: string }) => e.code === 'not_file');
  assert.equal(f.store.has(PROJECT), true);
});

test('3-1a 審査 C1: 名前の付け替えが EPERM / EBUSY / EACCES で一時的に失敗しても、数回やり直して書ける。ずっと失敗すれば前の中身のままで一時ファイルも残らない', t => {
  let failures = 0;
  let always = false;
  const f = storeFixture(t, {
    renameSync: (from, to) => {
      if (always || failures < 2) { failures++; throw Object.assign(new Error('busy'), { code: failures % 2 ? 'EPERM' : 'EBUSY' }); }
      renameSync(from, to);
    },
  });
  f.store.write(PROJECT, 'first', AI);
  assert.equal(readFileSync(f.file, 'utf8'), 'first');
  assert.equal(failures, 2);
  always = true;
  assert.throws(() => f.store.write(PROJECT, 'second', { ...AI, runId: 'r2' }), /busy/u);
  assert.equal(readFileSync(f.file, 'utf8'), 'first');
  assert.deepEqual(readdirSync(join(f.paths.projects, PROJECT)), ['plan.md']);
});

test('3-1a 審査 C2: writing は実行に効いているモードで決まる（計画モードで始めた実行は、途中で会話を自動承認に戻しても writing）', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: boolean[] = [];
  s.adapter().scripts = [async function* () {
    s.app.conversations.setChoice(uuid(1), { permissionMode: 'auto' });
    seen.push((await s.json(`/api/projects/${shop.id}/plan`, 'GET')).body.plan.writing);
    await gate;
    yield { type: 'text', delta: 'done' };
    yield { type: 'done', stop: 'end_turn' as StopReason };
  }];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'plan', projectId: shop.id, permissionMode: 'plan' });
  assert.equal(sent.status, 202);
  while (!seen.length) await new Promise(r => setTimeout(r, 5));
  release();
  await settled(s.app, sent.body.runId);
  assert.deepEqual(seen, [true]);
});

test('3-1a 審査 C3: 同じ中身の書き直しは控えも plan.changed も作らない', async t => {
  const h = toolHarness(t);
  await h.run('plan_write', { content: '# Same' }, h.ctxOf());
  await h.run('plan_write', { content: '# Same' }, h.ctxOf({ runId: 'r2' }));
  assert.equal(h.events.filter(e => e.type === 'plan.changed').length, 1);
  assert.equal(existsSync(join(h.paths.backups, 'mesh', PROJECT)), false);
  const s = await setup(t);
  const shop = await s.product('shop');
  const first = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: '# Same', baseHash: null });
  const again = await s.json(`/api/projects/${shop.id}/plan`, 'PUT', { content: '# Same', baseHash: first.body.plan.hash });
  assert.equal(again.status, 200);
  assert.deepEqual(Object.keys(again.body.plan).sort(), ['content', 'hash', 'reviewLocked', 'tainted', 'updated_at', 'updated_by', 'writing']);
  assert.equal(s.events.filter(e => e.type === 'plan.changed').length, 1, 'PUT も同じ中身なら流さない');
  const f = storeFixture(t);
  assert.equal(f.store.write(PROJECT, 'x', AI).changed, true);
  assert.equal(f.store.write(PROJECT, 'x', { ...AI, runId: 'r9' }).changed, false);
  assert.deepEqual(f.backups(), []);
  f.store.write(PROJECT, 'y', { ...AI, tainted: true });
  f.store.write(PROJECT, 'y', { ...AI, runId: 'r10' });
  assert.equal(f.store.view(PROJECT).tainted, true, '同じ中身を外を読んでいない実行が書き直しても、tainted は消えない');
});

test('3-1a 審査 C4: plan_write / mesh_read は builtinTools の shell_run の後ろに並ぶ', () => {
  const names = builtinTools().map(tool => tool.name);
  assert.ok(names.indexOf('shell_run') >= 0);
  assert.ok(names.indexOf('plan_write') > names.indexOf('shell_run'));
  assert.ok(names.indexOf('mesh_read') > names.indexOf('shell_run'));
});

test('3-1a 審査: しまった製品の plan_write は、PUT と同じく分かる誤りで断り、ファイルを変えない', async t => {
  const h = toolHarness(t, true);
  const out = await h.run('plan_write', { content: '# Plan' }, h.ctxOf());
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /archived/u);
  assert.equal(existsSync(h.file), false);
  assert.equal(h.events.length, 0);
});

test('3-1a 再審査 1: beat の外で書かれた計画書と同じ中身を AI が書いても AI の版にしない。その版は AI の実行が続いても控えに残る。持ち主が同じ中身を保存したら持ち主の版になり plan.changed', async t => {
  const f = storeFixture(t);
  writeFileSync(f.file, 'hand written');
  const same = f.store.write(PROJECT, 'hand written', AI);
  assert.equal(same.changed, false);
  assert.equal(same.updated_by, 'outside');
  assert.equal(f.store.view(PROJECT).updated_by, 'outside');
  assert.equal(f.kv.getJson(`plan:${PROJECT}`), undefined);
  for (let i = 0; i < 25; i++) f.store.write(PROJECT, `run ${i}`, { ...AI, runId: `r-${i}` });
  assert.ok(f.backupTexts().includes('hand written'), f.backups().join());

  const h = toolHarness(t);
  writeFileSync(h.file, 'by hand');
  await h.run('plan_write', { content: 'by hand' }, h.ctxOf());
  assert.equal(h.plans.view(PROJECT).updated_by, 'outside');
  assert.equal(h.events.length, 0);
  const owner = h.plans.write(PROJECT, 'by hand', { by: 'owner', tainted: false, conversationId: null, runId: null });
  assert.equal(owner.changed, true);
  assert.equal(h.plans.view(PROJECT).updated_by, 'owner');
});

test('3-1a 再審査 2: 同じ中身を外を読んだ実行が書き直したら、tainted と一緒に runId / conversationId もその実行にし、plan.changed を流す', async t => {
  const h = toolHarness(t);
  await h.run('plan_write', { content: '# Same' }, h.ctxOf({ runId: 'r3', conversationId: 'c3' }));
  await h.run('plan_write', { content: '# Same' }, h.ctxOf({ runId: 'r4', conversationId: 'c4', taint: { tainted: true, sources: ['web'] } }));
  const meta = h.plans.meta(PROJECT)!;
  assert.deepEqual([meta.tainted, meta.runId, meta.conversationId, meta.by], [true, 'r4', 'c4', 'ai']);
  assert.equal(h.events.filter(e => e.type === 'plan.changed').length, 2);
});

test('3-1a 再審査 3: 記録の書き手が知らない値でも、控えの名前には ai / owner / outside しか入らない', t => {
  const f = storeFixture(t);
  f.store.write(PROJECT, 'one', AI);
  f.kv.setJson(`plan:${PROJECT}`, { ...f.store.meta(PROJECT)!, by: '..\\..\\x' });
  f.store.write(PROJECT, 'two', { ...AI, runId: 'r2' });
  assert.equal(f.backups().length, 1);
  assert.match(f.backups()[0]!, /^plan-\d+-[0-9a-f]+-ai\.md$/u);
});
