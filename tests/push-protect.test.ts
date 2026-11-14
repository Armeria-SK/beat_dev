import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pushProtectOf } from '../src/tools/hooks/push-protect.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir, testConfig } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function repo(t: { after: (fn: () => void) => void }) {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  const remote = join(base, 'remote.git');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  const git = (...args: string[]): string => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout;
  };
  spawnSync('git', ['init', '-q', '--bare', remote]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'hi\n');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  const config = testConfig();
  config.tools.hooks.preToolUse = [{ matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'], afterOutside: [] }];
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [] };
  const protectOf = (command: string) => pushProtectOf({
    config, projectRoot: root, productRoots: [], tainted: false,
    statements: checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell: 'bash', windows: false }).statements,
    git: (dir, args) => {
      const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      return out.status === 0 ? out.stdout : undefined;
    },
  });
  return { root, git, protectOf };
}

test('push の守るファイル: stash（古い stash@{1} も）や refs/heads でない独自の ref で送るコミットの守るファイルも見る', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = repo(t);
  assert.equal(r.protectOf('git push origin main'), undefined, '送るものが無ければ何も出さない');
  writeFileSync(join(r.root, '.github', 'workflows', 'ci.yml'), 'on: [push, pull_request]\n');
  r.git('stash', '-q');
  writeFileSync(join(r.root, 'README.md'), 'changed\n');
  r.git('stash', '-q');
  const old = r.protectOf("git push origin 'stash@{1}:refs/heads/x'");
  assert.ok(old && 'files' in old && old.files.some(f => f.includes('ci.yml')), JSON.stringify(old));
  r.git('stash', 'clear');
  writeFileSync(join(r.root, '.github', 'workflows', 'ci.yml'), 'on: workflow_dispatch\n');
  r.git('add', '-A');
  const commit = r.git('commit-tree', r.git('write-tree').trim(), '-p', 'HEAD', '-m', 'custom').trim();
  r.git('reset', '-q', '--hard', 'HEAD');
  r.git('update-ref', 'refs/custom/y', commit);
  const custom = r.protectOf('git push origin refs/custom/y');
  assert.ok(custom && 'files' in custom && custom.files.some(f => f.includes('ci.yml')), JSON.stringify(custom));
});
