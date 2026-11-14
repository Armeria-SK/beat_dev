import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRemotes } from '../src/projects/remotes.ts';

import { findGitDir, inspectRepo } from '../src/tools/hooks/git-repo.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const PLAIN = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n';
const OTHER = `${PLAIN}[remote "origin"]\n\turl = https://other.example/secret/repo.git\n`;

function makeGitDir(dir: string, config: string): string {
  mkdirSync(join(dir, 'objects'), { recursive: true });
  mkdirSync(join(dir, 'refs'), { recursive: true });
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, 'config'), config);
  return dir;
}

test('gitdir・commondir・alternates の指す先の途中にリンクがあれば、たどらずに「読めない」にする', t => {
  const base = tempDir(t);
  const outside = join(base, 'outside');
  makeGitDir(join(outside, 'g'), OTHER);
  mkdirSync(join(outside, 'store', 'objects'), { recursive: true });
  const prod = join(base, 'prod');
  mkdirSync(prod);
  symlinkSync(outside, join(prod, 'j'), 'junction');

  const viaFile = join(prod, 'a');
  mkdirSync(viaFile);
  writeFileSync(join(viaFile, '.git'), `gitdir: ${join(prod, 'j', 'g')}\n`);
  assert.equal(findGitDir(viaFile)?.broken, true, 'gitdir');
  assert.equal(inspectRepo(viaFile).unreadable, true, 'gitdir');
  assert.deepEqual(readRemotes(viaFile), [], 'gitdir');

  const viaCommon = join(prod, 'b');
  mkdirSync(join(viaCommon, '.git'), { recursive: true });
  writeFileSync(join(viaCommon, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(viaCommon, '.git', 'commondir'), `${join(prod, 'j', 'g')}\n`);
  assert.equal(findGitDir(viaCommon)?.broken, true, 'commondir');
  assert.equal(inspectRepo(viaCommon).unreadable, true, 'commondir');
  assert.deepEqual(readRemotes(viaCommon), [], 'commondir');

  const viaAlternates = join(prod, 'c');
  makeGitDir(join(viaAlternates, '.git'), PLAIN);
  mkdirSync(join(viaAlternates, '.git', 'objects', 'info'));
  writeFileSync(join(viaAlternates, '.git', 'objects', 'info', 'alternates'), `${join(prod, 'j', 'store', 'objects')}\n`);
  assert.equal(inspectRepo(viaAlternates).unreadable, true, 'alternates');

  const direct = join(prod, 'd');
  mkdirSync(direct);
  writeFileSync(join(direct, '.git'), `gitdir: ${join(outside, 'g')}\n`);
  assert.equal(inspectRepo(direct).unreadable, false, 'リンクを通らない指し方はそのまま');
});

test('本物の git worktree add で作った作業フォルダは、今までどおりふつうに読める', { skip: !gitAvailable && 'git が無い' }, t => {
  const base = tempDir(t);
  const main = join(base, 'main');
  mkdirSync(main);
  const git = (...args: string[]) => {
    const done = spawnSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(done.status, 0, `${args.join(' ')}: ${done.stderr}`);
  };
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://host.example/a/b.git');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  const linked = join(base, 'linked');
  git('worktree', 'add', '-q', linked, '-b', 'side');
  const info = inspectRepo(linked);
  assert.deepEqual([info.found, info.unreadable, info.remotes], [true, false, ['origin']]);
  assert.equal(findGitDir(linked)?.broken, undefined);
  assert.equal(readRemotes(linked)[0]?.url, 'https://host.example/a/b.git');
});

test('alternates が同じ場所を何度も指していても、見るのは 1 回ずつで、すぐ終わる', t => {
  const base = tempDir(t);
  const repo = join(base, 'repo');
  makeGitDir(join(repo, '.git'), PLAIN);
  const level = (n: number) => (n === 0 ? join(repo, '.git', 'objects') : join(base, `level${n}`, 'objects'));
  for (let n = 0; n < 5; n++) {
    mkdirSync(join(level(n), 'info'), { recursive: true });
    mkdirSync(level(n + 1), { recursive: true });
    writeFileSync(join(level(n), 'info', 'alternates'), `${level(n + 1)}\n`.repeat(16));
  }
  const started = process.hrtime.bigint();
  const info = inspectRepo(repo);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(info.found, true);
  assert.equal(info.unreadable, false, '同じ場所の繰り返しは害が無い');
  assert.ok(ms < 1000, `${ms} ms`);
});

test('alternates の行が多すぎるときは、数え切らずに「読めない」にする', t => {
  const base = tempDir(t);
  const repo = join(base, 'repo');
  makeGitDir(join(repo, '.git'), PLAIN);
  mkdirSync(join(repo, '.git', 'objects', 'info'));
  const many = Array.from({ length: 300 }, (_, n) => join(base, 'stores', `s${n}`, 'objects'));
  writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${many.join('\n')}\n`);
  const started = process.hrtime.bigint();
  assert.equal(inspectRepo(repo).unreadable, true);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 1000);
});
