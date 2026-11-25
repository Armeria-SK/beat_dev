import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { shellRuleShape } from '../src/tools/approval-rules.ts';
import { gitDirLinkFree, productRunOf, repoInside, type ProductRunResult } from '../src/tools/hooks/product-run.ts';
import type { ScopePolicy } from '../src/tools/hooks/scope.ts';
import type { StatementFacts } from '../src/tools/hooks/shell-facts.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
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

// ── 審査の指摘: ハードリンクは「判定役を飛ばす許可」だけを止める。持ち主へ回す確かめ（鍵のメッセージ・鍵のファイルの add）は、ハードリンクがあっても働く ──

const KEY_MESSAGE = 'git commit --allow-empty -m "key AKIAABCDEFGHIJKLMNOP"';

function product(t: Parameters<typeof tempDir>[0]) {
  const s = setup(t);
  const policy: ScopePolicy = { roots: [{ path: s.product, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(dirname(s.product), 'skills') };
  const run = (dir: string, args: string[]): string | undefined => git(dir, args);
  const stepFour = (command: string): ProductRunResult => {
    const verdict = checkShellCommand(command, s.product, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
    assert.equal(verdict.decision, 'ask', `${command}: 前提（順 4 まで届く）`);
    return productRunOf({ root: s.product, verdict, which: () => undefined, ownerHooks: () => false, git: run });
  };
  return { ...s, stepFour, hardLink: (file: string) => hardLinkOut(join(s.gitDir, file), s.outside, 'target.log') };
}

test('G3 審査: ハードリンクがあっても、鍵の入ったコミットメッセージは持ち主へ回る（判定役へ落とさない）', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  assert.deepEqual(p.stepFour(KEY_MESSAGE), { secretMessage: true }, '前提: ハードリンクが無ければ持ち主へ');
  p.hardLink(join('logs', 'HEAD'));
  assert.deepEqual(p.stepFour(KEY_MESSAGE), { secretMessage: true }, 'logs/HEAD がハードリンクでも持ち主へ');
  assert.deepEqual(p.stepFour('git add README.md && git commit --allow-empty -m "key AKIAABCDEFGHIJKLMNOP"'), { secretMessage: true }, '前の文が普通の add でも、あとの文の鍵メッセージは持ち主へ');
});

test('G3 審査: ハードリンクがあっても、鍵のファイルの git add は持ち主へ回る', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  writeFileSync(join(p.product, 'credentials.txt'), 'x');
  assert.deepEqual(p.stepFour('git add credentials.txt'), { secret: 'credentials.txt' }, '前提: ハードリンクが無ければ持ち主へ');
  p.hardLink(join('logs', 'HEAD'));
  assert.deepEqual(p.stepFour('git add credentials.txt'), { secret: 'credentials.txt' }, 'ハードリンクでも持ち主へ');
  writeFileSync(join(p.product, 'plain.txt'), 'x');
  assert.deepEqual(p.stepFour('git add -A'), { secret: 'credentials.txt' }, '名前を挙げない add -A も、見つけた鍵のファイルで持ち主へ');
});

test('G3 審査: ハードリンクのある置き場の、ふつうの git add・commit は判定役を飛ばす許可（product-git）を得ない', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  writeFileSync(join(p.product, 'a.txt'), 'x');
  assert.deepEqual(p.stepFour('git commit --allow-empty -m x'), { run: 'product-git' }, '前提: ハードリンクが無ければ product-git');
  assert.deepEqual(p.stepFour('git add a.txt'), { run: 'product-git' }, '前提: add も');
  p.hardLink('COMMIT_EDITMSG');
  assert.equal(p.stepFour('git commit --allow-empty -m x'), undefined, 'commit は判定役へ');
  assert.equal(p.stepFour('git add a.txt'), undefined, 'add も判定役へ');
  assert.equal(p.stepFour('git add a.txt && git commit --allow-empty -m x'), undefined, '続けた文も判定役へ');
});

test('G3 審査: リンク（symlink・junction）のある置き場は、今までどおり鍵の確かめにも届かず判定役へ戻る', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  const logs = join(p.gitDir, 'logs');
  rmSync(logs, { recursive: true });
  try { symlinkSync(p.outside, logs, process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('リンクを作れない環境'); return; }
  assert.equal(gitDirLinkFree(p.gitDir), false);
  assert.equal(p.stepFour(KEY_MESSAGE), undefined, '鍵のメッセージでも、リンクのある置き場は今までどおり判定役へ');
  assert.equal(p.stepFour('git commit --allow-empty -m x'), undefined);
});

test('G3 審査: 承認の決まり（gitInside）は、ハードリンクのある置き場では git の形を作らない', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  const word = (text: string) => ({ text, dynamic: false, glob: false });
  const fact = (words: string[]): StatementFacts => ({
    program: words[0]!, programDynamic: false, programOdd: false, words: words.map(word), urls: [], env: [], gitGlobal: [], code: [], codeDynamic: false, stdin: false, shapes: [],
    reasonKeys: [], deletes: false, targets: [], writes: [], cwd: p.product,
  });
  const env = { git: (dir: string, args: string[]) => git(dir, args), ownerHooks: () => false };
  assert.deepEqual(shellRuleShape([fact(['git', 'fetch'])], p.product, undefined, env)?.cmd, ['git', 'fetch'], '前提: ハードリンクが無ければ形がある');
  p.hardLink(join('logs', 'HEAD'));
  assert.equal(shellRuleShape([fact(['git', 'fetch'])], p.product, undefined, env), undefined, 'ハードリンクがあれば形なし');
});
