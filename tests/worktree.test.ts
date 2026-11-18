import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { defaultConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { pushFacts } from '../src/pending/snapshot.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { BEAT_BRANCH, branchSlug, removeLinksInside, removeTree, worktreeRoot, Worktrees } from '../src/projects/worktree.ts';
import { removeDir, tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const WINDOWS = process.platform === 'win32';
const link = (target: string, path: string): void => symlinkSync(target, path, WINDOWS ? 'junction' : 'dir');
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function gitIn(dir: string, ...args: string[]): string {
  const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
}
const gitOk = (dir: string, ...args: string[]): boolean => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).status === 0;

function shortName(long: string): string | undefined {
  if (!WINDOWS) return undefined;
  const short = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
  return short && short.toLowerCase() !== long.toLowerCase() ? short : undefined;
}

// 作業の木（.git を除く）の中身のハッシュ
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (name === '.git' && dir === root) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out[relative(root, abs).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(abs, 'latin1').replaceAll('\r\n', '\n')).digest('hex');
    }
  };
  walk(root);
  return out;
}

function mainState(product: string) {
  const hash = (file: string): string => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : 'none');
  return {
    tree: tree(product), index: hash(join(product, '.git', 'index')), head: readFileSync(join(product, '.git', 'HEAD'), 'utf8'),
    branch: gitIn(product, 'symbolic-ref', 'HEAD'), commit: gitIn(product, 'rev-parse', 'HEAD'), status: gitIn(product, 'status', '--porcelain=v1', '--untracked-files=all'),
  };
}

interface Setup { base: string; data: string; product: string; db: DatabaseSync; projects: ProjectStore; wt: Worktrees; projectId: string; config: ReturnType<typeof defaultConfig>; marker: string }

function setup(t: Parameters<typeof tempDir>[0], options: { data?: string; home?: string; productConfig?: string[] } = {}): Setup {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-test-')));
  const data = options.data ?? join(base, 'data');
  mkdirSync(data, { recursive: true });
  const product = join(base, 'product');
  mkdirSync(product);
  gitIn(product, 'init', '-q', '-b', 'main');
  writeFileSync(join(product, 'a.txt'), 'one\n');
  mkdirSync(join(product, 'src'));
  writeFileSync(join(product, 'src', 'b.txt'), 'two\n');
  writeFileSync(join(product, 'package.json'), JSON.stringify({ name: 'product', version: '1.0.0', scripts: { path: 'node show-path.cjs' } }));
  writeFileSync(join(product, 'show-path.cjs'), "console.log(process.env.PATH)\n");
  // 追っているフックの置き場（.husky）。worktree にも取り出されるので、git が core.hooksPath のまま動けば動く
  const marker = join(base, 'hook-ran');
  mkdirSync(join(product, '.husky'));
  for (const hook of ['pre-commit', 'prepare-commit-msg']) writeFileSync(join(product, '.husky', hook), `#!/bin/sh\necho husky ${hook} >> '${marker.replaceAll('\\', '/')}'\n`, { mode: 0o755 });
  gitIn(product, 'add', '-A');
  gitIn(product, 'commit', '-q', '-m', 'first');
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-checkout', 'reference-transaction']) {
    writeFileSync(join(product, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> '${marker.replaceAll('\\', '/')}'\n`, { mode: 0o755 });
  }
  gitIn(product, 'config', 'core.hooksPath', '.husky');
  for (const entry of options.productConfig ?? []) { const [key, value] = entry.split('='); gitIn(product, 'config', key!, value!); }
  // 持ち主の書きかけ（コミットしていない変更と、追っていないファイル）
  writeFileSync(join(product, 'a.txt'), 'one, edited by the owner\n');
  writeFileSync(join(product, 'owner-new.txt'), 'untracked\n');
  const db = openDatabase(join(base, 'beat.db'), MIGRATIONS);
  t.after(async () => { db.close(); await removeDir(base); });
  const projects = new ProjectStore(db, join(data, 'projects'));
  const projectId = projects.create({ name: 'shop', root: product, rootKey: rootKeyOf(product), checkCommand: null }).id;
  const config = defaultConfig();
  const wt = new Worktrees({ db, paths: { data }, config: () => config, projects, ...(options.home ? { home: options.home } : {}) });
  return { base, data, product, db, projects, wt, projectId, config, marker };
}

const create = async (s: Setup, title = 'Restore the queue') => {
  const made = await s.wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', taskId: 'task-1', title });
  assert.ok(made.ok, `created: ${JSON.stringify(made)}`);
  return made.row;
};

test('worktree: 作ると元のコミットと同じ中身で、本体の作業の木・索引・HEAD・ブランチは変わらず、フックは動かない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const before = mainState(s.product);
  const row = await create(s);
  assert.equal(row.state, 'active');
  assert.match(row.branch, BEAT_BRANCH);
  assert.match(row.branch, /^beat\/restore-the-queue-[0-9a-f]{4}$/u);
  assert.equal(row.base, before.commit);
  assert.equal(row.repo, s.product);
  assert.ok(row.path!.startsWith(join(s.data, 'worktrees')), row.path!);
  const blob = (path: string): Buffer => spawnSync('git', ['show', `HEAD:${path}`], { cwd: s.product, env: GIT_ENV }).stdout;
  const expected = Object.fromEntries(gitIn(s.product, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').map(p => [p, createHash('sha256').update(blob(p).toString('latin1').replaceAll('\r\n', '\n')).digest('hex')]));
  assert.deepEqual(tree(row.path!), expected);
  assert.deepEqual(mainState(s.product), before);
  assert.equal(existsSync(s.marker), false, 'フック（post-checkout・reference-transaction など）が動かない');
  assert.equal(gitIn(row.path!, 'symbolic-ref', 'HEAD'), `refs/heads/${row.branch}`);
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: row.path!, encoding: 'utf8' });
  assert.equal(status.stdout.trim(), '', '取り出したあとの作業コピーは、持ち主の git の設定（autocrlf など）で見てきれい');
});

test('worktree: 書きかけをフックなし・署名なしの 1 コミットにして branch になり、取り込むと merged、片づけでブランチも消える', { skip: !gitAvailable }, async t => {
  const s = setup(t, { productConfig: ['commit.gpgsign=true'] });
  const row = await create(s);
  writeFileSync(join(row.path!, 'src', 'b.txt'), 'two, fixed\n');
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const before = mainState(s.product);
  const done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'Restore the queue' });
  assert.ok(done.ok && done.committed && done.changed, JSON.stringify(done));
  assert.equal(existsSync(s.marker), false, 'pre-commit・commit-msg・post-commit・.husky のフックが動かない');
  assert.equal(gitIn(row.path!, 'log', '-1', '--format=%G?'), 'N', '署名しない');
  assert.match(gitIn(row.path!, 'log', '-1', '--format=%B'), /Restore the queue\n\nBeat-Task: task-1/u);
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  assert.equal(s.wt.get(row.id)!.tip, done.tip);
  assert.deepEqual(mainState(s.product), before, '本体は変わらない');
  assert.equal(await s.wt.tipOf(row.id), done.tip);

  assert.equal(await s.wt.isMerged(row.id), false, '取り込む前は祖先でない');
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  gitIn(s.product, 'stash', 'pop');
  assert.equal(await s.wt.isMerged(row.id), true);
  assert.equal(s.wt.get(row.id)!.state, 'merged');

  const removed = await s.wt.removeWorktree(row.id, { keepBranch: false });
  assert.deepEqual(removed, { ok: true, branchKept: false });
  assert.equal(existsSync(row.path!), false);
  assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`), false);
  assert.equal(gitIn(s.product, 'worktree', 'list', '--porcelain').includes(row.id), false, '登録も消える');
  assert.equal(s.wt.get(row.id)!.state, 'merged');
  assert.equal(s.wt.get(row.id)!.path, null);
});

test('worktree: 持ち主の名前とメールが設定に無ければ beat の決まった名前でコミットする', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const home = join(s.base, 'empty-home');
  mkdirSync(home);
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.XDG_CONFIG_HOME;
  let done;
  try { done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' }); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.ok(done.ok && done.committed, JSON.stringify(done));
  assert.equal(gitIn(row.path!, 'log', '-1', '--format=%an <%ae> / %cn <%ce>'), 'beat <beat@localhost> / beat <beat@localhost>');
});

test('worktree: HEAD が行のブランチの上でなければ書きかけをコミットせず、行は branch になってカードに出す印が残る（D-13）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  gitIn(row.path!, 'checkout', '-q', '--detach');
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  assert.deepEqual(await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' }), { ok: false, reason: 'not_on_branch' });
  assert.equal(gitIn(row.path!, 'rev-parse', 'HEAD'), row.base);
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  assert.equal(s.wt.get(row.id)!.note, 'not_on_branch');
  assert.ok(existsSync(join(row.path!, 'c.txt')), '書きかけは作業コピーに残る');
});

test('worktree: 取り込まずに捨てるとブランチごと消えて discarded。持ち主が足したコミットのあるブランチは残す', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const one = await create(s, 'first');
  writeFileSync(join(one.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(one.id, { commitLeftovers: true, message: 'x' })).ok);
  assert.deepEqual(await s.wt.removeWorktree(one.id, { keepBranch: false }), { ok: true, branchKept: false });
  assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${one.branch}`), false);
  assert.equal(s.wt.get(one.id)!.state, 'discarded');

  const two = await create(s, 'second');
  writeFileSync(join(two.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(two.id, { commitLeftovers: true, message: 'x' })).ok);
  writeFileSync(join(two.path!, 'd.txt'), 'owner\n');
  gitIn(two.path!, 'add', 'd.txt');
  gitIn(two.path!, 'commit', '-q', '-m', 'owner commit');
  const ownerTip = gitIn(two.path!, 'rev-parse', 'HEAD');
  assert.deepEqual(await s.wt.removeWorktree(two.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${two.branch}`), ownerTip, '持ち主のコミットを消さない');
  assert.equal(existsSync(two.path!), false);
});

test('worktree: 終えたあとに持ち主が足したコミットは、tipOf で先端を見たあとでも消さない（beat が書いた先端と、見た先端は別）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok);
  writeFileSync(join(row.path!, 'd.txt'), 'owner\n');
  gitIn(row.path!, 'add', 'd.txt');
  gitIn(row.path!, 'commit', '-q', '-m', 'owner commit');
  const ownerTip = gitIn(row.path!, 'rev-parse', 'HEAD');
  assert.equal(await s.wt.tipOf(row.id), ownerTip);
  assert.equal(await s.wt.isMerged(row.id), false);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${row.branch}`), ownerTip, '持ち主のコミットを消さない');
  assert.equal(s.wt.get(row.id)!.own_tip, done.tip, 'tipOf・isMerged は beat の書いた先端を書き換えない');
  assert.equal(s.wt.get(row.id)!.tip, ownerTip, '見た先端は tip に残る');
});

test('worktree: own_tip は作ったときと、うまく終えたときだけ書く。終える前に捨てると AI のコミットのあるブランチは残す（branch_moved）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const one = await create(s, 'first');
  writeFileSync(join(one.path!, 'c.txt'), 'ai\n');
  gitIn(one.path!, 'add', 'c.txt');
  gitIn(one.path!, 'commit', '-q', '-m', 'ai commit during the task');
  const done = await s.wt.finishWorktree(one.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok && !done.committed && done.changed, JSON.stringify(done));
  assert.equal(s.wt.get(one.id)!.own_tip, done.tip, '終えたときの先端（AI のコミットを含む）は beat のもの');
  assert.deepEqual(await s.wt.removeWorktree(one.id, { keepBranch: false }), { ok: true, branchKept: false });
  assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${one.branch}`), false);

  const two = await create(s, 'second');
  writeFileSync(join(two.path!, 'c.txt'), 'ai\n');
  gitIn(two.path!, 'add', 'c.txt');
  gitIn(two.path!, 'commit', '-q', '-m', 'ai commit during the task');
  const unfinished = gitIn(two.path!, 'rev-parse', 'HEAD');
  assert.deepEqual(await s.wt.removeWorktree(two.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${two.branch}`), unfinished, '終えていないコミットは持ち主のものと見分けられないので残す');
  assert.equal(s.wt.get(two.id)!.own_tip, two.base, '捨てるときに今の先端を取り込まない');
  assert.equal(s.wt.get(two.id)!.state, 'branch');
});

test('worktree: HEAD が外れたあと持ち主が本体で自分のブランチに足したコミットは、D-13 で branch にしたあと捨てても消えない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'ai\n');
  gitIn(row.path!, 'add', 'c.txt');
  gitIn(row.path!, 'commit', '-q', '-m', 'ai commit');
  gitIn(row.path!, 'switch', '-q', '--detach');
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, 'switch', '-q', row.branch);
  writeFileSync(join(s.product, 'w.txt'), 'owner\n');
  gitIn(s.product, 'add', 'w.txt');
  gitIn(s.product, 'commit', '-q', '-m', 'owner W');
  const w = gitIn(s.product, 'rev-parse', 'HEAD');
  gitIn(s.product, 'switch', '-q', 'main');
  gitIn(s.product, 'stash', 'pop');
  assert.deepEqual(await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' }), { ok: false, reason: 'not_on_branch' });
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  assert.equal(s.wt.get(row.id)!.own_tip, row.base, 'not_on_branch では own_tip を変えない');
  assert.equal(s.wt.get(row.id)!.tip, w, '見た先端は tip に残る');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'dirty' }, '作業コピーの HEAD が外れている（そこに仕事がある）');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false, discardLocal: true }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${row.branch}`), w, 'W に届く');
});

test('worktree: 作りかけで止まった行の作業コピーで持ち主がコミットしていたら、見回りはブランチを残す', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  s.db.prepare("UPDATE worktrees SET state = 'creating', updated_at = 1 WHERE id = ?").run(row.id);
  writeFileSync(join(row.path!, 'd.txt'), 'owner\n');
  gitIn(row.path!, 'add', 'd.txt');
  gitIn(row.path!, 'commit', '-q', '-m', 'owner commit');
  const ownerTip = gitIn(row.path!, 'rev-parse', 'HEAD');
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 1, left: 0 });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${row.branch}`), ownerTip, '持ち主のコミットを消さない');
  assert.equal(existsSync(row.path!), false);
  assert.equal(s.wt.get(row.id)!.state, 'branch', 'ブランチを残したので終わった扱いにしない（gone にしない）');
});

test('worktree: ブランチを消すと決めて失敗し、やり直しの前に持ち主がコミットしたら、ブランチを残して状態も branch', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok);
  const lock = join(s.product, '.git', 'refs', 'heads', ...row.branch.split('/')) + '.lock';
  writeFileSync(lock, '');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'failed' });
  unlinkSync(lock);
  assert.equal(s.wt.get(row.id)!.state, 'removing');
  assert.equal(s.wt.get(row.id)!.ending, 'discarded');
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, 'switch', '-q', row.branch);
  writeFileSync(join(s.product, 'w.txt'), 'owner\n');
  gitIn(s.product, 'add', 'w.txt');
  gitIn(s.product, 'commit', '-q', '-m', 'owner W');
  const w = gitIn(s.product, 'rev-parse', 'HEAD');
  gitIn(s.product, 'switch', '-q', 'main');
  gitIn(s.product, 'stash', 'pop');
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 1, left: 0 });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${row.branch}`), w);
  assert.equal(s.wt.get(row.id)!.state, 'branch', '前の試みの discarded を残さない');
});

test('worktree: 消しかけで止まっても、頼まれた終わりの状態（gone・merged）と、決めた取り込み済みは見回りのあとも同じ', { skip: !gitAvailable || !WINDOWS }, async t => {
  const s = setup(t);
  const hold = async (dir: string) => {
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: dir, stdio: 'ignore' });
    t.after(() => { holder.kill(); });
    await new Promise(resolve => setTimeout(resolve, 300));
    return async () => { holder.kill(); await new Promise(resolve => holder.once('exit', resolve)); };
  };
  const gone = await create(s, 'gone');
  let release = await hold(join(gone.path!, 'src'));
  assert.deepEqual(await s.wt.removeWorktree(gone.id, { keepBranch: false, state: 'gone' }), { ok: false, reason: 'busy' });
  await release();
  const merged = await create(s, 'merged');
  release = await hold(join(merged.path!, 'src'));
  assert.deepEqual(await s.wt.removeWorktree(merged.id, { keepBranch: true, state: 'merged' }), { ok: false, reason: 'busy' });
  await release();
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 2, left: 0 });
  assert.equal(s.wt.get(gone.id)!.state, 'gone');
  assert.equal(s.wt.get(merged.id)!.state, 'merged');
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${merged.branch}`), 'ブランチを残す頼みも同じ');

  // 取り込み済みと決めて git branch -d まで進み、表に終わりを書く前に止まった
  const third = await create(s, 'third');
  writeFileSync(join(third.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(third.id, { commitLeftovers: true, message: 'x' })).ok);
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'merge', third.branch);
  gitIn(s.product, 'stash', 'pop');
  const lock = join(s.product, '.git', 'refs', 'heads', ...third.branch.split('/')) + '.lock';
  writeFileSync(lock, '');
  assert.deepEqual(await s.wt.removeWorktree(third.id, { keepBranch: false }), { ok: false, reason: 'failed' });
  unlinkSync(lock);
  gitIn(s.product, 'branch', '-D', third.branch);
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 1, left: 0 });
  assert.equal(s.wt.get(third.id)!.state, 'merged', 'ブランチを消したあと止まっても discarded にしない');
});

test('worktree: 表に無い・beat/ でない・場所が表と違う・大文字小文字だけ違うブランチや worktree は消さない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  assert.deepEqual(await s.wt.removeWorktree('deadbeef', { keepBranch: false }), { ok: false, reason: 'unknown' });

  const row = await create(s);
  s.db.prepare("UPDATE worktrees SET branch = 'main' WHERE id = ?").run(row.id);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.equal(gitIn(s.product, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.ok(existsSync(row.path!));
  s.db.prepare('UPDATE worktrees SET branch = ? WHERE id = ?').run(row.branch, row.id);

  // 持ち主の worktree（表に無いもの）を指す行
  const ownerWt = join(s.base, 'owner-wt');
  gitIn(s.product, 'worktree', 'add', '-q', '-b', 'owner-x', ownerWt);
  const foreignRow = { ...row, id: 'abcdef01', path: ownerWt, branch: 'beat/owner-x-1a2b' };
  s.db.prepare('INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, state, keep_branch, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, 1, 1)')
    .run(foreignRow.id, row.project_id, row.repo, 'task', ownerWt, foreignRow.branch, row.base, row.base, 'branch');
  assert.deepEqual(await s.wt.removeWorktree(foreignRow.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(existsSync(join(ownerWt, 'a.txt')), '持ち主の worktree が残る');

  // 置き場の外のフォルダ（大文字・8.3・末尾の . の書き方も）
  const outside = join(s.base, 'outside-folder-long-name');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep\n');
  const variants = [outside, ...(WINDOWS ? [outside.toUpperCase(), `${outside}.`, shortName(outside)].filter((v): v is string => Boolean(v)) : [])];
  for (const variant of variants) {
    s.db.prepare('UPDATE worktrees SET path = ? WHERE id = ?').run(variant, foreignRow.id);
    const result = await s.wt.removeWorktree(foreignRow.id, { keepBranch: false });
    assert.ok(existsSync(join(outside, 'keep.txt')), variant);
    if (!variant.endsWith('.')) assert.deepEqual(result, { ok: false, reason: 'foreign' }, variant);
    s.db.prepare("UPDATE worktrees SET state = 'branch' WHERE id = ?").run(foreignRow.id);
  }
  // 表と同じ形の名前で、置き場の外にあるフォルダ
  const lookalike = join(s.base, 'elsewhere', relative(s.data, dirname(row.path!)).split(/[\\/]/u).at(-1)!, 'abcdef01');
  mkdirSync(lookalike, { recursive: true });
  writeFileSync(join(lookalike, 'keep.txt'), 'keep\n');
  s.db.prepare('UPDATE worktrees SET path = ? WHERE id = ?').run(lookalike, foreignRow.id);
  assert.deepEqual(await s.wt.removeWorktree(foreignRow.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(existsSync(join(lookalike, 'keep.txt')));
  // 置き場の中でも、表の形（<製品>/<id>）でない名前のフォルダ
  const misnamed = join(dirname(row.path!), 'not-an-id');
  mkdirSync(misnamed);
  writeFileSync(join(misnamed, 'keep.txt'), 'keep\n');
  s.db.prepare('UPDATE worktrees SET path = ? WHERE id = ?').run(misnamed, foreignRow.id);
  assert.deepEqual(await s.wt.removeWorktree(foreignRow.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(existsSync(join(misnamed, 'keep.txt')));
  // beat/ でない持ち主のブランチ（どこにも取り出されていないもの）
  gitIn(s.product, 'branch', 'feature');
  s.db.prepare("UPDATE worktrees SET path = NULL, branch = 'feature' WHERE id = ?").run(foreignRow.id);
  assert.deepEqual(await s.wt.removeWorktree(foreignRow.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', 'refs/heads/feature'), '持ち主のブランチが残る');

  // 大文字小文字だけ違う持ち主のブランチ（Windows では同じファイルになる）
  gitIn(s.product, 'branch', 'beat/OWNER-1a2b');
  s.db.prepare("UPDATE worktrees SET path = NULL, branch = 'beat/owner-1a2b' WHERE id = ?").run(foreignRow.id);
  assert.equal((await s.wt.removeWorktree(foreignRow.id, { keepBranch: false })).ok, true);
  assert.ok(gitIn(s.product, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split('\n').includes('refs/heads/beat/OWNER-1a2b'), '持ち主のブランチが残る');
  assert.ok(existsSync(row.path!), '自分の worktree は何もしていない');
});

test('worktree: 製品のフォルダが作ったときと違う行は自動で消さない（見回りでも）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  const other = join(s.base, 'moved');
  mkdirSync(other);
  s.db.prepare('UPDATE projects SET root = ?, root_key = ? WHERE id = ?').run(other, rootKeyOf(other), s.projectId);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'repo_moved' });
  s.db.prepare("UPDATE worktrees SET state = 'removing' WHERE id = ?").run(row.id);
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 0, left: 1 });
  assert.ok(existsSync(row.path!));
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`));
});

test('worktree: 作業コピーの中のジャンクションの先は消えない（片づけ）。git worktree remove 自身もたどらない（A-3）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const outside = join(s.base, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'keep\n');
  const row = await create(s);
  link(outside, join(row.path!, 'src', 'linked'));
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false, discardLocal: true }), { ok: true, branchKept: false });
  assert.equal(existsSync(row.path!), false);
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep\n');

  // A-3: beat の外し方を通さず、git worktree remove --force だけで消したとき
  const direct = join(s.base, 'direct-wt');
  gitIn(s.product, 'worktree', 'add', '-q', '-b', 'probe-a3', direct);
  link(outside, join(direct, 'linked'));
  const removed = spawnSync('git', ['worktree', 'remove', '--force', direct], { cwd: s.product, encoding: 'utf8', env: GIT_ENV });
  t.diagnostic(`A-3: git worktree remove --force exit ${removed.status}, folder left: ${existsSync(direct) ? readdirSync(direct).join(',') : 'none'}, stderr: ${removed.stderr.trim()}`);
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep\n', 'git worktree remove はジャンクションの先へ入らない');
});

test('worktree: 作業コピーやその上の <製品> のフォルダがジャンクションに差し替わっていたら、中を歩かず消さない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const victim = join(s.base, 'victim');
  const deep = join(s.base, 'deep-target');
  mkdirSync(victim);
  mkdirSync(deep);
  writeFileSync(join(victim, 'keep.txt'), 'keep\n');
  writeFileSync(join(deep, 'keep.txt'), 'keep\n');
  link(deep, join(victim, 'innerlink'));
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' })).ok);
  // <id> をジャンクションに差し替える
  renameSync(row.path!, `${row.path!}-moved`);
  link(victim, row.path!);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(lstatSync(join(victim, 'innerlink')).isSymbolicLink(), '先のフォルダのリンクを外さない');
  assert.ok(existsSync(join(victim, 'keep.txt')));
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`));
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  // <製品> のフォルダをジャンクションに差し替える（<id> は先の中にある本物のフォルダ）
  unlinkSync(row.path!);
  const hashDir = dirname(row.path!);
  const victim2 = join(s.base, 'victim2');
  mkdirSync(join(victim2, row.id), { recursive: true });
  link(deep, join(victim2, row.id, 'innerlink'));
  renameSync(hashDir, `${hashDir}-moved`);
  link(victim2, hashDir);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(lstatSync(join(victim2, row.id, 'innerlink')).isSymbolicLink());
  assert.ok(existsSync(join(victim2, row.id)));
  unlinkSync(hashDir);
  renameSync(`${hashDir}-moved`, hashDir);
  renameSync(`${row.path!}-moved`, row.path!);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: false }, '元に戻せば消せる');
});

test('worktree: 自分のブランチがほかの場所で取り出されている・登録された作業コピーが別のブランチに移った行は消さない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const one = await create(s, 'first');
  gitIn(one.path!, 'checkout', '-q', '--detach');
  const ownerWt = join(s.base, 'owner-wt');
  gitIn(s.product, 'worktree', 'add', '-q', ownerWt, one.branch);
  assert.deepEqual(await s.wt.removeWorktree(one.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(existsSync(join(ownerWt, 'a.txt')));
  assert.ok(existsSync(join(one.path!, 'a.txt')));
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${one.branch}`));

  const two = await create(s, 'second');
  gitIn(two.path!, 'switch', '-q', '-c', 'other');
  assert.deepEqual(await s.wt.removeWorktree(two.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  assert.ok(existsSync(join(two.path!, 'a.txt')));
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', 'refs/heads/other'));
  assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${two.branch}`));
});

test('worktree: 作業コピーの .git のファイルが本体の管理フォルダを指していなければ、終えるのを断る（foreign）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const head = gitIn(s.product, 'rev-parse', 'HEAD');
  unlinkSync(join(row.path!, '.git'));
  writeFileSync(join(row.path!, '.git'), `gitdir: ${join(s.product, '.git')}\n`);
  assert.deepEqual(await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' }), { ok: false, reason: 'foreign' });
  assert.equal(gitIn(s.product, 'rev-parse', 'HEAD'), head);
  assert.equal(s.wt.get(row.id)!.state, 'active');
});

test('removeLinksInside: 根がリンクなら何もせず false。中のリンクはリンクだけ外し、先は残る', t => {
  const base = realpathSync.native(tempDir(t));
  const target = join(base, 'target');
  mkdirSync(join(target, 'sub'), { recursive: true });
  writeFileSync(join(target, 'keep.txt'), 'keep\n');
  link(join(target, 'sub'), join(target, 'innerlink'));
  link(target, join(base, 'root-link'));
  assert.equal(removeLinksInside(join(base, 'root-link')), false);
  assert.ok(lstatSync(join(target, 'innerlink')).isSymbolicLink(), '根のリンクの先へ入らない');
  const root = join(base, 'root');
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'file.txt'), 'x\n');
  link(target, join(root, 'a', 'b', 'deep'));
  link(target, join(root, '.git'));
  assert.equal(removeLinksInside(root), true);
  assert.equal(existsSync(join(root, 'a', 'b', 'deep')), false);
  assert.ok(existsSync(join(root, 'a', 'file.txt')));
  assert.ok(lstatSync(join(root, '.git')).isSymbolicLink(), '根の .git はそのまま（git に任せる）');
  assert.ok(existsSync(join(target, 'keep.txt')) && lstatSync(join(target, 'innerlink')).isSymbolicLink());
  assert.equal(removeLinksInside(join(base, 'missing')), false);
});

test('worktree: 本体の .git に、ほかの worktree の管理フォルダの印やリンクがあれば dirty_git_dir', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const outside = join(s.base, 'outside');
  mkdirSync(outside);
  const git = join(s.product, '.git');
  const cases: Array<[string, () => void, () => void]> = [
    ['commondir', () => writeFileSync(join(git, 'commondir'), '..\n'), () => unlinkSync(join(git, 'commondir'))],
    ['gitdir', () => writeFileSync(join(git, 'gitdir'), 'x\n'), () => unlinkSync(join(git, 'gitdir'))],
    ['refs/heads/beat', () => link(outside, join(git, 'refs', 'heads', 'beat')), () => unlinkSync(join(git, 'refs', 'heads', 'beat'))],
    ['logs/refs/heads/beat', () => { mkdirSync(join(git, 'logs', 'refs', 'heads'), { recursive: true }); link(outside, join(git, 'logs', 'refs', 'heads', 'beat')); }, () => unlinkSync(join(git, 'logs', 'refs', 'heads', 'beat'))],
    ['objects/<entry>', () => link(outside, join(git, 'objects', 'zz')), () => unlinkSync(join(git, 'objects', 'zz'))],
    ['worktrees/<entry>', () => { mkdirSync(join(git, 'worktrees'), { recursive: true }); link(outside, join(git, 'worktrees', 'zz')); }, () => unlinkSync(join(git, 'worktrees', 'zz'))],
  ];
  for (const [name, make, undo] of cases) {
    make();
    const made = await s.wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', title: name });
    assert.deepEqual(made, { ok: false, reason: 'dirty_git_dir' }, name);
    assert.deepEqual(readdirSync(outside), [], `${name}: リンクの先に何も書かない`);
    undo();
  }
  assert.equal(s.wt.list().length, 0);
  assert.ok((await s.wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', title: 'clean' })).ok, '戻せば作れる');
});

test('worktree: 作るときの名前は、詰めた参照（packed-refs）にしか無い既にあるブランチとも重ねない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  gitIn(s.product, 'branch', 'beat/restore-the-queue-1a2b');
  gitIn(s.product, 'pack-refs', '--all');
  unlinkSync(join(s.product, '.git', 'logs', 'refs', 'heads', 'beat', 'restore-the-queue-1a2b'));
  assert.equal(existsSync(join(s.product, '.git', 'refs', 'heads', 'beat', 'restore-the-queue-1a2b')), false, '参照のファイルも記録のファイルも無く、packed-refs にだけある');
  const parts = ['1a2b', 'aaaaaaaa', '3c4d', 'bbbbbbbb'];
  const wt = new Worktrees({ db: s.db, paths: { data: s.data }, config: () => s.config, projects: s.projects, random: () => parts.shift()! });
  const made = await wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', title: 'Restore the queue' });
  assert.ok(made.ok, JSON.stringify(made));
  assert.equal(made.row.branch, 'beat/restore-the-queue-3c4d');
  assert.equal(made.row.id, 'aaaaaaaa');
  assert.equal(gitIn(s.product, 'rev-parse', 'refs/heads/beat/restore-the-queue-1a2b'), made.row.base, '既にあるブランチはそのまま');
});

const finished = async (s: Setup, title = 'Restore the queue') => {
  const row = await create(s, title);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok, JSON.stringify(done));
  return { row, tip: done.tip };
};
const ownerCommit = (dir: string, file = 'w.txt'): string => {
  writeFileSync(join(dir, file), 'owner\n');
  gitIn(dir, 'add', file);
  gitIn(dir, 'commit', '-q', '-m', `owner ${file}`);
  return gitIn(dir, 'rev-parse', 'HEAD');
};
const reachable = (product: string, sha: string): boolean => gitIn(product, 'for-each-ref', '--contains', sha, '--format=%(refname)') !== '';

test('worktree P1: 本体の HEAD が外れて（detached）持ち主のコミットの上にあっても、取り込み済みとみなさず消さない。ほかの beat/ のブランチの上でも同じ', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const { row } = await finished(s);
  const w = ownerCommit(row.path!);
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, 'switch', '-q', '--detach', w);
  assert.equal(await s.wt.isMerged(row.id), false, '外れた HEAD は「今のブランチ」ではない');
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.ok(reachable(s.product, w), 'W はブランチから届く');
  // ほかの beat/ のブランチが W を含んでいて、本体がそこにいる
  const { row: two } = await finished(s, 'second');
  const w2 = ownerCommit(two.path!, 'w2.txt');
  gitIn(s.product, 'switch', '-q', '-c', 'beat/other-1a2b', w2);
  assert.equal(await s.wt.isMerged(two.id), false, 'beat/ のブランチは取り込み先にならない');
  assert.deepEqual(await s.wt.removeWorktree(two.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${two.branch}`), w2);
  gitIn(s.product, 'switch', '-q', 'main');
  gitIn(s.product, 'stash', 'pop');
});

test('worktree P1-sweep: 消しかけの行を見回りでやり直すときも、外れた HEAD を取り込み先にしない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const { row } = await finished(s);
  const w = ownerCommit(row.path!);
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, 'switch', '-q', '--detach', w);
  s.db.prepare("UPDATE worktrees SET state = 'removing', keep_branch = 0 WHERE id = ?").run(row.id);
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 1, left: 0 });
  assert.ok(reachable(s.product, w));
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  gitIn(s.product, 'switch', '-q', 'main');
  gitIn(s.product, 'stash', 'pop');
});

test('worktree P1-trial: 外れた HEAD の上で試しに取り込んでも merged にせず、ブランチの先が残る', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const { row } = await finished(s);
  const w = ownerCommit(row.path!);
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, 'switch', '-q', '--detach');
  gitIn(s.product, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'trial', row.branch);
  assert.equal(await s.wt.isMerged(row.id), false);
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  gitIn(s.product, 'switch', '-q', 'main');
  gitIn(s.product, 'stash', 'pop');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'branch_moved' });
  assert.ok(reachable(s.product, w));
});

test('worktree P5: merged と決めた行でも、今は取り込まれていなければブランチを残す（not_merged・branch）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const { row, tip } = await finished(s);
  gitIn(s.product, 'stash', '-u');
  const before = gitIn(s.product, 'rev-parse', 'HEAD');
  gitIn(s.product, 'merge', '-q', '--ff-only', row.branch);
  assert.equal(await s.wt.isMerged(row.id), true);
  assert.equal(s.wt.get(row.id)!.state, 'merged');
  gitIn(s.product, 'reset', '-q', '--hard', before);
  gitIn(s.product, 'stash', 'pop');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: true, note: 'not_merged' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${row.branch}`), tip);
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  // 頼みが merged でも同じ
  const { row: two, tip: tip2 } = await finished(s, 'second');
  assert.deepEqual(await s.wt.removeWorktree(two.id, { keepBranch: false, state: 'merged' }), { ok: true, branchKept: true, note: 'not_merged' });
  assert.equal(gitIn(s.product, 'rev-parse', `refs/heads/${two.branch}`), tip2);
  assert.equal(s.wt.get(two.id)!.state, 'branch');
});

test('worktree P4: D-13 の行（not_on_branch）と、先端が作ったときのままの行は、取り込み済みにしない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  gitIn(row.path!, 'switch', '-q', '--detach');
  ownerCommit(row.path!, 'work.txt');
  assert.deepEqual(await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' }), { ok: false, reason: 'not_on_branch' });
  assert.equal(await s.wt.isMerged(row.id), false);
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  s.db.prepare('UPDATE worktrees SET note = NULL WHERE id = ?').run(row.id);
  assert.equal(await s.wt.isMerged(row.id), false, '先端が base のままなら、取り込むものが無い');
  assert.equal(s.wt.get(row.id)!.state, 'branch');
  // ブランチに AI のコミットがあり、本体がそれを取り込んでいても、D-13 の行は取り込み済みにしない（本当の仕事は外れた HEAD にある）
  const two = await create(s, 'second');
  ownerCommit(two.path!, 'ai.txt');
  gitIn(two.path!, 'switch', '-q', '--detach');
  ownerCommit(two.path!, 'work2.txt');
  assert.deepEqual(await s.wt.finishWorktree(two.id, { commitLeftovers: true, message: 'x' }), { ok: false, reason: 'not_on_branch' });
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'merge', two.branch);
  gitIn(s.product, 'stash', 'pop');
  assert.equal(await s.wt.isMerged(two.id), false);
  assert.equal(s.wt.get(two.id)!.state, 'branch');
});

test('worktree: 取り出す前に止まった作りかけの行（作業コピーに .git しか無い）は、見回りが片づける', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  for (const name of readdirSync(row.path!)) if (name !== '.git') rmSync(join(row.path!, name), { recursive: true, force: true });
  assert.notEqual(gitIn(row.path!, 'status', '--porcelain=v1'), '', '索引にはファイルがあるので git には消えたように見える');
  s.db.prepare("UPDATE worktrees SET state = 'creating', updated_at = 1 WHERE id = ?").run(row.id);
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 1, left: 0 });
  assert.equal(existsSync(row.path!), false);
  assert.equal(s.wt.get(row.id)!.state, 'gone');
});

test('worktree P2: git worktree lock された作業コピーは消さない（locked）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const { row } = await finished(s);
  gitIn(s.product, 'worktree', 'lock', '--reason', 'owner keeps it', row.path!);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'locked' });
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false, discardLocal: true }), { ok: false, reason: 'locked' });
  assert.ok(existsSync(join(row.path!, 'c.txt')));
  assert.equal(s.wt.get(row.id)!.state, 'branch', '何も書かない');
  gitIn(s.product, 'worktree', 'unlock', row.path!);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: true, branchKept: false });
});

test('worktree P3: 作業コピーに書きかけ・追っていないファイル・外れた HEAD・取り込みの途中があれば、discardLocal なしでは消さない（dirty）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const cases: Array<[string, (dir: string) => void]> = [
    ['uncommitted', dir => writeFileSync(join(dir, 'a.txt'), 'changed\n')],
    ['untracked', dir => writeFileSync(join(dir, 'new-file.txt'), 'x\n')],
    ['detached', dir => { gitIn(dir, 'switch', '-q', '--detach'); ownerCommit(dir, 'detached.txt'); }],
    ['merge in progress', dir => {
      const side = ownerCommit(dir, 'side.txt');
      gitIn(dir, 'reset', '-q', '--hard', 'HEAD~1');
      writeFileSync(join(dir, 'side.txt'), 'conflict\n');
      gitIn(dir, 'add', 'side.txt');
      gitIn(dir, 'commit', '-q', '-m', 'mine');
      assert.equal(gitOk(dir, '-c', 'commit.gpgsign=false', 'merge', side), false, 'ぶつかって止まる');
      writeFileSync(join(dir, 'side.txt'), 'conflict\n');
      gitIn(dir, 'add', 'side.txt');
      assert.equal(gitIn(dir, 'status', '--porcelain=v1', '--untracked-files=all'), '', '書きかけは無く、取り込みの途中だけが残る');
    }],
  ];
  for (const [name, make] of cases) {
    const { row } = await finished(s, name);
    make(row.path!);
    assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'dirty' }, name);
    assert.ok(existsSync(join(row.path!, 'c.txt')), name);
    assert.equal(s.wt.get(row.id)!.state, 'branch', `${name}: 何も書かない`);
    s.db.prepare("UPDATE worktrees SET state = 'creating', updated_at = 1 WHERE id = ?").run(row.id);
    assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 0, left: 1 }, `${name}: 作りかけの残りでも同じ`);
    assert.ok(existsSync(join(row.path!, 'c.txt')), name);
    s.db.prepare("UPDATE worktrees SET state = 'branch' WHERE id = ?").run(row.id);
    const discarded = await s.wt.removeWorktree(row.id, { keepBranch: true, discardLocal: true });
    assert.ok(discarded.ok, `${name}: ${JSON.stringify(discarded)}`);
    assert.equal(existsSync(row.path!), false, name);
  }
});

test('worktree: 詰めた beat のブランチと、大文字小文字だけ違う持ち主のブランチがあるときは、どちらも消さない（foreign）', { skip: !gitAvailable || !WINDOWS }, async t => {
  const s = setup(t);
  const { row, tip } = await finished(s, 'task');
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: true }), { ok: true, branchKept: true });
  gitIn(s.product, 'pack-refs', '--all');
  const upper = row.branch.replace('beat/task', 'beat/TASK');
  gitIn(s.product, 'update-ref', `refs/heads/${upper}`, row.base);
  const refs = gitIn(s.product, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/beat/').split('\n');
  assert.ok(refs.includes(`refs/heads/${row.branch} ${tip}`) && refs.includes(`refs/heads/${upper} ${row.base}`), refs.join('|'));
  s.db.prepare("UPDATE worktrees SET state = 'branch' WHERE id = ?").run(row.id);
  assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'foreign' });
  const after = gitIn(s.product, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/beat/').split('\n');
  assert.ok(after.includes(`refs/heads/${row.branch} ${tip}`), '自分のブランチも残る');
  assert.ok(after.includes(`refs/heads/${upper} ${row.base}`), '持ち主のブランチが残る');
});

test('worktree: 待っているあいだに行が消しかけに変わったら、isMerged も finishWorktree も状態を上書きしない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const race = (id: string) => {
    let armed = true;
    return new Worktrees({ db: s.db, paths: { data: s.data }, config: () => s.config, projects: { list: o => s.projects.list(o), get: pid => {
      if (armed) { armed = false; setImmediate(() => { s.db.prepare("UPDATE worktrees SET state = 'removing' WHERE id = ?").run(id); }); }
      return s.projects.get(pid);
    } } });
  };
  const { row } = await finished(s);
  gitIn(s.product, 'stash', '-u');
  gitIn(s.product, '-c', 'commit.gpgsign=false', 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
  gitIn(s.product, 'stash', 'pop');
  await race(row.id).isMerged(row.id);
  assert.equal(s.wt.get(row.id)!.state, 'removing', 'isMerged が merged で上書きしない');
  const two = await create(s, 'second');
  writeFileSync(join(two.path!, 'c.txt'), 'new\n');
  await race(two.id).finishWorktree(two.id, { commitLeftovers: true, message: 'x' });
  assert.equal(s.wt.get(two.id)!.state, 'removing', 'finishWorktree が branch で上書きしない');
});

test('worktree: 消せないときは removing で残り、次の見回りで消える。作りかけで止まった行も片づける', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' })).ok);
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: join(row.path!, 'src'), stdio: 'ignore' });
  t.after(() => { holder.kill(); });
  await new Promise(resolve => setTimeout(resolve, 300));
  if (WINDOWS) {
    assert.deepEqual(await s.wt.removeWorktree(row.id, { keepBranch: false }), { ok: false, reason: 'busy' });
    assert.equal(s.wt.get(row.id)!.state, 'removing');
    assert.equal(s.wt.get(row.id)!.keep_branch, 0);
    assert.ok(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`), 'フォルダを消せるまでブランチは触らない');
  } else {
    s.db.prepare("UPDATE worktrees SET state = 'removing', keep_branch = 0 WHERE id = ?").run(row.id);
  }
  holder.kill();
  await new Promise(resolve => holder.once('exit', resolve));
  // 作りかけで止まった行（ブランチだけできた）
  gitIn(s.product, 'branch', 'beat/left-over-1a2b');
  s.db.prepare("INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, state, keep_branch, created_at, updated_at) VALUES ('0badc0de', ?, ?, NULL, NULL, 'task', ?, 'beat/left-over-1a2b', ?, ?, 'creating', 0, 1, 1)")
    .run(s.projectId, s.product, join(dirname(row.path!), '0badc0de'), row.base, row.base);
  // 作りかけでも新しい行（ほかのプロセスが作っている最中かもしれない）には触らない
  s.db.prepare("INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, state, keep_branch, created_at, updated_at) VALUES ('0badc0df', ?, ?, NULL, NULL, 'task', NULL, 'beat/fresh-1a2b', ?, ?, 'creating', 0, ?, ?)")
    .run(s.projectId, s.product, row.base, row.base, Date.now(), Date.now());
  assert.deepEqual(await s.wt.sweepWorktrees(), { removed: 2, left: 0 });
  assert.equal(existsSync(row.path!), false);
  assert.equal(s.wt.get(row.id)!.state, 'discarded');
  assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`), false);
  assert.equal(s.wt.get('0badc0de')!.state, 'gone');
  assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', 'refs/heads/beat/left-over-1a2b'), false);
  assert.equal(s.wt.get('0badc0df')!.state, 'creating');
});

test('worktree: 置き場の決め方（D-9）と unsafe_place', t => {
  const base = realpathSync.native(tempDir(t));
  const config = defaultConfig();
  // 上に何も無いデータのフォルダ
  const plain = join(base, 'plain', 'data');
  mkdirSync(plain, { recursive: true });
  assert.deepEqual(worktreeRoot({ data: plain }, config), { ok: true, root: join(plain, 'worktrees') });
  // beat のフォルダの中のデータ（上に node_modules と package.json）
  const app = join(base, 'app');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{}');
  mkdirSync(join(app, 'data'));
  const home = join(base, 'home');
  const away = worktreeRoot({ data: join(app, 'data') }, config, { home });
  assert.ok(away.ok);
  assert.match(away.root, /[\\/]\.beat[\\/]worktrees[\\/][0-9a-f]{8}$/u);
  assert.ok(away.root.startsWith(home));
  const other = join(app, 'data2');
  mkdirSync(other);
  const away2 = worktreeRoot({ data: other }, config, { home });
  assert.ok(away2.ok && away2.root !== away.root, 'データのフォルダごとに別の置き場');
  // 設定の置き場
  const custom = join(base, 'custom', 'wt');
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: custom } }), { ok: true, root: custom });
  mkdirSync(join(base, 'custom'));
  writeFileSync(join(base, 'custom', 'package.json'), '{}');
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: custom } }), { ok: false, reason: 'unsafe_place' });
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: 'relative/wt' } }), { ok: false, reason: 'unsafe_place' });
  // beat のデータのフォルダの中（git-run は見回りが消す）。決まった置き場（<data>/worktrees）とその中だけは通す
  for (const inside of [plain, join(plain, 'git-run'), join(plain, 'git-run', 'wt'), join(plain, 'snapshots'), ...(WINDOWS ? [join(plain.toUpperCase(), 'git-run')] : [])]) {
    assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: inside } }), { ok: false, reason: 'unsafe_place' }, inside);
  }
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: join(plain, 'worktrees') } }), { ok: true, root: join(plain, 'worktrees') });
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: join(plain, 'worktrees', 'mine') } }), { ok: true, root: join(plain, 'worktrees', 'mine') });
  // 製品のフォルダの中
  const product = join(base, 'product');
  mkdirSync(product);
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: join(product, 'wt') } }, { productRoots: [product] }), { ok: false, reason: 'unsafe_place' });
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: join(product.toUpperCase(), 'wt') } }, { productRoots: [product] }).ok, !WINDOWS);
  // 置き場か途中がリンク
  const target = join(base, 'target');
  mkdirSync(target);
  const linked = join(base, 'linked', 'data');
  mkdirSync(linked, { recursive: true });
  link(target, join(linked, 'worktrees'));
  assert.deepEqual(worktreeRoot({ data: linked }, config), { ok: false, reason: 'unsafe_place' });
  link(target, join(base, 'via'));
  assert.deepEqual(worktreeRoot({ data: plain }, { worker: { ...config.worker, worktreeRoot: join(base, 'via', 'wt') } }), { ok: false, reason: 'unsafe_place' });
});

test('worktree: 置き場がリンクなら作らず、リンクの先には何も書かない', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const target = join(s.base, 'target');
  mkdirSync(target);
  link(target, join(s.data, 'worktrees'));
  const before = mainState(s.product);
  assert.deepEqual(await s.wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', title: 'x' }), { ok: false, reason: 'unsafe_place' });
  assert.deepEqual(readdirSync(target), []);
  assert.deepEqual(s.wt.list(), []);
  assert.deepEqual(mainState(s.product), before);
});

test('worktree: 作った worktree の中から、置き場の上の node_modules に Node も npm run も届かない', { skip: !gitAvailable }, async t => {
  const base = realpathSync.native(tempDir(t));
  const app = join(base, 'app');
  mkdirSync(join(app, 'node_modules', 'beat-only-dep'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'beat-only-dep', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(app, 'node_modules', '.bin'));
  writeFileSync(join(app, 'package.json'), '{}');
  const s = setup(t, { data: join(app, 'data'), home: join(base, 'home') });
  const row = await create(s);
  assert.ok(row.path!.startsWith(join(base, 'home', '.beat', 'worktrees')), row.path!);
  assert.throws(() => createRequire(join(row.path!, 'x.js')).resolve('beat-only-dep'), /Cannot find module/u);
  assert.equal(createRequire(join(app, 'data', 'x.js')).resolve('beat-only-dep'), join(app, 'node_modules', 'beat-only-dep', 'index.js'), '試験の力: データのフォルダからは届く');
  const npm = spawnSync(WINDOWS ? 'npm.cmd' : 'npm', ['run', '--silent', 'path'], { cwd: row.path!, encoding: 'utf8', shell: WINDOWS });
  assert.equal(npm.status, 0, npm.stderr);
  const bins = npm.stdout.trim().split(delimiter).filter(p => /node_modules[\\/]\.bin$/u.test(p));
  assert.ok(bins.length > 0);
  assert.deepEqual(bins.filter(p => existsSync(p) && !p.includes(`${join('node_modules', 'npm')}`)), [], 'npm run が足す .bin のうち、ある所が無い');
});

test('worktree: .git のファイルを消しても、GIT_CEILING_DIRECTORIES=<置き場> の git は上のリポジトリを見つけない', { skip: !gitAvailable }, async t => {
  const base = realpathSync.native(tempDir(t));
  const outer = join(base, 'outer');
  mkdirSync(outer);
  gitIn(outer, 'init', '-q', '-b', 'main');
  const s = setup(t, { data: join(outer, 'data') });
  const place = s.wt.place();
  assert.ok(place.ok);
  const row = await create(s);
  unlinkSync(join(row.path!, '.git'));
  const plainRun = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: row.path!, encoding: 'utf8', env: GIT_ENV });
  assert.equal(realpathSync.native(plainRun.stdout.trim()), outer, '試験の力: 止めなければ上のリポジトリが見つかる');
  const ceiling = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: row.path!, encoding: 'utf8', env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: place.root } });
  assert.notEqual(ceiling.status, 0);
  assert.match(ceiling.stderr, /not a git repository/u);
});

test('worktree: git の設定にコードを動かす項目があるリポジトリでは作らない。extensions.worktreeConfig は通す', { skip: !gitAvailable }, async t => {
  const bad = setup(t, { productConfig: ['filter.x.clean=evil'] });
  const before = mainState(bad.product);
  assert.deepEqual(await bad.wt.createWorktree({ projectId: bad.projectId, root: bad.product, kind: 'task', title: 'x' }), { ok: false, reason: 'unsafe' });
  assert.deepEqual(bad.wt.list(), []);
  assert.equal(gitIn(bad.product, 'for-each-ref', 'refs/heads/beat/'), '');
  assert.deepEqual(mainState(bad.product), before);

  const ok = setup(t, { productConfig: ['extensions.worktreeConfig=true'] });
  const row = await create(ok);
  assert.equal(row.state, 'active');
});

test('worktree: 本体の .git の worktrees がリンクなら dirty_git_dir。git でないフォルダは not_git', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const target = join(s.base, 'admin-target');
  mkdirSync(target);
  link(target, join(s.product, '.git', 'worktrees'));
  assert.deepEqual(await s.wt.createWorktree({ projectId: s.projectId, root: s.product, kind: 'task', title: 'x' }), { ok: false, reason: 'dirty_git_dir' });
  assert.deepEqual(readdirSync(target), []);

  const plainDir = join(s.base, 'plain-product');
  mkdirSync(plainDir);
  const plainId = s.projects.create({ name: 'plain', root: plainDir, rootKey: rootKeyOf(plainDir), checkCommand: null }).id;
  assert.deepEqual(await s.wt.createWorktree({ projectId: plainId, root: plainDir, kind: 'task', title: 'x' }), { ok: false, reason: 'not_git' });
});

test('worktree: ブランチの名前（日本語の題・空の題・長い題・同じ題が 2 つ）', { skip: !gitAvailable }, async t => {
  assert.equal(branchSlug('キューを戻す', 'task'), 'task');
  assert.equal(branchSlug('', 'fix'), 'fix');
  assert.equal(branchSlug('  Fix: the Queue -- restore!  ', 'task'), 'fix-the-queue-restore');
  assert.equal(branchSlug('a'.repeat(29) + ' bcd', 'task'), 'a'.repeat(29));
  assert.equal(branchSlug('Café ünïcode', 'task'), 'cafe-unicode');
  const s = setup(t);
  const one = await create(s, 'キューを戻す');
  const two = await create(s, 'キューを戻す');
  assert.match(one.branch, /^beat\/task-[0-9a-f]{4}$/u);
  assert.notEqual(one.branch, two.branch);
  assert.notEqual(one.path, two.path);
});

test('removeTree: ジャンクションはリンクだけ外し、under の外（大文字・8.3・末尾の .・途中のリンク）と under 自身は断る', t => {
  const base = realpathSync.native(tempDir(t));
  const under = join(base, 'under');
  const outside = join(base, 'outside-long-folder-name');
  mkdirSync(join(under, 'tree', 'deep'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel.txt'), 'keep\n');
  writeFileSync(join(under, 'tree', 'deep', 'f.txt'), 'x');
  writeFileSync(join(under, 'tree', 'ro.txt'), 'x', { mode: 0o444 });
  link(outside, join(under, 'tree', 'deep', 'linked'));
  for (const variant of [outside, ...(WINDOWS ? [outside.toUpperCase(), `${outside}.`, shortName(outside)].filter((v): v is string => Boolean(v)) : [])]) {
    assert.deepEqual(removeTree(variant, { under }), { ok: false, reason: 'outside' }, variant);
  }
  link(outside, join(under, 'via'));
  assert.deepEqual(removeTree(join(under, 'via', 'sentinel.txt'), { under }), { ok: false, reason: 'outside' }, '途中のリンクの先');
  assert.deepEqual(removeTree(under, { under }), { ok: false, reason: 'outside' });
  assert.deepEqual(removeTree(join(under, '..', 'outside-long-folder-name'), { under }), { ok: false, reason: 'outside' });
  assert.deepEqual(removeTree(join(under, 'tree'), { under }), { ok: true });
  assert.equal(existsSync(join(under, 'tree')), false);
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep\n');
  assert.deepEqual(removeTree(join(under, 'via'), { under }), { ok: true }, 'リンク自身はリンクだけ外す');
  assert.equal(readFileSync(join(outside, 'sentinel.txt'), 'utf8'), 'keep\n');
  assert.deepEqual(removeTree(join(under, 'missing'), { under }), { ok: true });
});

test('worktree: beat/ のブランチを足しても Pending の push の指紋は変わらず、先端は push の確かめの一覧に入る', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const before = await pushFacts([{ dir: s.product }], s.data);
  const row = await create(s);
  const after = await pushFacts([{ dir: s.product }], s.data);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.ok(after.tips?.includes(row.base));
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  const done = await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' });
  assert.ok(done.ok);
  const finished = await pushFacts([{ dir: s.product }], s.data);
  assert.equal(finished.fingerprint, before.fingerprint);
  assert.ok(finished.tips?.includes(done.tip), '--all の push では今までどおり確かめの一覧で見る');
  gitIn(s.product, 'branch', 'owner-branch', done.tip);
  assert.notEqual((await pushFacts([{ dir: s.product }], s.data)).fingerprint, before.fingerprint, '試験の力: ほかのブランチでは変わる');
});

test('worktree: App を起こすと見回りが消しかけの行を片づける（起動の 1 回）', { skip: !gitAvailable }, async t => {
  const s = setup(t);
  const row = await create(s);
  writeFileSync(join(row.path!, 'c.txt'), 'new\n');
  assert.ok((await s.wt.finishWorktree(row.id, { commitLeftovers: true, message: 'x' })).ok);
  s.db.prepare("UPDATE worktrees SET state = 'removing', keep_branch = 0 WHERE id = ?").run(row.id);
  const { App } = await import('../src/app.ts');
  const { resolvePaths } = await import('../src/paths.ts');
  const paths = { ...resolvePaths(s.data), env: join(s.base, '.env') };
  const app = new App({ paths, databasePath: join(s.base, 'beat.db'), log: () => undefined, workerTimers: false });
  try {
    for (let i = 0; i < 100 && app.worktrees.get(row.id)?.state === 'removing'; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(app.worktrees.get(row.id)!.state, 'discarded');
    assert.equal(existsSync(row.path!), false);
    assert.equal(gitOk(s.product, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}`), false);
  } finally { await app.close(); }
});
