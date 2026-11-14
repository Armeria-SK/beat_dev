import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { productRunOf } from '../src/tools/hooks/product-run.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import type { ShellKind } from '../src/tools/hooks/shell-lex.ts';
import { tempDir } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function fixture(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'sub,-C,x'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'a.test.js'), '');
  const run = (...args: string[]) => {
    const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  };
  run('init', '-q');
  run('config', 'user.name', 'beat test');
  run('config', 'user.email', 'beat@test.invalid');
  writeFileSync(join(root, 'README.md'), 'hi\n');
  run('add', 'README.md');
  run('commit', '-q', '-m', 'init');
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(base, 'skills') };
  const check = (command: string, shell: ShellKind = 'pwsh'): ShellVerdict => checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell, windows: false });
  const stepFour = (verdict: ShellVerdict) => productRunOf({
    root, verdict, which: () => undefined, ownerHooks: () => false,
    git: (dir, args) => {
      const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      return out.status === 0 ? out.stdout : undefined;
    },
  });
  const reached = (command: string, shell: ShellKind = 'pwsh'): string | undefined => {
    const verdict = check(command, shell);
    const result = verdict.decision === 'ask' ? stepFour(verdict) : undefined;
    return result && 'run' in result ? result.run : undefined;
  };
  return { root, check, stepFour, reached };
}

test('Windows でない PowerShell でも、空白のあるカンマの並びの -c・-C と node --test の引数は順 4 に乗らず、引数の形で止まる', { skip: !gitAvailable && 'git が無い' }, t => {
  const f = fixture(t);
  for (const shell of ['pwsh', 'powershell'] as const) {
    assert.equal(f.reached('git -C sub add -A', shell), 'product-git', `${shell}: ふつうの -C は順 4（土台の確かめ）`);
    assert.equal(f.reached('git -c user.name=a commit --allow-empty -m x', shell), 'product-git', `${shell}: 名乗りの -c は順 4（土台の確かめ）`);
    assert.equal(f.reached('git -C sub,-C,x add -A', shell), 'product-git', `${shell}: きっちりつないだカンマの語は 1 つのフォルダ名（土台の確かめ）`);
    assert.equal(f.reached('node --test tests/a.test.js', shell), 'product-code', `${shell}: node --test は順 4（土台の確かめ）`);
    const commands = [
      'git -c user.name=a, -c, core.fsmonitor=x commit -m x',
      'git -c user.name=a ,-c,core.hooksPath=x commit -m x',
      'git -c user.name=a,-c, core.fsmonitor=x commit -m x',
      'git -C sub, -C, x add -A',
      'git -C sub,-C, x commit -m x',
      'node --test tests/a.test.js, --require, ./x.cjs',
      'node --test tests/a.test.js,--import, ./x.mjs',
      'git -C sub add -A -- README.md, x',
      'git -c user.name=a,b, -c, core.fsmonitor=x commit -m x',
      'git -C sub,b, x add -A',
    ];
    const leaked: string[] = [];
    for (const command of commands) {
      const verdict = f.check(command, shell);
      const step = f.reached(command, shell);
      if (verdict.decision !== 'deny' || step !== undefined) leaked.push(`${command} -> ${verdict.decision} ${step ?? ''} ${verdict.reasonKeys.join(',')}`);
    }
    assert.deepEqual(leaked, [], `${shell}: 引数の形で止まらなかった形`);
  }
  assert.equal(f.reached('git -c user.name=a, -c, core.fsmonitor=x commit -m x', 'bash'), undefined, 'bash ではカンマは文字のまま（-c の値がふつうの名乗りでない）');
});

test('Windows でない PowerShell でも、-名前:値 と空の引数は外部のプログラムに渡す前に止まる', t => {
  const f = fixture(t);
  for (const command of ['git -C:sub add -A', "git -C sub add ''", 'node --test tests/a.test.js -r:./x.cjs', "node --test '' tests/a.test.js"]) {
    const verdict = f.check(command);
    assert.equal(verdict.decision, 'deny', `${command}: ${verdict.reasonKeys.join(',')}`);
    assert.ok(verdict.reasonKeys.includes('list.winargs_ps'), `${command}: ${verdict.reasonKeys.join(',')}`);
  }
});

test('順 4 の git は、許可の一覧と食い違う -c のキーを自分でも断る（許可の一覧の名乗りの確かめが外れても core.fsmonitor などは通らない）', { skip: !gitAvailable && 'git が無い' }, t => {
  const f = fixture(t);
  const verdict = f.check('git -c user.name=a commit --allow-empty -m x', 'bash');
  assert.equal(verdict.decision, 'ask');
  assert.deepEqual(f.stepFour(verdict), { run: 'product-git' }, '名乗りの -c は順 4（土台の確かめ）');
  for (const key of ['core.fsmonitor=x', 'core.hooksPath=x', 'user.namex=a', 'user.name']) {
    const swapped: ShellVerdict = { ...verdict, statements: verdict.statements.map(st => ({ ...st, words: st.words.map(w => (w.text === 'user.name=a' ? { ...w, text: key } : w)) })) };
    assert.ok(swapped.statements[0]!.words.some(w => w.text === key), `${key}: 語を差し替えた`);
    assert.equal(f.stepFour(swapped), undefined, `${key}: 順 4 にしない`);
  }
});
