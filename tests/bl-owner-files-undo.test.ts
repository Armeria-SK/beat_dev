import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { readThen, reply, tempDir, type Script } from './helpers.ts';

// L241（Undo は画面に出した差分のハッシュを付け、違うファイルは書き戻さない）と L242（redo は、いちばん新しい Undo の束がまだ戻っていないときだけ）

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function rig(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  let n = 0;
  const product = async (name: string, files: Record<string, string>, options: { git?: boolean } = {}) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    if (options.git) git(root, 'init', '-q', '-b', 'main');
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(root, rel), body);
    if (options.git) { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'first'); }
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
  const changes = (projectId: string, query = '') => s.json(`/api/projects/${projectId}/changes${query}`, 'GET');
  const undo = (projectId: string, body: Record<string, unknown>) => s.json(`/api/projects/${projectId}/changes/undo`, 'POST', body);
  const redo = (projectId: string, id: string) => s.json(`/api/projects/${projectId}/changes/redo`, 'POST', { redo: id });
  // 画面が Undo の頼みに付けるハッシュの表（差分を出した時点のもの）
  const shown = async (projectId: string, query = ''): Promise<Record<string, string | null>> => {
    const got = await changes(projectId, query);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    return Object.fromEntries((got.body.files as Array<{ path: string; undo: boolean; hash?: string | null }>).filter(f => f.undo).map(f => [f.path, f.hash as string | null]));
  };
  return { ...s, products, product, run, changes, undo, redo, shown };
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

test('L241: 差分には、いまのファイルの中身のハッシュ（消えたファイルは null）が付く', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n', 'gone.txt': 'bye\n' });
  await s.run(p.id, [
    readThen('file_write', { path: 'a.txt', content: 'v2\n' }),
    readThen('file_write', { path: 'gone.txt', content: 'changed\n' }),
  ]);
  rmSync(join(p.root, 'gone.txt'));
  const got = await s.changes(p.id);
  const byPath = new Map((got.body.files as Array<{ path: string; hash?: string | null }>).map(f => [f.path, f]));
  assert.equal(byPath.get('a.txt')!.hash, sha('v2\n'));
  assert.equal(byPath.get('gone.txt')!.hash, null, '消えたファイルは「無い」');
});

test('L241: 隠すファイル（.env）には、中身から作ったハッシュを出さない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const g = await s.product('repo', { 'a.txt': 'x\n' }, { git: true });
  writeFileSync(join(g.root, '.env'), 'API_KEY=TOPSECRET123\n');
  const listed = await s.changes(g.id, '?base=commit');
  assert.equal(listed.body.files.length, 1);
  assert.equal(listed.body.files[0].hidden, true);
  assert.equal('hash' in listed.body.files[0], false);
  assert.ok(!JSON.stringify(listed.body).includes(sha('API_KEY=TOPSECRET123\n')));
});

test('L241: 差分を読んだあとにファイルへ書き足されたら、Undo は書き戻さず changed で断る。書き足されなければ今までどおり戻る', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n', 'b.txt': 'b1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' }), readThen('file_write', { path: 'b.txt', content: 'b2\n' })]);
  const hashes = await s.shown(p.id);
  appendFileSync(join(p.root, 'a.txt'), 'added later by the owner\n');

  const refused = await s.undo(p.id, { paths: ['a.txt'], hashes });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.undone, []);
  assert.deepEqual(refused.body.refused, [{ path: 'a.txt', reason: 'changed' }]);
  assert.equal(refused.body.redo, null);
  assert.equal(read(p.root, 'a.txt'), 'v2\nadded later by the owner\n', '書き足した分は残る');

  const done = await s.undo(p.id, { paths: ['b.txt'], hashes });
  assert.deepEqual([done.body.undone, done.body.refused], [['b.txt'], []]);
  assert.equal(read(p.root, 'b.txt'), 'b1\n');

  const again = await s.undo(p.id, { paths: ['a.txt'], hashes: await s.shown(p.id) });
  assert.deepEqual(again.body.undone, ['a.txt'], '新しい差分を読み直せば戻せる');
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('L241: git の製品でも同じ。差分のあとに書き足された分を Undo で消さない', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('repo', { 'a.txt': 'one\n', 'keep.txt': 'same\n' }, { git: true });
  writeFileSync(join(p.root, 'a.txt'), 'one\ntwo\n');
  const hashes = await s.shown(p.id, '?base=commit');
  assert.equal(hashes['a.txt'], sha('one\ntwo\n'));
  appendFileSync(join(p.root, 'a.txt'), 'three, written after the diff\n');
  const refused = await s.undo(p.id, { base: 'commit', paths: ['a.txt'], hashes });
  assert.deepEqual(refused.body.refused, [{ path: 'a.txt', reason: 'changed' }]);
  assert.equal(read(p.root, 'a.txt'), 'one\ntwo\nthree, written after the diff\n');
});

test('L241: paths: "all" も同じ。書き足されたファイルと、表に無い（差分を出したあとに増えた）ファイルは断り、ほかは戻す', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'a2\n' }), readThen('file_write', { path: 'b.txt', content: 'b2\n' })]);
  const hashes = await s.shown(p.id);
  appendFileSync(join(p.root, 'a.txt'), 'more\n');
  await s.run(p.id, [readThen('file_write', { path: 'c.txt', content: 'c2\n' })]);
  const all = await s.undo(p.id, { paths: 'all', hashes });
  assert.deepEqual(all.body.undone, ['b.txt']);
  assert.deepEqual([...all.body.refused].sort((x: { path: string }, y: { path: string }) => x.path.localeCompare(y.path)), [{ path: 'a.txt', reason: 'changed' }, { path: 'c.txt', reason: 'changed' }]);
  assert.deepEqual([read(p.root, 'a.txt'), read(p.root, 'b.txt'), read(p.root, 'c.txt')], ['a2\nmore\n', 'b1\n', 'c2\n']);
});

test('L241: 消えたファイルを差分のあとに作り直されたら、Undo は上書きしない。作り直されていなければ戻す', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'gone.txt': 'old\n', 'also.txt': 'old2\n' });
  await s.run(p.id, [readThen('file_write', { path: 'gone.txt', content: 'x\n' }), readThen('file_write', { path: 'also.txt', content: 'y\n' })]);
  rmSync(join(p.root, 'gone.txt'));
  rmSync(join(p.root, 'also.txt'));
  const hashes = await s.shown(p.id);
  assert.deepEqual([hashes['gone.txt'], hashes['also.txt']], [null, null]);
  writeFileSync(join(p.root, 'gone.txt'), 'the owner wrote this new file\n');
  const out = await s.undo(p.id, { paths: ['gone.txt', 'also.txt'], hashes });
  assert.deepEqual(out.body.undone, ['also.txt']);
  assert.deepEqual(out.body.refused, [{ path: 'gone.txt', reason: 'changed' }]);
  assert.equal(read(p.root, 'gone.txt'), 'the owner wrote this new file\n');
});

test('L241: ハッシュの表の形が違う頼みは 400。表の無い古い頼みは今までどおり受ける（画面とサーバーは同じ版で配る）', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  for (const hashes of [[], 'x', { 'a.txt': 'not-a-hash' }, { 'a.txt': 5 }]) {
    const bad = await s.undo(p.id, { paths: ['a.txt'], hashes });
    assert.deepEqual([bad.status, bad.body.code], [400, 'project.changes_bad_paths'], JSON.stringify(hashes));
  }
  assert.equal(read(p.root, 'a.txt'), 'v2\n');
  const legacy = await s.undo(p.id, { paths: ['a.txt'] });
  assert.deepEqual([legacy.status, legacy.body.undone], [200, ['a.txt']]);
  assert.equal(read(p.root, 'a.txt'), 'v1\n');
});

test('L241: 表を付けたのに、そのファイルの項目が無ければ書き戻さない（画面が見せていないものは戻さない）', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'v1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'v2\n' })]);
  const out = await s.undo(p.id, { paths: ['a.txt'], hashes: {} });
  assert.deepEqual(out.body.refused, [{ path: 'a.txt', reason: 'changed' }]);
  assert.equal(read(p.root, 'a.txt'), 'v2\n');
});

test('L242: 新しい方の Undo をやり直し済みなら、GET の redo は null（古い Undo の束を出さない）。新しい Undo をすれば、その束が出る', async t => {
  const s = await rig(t);
  const p = await s.product('plain', { 'a.txt': 'a1\n', 'b.txt': 'b1\n' });
  await s.run(p.id, [readThen('file_write', { path: 'a.txt', content: 'a2\n' }), readThen('file_write', { path: 'b.txt', content: 'b2\n' })]);
  const first = await s.undo(p.id, { paths: ['a.txt'] });
  const second = await s.undo(p.id, { paths: ['b.txt'] });
  assert.ok(first.body.redo && second.body.redo && first.body.redo !== second.body.redo);
  assert.equal((await s.changes(p.id)).body.redo.id, second.body.redo, '新しい方の束');

  assert.equal((await s.redo(p.id, second.body.redo)).status, 200);
  assert.equal((await s.changes(p.id)).body.redo, null, '新しい方をやり直した。古い方の束は出さない');

  await s.run(p.id, [readThen('file_write', { path: 'b.txt', content: 'b3\n' })]);
  const third = await s.undo(p.id, { paths: ['b.txt'] });
  assert.equal((await s.changes(p.id)).body.redo.id, third.body.redo, 'その後の新しい Undo の束は出る');
});
