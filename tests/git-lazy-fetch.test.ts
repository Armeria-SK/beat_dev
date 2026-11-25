import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { withGit } from '../src/mesh/folders.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
};

function git(cwd: string, args: string[], extra: Record<string, string> = {}): { ok: boolean; out: string } {
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: cleanEnv(extra), encoding: 'utf8' });
  return { ok: done.status === 0, out: `${done.stdout}${done.stderr}`.trim() };
}

function mustGit(cwd: string, args: string[]): string {
  const done = git(cwd, args);
  assert.equal(done.ok, true, `git ${args.join(' ')}: ${done.out}`);
  return done.out;
}

const packCount = (repo: string): number => readdirSync(join(repo, '.git', 'objects', 'pack')).filter(name => name.endsWith('.pack')).length;

// 元のリポジトリから部分クローン（blob は取らない）を作る。今の git が書く印（remote.<名前>.promisor）は beat の「ふつうの設定」に無く、beat は git を動かさない。
// beat が git を動かす形（extensions.partialclone と remote の url だけ。昔の git の書き方で、今の git も同じに読む）に書き直す
function partialClone(base: string): { dest: string; blob: string } {
  const origin = join(base, 'origin');
  mkdirSync(origin);
  mustGit(origin, ['init', '-q', '-b', 'main']);
  mustGit(origin, ['config', 'uploadpack.allowFilter', 'true']);
  mustGit(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  writeFileSync(join(origin, 'a.txt'), 'hello from origin\n');
  mustGit(origin, ['add', 'a.txt']);
  mustGit(origin, ['commit', '-q', '-m', 'first']);
  const blob = mustGit(origin, ['rev-parse', 'HEAD:a.txt']);
  const dest = join(base, 'dest');
  mustGit(base, ['clone', '-q', '--filter=blob:none', '--no-checkout', pathToFileURL(origin).href, dest]);
  const config = join(dest, '.git', 'config');
  const text = readFileSync(config, 'utf8');
  assert.match(text, /promisor\s*=\s*true/iu, '今の git の部分クローンの印がある');
  writeFileSync(config, `${text.split('\n').filter(line => !/^\s*(?:promisor|partialclonefilter)\s*=/iu.test(line)).join('\n')}[extensions]\n\tpartialclone = origin\n`);
  return { dest, blob };
}

test('G2: beat が自分で読む git は、部分クローンで足りない物を remote へ取りに行かない', { skip: !gitAvailable && 'git が無い' }, async t => {
  const base = tempDir(t);
  const { dest, blob } = partialClone(base);
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  const missing = (): boolean => !git(dest, ['cat-file', '-e', blob], { GIT_NO_LAZY_FETCH: '1' }).ok;
  assert.equal(missing(), true, '前提: クローン先に blob は無い');

  // 前提の確かめ: この git が GIT_NO_LAZY_FETCH を守ること（守らない git ではこの試験は何も言えない）
  const before = packCount(dest);
  const probe = git(dest, ['show', 'HEAD:a.txt'], { GIT_NO_LAZY_FETCH: '1' });
  if (probe.ok) { t.skip('この git は GIT_NO_LAZY_FETCH を守らない'); return; }
  assert.equal(packCount(dest), before, '前提: GIT_NO_LAZY_FETCH=1 の git は取りに行かない');
  assert.equal(missing(), true);

  // beat の git（withGit）。git が動いたこと（コミットは読める）と、足りない blob を読めないこと（null）を両方見る
  const seen = await withGit(dest, dataDir, async run => ({ head: await run(['rev-parse', 'HEAD']), show: await run(['show', 'HEAD:a.txt']) }));
  assert.ok(seen, 'withGit は git を動かした');
  assert.notEqual(seen.head, null, 'git は動いた（コミットは読める）');
  assert.equal(seen.show, null, '足りない blob は取りに行かず、失敗する');
  assert.equal(packCount(dest), before, '取りに行った跡（新しい pack）が無い');
  assert.equal(missing(), true, 'blob は増えていない');

  // 対照: 変数が無ければ、同じ git show は remote から取ってくる（上の null が、取りに行かないことによるものだと分かる）
  const plain = git(dest, ['show', 'HEAD:a.txt']);
  assert.equal(plain.ok, true, `対照: 変数なしなら取れる: ${plain.out}`);
  assert.match(plain.out, /hello from origin/u);
  assert.equal(missing(), false, '対照: 取ったので blob が増えた');
});
