import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { readThen, reply, tempDir, type Script } from './helpers.ts';

// L240: 裏の仕事（scout-run）・入れ子の製品・tools.roots で書ける会話の実行が動いている間も、Undo・Redo は changes_busy で断る

async function rig(t: Parameters<typeof startApp>[0], writeRoots = false) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, {
    models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools(),
    ...(writeRoots ? { configure: config => { config.tools.roots = [{ path: products, mode: 'write' }]; } } : {}),
  });
  let n = 100;
  const product = async (name: string, files: Record<string, string>, parent = products) => {
    const root = join(parent, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const run = async (projectId: string, scripts: Script[]) => {
    s.adapter().scripts = [...scripts, reply('done')];
    const sent = await s.json(`/api/conversations/${uuid(++n)}/messages`, 'POST', { text: 'work', projectId, permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    await settled(s.app, sent.body.runId);
  };
  // 動いたままの会話の実行（projectId が無ければ、製品に結び付かない会話）
  const hold = async (projectId?: string) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting: Script = async function* (req) { await gate; yield* reply('later')(req); };
    s.adapter().scripts = [waiting];
    const sent = await s.json(`/api/conversations/${uuid(++n)}/messages`, 'POST', { text: 'work', ...(projectId ? { projectId } : {}), permissionMode: 'auto' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    for (let i = 0; i < 200 && !s.app.engine.activeRuns().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(s.app.engine.activeRuns().length > 0);
    return async () => { release(); await settled(s.app, sent.body.runId); };
  };
  const running = (projectId: string, scout = false) => {
    const task = s.app.tasks.create({ title: scout ? 'thinking' : 'build', origin: scout ? 'self' : 'user', actor: scout ? 'worker' : 'user', projectId, ...(scout ? { scoutRun: true as const } : {}) });
    s.app.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(task.id);
    return () => s.app.db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id);
  };
  const undo = (projectId: string, body: Record<string, unknown>) => s.json(`/api/projects/${projectId}/changes/undo`, 'POST', body);
  const redo = (projectId: string, id: string) => s.json(`/api/projects/${projectId}/changes/redo`, 'POST', { redo: id });
  const edited = async (p: { id: string }, rel = 'a.txt') => {
    await run(p.id, [readThen('file_write', { path: rel, content: 'v2\n' })]);
  };
  return { ...s, products, product, run, hold, running, undo, redo, edited };
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');
const busy = (r: { status: number; body: { code?: string } }): [number, string | undefined] => [r.status, r.body.code];

test('L240: 裏の仕事（scout-run）のタスクが running のあいだも、その製品の Undo・Redo は changes_busy', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n', 'b.txt': 'b1\n' });
  await s.edited(p);
  await s.run(p.id, [readThen('file_write', { path: 'b.txt', content: 'b2\n' })]);
  const undone = await s.undo(p.id, { paths: ['b.txt'] });
  const finish = s.running(p.id, true);
  assert.deepEqual(busy(await s.undo(p.id, { paths: ['a.txt'] })), [409, 'project.changes_busy']);
  assert.deepEqual(busy(await s.redo(p.id, undone.body.redo)), [409, 'project.changes_busy']);
  assert.equal(read(p.root, 'a.txt'), 'v2\n');
  finish();
  assert.equal((await s.undo(p.id, { paths: ['a.txt'] })).status, 200, '終われば戻せる');
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('L240: フォルダが入れ子の別の製品のタスクが running なら、親からも子からも Undo は changes_busy。重ならない製品なら断らない', async t => {
  const s = await rig(t);
  const parent = await s.product('mono', { 'a.txt': 'v1\n' });
  const child = await s.product('inner', { 'c.txt': 'c1\n' }, parent.root);
  const sibling = await s.product('other', { 'z.txt': 'z1\n' });
  await s.edited(parent);
  await s.run(child.id, [readThen('file_write', { path: 'c.txt', content: 'c2\n' })]);

  const childBuild = s.running(child.id);
  assert.deepEqual(busy(await s.undo(parent.id, { paths: ['a.txt'] })), [409, 'project.changes_busy'], '子の実行が動いている間、親の Undo は断る');
  assert.equal(read(parent.root, 'a.txt'), 'v2\n');
  childBuild();

  const parentBuild = s.running(parent.id);
  assert.deepEqual(busy(await s.undo(child.id, { paths: ['c.txt'] })), [409, 'project.changes_busy'], '親の実行が動いている間、子の Undo は断る');
  assert.equal(read(child.root, 'c.txt'), 'c2\n');
  parentBuild();

  const siblingBuild = s.running(sibling.id);
  assert.equal((await s.undo(parent.id, { paths: ['a.txt'] })).status, 200, '重ならない製品の実行は関係ない');
  siblingBuild();
});

test('L240: 入れ子の別の製品の会話の実行が動いているあいだも、Undo は changes_busy', async t => {
  const s = await rig(t);
  const parent = await s.product('mono', { 'a.txt': 'v1\n' });
  const child = await s.product('inner', { 'c.txt': 'c1\n' }, parent.root);
  await s.edited(parent);
  const release = await s.hold(child.id);
  try {
    assert.deepEqual(busy(await s.undo(parent.id, { paths: ['a.txt'] })), [409, 'project.changes_busy']);
    assert.equal(read(parent.root, 'a.txt'), 'v2\n');
  } finally { await release(); }
  assert.equal((await s.undo(parent.id, { paths: ['a.txt'] })).status, 200);
});

test('L240: tools.roots でその製品のフォルダに書ける会話（製品に結び付かない会話）の実行が動いているあいだは Undo は changes_busy。書けない設定なら断らない', async t => {
  const wide = await rig(t, true);
  const p = await wide.product('plain', { 'a.txt': 'v1\n' });
  await wide.edited(p);
  const release = await wide.hold();
  try {
    assert.deepEqual(busy(await wide.undo(p.id, { paths: ['a.txt'] })), [409, 'project.changes_busy']);
    assert.equal(read(p.root, 'a.txt'), 'v2\n');
  } finally { await release(); }
  assert.equal((await wide.undo(p.id, { paths: ['a.txt'] })).status, 200, '会話が終われば戻せる');

  const narrow = await rig(t);
  const q = await narrow.product('plain', { 'a.txt': 'v1\n' });
  await narrow.edited(q);
  const free = await narrow.hold();
  try {
    assert.equal((await narrow.undo(q.id, { paths: ['a.txt'] })).status, 200, 'tools.roots が製品のフォルダに重ならなければ、ほかの会話は関係ない');
  } finally { await free(); }
});
