import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { findGitDir, inspectRepo } from '../src/tools/hooks/git-repo.ts';
import { tempDir } from './helpers.ts';

const PLAIN = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';

function makeGitDir(dir: string, config = PLAIN): string {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), config);
  return dir;
}

// 165: リンク名のあとの `..` は、POSIX ではリンクの先の 1 つ上を指す。resolve は先に畳むので、見ている場所と git が使う場所がずれる。
// 畳んだ先は本物の git のフォルダに見えるように作り、「リンクのあとの .. があれば読めない（今回だけ）」だけで差が出るようにする

test('165: gitdir の中でリンクのあとに .. が来れば、畳んだ先が本物に見えても、たどらずに「読めない」にする', t => {
  const base = tempDir(t);
  const away = join(base, 'away');
  mkdirSync(away);
  const prod = join(base, 'prod');
  mkdirSync(prod);
  makeGitDir(join(prod, 'real.git'));
  symlinkSync(away, join(prod, 'j'), 'junction');

  const viaRelative = join(prod, 'a');
  mkdirSync(viaRelative);
  symlinkSync(away, join(viaRelative, 'j'), 'junction');
  makeGitDir(join(viaRelative, 'real.git'));
  writeFileSync(join(viaRelative, '.git'), 'gitdir: j/../real.git\n');
  assert.equal(findGitDir(viaRelative)?.broken, true, '相対');
  assert.equal(inspectRepo(viaRelative).unreadable, true, '相対');

  const viaAbsolute = join(prod, 'b');
  mkdirSync(viaAbsolute);
  writeFileSync(join(viaAbsolute, '.git'), `gitdir: ${prod}/j/../real.git\n`);
  assert.equal(findGitDir(viaAbsolute)?.broken, true, '絶対');
  assert.equal(inspectRepo(viaAbsolute).unreadable, true, '絶対');
});

test('165: commondir の中でリンクのあとに .. が来れば、「読めない」にする', t => {
  const base = tempDir(t);
  const away = join(base, 'away');
  mkdirSync(away);
  const repo = join(base, 'repo');
  const gitDir = join(repo, '.git');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync(away, join(gitDir, 'j'), 'junction');
  makeGitDir(join(gitDir, 'common'));
  writeFileSync(join(gitDir, 'commondir'), 'j/../common\n');
  assert.equal(findGitDir(repo)?.broken, true);
  assert.equal(inspectRepo(repo).unreadable, true);
});

test('165: alternates の行の中でリンクのあとに .. が来れば、「読めない」にする', t => {
  const base = tempDir(t);
  const away = join(base, 'away');
  mkdirSync(away);
  const repo = join(base, 'repo');
  const gitDir = makeGitDir(join(repo, '.git'));
  mkdirSync(join(gitDir, 'objects', 'info'));
  symlinkSync(away, join(gitDir, 'objects', 'j'), 'junction');
  mkdirSync(join(gitDir, 'objects', 'store', 'objects'), { recursive: true });
  writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), 'j/../store/objects\n');
  assert.equal(inspectRepo(repo).unreadable, true);
});

test('165: リンクを通らない .. （ふつうのフォルダのあと・先頭）は、今までどおり読める', t => {
  const base = tempDir(t);
  const prod = join(base, 'prod');
  mkdirSync(prod);
  makeGitDir(join(prod, 'real.git'));

  const plainDir = join(prod, 'a');
  mkdirSync(join(plainDir, 'sub'), { recursive: true });
  writeFileSync(join(plainDir, '.git'), 'gitdir: sub/../../real.git\n');
  assert.equal(inspectRepo(plainDir).unreadable, false, 'ふつうのフォルダのあとの ..');
  assert.equal(inspectRepo(plainDir).found, true);

  const leading = join(prod, 'b');
  mkdirSync(leading);
  writeFileSync(join(leading, '.git'), 'gitdir: ../real.git\n');
  assert.equal(inspectRepo(leading).unreadable, false, '先頭の ..');

  const common = join(prod, 'c');
  const commonGit = join(common, '.git');
  mkdirSync(commonGit, { recursive: true });
  writeFileSync(join(commonGit, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(commonGit, 'commondir'), '../../real.git\n');
  assert.equal(inspectRepo(common).unreadable, false, 'commondir の先頭の ..');

  const alt = join(prod, 'd');
  const altGit = makeGitDir(join(alt, '.git'));
  mkdirSync(join(altGit, 'objects', 'info'));
  writeFileSync(join(altGit, 'objects', 'info', 'alternates'), '../../../real.git/objects\n');
  assert.equal(inspectRepo(alt).unreadable, false, 'alternates の先頭の ..');
});
