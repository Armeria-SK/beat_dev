import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitDirLinkFree, repoInside } from '../src/tools/hooks/product-run.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function git(cwd: string, args: string[]): string | undefined {
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  return done.status === 0 ? done.stdout : undefined;
}

// 製品のフォルダ（git init 済み・コミット 1 つ）と、その外の置き場を作る
function setup(t: Parameters<typeof tempDir>[0]): { product: string; gitDir: string; outside: string } {
  const base = realpathSync.native(tempDir(t));
  const product = join(base, 'product');
  const outside = join(base, 'outside');
  mkdirSync(product);
  mkdirSync(outside);
  assert.notEqual(git(product, ['init', '-q', '-b', 'main']), undefined);
  assert.notEqual(git(product, ['commit', '-q', '--allow-empty', '-m', 'first']), undefined);
  return { product, gitDir: join(product, '.git'), outside };
}

// .git の中の file を、外のファイルとのハードリンクに替える（中身は今のまま）
function hardLinkOut(file: string, outside: string, name: string): void {
  const target = join(outside, name);
  writeFileSync(target, readFileSync(file));
  rmSync(file);
  linkSync(target, file);
}

test('G3: .git の直下・refs・logs のファイルが外のファイルとハードリンクなら、置き場は「リンク無し」と言わない', { skip: !gitAvailable && 'git が無い' }, t => {
  for (const file of [join('logs', 'HEAD'), 'COMMIT_EDITMSG', join('refs', 'heads', 'main'), join('logs', 'refs', 'heads', 'main')]) {
    const { gitDir, outside } = setup(t);
    assert.equal(gitDirLinkFree(gitDir), true, `${file}: ハードリンクが無ければ true`);
    hardLinkOut(join(gitDir, file), outside, 'target.log');
    assert.equal(gitDirLinkFree(gitDir), false, `${file}: 外とハードリンクなら false`);
  }
});

test('G3: ハードリンクの置き場は、製品の中の git add・commit を判定役なしで通す道（repoInside）から外れる', { skip: !gitAvailable && 'git が無い' }, t => {
  const { product, gitDir, outside } = setup(t);
  const run = (dir: string, args: string[]): string | undefined => git(dir, args);
  assert.equal(repoInside(product, product, run), true, 'ふつうの製品は通る');
  hardLinkOut(join(gitDir, 'logs', 'HEAD'), outside, 'reflog-target');
  assert.equal(repoInside(product, product, run), false, 'logs/HEAD が外とハードリンクなら判定役の道へ戻る');
});

test('G3: objects の下のハードリンク（git clone --local が作る正しいもの）は、今までどおり見ない', { skip: !gitAvailable && 'git が無い' }, t => {
  const { product, gitDir, outside } = setup(t);
  const loose = join(gitDir, 'objects', 'ab');
  mkdirSync(loose, { recursive: true });
  writeFileSync(join(loose, 'cdef'), 'x');
  hardLinkOut(join(loose, 'cdef'), outside, 'object-target');
  const pack = join(gitDir, 'objects', 'pack');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'p.pack'), 'x');
  hardLinkOut(join(pack, 'p.pack'), outside, 'pack-target');
  writeFileSync(join(gitDir, 'objects', 'stray'), 'x');
  hardLinkOut(join(gitDir, 'objects', 'stray'), outside, 'stray-target');
  assert.equal(gitDirLinkFree(gitDir), true);
  assert.equal(repoInside(product, product, (dir, args) => git(dir, args)), true);
});
