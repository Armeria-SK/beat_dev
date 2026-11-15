import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { pushFacts } from '../src/pending/snapshot.ts';
import { needsSnapshot, SNAPSHOT_EVENT, SNAPSHOT_REF, snapshotBeforeBuild, snapshotLine } from '../src/projects/snapshot-before.ts';
import { OWNER_FIX } from '../src/tasks/store.ts';
import { fakeModel, startApp, waitFor } from './app-setup.ts';
import { reply, tempDir, type Script } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const TASK = 'aaaaaaaa-0000-4000-8000-00000000c0de';

function repo(t: Parameters<typeof tempDir>[0], init = true) {
  const dir = realpathSync.native(tempDir(t));
  const git = (...args: string[]): string => {
    const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  if (init) git('init', '-q', '-b', 'main');
  return { dir, git };
}

function seeded(t: Parameters<typeof tempDir>[0]) {
  const r = repo(t);
  writeFileSync(join(r.dir, '.gitignore'), 'secret.txt\n');
  writeFileSync(join(r.dir, 'a.txt'), 'one\n');
  writeFileSync(join(r.dir, 'staged.txt'), 'base\n');
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'first');
  writeFileSync(join(r.dir, 'a.txt'), 'one changed\n');
  writeFileSync(join(r.dir, 'staged.txt'), 'staged change\n');
  r.git('add', 'staged.txt');
  writeFileSync(join(r.dir, 'staged.txt'), 'worktree after staging\n');
  mkdirSync(join(r.dir, 'new'), { recursive: true });
  writeFileSync(join(r.dir, 'new', 'b.txt'), 'untracked\n');
  writeFileSync(join(r.dir, 'secret.txt'), 'ignored\n');
  return r;
}

function tree(root: string, skipGit = true): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (skipGit && name === '.git' && dir === root) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(abs)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function state(r: ReturnType<typeof repo>) {
  return {
    work: tree(r.dir),
    index: createHash('sha256').update(readFileSync(join(r.dir, '.git', 'index'))).digest('hex'),
    head: readFileSync(join(r.dir, '.git', 'HEAD'), 'utf8'),
    branches: r.git('for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags', 'refs/remotes'),
    status: r.git('status', '--porcelain=v1', '--untracked-files=all'),
  };
}

test('6-0 控え: 作業の木・index・HEAD・枝を中身で比べて変えずに、追っていないファイルも入れた控えのコミットを refs/beat/snapshots/<task> に 1 つ作る。無視したファイルは入らない', { skip: !gitAvailable }, async t => {
  const r = seeded(t);
  const before = state(r);
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken', JSON.stringify(result));
  if (result.kind !== 'taken') return;
  assert.deepEqual(state(r), before, '作業の木・持ち主の index・HEAD・枝・status が同じ');
  assert.equal(result.ref, `refs/beat/snapshots/${TASK}`);
  assert.equal(r.git('rev-parse', `refs/beat/snapshots/${TASK}`), result.hash);
  assert.equal(r.git('for-each-ref', '--format=%(refname)', 'refs/beat'), `refs/beat/snapshots/${TASK}`, '名前は 1 つだけ');
  assert.equal(r.git('show', `${result.hash}:a.txt`), 'one changed');
  assert.equal(r.git('show', `${result.hash}:staged.txt`), 'worktree after staging');
  assert.equal(r.git('show', `${result.hash}:new/b.txt`), 'untracked');
  assert.throws(() => r.git('show', `${result.hash}:secret.txt`), '無視したファイルは入れない');
  assert.equal(r.git('rev-parse', `${result.hash}^`), r.git('rev-parse', 'HEAD'), '親は HEAD');
});

test('6-0 控え: 控えのあとに書き換えても、経過の 1 文の戻し方で控えの時点の中身に戻る', { skip: !gitAvailable }, async t => {
  const r = seeded(t);
  const original = tree(r.dir);
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken');
  if (result.kind !== 'taken') return;
  writeFileSync(join(r.dir, 'a.txt'), 'broken by build\n');
  writeFileSync(join(r.dir, 'new', 'b.txt'), 'broken too\n');
  r.git('rm', '-q', '-f', 'staged.txt');
  const line = snapshotLine(result);
  assert.match(line, new RegExp(`^Snapshot before Build: ${result.hash}\\. `, 'u'));
  const command = /`git ([^`]+)`/u.exec(line)![1]!.split(' ');
  r.git(...command);
  const now = tree(r.dir);
  for (const [file, hash] of Object.entries(original)) assert.equal(now[file], hash, file);
});

test('6-0 控え: 履歴の無いリポジトリでも、親の無い控えができる', { skip: !gitAvailable }, async t => {
  const r = repo(t);
  writeFileSync(join(r.dir, 'only.txt'), 'x\n');
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken', JSON.stringify(result));
  if (result.kind !== 'taken') return;
  assert.equal(r.git('show', `${result.hash}:only.txt`), 'x');
  assert.equal(r.git('rev-list', '--count', result.hash), '1');
  assert.equal(r.git('status', '--porcelain=v1', '--untracked-files=all'), '?? only.txt');
});

test('6-0 控え: 製品のフックを動かさない（index を書く・名前を足すときのフックも）', { skip: !gitAvailable }, async t => {
  const r = seeded(t);
  const marks = join(tempDir(t), 'marks');
  mkdirSync(marks);
  const hooks = join(r.dir, '.git', 'hooks');
  for (const name of ['reference-transaction', 'post-index-change', 'post-commit', 'pre-commit']) {
    writeFileSync(join(hooks, name), `#!/bin/sh\necho ran > "${marks.replaceAll('\\', '/')}/${name}"\n`, { mode: 0o755 });
  }
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken', JSON.stringify(result));
  assert.deepEqual(readdirSync(marks), [], 'どのフックも動かない');
  r.git('update-ref', 'refs/heads/control', 'HEAD');
  assert.ok(existsSync(join(marks, 'reference-transaction')), '対照: ふつうの git ではこのフックが動く');
});

test('6-0 控え: git の置き場が製品の外を指す .git のファイルなら控えを取らず、外のリポジトリに名前を足さない', { skip: !gitAvailable }, async t => {
  const outside = repo(t);
  writeFileSync(join(outside.dir, 'x.txt'), 'x\n');
  const product = repo(t, false);
  writeFileSync(join(product.dir, '.git'), `gitdir: ${join(outside.dir, '.git').replaceAll('\\', '/')}\n`);
  writeFileSync(join(product.dir, 'p.txt'), 'p\n');
  const result = await snapshotBeforeBuild(product.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'unavailable', JSON.stringify(result));
  assert.equal(outside.git('for-each-ref', 'refs/beat'), '');
});

test('6-0 控え: git でないフォルダは not_git。時間の上限を超えたら控えなしで timeout（名前は足さない）', { skip: !gitAvailable }, async t => {
  const plain = realpathSync.native(tempDir(t));
  writeFileSync(join(plain, 'f.txt'), 'f\n');
  assert.deepEqual(await snapshotBeforeBuild(plain, TASK, tempDir(t)), { kind: 'not_git' });
  assert.equal(existsSync(join(plain, '.git')), false);
  const r = seeded(t);
  const slow = await snapshotBeforeBuild(r.dir, TASK, tempDir(t), 1);
  assert.equal(slow.kind, 'timeout', JSON.stringify(slow));
  assert.equal(r.git('for-each-ref', 'refs/beat'), '');
  assert.match(snapshotLine(slow), /took longer than .* without a snapshot/u);
  assert.match(snapshotLine({ kind: 'not_git' }), /^This folder is not a git repository, so beat cannot take a snapshot before Build/u);
});

test('6-0 控え: Pending に積んだ push の行の控え（指紋と送ってよい先端）は、控えの名前ができても変わらない', { skip: !gitAvailable }, async t => {
  const r = seeded(t);
  const data = tempDir(t);
  const before = await pushFacts([{ dir: r.dir }], data);
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken');
  const after = await pushFacts([{ dir: r.dir }], data);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.tips, before.tips);
  r.git('update-ref', 'refs/heads/other', 'HEAD~0');
  writeFileSync(join(r.dir, 'c.txt'), 'c\n');
  r.git('add', 'c.txt');
  r.git('commit', '-q', '-m', 'second');
  assert.notEqual((await pushFacts([{ dir: r.dir }], data)).fingerprint, before.fingerprint, '対照: 枝が動けば変わる');
});

const big = (dir: string, files = 4): void => {
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `big${i}.bin`), randomBytes(48 * 1024 * 1024));
};
const runFolder = (data: string): string[] => (existsSync(join(data, 'git-run')) ? readdirSync(join(data, 'git-run')) : []);
const link = (target: string, path: string): void => symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');

test('6-0 控え: 無視されていない秘密らしいファイル（.env・*.pem・secrets/ の中）と、製品の外へのリンク（ジャンクション）の中身は控えに入れない', { skip: !gitAvailable }, async t => {
  const r = seeded(t);
  const outside = realpathSync.native(tempDir(t));
  writeFileSync(join(outside, 'outside.txt'), 'not the product\n');
  writeFileSync(join(r.dir, '.env'), 'TOKEN=x\n');
  writeFileSync(join(r.dir, 'deploy.pem'), 'key\n');
  mkdirSync(join(r.dir, 'secrets'));
  writeFileSync(join(r.dir, 'secrets', 'db.txt'), 'password\n');
  link(outside, join(r.dir, 'linked'));
  const result = await snapshotBeforeBuild(r.dir, TASK, tempDir(t));
  assert.equal(result.kind, 'taken', JSON.stringify(result));
  if (result.kind !== 'taken') return;
  const files = r.git('ls-tree', '-r', '--name-only', result.hash).split('\n');
  assert.deepEqual(files.filter(f => /\.env|\.pem|secrets\/|linked/u.test(f)), [], files.join(','));
  assert.ok(files.includes('new/b.txt') && files.includes('a.txt'), files.join(','));
});

for (const name of ['commondir', 'gitdir']) {
  test(`6-0 控え: .git/${name} が別のリポジトリを指すなら控えを取らず、そのリポジトリに物も名前も足さない`, { skip: !gitAvailable }, async t => {
    const other = repo(t);
    const product = repo(t);
    writeFileSync(join(product.dir, 'p.txt'), 'p\n');
    writeFileSync(join(product.dir, '.git', name), `${join(other.dir, '.git').replaceAll('\\', '/')}\n`);
    const objects = readdirSync(join(other.dir, '.git', 'objects')).sort();
    assert.deepEqual(await snapshotBeforeBuild(product.dir, TASK, tempDir(t)), { kind: 'unavailable' });
    assert.equal(other.git('for-each-ref', 'refs/beat'), '');
    assert.deepEqual(readdirSync(join(other.dir, '.git', 'objects')).sort(), objects);
  });
}

for (const at of ['refs', 'refs/beat', 'refs/beat/snapshots', 'logs']) {
  test(`6-0 控え: .git/${at} が外へのリンクなら控えを取らず、外に書かない`, { skip: !gitAvailable }, async t => {
    const r = seeded(t);
    const outside = realpathSync.native(tempDir(t));
    const path = join(r.dir, '.git', ...at.split('/'));
    if (at === 'refs') {
      rmSync(join(r.dir, '.git', 'refs'), { recursive: true, force: true });
    } else {
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { recursive: true, force: true });
    }
    link(outside, path);
    assert.deepEqual(await snapshotBeforeBuild(r.dir, TASK, tempDir(t)), { kind: 'unavailable' });
    assert.deepEqual(readdirSync(outside), []);
  });
}

test('6-0 控え: 製品のフォルダの代わりにファイルが来ても投げない（POSIX では ENOTDIR で unavailable、Windows では not_git）', async t => {
  const file = join(realpathSync.native(tempDir(t)), 'not-a-folder.txt');
  writeFileSync(file, 'x');
  assert.deepEqual(await snapshotBeforeBuild(file, TASK, tempDir(t)), { kind: process.platform === 'win32' ? 'not_git' : 'unavailable' });
});

test('6-0 控え: 動いている git を時間の上限で止める（控えなし・名前なし）。成功・失敗・時間切れのどれでも git-run は空に戻る', { skip: !gitAvailable }, async t => {
  const r = repo(t);
  big(r.dir);
  const data = tempDir(t);
  const started = Date.now();
  const slow = await snapshotBeforeBuild(r.dir, TASK, data, 1000);
  const took = Date.now() - started;
  assert.equal(slow.kind, 'timeout', JSON.stringify(slow));
  assert.ok(took < 3500, `git を止めずに待った: ${took} ms`);
  assert.equal(r.git('for-each-ref', 'refs/beat'), '');
  assert.deepEqual(runFolder(data), []);
  const small = repo(t);
  writeFileSync(join(small.dir, 'f.txt'), 'f\n');
  assert.equal((await snapshotBeforeBuild(small.dir, TASK, data)).kind, 'taken');
  assert.deepEqual(runFolder(data), []);
  assert.equal((await snapshotBeforeBuild(small.dir, TASK, data)).kind, 'failed', '同じ名前は作り直さない');
  assert.deepEqual(runFolder(data), []);
});

test('6-0 控え: 直しのタスク（owner_fix）も根なら取る。控えの経過があれば取らない', async t => {
  const s = await startApp(t, { models: [fakeModel('m1')] });
  const projectsDir = realpathSync.native(tempDir(t));
  const project = s.app.projects.create({ name: 'fixme', root: projectsDir, rootKey: projectsDir.toLowerCase(), checkCommand: null });
  const fix = s.app.tasks.create({ title: 'Fix A-1', origin: 'user', actor: 'user', projectId: project.id, acceptanceItems: ['A-1'] });
  s.app.tasks.event(fix.id, OWNER_FIX, 'user', '{}');
  assert.equal(needsSnapshot(s.app.db, s.app.tasks.get(fix.id)!), true);
  s.app.tasks.event(fix.id, SNAPSHOT_EVENT, 'beat', 'x');
  assert.equal(needsSnapshot(s.app.db, s.app.tasks.get(fix.id)!), false);
});

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

async function buildRig(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-6-0-')));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  t.after(async () => {
    for (let attempt = 0; ; attempt++) {
      try { rmSync(products, { recursive: true, force: true }); return; } catch (error) {
        if (attempt >= 40) throw error;
        await new Promise(r => setTimeout(r, 250));
      }
    }
  });
  const product = async (name: string, git: boolean) => {
    const dir = join(products, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.txt'), 'v1\n');
    if (git) spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const made = await s.json('/api/projects', 'POST', { root: dir });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.project.id as string;
    await s.json(`/api/projects/${id}/plan`, 'PUT', { content: '# Plan', baseHash: null });
    const plan = (await s.json(`/api/projects/${id}/plan`, 'GET')).body.plan.hash;
    const acceptance = (await s.json(`/api/projects/${id}/acceptance`, 'GET')).body.acceptance.hash;
    const built = await s.json(`/api/projects/${id}/build`, 'POST', { planHash: plan, acceptanceHash: acceptance });
    assert.equal(built.status, 201, JSON.stringify(built.body));
    return { id, dir, task: built.body.task.id as string };
  };
  const refs = (dir: string) => spawnSync('git', ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/beat'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const snaps = (task: string) => s.app.tasks.events(task).filter(e => e.kind === SNAPSHOT_EVENT);
  return { ...s, product, refs, snaps };
}

test('6-0 ワーカー: git の製品の Build は、根のタスクが最初に動く直前に控えを 1 つ取り、経過に 1 行。2 回目の回と子のタスクでは取らない', { skip: !gitAvailable }, async t => {
  const s = await buildRig(t);
  const p = await s.product('shop', true);
  let seenAtFirstCall = '';
  s.adapter().scripts = [
    async function* (req) { seenAtFirstCall = s.refs(p.dir); yield* reply('first run')(req); },
  ];
  assert.equal(await s.app.worker.tick(), 'ran');
  const first = s.refs(p.dir);
  assert.match(first, new RegExp(`^[0-9a-f]{40,64} ${SNAPSHOT_REF}${p.task}$`, 'u'));
  assert.equal(seenAtFirstCall, first, 'モデルを呼ぶ前に控えがある');
  const hash = first.split(' ')[0]!;
  assert.deepEqual(s.snaps(p.task).map(e => e.content?.split('. ')[0]), [`Snapshot before Build: ${hash}`]);

  s.app.tasks.setReady(p.task, { runAt: 0, reason: 'again' });
  s.adapter().scripts = [reply('second run')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.refs(p.dir), first, '2 回目の回では取らない');
  assert.equal(s.snaps(p.task).length, 1);

  s.app.tasks.finish(p.task, 'done', 'ok', 'user');
  const child = s.app.tasks.create({ title: 'child', body: 'part', origin: 'user', actor: 'beat', projectId: p.id, spawnedBy: p.task, acceptanceItems: [] });
  s.adapter().scripts = [reply('child ran')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.app.tasks.get(child.id)?.conversation_id !== null, true, '子が動いた');
  assert.equal(s.refs(p.dir), first, '子のタスクでは取らない');
  assert.equal(s.snaps(child.id).length, 0);
});

test('6-0 ワーカー: git でない製品の Build は、経過に知らせを 1 行書いて、そのまま動く', async t => {
  const s = await buildRig(t);
  const p = await s.product('plain', false);
  s.adapter().scripts = [reply('built')];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.adapter().calls.length, 1, 'Build は動く');
  assert.deepEqual(s.snaps(p.task).map(e => e.content), [snapshotLine({ kind: 'not_git' })]);
  assert.equal(existsSync(join(p.dir, '.git')), false);
});

test('6-0 ワーカー: 控えを取っているあいだに取り消されたら、モデルを呼ばずに止まる', { skip: !gitAvailable }, async t => {
  const s = await buildRig(t);
  const p = await s.product('slow', true);
  big(p.dir);
  s.adapter().scripts = [reply('should not run')];
  const ticking = s.app.worker.tick();
  await waitFor(() => runFolder(s.paths.data).some(name => name.startsWith('index-')), 'snapshot started', 10_000);
  const cancelled = await s.json(`/api/tasks/${p.task}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  await ticking;
  assert.equal(s.adapter().calls.length, 0, 'モデルを呼ばない');
  assert.equal(s.app.tasks.get(p.task)?.status, 'cancelled');
  assert.equal(s.snaps(p.task).length, 1);
});
