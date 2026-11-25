import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findGitDir, inspectRepo } from '../src/tools/hooks/git-repo.ts';
import { tempDir } from './helpers.ts';

const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const GIT_REPO = pathToFileURL(fileURLToPath(new URL('../src/tools/hooks/git-repo.ts', import.meta.url))).href;

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

// 165（レビューの指摘）: POSIX ではバックスラッシュはふつうの名前の文字。区切りに数えると、l、k をバックスラッシュでつないだ名前のリンクのあとの .. を見逃し、見る場所と git が使う場所がずれる。
// Windows では名前にバックスラッシュを使えないので、実機の POSIX だけで動かす
const POSIX_ONLY = process.platform === 'win32' && 'Windows では名前にバックスラッシュを使えない';

test('165: （POSIX のみ）名前にバックスラッシュを含むリンクのあとの .. も、gitdir・commondir・alternates で「読めない」にする', { skip: POSIX_ONLY }, t => {
  const base = tempDir(t);
  const away = join(base, 'away');
  mkdirSync(away);

  const viaFile = join(base, 'a');
  mkdirSync(viaFile);
  symlinkSync(away, join(viaFile, 'l\\k'));
  makeGitDir(join(viaFile, 'real.git'));
  writeFileSync(join(viaFile, '.git'), 'gitdir: l\\k/../real.git\n');
  assert.equal(findGitDir(viaFile)?.broken, true, 'gitdir');
  assert.equal(inspectRepo(viaFile).unreadable, true, 'gitdir');

  const viaCommon = join(base, 'b');
  const commonGit = join(viaCommon, '.git');
  mkdirSync(commonGit, { recursive: true });
  writeFileSync(join(commonGit, 'HEAD'), 'ref: refs/heads/main\n');
  symlinkSync(away, join(commonGit, 'l\\k'));
  makeGitDir(join(commonGit, 'common'));
  writeFileSync(join(commonGit, 'commondir'), 'l\\k/../common\n');
  assert.equal(findGitDir(viaCommon)?.broken, true, 'commondir');

  const viaAlt = join(base, 'c');
  const altGit = makeGitDir(join(viaAlt, '.git'));
  mkdirSync(join(altGit, 'objects', 'info'));
  symlinkSync(away, join(altGit, 'objects', 'l\\k'));
  mkdirSync(join(altGit, 'objects', 'store', 'objects'), { recursive: true });
  writeFileSync(join(altGit, 'objects', 'info', 'alternates'), 'l\\k/../store/objects\n');
  assert.equal(inspectRepo(viaAlt).unreadable, true, 'alternates');
});

test('165: （POSIX のみ）名前にバックスラッシュを含むふつうのフォルダのあとの .. は、今までどおり読める', { skip: POSIX_ONLY }, t => {
  const base = tempDir(t);
  const dir = join(base, 'a');
  mkdirSync(join(dir, 'p\\q'), { recursive: true });
  makeGitDir(join(dir, 'real.git'));
  writeFileSync(join(dir, '.git'), 'gitdir: p\\q/../real.git\n');
  assert.equal(inspectRepo(dir).unreadable, false);
  assert.equal(inspectRepo(dir).found, true);
});

// 上の試験は実機の POSIX でしか動かない。Windows でも赤くなるように、子のプロセスで POSIX を模して dotDotAfterLink を直接見る
// （process.platform を linux、node:path を posix の関数にし、lstat は決めた名前だけリンクと答える）
test('165（POSIX を模す）: 区切りは / だけ。名前にバックスラッシュを含むリンクのあとの .. も見つけ、ふつうのフォルダのあとの .. は見つけない', () => {
  const script = [
    "import path from 'node:path';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    `const mod = await import(${JSON.stringify(GIT_REPO)});`,
    "for (const k of ['resolve', 'relative', 'join', 'dirname', 'basename', 'isAbsolute', 'normalize', 'parse', 'sep', 'delimiter']) path[k] = path.posix[k];",
    "const links = new Set(['/base/dir/l\\\\k', '/base/dir/lnk']);",
    "fs.lstatSync = p => { if (links.has(p)) return { isSymbolicLink: () => true }; if (p.startsWith('/base')) return { isSymbolicLink: () => false }; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };",
    'syncBuiltinESMExports();',
    "const raws = ['l\\\\k/../real.git', 'lnk/../real.git', '/base/dir/l\\\\k/../real.git', 'sub/../real.git', '../real.git', 'p\\\\q/../real.git', 'a\\\\..\\\\b'];",
    "process.stdout.write(JSON.stringify(raws.map(raw => mod.dotDotAfterLink('/base/dir', raw))));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [true, true, true, false, false, false, false]);
});
