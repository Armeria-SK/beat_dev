import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { memoGit } from '../src/tools/hooks/outbound-env.ts';
import { shellPreCheck } from '../src/tools/builtin/shell.ts';
import { selfRunRig } from './helpers/self-run-rig.ts';

const gitAvailable = cp.spawnSync('git', ['--version']).status === 0;

test('memoGit: 同じ（フォルダ, 引数）は 1 回だけ動かし、失敗（undefined）も使い回す。別のフォルダ・別の引数は別に動かす', () => {
  const calls: string[] = [];
  const answers: Record<string, string | undefined> = { 'rev-parse HEAD': 'abc', 'status': undefined };
  const git = memoGit((dir, args) => { calls.push(`${dir}::${args.join(' ')}`); return answers[args.join(' ')]; });
  assert.equal(git('/a', ['rev-parse', 'HEAD']), 'abc');
  assert.equal(git('/a', ['rev-parse', 'HEAD']), 'abc');
  assert.equal(git('/a', ['status']), undefined);
  assert.equal(git('/a', ['status']), undefined);
  assert.equal(git('/b', ['rev-parse', 'HEAD']), 'abc');
  assert.equal(git('/a', ['rev-parse', '-q', 'HEAD']), undefined);
  assert.deepEqual(calls, ['/a::rev-parse HEAD', '/a::status', '/b::rev-parse HEAD', '/a::rev-parse -q HEAD']);
});

// 1 回の振り分け（shellPreCheck）の中で、同じ git の問い合わせを 2 度動かさない。結果は変わらず、次の振り分けには持ち越さない
function gitRig(t: { after: (fn: () => void) => void }) {
  const rig = selfRunRig(t, c => { c.tools.shell.shell = 'bash'; }, { 'package.json': '{"name":"p"}', 'a.txt': 'a', 'src/b.ts': 'export const b = 1;' });
  const original = cp.execFileSync;
  const calls: string[] = [];
  const patched = mock.method(cp, 'execFileSync', ((file: string, args: string[], opts: { cwd?: string }) => {
    calls.push(`${opts?.cwd ?? ''} :: ${Array.isArray(args) ? args.join(' ') : ''}`);
    return (original as (...a: unknown[]) => unknown)(file, args, opts);
  }) as never);
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  const git = (...args: string[]) => cp.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: rig.ws, encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(rig.ws, 'c.txt'), 'c');
  const classify = (command: string) => {
    calls.length = 0;
    const pre = shellPreCheck({ command }, rig.ctx);
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call, (counts.get(call) ?? 0) + 1);
    return { pre, total: calls.length, distinct: counts.size, repeated: [...counts].filter(([, n]) => n > 1).map(([call]) => call.replace(rig.ws, '<ws>')) };
  };
  return { rig, git, classify };
}

const GIT_COMMANDS = ['git add -A', 'git add -A && git commit -m x', 'git commit -m x', 'git add a.txt', 'git push origin main'];

test('1 回の振り分けの中で、同じ（フォルダ, 引数）の git の問い合わせは 1 回しか動かない（製品の中の git add -A・commit・push）', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = gitRig(t);
  for (const command of GIT_COMMANDS) {
    const c = r.classify(command);
    assert.ok(c.total > 0, `${command}: 数えられていない`);
    assert.deepEqual(c.repeated, [], `${command}: 同じ問い合わせを繰り返した`);
    assert.equal(c.total, c.distinct, command);
  }
});

test('結果は同じ: 同じコマンドを続けて振り分けても判定・製品の中の実行の種類は変わらず、問い合わせの数も同じ（持ち越さない）', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = gitRig(t);
  for (const command of GIT_COMMANDS) {
    const first = r.classify(command);
    const second = r.classify(command);
    assert.equal(second.total, first.total, `${command}: 2 回目に前の答えを使い回した（問い合わせが減った）`);
    assert.equal(second.pre.decision, first.pre.decision, command);
    assert.equal((second.pre as { productRun?: string }).productRun, (first.pre as { productRun?: string }).productRun, command);
  }
});

test('持ち越さない: 振り分けのあとでリポジトリの状態が変わったら、次の振り分けは新しい状態を見る（git add -A の対象が変わる）', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = gitRig(t);
  const before = r.classify('git add -A');
  assert.ok(before.total > 0);
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'second');
  writeFileSync(join(r.rig.ws, 'd.txt'), 'd');
  const after = r.classify('git add -A');
  assert.equal(after.total, before.total, `次の振り分けも同じだけ問い合わせを動かす（${before.total} → ${after.total}）`);
  assert.deepEqual(after.repeated, []);
});
