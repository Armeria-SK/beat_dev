import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type StatementFacts } from '../src/tools/hooks/shell-guard.ts';
import { guardRowOf, routeOf, type GuardModules } from './helpers/guard-route.ts';
import { tempDir } from './helpers.ts';

// guard-cd (plans/beat/backlog.md, from the control-bodies deep review): cd shapes the guard did not follow, or followed although the
// shell does not move. PowerShell `cd..` / `cd\` (built-in functions) and a module-qualified Set-Location move; a top-level cd to a folder
// that is not there fails and the next statement runs where it was; a bash cd inside a body, after && / ||, in a pipeline or background
// keeps the folder before it, and one inside ( ) or $( ) is gone when the subshell ends; `git -C $x fetch` still reads from outside.
// Nothing here is executed: the guard only.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;
type Shell = 'powershell' | 'bash';

function fixture(t: { after: (fn: () => void) => void }) {
  const ws = realish(join(tempDir(t), 'ws'));
  for (const dir of ['sub', 'a/private', 'a/inner', 'evil/ok']) mkdirSync(join(ws, dir), { recursive: true });
  execFileSync('git', ['init', '-q', join(ws, 'evil')]);
  execFileSync('git', ['config', '--file', join(ws, 'evil', '.git', 'config'), 'core.fsmonitor', 'node put.js']);
  execFileSync('git', ['init', '-q', join(ws, 'evil', 'ok')]);
  const policy = (deny: string[] = []): ScopePolicy => ({ roots: [{ path: ws, mode: 'write' }], deny: deny.map(d => join(ws, d)) });
  const check = (command: string, shell: Shell, cwd = ws, deny: string[] = []) => checkShellCommand(command, cwd, { policy: policy(deny), outsideRoots: 'ask', shell, windows: shell === 'powershell', gitIsolated: true });
  const row = (command: string, shell: Shell, deny: string[] = []) => guardRowOf(MODS, command, shell, ws, policy(deny) as unknown as Record<string, unknown>);
  // the facts of the last statement whose program is `program`
  const factsOf = (command: string, shell: Shell, program: string, cwd = ws): StatementFacts => {
    const found = check(command, shell, cwd).statements.filter(s => s.program === program).at(-1);
    assert.ok(found, `${command}: no ${program} statement`);
    return found;
  };
  const pushes = (command: string, shell: Shell) => { const v = check(command, shell); return pushesOf(v.statements, v.reasonKeys).map(p => p.dir); };
  return { ws, check, row, factsOf, pushes };
}

test('guard-cd: PowerShell cd.. / cd\\ and a module-qualified Set-Location / Push-Location move the folder', t => {
  const f = fixture(t);
  const ok = join(f.ws, 'evil', 'ok');
  const evil = join(f.ws, 'evil');
  // from evil/ok (a plain repo) one level up is evil, whose config runs code: git there must be seen
  assert.deepEqual(f.check('git status', 'powershell', ok).reasonKeys, []);
  for (const command of ['cd..; git status', 'CD..\ngit status', 'Microsoft.PowerShell.Management\\Set-Location ..; git status', 'microsoft.powershell.management\\push-location ..; git status']) {
    assert.ok(f.check(command, 'powershell', ok).reasonKeys.includes('list.git_config'), command);
    assert.equal(f.factsOf(command, 'powershell', 'git', ok).cwd, evil, command);
  }
  // cd\ goes to the root of the drive
  assert.equal(f.factsOf('cd\\; git status', 'powershell', 'git', ok).cwd, parse(ok).root);
  // the shapes keep the reason they had (never looser than before): only the folder that follows is new
  assert.ok(f.check('cd..', 'powershell', ok).reasonKeys.includes('list.command'));
  assert.ok(f.check('Microsoft.PowerShell.Management\\Set-Location ..', 'powershell', ok).reasonKeys.includes('list.command'));
  // another module's Set-Location may not exist: the folder before it is kept as well
  assert.deepEqual(new Set(f.factsOf('Other.Module\\Set-Location ..; git status', 'powershell', 'git', ok).cwds), new Set([ok, evil]));
  // inside a loop body, the shortcut is applied at the body entry too
  assert.equal(f.check('while ($true) { Get-Content private/notes.txt; cd.. }', 'powershell', join(f.ws, 'a', 'inner'), ['a/private']).decision, 'deny');
});

test('guard-cd: a top-level cd to a folder that is not there may fail, so the folder before it is kept', t => {
  const f = fixture(t);
  for (const shell of ['powershell', 'bash'] as const) {
    assert.deepEqual(new Set(f.factsOf('cd nope; git push', shell, 'git').cwds), new Set([f.ws, join(f.ws, 'nope')]), shell);
    // the push destination is no longer taken to be the missing folder
    assert.deepEqual(f.pushes('cd nope; git push', shell), [null], shell);
    // the delete target in the folder where the shell still is, is reported too
    const rm = f.factsOf(shell === 'bash' ? 'cd nope; rm x' : 'cd nope; Remove-Item x', shell, shell === 'bash' ? 'rm' : 'remove-item');
    assert.ok(rm.targets.some(target => typeof target === 'object' && 'path' in target && target.path === join(f.ws, 'x')), `${shell}: ${JSON.stringify(rm.targets)}`);
    // a folder that is there now, after an earlier statement wrote or deleted, may be gone by the time the cd runs
    const removed = shell === 'bash' ? 'rm -r sub; cd sub; git push' : 'Remove-Item -Recurse sub; cd sub; git push';
    assert.deepEqual(new Set(f.factsOf(removed, shell, 'git').cwds), new Set([f.ws, join(f.ws, 'sub')]), `${shell}: ${removed}`);
    // a folder that is there still moves exactly as before
    assert.deepEqual(f.pushes('cd sub; git push', shell), [join(f.ws, 'sub')], shell);
    assert.equal(f.factsOf('cd sub; git push', shell, 'git').cwd, join(f.ws, 'sub'), shell);
  }
  assert.deepEqual(f.pushes('cd sub && git push', 'bash'), [join(f.ws, 'sub')]);
});

test('guard-cd: git with an unreadable -C, a second -C or a global option still marks the read from outside', t => {
  const f = fixture(t);
  for (const shell of ['powershell', 'bash'] as const) {
    for (const command of ['git -C $x fetch', 'git -C $x pull origin main', 'git -C a -C b fetch', 'git -c http.extraHeader=x fetch', 'git --git-dir=$g clone x', 'git --no-pager -C $x submodule update', 'git -C $x ls-remote origin']) {
      assert.equal(f.check(command, shell).fetched, true, `${shell}: ${command}`);
    }
    for (const command of ['git -C $x status', 'git commit -m fetch', 'git -C $x log fetch', 'git status']) {
      assert.equal(f.check(command, shell).fetched, false, `${shell}: ${command}`);
    }
  }
});

test('guard-cd: a bash cd that may not run (body, && / ||, pipeline, background, case) keeps the folder before it', t => {
  const f = fixture(t);
  const both = [f.ws, join(f.ws, 'sub')];
  for (const command of [
    'false && cd sub; git push', 'true || cd sub; git push', 'if false; then cd sub; fi; git push', 'if cd sub; then true; fi; git push',
    'cd sub | cat; git push', 'cat x | cd sub; git push', 'cd sub & git push', '{ cd sub; } | cat; git push', '{ cd sub; } & git push',
    'echo | { cd sub; true; }; git push', 'case x in x) cd sub;; esac; git push', 'while false; do cd sub; done; git push',
  ]) {
    const cwds = f.factsOf(command, 'bash', 'git').cwds ?? [];
    assert.ok(both.every(dir => cwds.includes(dir)), `${command}: ${JSON.stringify(cwds)}`);
  }
});

test('guard-cd: a bash cd inside ( ) or $( ) ends with the subshell', t => {
  const f = fixture(t);
  const sub = join(f.ws, 'sub');
  for (const command of ['(cd sub); git push', '(cd sub && true); git push', 'x=$(cd sub); git push', 'echo "$(cd sub; pwd)"; git push', '(cd sub; (cd ..)); git push', 'diff <(cd sub; ls) x; git push']) {
    assert.equal(f.factsOf(command, 'bash', 'git').cwd, f.ws, command);
  }
  assert.deepEqual(f.pushes('(cd sub); git push', 'bash'), [f.ws]);
  // inside the subshell the cd still counts, as before
  assert.deepEqual(f.pushes('(cd sub && git push)', 'bash'), [sub]);
  assert.equal(f.factsOf('(cd sub; git push)', 'bash', 'git').cwd, sub);
  // a case pattern's `)` does not end the subshell around it
  assert.equal(f.factsOf('(cd sub; case x in x) true;; esac; git push)', 'bash', 'git').cwd, sub);
  // braces are not a subshell: the cd stays after them
  assert.equal(f.factsOf('{ cd sub; }; git push', 'bash', 'git').cwd, sub);
});

test('guard-cd: a bash cd inside a loop or a function body is applied at the body entry too', t => {
  const f = fixture(t);
  for (const command of ['for i in 1 2; do cat private/notes.txt; cd a; done', 'while true; do cat private/notes.txt; cd a; done']) {
    assert.equal(routeOf(f.row(command, 'bash', ['a/private']), { judgeOff: true }), 'refused', command);
  }
  // a loop that cds into a repo whose config runs code: git on the next pass runs there
  assert.notEqual(f.check('for i in 1 2; do git status; cd evil; done', 'bash').decision, 'allow');
  assert.notEqual(f.check('f() { cd evil; }; f; git status', 'bash').decision, 'allow');
});
