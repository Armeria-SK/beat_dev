import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { builtinTools } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { CreatedFiles } from '../src/projects/created.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { reply, tempDir, type Script } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
const gitAvailable = spawnSync('git', ['--version']).status === 0;

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
}

function setup(t: Parameters<typeof tempDir>[0], options: { limit?: number; git?: boolean; dbFile?: boolean } = {}) {
  const base = realpathSync.native(tempDir(t));
  const root = join(base, 'shop');
  mkdirSync(root, { recursive: true });
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = options.dbFile ? join(base, 'beat.db') : ':memory:';
  const kv = new KV(openDatabase(dbPath, MIGRATIONS));
  const logs: string[] = [];
  const make = (store: KV = kv) => new CreatedFiles({ kv: store, dataDir, log: line => { logs.push(line); }, ...(options.limit ? { limit: options.limit } : {}) });
  if (options.git !== false) {
    git(root, 'init', '-q');
    writeFileSync(join(root, 'tracked.txt'), 'x');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-q', '-m', 'init');
  }
  const put = (rel: string, text = 'x') => { const file = join(root, rel); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file; };
  return { base, root, dataDir, dbPath, kv, logs, make, put };
}

const scope = { kind: 'conv' as const, id: 'c1' };

test('作ったもの: 実行の中でシェルが作ったファイルは、その実行の中でも次の実行でも「作った」。前からあるもの・追っているものは「作った」でない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  writeFileSync(join(s.root, 'before.txt'), 'owner');
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const made = s.put('made.txt');
  assert.equal(created.isCreated(made, { runId: 'r1' }), true, 'この実行の中で生まれた');
  assert.equal(created.isCreated(join(s.root, 'before.txt'), { runId: 'r1' }), false, '始めにあった追っていないファイル');
  assert.equal(created.isCreated(join(s.root, 'tracked.txt'), { runId: 'r1' }), false, '追っているファイル');
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['made.txt']);

  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(made, { runId: 'r2' }), true, '次の実行でも作ったもの');
  assert.equal(created.isCreated(made, { runId: 'r9' }), false, '始めていない実行（製品に属さない実行など）は何も「作った」でない');
  assert.equal(created.isCreated(join(s.root, '..', 'shop', 'made.txt'), { runId: 'r2' }), true, '.. を含む書き方もそろえて照らす');
  assert.equal(created.isCreated(join(s.base, 'made.txt'), { runId: 'r2' }), false, '製品のフォルダの外');
  if (WINDOWS) {
    assert.equal(created.isCreated(made.toUpperCase(), { runId: 'r2' }), true, 'Windows は大文字小文字を問わない');
    assert.equal(created.isCreated(join(s.root, 'BEFORE.TXT'), { runId: 'r2' }), false, '書き方の大文字で、前からあるファイルが新しく見えない');
    await created.end('r2');
    const long = s.put('longfilename-owner.txt');
    const short = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
    await created.begin('r2', scope, s.root);
    if (short && short.toLowerCase() !== long.toLowerCase()) assert.equal(created.isCreated(short, { runId: 'r2' }), false, `8.3 の短い名前 ${short} で、前からあるファイルが新しく見えない`);
    else t.diagnostic('8.3 names are off on this volume');
  }
  await created.end('r2');
  assert.equal(created.isCreated(made, { runId: 'r2' }), false, '終わった実行の控えは残らない');
  assert.equal(s.kv.get('created-base:r1'), undefined);
});

test('作ったもの: 実行と実行のあいだに持ち主が置いたファイルは「作った」にならない（AI が作ったフォルダの中に置いたものも）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const gen = s.put(join('gen', 'a.txt'));
  s.put(join('gen', 'deep', 'b.txt'));
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['gen/', 'gen/a.txt', 'gen/deep/', 'gen/deep/b.txt']);

  const mine = s.put('mine.txt');
  const mineInGen = s.put(join('gen', 'mine.txt'));
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(mine, { runId: 'r2' }), false);
  assert.equal(created.isCreated(mineInGen, { runId: 'r2' }), false);
  assert.equal(created.isCreated(gen, { runId: 'r2' }), true, 'AI が作ったファイルはそのまま');
  assert.equal(created.isCreated(join(s.root, 'gen'), { runId: 'r2' }), false, '持ち主のファイルが入ったフォルダは丸ごとでは「作った」でない');
  assert.equal(created.isCreated(join(s.root, 'gen', 'deep'), { runId: 'r2' }), true, '中が全部作ったものなら、フォルダも作ったもの');
  await created.end('r2');
  assert.equal(created.list(scope).includes('gen/mine.txt'), false);
  assert.equal(created.list(scope).includes('mine.txt'), false);
});

test('作ったもの: 始めに追っていて git rm --cached で外したファイル、索引にだけあるファイルは「作った」にならない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  s.put('staged.txt');
  git(s.root, 'add', 'staged.txt');
  const created = s.make();
  await created.begin('r1', scope, s.root);
  git(s.root, 'rm', '-q', '--cached', 'tracked.txt');
  git(s.root, 'rm', '-q', '--cached', 'staged.txt');
  assert.equal(created.isCreated(join(s.root, 'tracked.txt'), { runId: 'r1' }), false, 'HEAD の木にある');
  assert.equal(created.isCreated(join(s.root, 'staged.txt'), { runId: 'r1' }), false, '始めの索引にある');
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(join(s.root, 'tracked.txt'), { runId: 'r2' }), false);
  assert.equal(created.isCreated(join(s.root, 'staged.txt'), { runId: 'r2' }), false);
  await created.end('r2');
});

test('作ったもの: 作ったあとで持ち主がコミットしたファイルは、一覧にあっても「作った」でない（git で戻せるかで見る）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const made = s.put('made.txt');
  await created.end('r1');
  git(s.root, 'add', 'made.txt');
  git(s.root, 'commit', '-q', '-m', 'keep');
  writeFileSync(made, 'owner edits');
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(made, { runId: 'r2' }), false);
  await created.end('r2');
});

test('作ったもの: Windows で、追っているファイルの名前を大文字小文字だけ変えても「作った」にならない', { skip: !gitAvailable || !WINDOWS }, async t => {
  const s = setup(t);
  s.put('readme.md');
  git(s.root, 'add', 'readme.md');
  git(s.root, 'commit', '-q', '-m', 'docs');
  renameSync(join(s.root, 'readme.md'), join(s.root, 'README.md'));
  const created = s.make();
  await created.begin('r1', scope, s.root);
  assert.equal(created.isCreated(join(s.root, 'README.md'), { runId: 'r1' }), false);
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
});

test('作ったもの: 日本語の名前のファイルとフォルダが照らせる', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const file = s.put('メモ.txt');
  const inDir = s.put(join('資料', '下書き.md'));
  await created.end('r1');
  assert.deepEqual(created.list(scope).sort(), ['メモ.txt', '資料/', '資料/下書き.md'].sort());
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(file, { runId: 'r2' }), true);
  assert.equal(created.isCreated(inDir, { runId: 'r2' }), true);
  assert.equal(created.isCreated(join(s.root, '資料'), { runId: 'r2' }), true);
  await created.end('r2');
});

test('作ったもの: 控えは kv にあり、再起動をまたいで残る。壊れた kv は空として読む', { skip: !gitAvailable }, async t => {
  const s = setup(t, { dbFile: true });
  const first = s.make();
  await first.begin('r1', scope, s.root);
  const made = s.put('made.txt');
  await first.end('r1');
  s.kv.db.close();

  const reopened = new KV(openDatabase(s.dbPath, MIGRATIONS));
  const again = s.make(reopened);
  await again.begin('r2', scope, s.root);
  assert.equal(again.isCreated(made, { runId: 'r2' }), true, '新しいプロセスでも');
  await again.end('r2');
  reopened.db.close();

  const store = new KV(openDatabase(s.dbPath, MIGRATIONS));
  const broken = s.make(store);
  for (const value of ['{not json', '{"a":1}', '[1,2]', '"made.txt"']) {
    store.set('created:conv:c1', value);
    assert.deepEqual(broken.list(scope), [], value);
    await broken.begin('r3', scope, s.root);
    assert.equal(broken.isCreated(made, { runId: 'r3' }), false, value);
    await broken.end('r3');
  }
  store.db.close();
});

test('作ったもの: 上限を超えると、その実行の分は足さない（消すときに積まれる向き）', { skip: !gitAvailable }, async t => {
  const s = setup(t, { limit: 3 });
  const created = s.make();
  await created.begin('r1', scope, s.root);
  s.put('a.txt');
  s.put('b.txt');
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['a.txt', 'b.txt']);
  await created.begin('r2', scope, s.root);
  s.put('c.txt');
  s.put('d.txt');
  await created.end('r2');
  assert.deepEqual(created.list(scope), ['a.txt', 'b.txt'], '足すと 4 になるので足さない');
  assert.ok(s.logs.some(line => line.startsWith('[WARN]')), s.logs.join('\n'));
  await created.begin('r3', scope, s.root);
  assert.equal(created.isCreated(join(s.root, 'c.txt'), { runId: 'r3' }), false);
  await created.end('r3');
});

test('作ったもの: タスクと会話は別の一覧。子の担当は親の実行の控えで照らす', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', { kind: 'task', id: 't1' }, s.root);
  const made = s.put('made.txt');
  assert.equal(created.isCreated(made, { runId: 'child', parent: { runId: 'r1' } }), true);
  await created.end('r1');
  assert.deepEqual(created.list({ kind: 'task', id: 't1' }), ['made.txt']);
  assert.deepEqual(created.list(scope), []);
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(made, { runId: 'r2' }), false, '別の作業のもの');
  await created.end('r2');
});

test('作ったもの: git でないフォルダは、ファイルの道具が新しく作ったパスだけ。ほかで生まれたものは分からない', async t => {
  const s = setup(t, { git: false });
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const byTool = s.put('tool.txt');
  created.note({ runId: 'r1' }, byTool);
  const byShell = s.put('shell.txt');
  assert.equal(created.isCreated(byTool, { runId: 'r1' }), true);
  assert.equal(created.isCreated(byShell, { runId: 'r1' }), false);
  created.note({ runId: 'r1' }, join(s.base, 'outside.txt'));
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['tool.txt']);
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(byTool, { runId: 'r2' }), true);
  assert.equal(created.isCreated(s.root, { runId: 'r2' }), false, '製品のフォルダそのもの');
  await created.end('r2');
});

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

test('作ったもの（エンジン）: 製品の会話の実行が作ったファイルは会話の一覧に入り、製品に属さない実行では控えない', { skip: !gitAvailable }, async t => {
  const products = realpathSync.native(tempDir(t));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const root = join(products, 'shop');
  mkdirSync(root);
  git(root, 'init', '-q');
  const made = await s.json('/api/projects', 'POST', { root });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.id as string;

  s.adapter().scripts = [call('file_write', { path: 'hello.txt', content: 'hi' }), reply('done')];
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'make a file', projectId, permissionMode: 'normal' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId);
  await waitFor(() => s.app.kv.get(`created:conv:${uuid(1)}`) !== undefined, 'created list written');
  assert.deepEqual(s.app.kv.getJson(`created:conv:${uuid(1)}`), ['hello.txt']);

  s.adapter().scripts = [call('file_write', { path: 'note.txt', content: 'x' }), reply('done')];
  const plain = await s.json(`/api/conversations/${uuid(2)}/messages`, 'POST', { text: 'write' });
  await settled(s.app, plain.body.runId);
  await waitFor(() => s.app.engine.wait(plain.body.runId) === undefined, 'run cleared');
  assert.equal(s.app.kv.get(`created:conv:${uuid(2)}`), undefined);
  assert.equal(s.app.kv.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'created-base:%'").get()!.n, 0);
});

test('作ったもの（エンジン）: git でない製品のフォルダでは、file_write が新しく作ったパスだけが一覧に入る（上書きは入らない）', async t => {
  const products = realpathSync.native(tempDir(t));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const root = join(products, 'plain');
  mkdirSync(root);
  writeFileSync(join(root, 'old.txt'), 'owner');
  const made = await s.json('/api/projects', 'POST', { root });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  s.adapter().scripts = [call('file_write', { path: 'old.txt', content: 'over' }), call('file_write', { path: 'new.txt', content: 'x' }), call('table_write', { path: 'sheet.csv', rows: [['a']] }), reply('done')];
  const sent = await s.json(`/api/conversations/${uuid(3)}/messages`, 'POST', { text: 'write', projectId: made.body.project.id, permissionMode: 'normal' });
  await settled(s.app, sent.body.runId);
  await waitFor(() => s.app.kv.get(`created:conv:${uuid(3)}`) !== undefined, 'created list written');
  assert.deepEqual(s.app.kv.getJson(`created:conv:${uuid(3)}`), ['new.txt', 'sheet.csv']);
});
