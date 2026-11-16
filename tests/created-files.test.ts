import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { App, builtinTools } from '../src/app.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { CreatedFiles } from '../src/projects/created.ts';
import { fakeModel, settled, startApp, uuid, waitFor } from './app-setup.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

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
  const live: Array<{ created: CreatedFiles; runs: Set<string> }> = [];
  const make = (store: KV = kv) => {
    const created = new CreatedFiles({ kv: store, dataDir, log: line => { logs.push(line); }, ...(options.limit ? { limit: options.limit } : {}) });
    const runs = new Set<string>();
    const begin = created.begin.bind(created);
    const end = created.end.bind(created);
    created.begin = async (runId, scope, root) => { runs.add(runId); await begin(runId, scope, root); };
    created.end = async runId => { runs.delete(runId); await end(runId); };
    live.push({ created, runs });
    return created;
  };
  const asTool = <T>(work: () => T): T => {
    const closes = live.flatMap(({ created, runs }) => [...runs].map(runId => created.open({ runId })));
    try { return work(); } finally { for (const close of closes) close(); }
  };
  if (options.git !== false) {
    git(root, 'init', '-q');
    writeFileSync(join(root, 'tracked.txt'), 'x');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-q', '-m', 'init');
  }
  const own = (rel: string, text = 'x') => { const file = join(root, rel); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); return file; };
  const put = (rel: string, text = 'x') => asTool(() => own(rel, text));
  return { base, root, dataDir, dbPath, kv, logs, make, put, own, asTool };
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
  writeFileSync(join(s.base, 'made.txt'), 'x');
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
  writeFileSync(join(s.base, 'outside.txt'), 'x');
  created.note({ runId: 'r1' }, join(s.base, 'outside.txt'));
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['tool.txt']);
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(byTool, { runId: 'r2' }), true);
  assert.equal(created.isCreated(s.root, { runId: 'r2' }), false, '製品のフォルダそのもの');
  await created.end('r2');
});

const call = (name: string, args: unknown): Script => async function* (req) {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  for (const c of withLoad(toolCall, req)) yield { type: 'tool_call', call: c };
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
  const sent = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'make a file', projectId, permissionMode: 'auto' });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await settled(s.app, sent.body.runId);
  await waitFor(() => s.app.kv.get(`created:conv:${uuid(1)}`) !== undefined, 'created list written');
  assert.deepEqual(s.app.engine.created.list({ kind: 'conv', id: uuid(1) }), ['hello.txt']);

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
  const sent = await s.json(`/api/conversations/${uuid(3)}/messages`, 'POST', { text: 'write', projectId: made.body.project.id, permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  await waitFor(() => s.app.kv.get(`created:conv:${uuid(3)}`) !== undefined, 'created list written');
  assert.deepEqual(s.app.engine.created.list({ kind: 'conv', id: uuid(3) }), ['new.txt', 'sheet.csv']);
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const link = (target: string, path: string) => symlinkSync(target, path, WINDOWS ? 'junction' : 'dir');

test('作ったもの（H1）: 控えの書き終わりを待っているあいだに会話が来ても、終わったタスクを「割り込まれた」にしない', async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [{ id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }];
  config.routing = { chat: ['m'], background: ['m'], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  let adapter!: FakeAdapter;
  const app = new App({ paths, databasePath: ':memory:', log: () => undefined, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  const created = app.engine.created;
  const realEnd = created.end.bind(created);
  created.end = async (runId: string) => { await sleep(400); await realEnd(runId); };
  const ends: string[] = [];
  app.bus.subscribe(e => { if (e.event.type === 'run.end') ends.push(e.event.runId); });
  const task = app.tasks.create({ title: 'quick job', origin: 'user', actor: 'user', nextAction: 'finish' });
  adapter.scripts.push(call('task_complete', { summary: 'finished', notify: false }), reply('done'));
  const ticking = app.worker.tick();
  await waitFor(() => ends.length === 1, 'task run ended');
  adapter.scripts.push(reply('hello'));
  const sent = app.engine.send('c1', 'hi');
  assert.ok(sent.ok, JSON.stringify(sent));
  await ticking;
  await app.engine.wait(sent.runId);
  assert.equal(app.engine.wasPreempted(ends[0]!), false);
  assert.equal(app.tasks.get(task.id)!.status, 'done');
});

test('作ったもの（H2）: AI が作って消した名前に持ち主が置いたファイル、持ち主が書き換えた AI のファイルは「作った」でなく、一覧から落ちる', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const notes = s.put('notes.md', 'ai');
  const draft = s.put('draft.md', 'ai');
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['draft.md', 'notes.md']);
  rmSync(notes);
  await sleep(20);
  s.put('notes.md', 'the owner wrote this');
  writeFileSync(draft, 'the owner edited this draft');
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(notes, { runId: 'r2' }), false);
  assert.equal(created.isCreated(draft, { runId: 'r2' }), false);
  assert.deepEqual(created.list(scope), []);
  await created.end('r2');
});

test('作ったもの（H2）: 実行の中で持ち主が書き換えた一覧のファイルも、その場で「作った」でない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const draft = s.put('draft.md', 'ai');
  await created.end('r1');
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(draft, { runId: 'r2' }), true);
  writeFileSync(draft, 'edited by the owner while the run goes on');
  assert.equal(created.isCreated(draft, { runId: 'r2' }), false);
  await created.end('r2');
});

test('作ったもの（H3）: 同じ製品のフォルダで重なった実行は、どちらも一覧に足さず、実行の中でも一覧だけを信じる', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  await created.begin('r2', { kind: 'conv', id: 'c2' }, s.root);
  const made = s.put('made.txt');
  assert.equal(created.isCreated(made, { runId: 'r1' }), false);
  assert.equal(created.isCreated(made, { runId: 'r2' }), false);
  await created.end('r2');
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
  assert.deepEqual(created.list({ kind: 'conv', id: 'c2' }), []);
  assert.ok(s.logs.some(line => line.startsWith('[WARN]')), s.logs.join('\n'));

  const inner = join(s.root, 'api');
  mkdirSync(inner);
  writeFileSync(join(inner, 'index.ts'), 'x');
  git(s.root, 'add', 'api/index.ts');
  git(s.root, 'commit', '-q', '-m', 'api');
  const outer = { kind: 'conv' as const, id: 'outer' };
  const task = { kind: 'task' as const, id: 'inner' };
  for (const [label, first, second] of [['outer first', 'o', 'i'], ['inner first', 'i', 'o']] as const) {
    const starts = { o: () => created.begin(`o-${label}`, outer, s.root), i: () => created.begin(`i-${label}`, task, inner) };
    await starts[first]();
    await starts[second]();
    const report = join(inner, `report-${first}.json`);
    writeFileSync(report, '{}');
    assert.equal(created.isCreated(report, { runId: `o-${label}` }), false, `${label}: the outer run sees the inner run's file`);
    assert.equal(created.isCreated(report, { runId: `i-${label}` }), false, `${label}: the inner run while overlapping`);
    await created.end(`o-${label}`);
    await created.end(`i-${label}`);
    assert.deepEqual(created.list(outer), [], label);
    assert.deepEqual(created.list(task), [], label);
  }
});

test('作ったもの（H3）: 実行の頭より前に生まれたファイルを実行の中で運び込んでも「作った」にならない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const outside = join(s.base, 'old.txt');
  writeFileSync(outside, 'old');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(outside, past, past);
  await sleep(2500);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const moved = join(s.root, 'old.txt');
  renameSync(outside, moved);
  assert.equal(created.isCreated(moved, { runId: 'r1' }), false);
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
});

test('作ったもの（M1）: git を使えない実行では、前の一覧にあっても「作った」でない。親のリポジトリの中の製品のフォルダも同じ', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const made = s.put('made.txt');
  await created.end('r1');
  git(s.root, 'config', 'remote.origin.gh-resolved', 'base');
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(made, { runId: 'r2' }), false);
  await created.end('r2');
  assert.ok(s.logs.some(line => line.startsWith('[WARN]')), s.logs.join('\n'));

  const parent = realpathSync.native(tempDir(t));
  git(parent, 'init', '-q');
  const inner = join(parent, 'inner');
  mkdirSync(inner);
  await created.begin('r3', scope, inner);
  const byTool = join(inner, 'tool.txt');
  writeFileSync(byTool, 'x');
  created.note({ runId: 'r3' }, byTool);
  assert.equal(created.isCreated(byTool, { runId: 'r3' }), false);
  await created.end('r3');
  assert.equal(created.list(scope).includes('tool.txt'), false);
});

test('作ったもの（M2・M4・L1・L2）: .git の中、末尾の点や空白、別のデータの流れ、相対のパスは「作った」でない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  assert.equal(created.isCreated(join(s.root, '.git'), { runId: 'r1' }), false);
  assert.equal(created.isCreated(join(s.root, '.git', 'config'), { runId: 'r1' }), false);
  assert.equal(created.isCreated(join(s.root, '.git', 'HEAD'), { runId: 'r1' }), false);
  const made = s.put('made.txt');
  assert.equal(created.isCreated('made.txt', { runId: 'r1' }), false, '相対のパス');
  assert.equal(created.isCreated(made, { runId: 'r1' }), true);
  if (WINDOWS) {
    assert.equal(created.isCreated(join(s.root, '.GIT', 'HEAD'), { runId: 'r1' }), false);
    writeFileSync(join(s.root, 'owner.txt'), 'x');
    await created.end('r1');
    await created.begin('r2', scope, s.root);
    for (const name of ['owner.txt.', 'owner.txt  ', 'owner.txt:zone', 'owner.txt::$DATA']) assert.equal(created.isCreated(join(s.root, name), { runId: 'r2' }), false, name);
    await created.end('r2');
  } else await created.end('r1');
});


test('作ったもの（M3）: AI のフォルダの中のリンク・フォルダへのリンクは「作った」でなく、終わりの記録はリンクの先へ入らない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const target = join(s.base, 'elsewhere');
  mkdirSync(target);
  writeFileSync(join(target, 'secret.txt'), 'owner');
  const created = s.make();
  await created.begin('r1', scope, s.root);
  s.put(join('gen', 'a.txt'));
  link(target, join(s.root, 'gen', 'j'));
  link(target, join(s.root, 'top'));
  assert.equal(created.isCreated(join(s.root, 'gen'), { runId: 'r1' }), false);
  assert.equal(created.isCreated(join(s.root, 'gen', 'j'), { runId: 'r1' }), false);
  assert.equal(created.isCreated(join(s.root, 'top'), { runId: 'r1' }), false);
  s.put(join('made', 'b.txt'));
  link(join(s.root, 'made'), join(s.root, 'alias'));
  assert.equal(created.isCreated(join(s.root, 'made'), { runId: 'r1' }), true);
  assert.equal(created.isCreated(join(s.root, 'alias'), { runId: 'r1' }), false, 'フォルダへのリンクは、先が作ったものでも false');
  await created.end('r1');
  const list = created.list(scope);
  assert.ok(!list.some(entry => entry.startsWith('top') || entry.startsWith('gen/j')), list.join(', '));
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(join(s.root, 'gen'), { runId: 'r2' }), false);
  assert.equal(created.isCreated(join(s.root, 'gen', 'a.txt'), { runId: 'r2' }), true);
  await created.end('r2');
});

test('作ったもの（L6・L3）: HEAD にあって頭の前に索引とフォルダから外したファイルを作り直しても「作った」にならない。頭の控えを kv に書かない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  git(s.root, 'rm', '-q', '--cached', 'tracked.txt');
  rmSync(join(s.root, 'tracked.txt'));
  const created = s.make();
  await created.begin('r1', scope, s.root);
  assert.equal(s.kv.db.prepare("SELECT count(*) AS n FROM kv WHERE key LIKE 'created-base:%'").get()!.n, 0);
  const again = s.put('tracked.txt', 'again');
  assert.equal(created.isCreated(again, { runId: 'r1' }), false);
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
});

test('作ったもの（W1-7）: 実行の途中で道具の呼び出しの外に持ち主が置いたファイルは、その場でも終わりの記録でも「作った」にならない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const made = s.put('made.txt');
  s.put(join('gen', 'a.txt'));
  await sleep(60);
  const mine = s.own('mine.txt', 'owner');
  const mineInGen = s.own(join('gen', 'owner.txt'), 'owner');
  await sleep(60);
  const later = s.put('later.txt');
  assert.equal(created.isCreated(made, { runId: 'r1' }), true);
  assert.equal(created.isCreated(later, { runId: 'r1' }), true);
  assert.equal(created.isCreated(mine, { runId: 'r1' }), false, 'placed by the owner between two tool calls');
  assert.equal(created.isCreated(mineInGen, { runId: 'r1' }), false);
  assert.equal(created.isCreated(join(s.root, 'gen'), { runId: 'r1' }), false, 'a folder that holds an owner file');
  await created.end('r1');
  assert.deepEqual(created.list(scope).sort(), ['gen/a.txt', 'later.txt', 'made.txt'], 'the folder changed outside a tool call, so only the files the tools made are kept');
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(join(s.root, 'gen'), { runId: 'r2' }), false);
  await created.end('r2');
});

test('作ったもの（W1-7）: 最後の道具の呼び出しのあと、終わりの一覧を取るまでに持ち主が置いたファイルは「作った」にならない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  s.put('made.txt');
  await sleep(60);
  const late = s.own('late.txt', 'owner');
  await created.end('r1');
  assert.deepEqual(created.list(scope), ['made.txt']);
  await created.begin('r2', scope, s.root);
  assert.equal(created.isCreated(late, { runId: 'r2' }), false);
  await created.end('r2');
});

test('作ったもの（W1-7）: 道具の呼び出しを一度もしていない実行は、何も「作った」にしない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const created = s.make();
  await created.begin('r1', scope, s.root);
  const file = s.own('quiet.txt');
  assert.equal(created.isCreated(file, { runId: 'r1' }), false);
  await created.end('r1');
  assert.deepEqual(created.list(scope), []);
});
