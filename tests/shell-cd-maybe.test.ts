import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { protectedTouchOf } from '../src/tools/hooks/protected-touch.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand, type StatementFacts } from '../src/tools/hooks/shell-guard.ts';
import { guardRowOf, routeOf, type GuardModules } from './helpers/guard-route.ts';
import { tempDir } from './helpers.ts';

// control-bodies fix-back (security review F1-F6, N1, N2): a cd that beat cannot prove ran (inside try / if / a loop / after && or ||),
// or cannot work out (cd $x), never drops a folder from the ones later statements are checked against, and never skips a check.
// Nothing here is executed: the guard only.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;

function fixture(t: { after: (fn: () => void) => void }) {
  const ws = realish(join(tempDir(t), 'ws'));
  for (const dir of ['a/private', 'a/skills', 'b', 'private', 'sub']) mkdirSync(join(ws, dir), { recursive: true });
  writeFileSync(join(ws, 'private', 'notes.txt'), 'x');
  writeFileSync(join(ws, 'a', 'private', 'notes.txt'), 'x');
  execFileSync('git', ['init', '-q', join(ws, 'b')]);
  execFileSync('git', ['config', '--file', join(ws, 'b', '.git', 'config'), 'core.fsmonitor', 'node put.js']);
  const policy = (deny: string[] = []): ScopePolicy => ({ roots: [{ path: ws, mode: 'write' }], deny: deny.map(d => join(ws, d)), skillsDir: join(ws, 'a', 'skills'), askOnWrite: [join(ws, 'a', 'skills')] });
  const row = (command: string, deny: string[] = [], shell: 'powershell' | 'pwsh' = 'powershell') => guardRowOf(MODS, command, shell, ws, policy(deny) as unknown as Record<string, unknown>);
  const check = (command: string, deny: string[] = [], shell: 'powershell' | 'pwsh' = 'powershell') => checkShellCommand(command, ws, { policy: policy(deny), outsideRoots: 'ask', shell, windows: true });
  return { ws, policy, row, check };
}

const route = (r: ReturnType<ReturnType<typeof fixture>['row']>) => `${routeOf(r, { judgeOff: true })} [${r.reasonKeys.join(',')}]`;

test('cd maybe: a cd that may not have run keeps the folder before it (a repo with an odd config in either place is seen)', t => {
  const f = fixture(t);
  assert.match(route(f.row('if ($false) { cd a }\ncd b\ngit status')), /^owner /u);
  assert.match(route(f.row('cd b\ngit status')), /^owner /u);
});

test('cd maybe: after a cd beat cannot work out, the secret and deny-list checks still run on every known folder (refused, not skipped)', t => {
  const f = fixture(t);
  for (const command of ['try { cd $x } catch {}\nGet-Content server.pem', 'try { Set-Location $x } catch {}\nGet-Content server.pem', 'while ($true) { cd $x; break }\nGet-Content server.pem', 'function f { cd $x }\nGet-Content server.pem']) {
    assert.match(route(f.row(command)), /^refused /u, command);
  }
  assert.match(route(f.row('try { cd $x } catch {}\nRemove-Item -Recurse -Force .')), /^refused /u);
});

test('cd maybe: pre-existing top-level dynamic cd (N2) no longer skips the checks', t => {
  const f = fixture(t);
  for (const command of ['cd $HOME\nGet-Content .ssh/id_ed25519', 'cd $env:USERPROFILE; Get-Content .ssh/id_rsa', 'cd $x\nGet-Content .env']) {
    assert.match(route(f.row(command)), /^refused /u, command);
  }
  assert.match(route(f.row('cd $x\nGet-ChildItem -Recurse | Get-Content', ['private'])), /^refused /u);
  assert.match(route(f.row('cd $x\ngit grep --no-index x', ['private'])), /^refused /u);
});

test('cd maybe: a cd inside a re-runnable body is applied at the body entry too (a later loop pass starts there)', t => {
  const f = fixture(t);
  for (const command of ['while ($true) { Get-Content private/notes.txt; cd a }', 'foreach ($i in 1..2) { Get-Content private/notes.txt; cd a }']) {
    assert.match(route(f.row(command, ['a/private'])), /^refused /u, command);
  }
  assert.match(route(f.row('Remove-Item missing.txt\nGet-Content private/notes.txt\ntrap { cd a; continue }', ['a/private'])), /^refused /u);
});

test('cd maybe: a cd in try / catch / finally / trap / begin / while, then cd .., still sees the workspace being deleted', t => {
  const f = fixture(t);
  for (const body of ['try { cd a } catch {}', 'try {} catch { cd a }', 'try {} finally { cd a }', 'trap { cd a }', 'begin { cd a }', 'while ($false) { cd a }']) {
    const command = `${body}\ncd ..\nRemove-Item -Recurse -Force ws`;
    assert.match(route(f.row(command)), /^refused /u, command);
  }
  for (const op of ['&&', '||']) {
    const command = `Test-Path a ${op} cd a\ncd ..\nRemove-Item -Recurse -Force ws`;
    assert.match(route(f.row(command, [], 'pwsh')), /^refused /u, `pwsh: ${command}`);
  }
});

test('cd maybe: too many possible folders is refused (guard.cwd_many)', t => {
  const f = fixture(t);
  const five = [1, 2, 3, 4, 5].map(n => `if ($c${n}) { cd d${n} }`).join('\n');
  assert.ok(!f.row(`${five}\nGet-Date`).reasonKeys.includes('guard.cwd_many'));
  const six = `${five}\nif ($c6) { cd d6 }\nGet-Date`;
  const r = f.row(six);
  assert.ok(r.reasonKeys.includes('guard.cwd_many'), r.reasonKeys.join(','));
  assert.equal(r.decision, 'deny');
});

test('cd maybe: protected places are looked up in every folder the command may be in', t => {
  const f = fixture(t);
  const command = 'if ($c) { cd a }\nSet-Content skills/x/SKILL.md y';
  const v = f.check(command);
  const touch = protectedTouchOf(command, v.statements, f.policy(), f.ws);
  assert.equal(touch?.key, 'guard.touch_skill');
});

test('cd maybe: a push wrapped in another shell after an unknown cd is kept, with no destination', t => {
  const f = fixture(t);
  const r = f.row('try { cd $x } catch {}\nbash -c "git push ../r.git feature"');
  assert.deepEqual(r.pushes, [null]);
});

test('cd maybe: git after an unknown folder still marks the fetch and walks the paths', t => {
  const f = fixture(t);
  const pull = f.row('try { cd $x } catch {}\ngit pull');
  assert.equal(pull.fetched, true, pull.reasonKeys.join(','));
  assert.match(route(f.row('try { cd $x } catch {}\ngit grep --no-index x', ['private'])), /^refused /u);
});

test('cd maybe: a delete after a cd that may have failed names both places (cwd unknown, both targets)', t => {
  const f = fixture(t);
  const v = f.check('try { cd nope } catch {}\nRemove-Item x');
  const rm = v.statements.find((s: StatementFacts) => s.program === 'remove-item')!;
  assert.equal(rm.cwd, null);
  assert.deepEqual(rm.cwds, [f.ws, join(f.ws, 'nope')]);
  assert.deepEqual(rm.targets.map(x => x.path).sort(), [join(f.ws, 'nope', 'x'), join(f.ws, 'x')].sort());
});

test('cd maybe: unknown-command path args are checked against every possible folder', t => {
  const f = fixture(t);
  const r = f.row('if ($c) { cd a }\nfoo-tool private/notes.txt', ['a/private']);
  assert.equal(r.decision, 'deny', r.reasonKeys.join(','));
  assert.ok(r.reasonKeys.includes('scope.deny'), r.reasonKeys.join(','));
});

test('cd maybe: a repo entered by a cd later in a loop body is seen at the body start', t => {
  const f = fixture(t);
  assert.match(route(f.row('while ($true) { git status; cd b }')), /^owner /u);
});

test('cd maybe: a program file is taken as present only when it is there in every possible folder', t => {
  const f = fixture(t);
  writeFileSync(join(f.ws, 'tool.exe'), 'x');
  assert.ok(f.row('./tool.exe "a&b"').reasonKeys.includes('code.cmd_is_file'));
  const r = f.row('if ($c) { cd a }\n./tool.exe "a&b"');
  assert.equal(r.decision, 'deny', r.reasonKeys.join(','));
  assert.ok(r.reasonKeys.includes('list.winargs'), r.reasonKeys.join(','));
});

test('cd maybe: a wrapped shell after an unknown cd stays an unknown command for outbound (its inside is not trusted)', t => {
  const f = fixture(t);
  const r = f.row('try { cd $x } catch {}\nbash -c "ls"');
  assert.notEqual(r.outbound, 'none', r.reasonKeys.join(','));
});

test('cd maybe: git in an unreadable repo or with an old git still marks the fetch', t => {
  const f = fixture(t);
  mkdirSync(join(f.ws, 'u'));
  writeFileSync(join(f.ws, 'u', '.git'), 'gitdir: ./nowhere\n');
  const unreadable = f.row('cd u\ngit pull');
  assert.equal(unreadable.fetched, true, unreadable.reasonKeys.join(','));
  const old = checkShellCommand('git pull', f.ws, { policy: f.policy(), outsideRoots: 'ask', shell: 'powershell', windows: true, gitIsolated: false });
  assert.equal(old.fetched, true, old.reasonKeys.join(','));
  assert.ok(old.reasonKeys.includes('list.git_old'), old.reasonKeys.join(','));
});

test('cd maybe: [CmdletBinding()] param stays refused as before, at top level and inside if', t => {
  const f = fixture(t);
  for (const command of ['[CmdletBinding()] param($x)', 'if ($true) { [CmdletBinding()] param($x) }']) {
    const r = f.row(command);
    assert.equal(r.decision, 'deny', `${command} -> ${r.reasonKeys.join(',')}`);
  }
});
