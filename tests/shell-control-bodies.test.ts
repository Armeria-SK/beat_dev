import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { guardRowOf, looserThan, routeOf, type GuardModules } from './helpers/guard-route.ts';
import { tempDir, testConfig } from './helpers.ts';

// control-bodies (plans/beat/steps/control-bodies/PLAN.md): a command inside a PowerShell try / while / switch / function body
// is never judged less strictly than the same command at top level. Nothing here is executed: the guard only, or the pipeline
// with a counting execute stub and no judge that allows.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;

function workspace(t: { after: (fn: () => void) => void }): string {
  const ws = join(tempDir(t), 'workspace');
  mkdirSync(ws, { recursive: true });
  return realish(ws);
}

const THREE = ['Remove-Item -Path C:/Users -Recurse -Force', 'Get-Content ~/.ssh/id_rsa', 'git push --force origin main'];

// Each wrapper puts C where PowerShell runs it (or may run it) as a statement
const WRAPS: Array<[string, (c: string) => string]> = [
  ['try', c => `try {\n${c}\n} catch {}`],
  ['catch', c => `try {}\ncatch {\n${c}\n}`],
  ['typed catch', c => `try { Get-Date } catch [System.IO.IOException], [System.Exception] {\n${c}\n}`],
  ['finally', c => `try {} finally {\n${c}\n}`],
  ['while', c => `while ($true) {\n${c}\n}`],
  ['do while', c => `do {\n${c}\n} while ($false)`],
  ['do until', c => `do {\n${c}\n}\nuntil ($true)`],
  ['for', c => `for (;;) {\n${c}\n}`],
  ['for init', c => `for ($i = 0; $i -lt 1; $i++) {\n${c}\n}`],
  ['switch clause', c => `switch (1) { 1 {\n${c}\n} }`],
  ['switch default', c => `switch -Regex ($x) { 'a' { 1 } default {\n${c}\n} }`],
  ['switch label block', c => `switch (1) { {\n${c}\n} {} }`],
  ['switch condition', c => `switch (${c}) { default { 1 } }`],
  ['switch paren label', c => `switch (1) { (${c}) { 1 } }`],
  ['function', c => `function f {\n${c}\n}`],
  ['function params', c => `function global:f([string]$a = 'x', $b) {\n${c}\n}`],
  ['filter', c => `filter f {\n${c}\n}`],
  ['trap', c => `trap {\n${c}\n}`],
  ['typed trap', c => `trap [System.Exception] {\n${c}\n}`],
  ['begin', c => `begin {\n${c}\n}`],
  ['process', c => `process {\n${c}\n}`],
  ['end', c => `end {\n${c}\n}`],
  ['named blocks in a function', c => `function f { param($a) begin { 1 } process {\n${c}\n} end {} }`],
  ['return', c => `return ${c}`],
  ['throw', c => `throw (${c})`],
  ['exit', c => `exit (${c})`],
  ['param continuation', c => `param($x) ${c}`],
  ['param with attributes', c => `[CmdletBinding()]\nparam([Parameter(Mandatory=$true, Position=0)][ValidateSet('a','b')][string]$x = 'a')\n${c}`],
  ['nested', c => `function f { try { while ($true) { switch ($x) { default {\n${c}\n} } } } finally {} }`],
  ['foreach', c => `foreach ($i in 1..2) {\n${c}\n}`],
];

test('control bodies: the three example commands are judged inside every body as at top level (judge on and off)', t => {
  const ws = workspace(t);
  const wrong: string[] = [];
  for (const c of THREE) {
    const top = guardRowOf(MODS, c, 'powershell', ws);
    for (const [name, wrap] of WRAPS) {
      const inner = guardRowOf(MODS, wrap(c), 'powershell', ws);
      const looser = looserThan(top, inner);
      if (looser.length) wrong.push(`${name}: ${c} -> ${looser.join('; ')} (${inner.decision} ${inner.reasonKeys.join(',')})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('control bodies: a disk wipe, a secret read and a forced push inside try are refused / refused / push-checked', t => {
  const ws = workspace(t);
  const rm = guardRowOf(MODS, 'try { Remove-Item -Path C:\\Users -Recurse -Force } catch {}', 'powershell', ws);
  assert.equal(rm.decision, 'deny', rm.reasonKeys.join(','));
  const key = guardRowOf(MODS, 'try { Get-Content ~/.ssh/id_rsa } catch {}', 'powershell', ws);
  assert.equal(key.decision, 'deny', key.reasonKeys.join(','));
  assert.ok(key.reasonKeys.includes('scope.deny'), key.reasonKeys.join(','));
  const push = guardRowOf(MODS, 'try { git push --force origin main } catch {}', 'powershell', ws);
  assert.ok(push.reasonKeys.includes('list.git_push'), push.reasonKeys.join(','));
  assert.equal(push.pushes.length, 1);
});

test('control bodies: switch -File reads the file, so a secret file is refused', t => {
  const ws = workspace(t);
  for (const command of ['switch -File ~/.ssh/id_rsa { default { $_ } }', 'switch -Regex -File ~/.ssh/id_rsa { "^a" { 1 } }', 'switch -file "~/.ssh/id_rsa" { default {} }']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.equal(row.decision, 'deny', `${command} -> ${row.decision} ${row.reasonKeys.join(',')}`);
    assert.ok(row.reasonKeys.includes('scope.deny'), `${command} -> ${row.reasonKeys.join(',')}`);
  }
  const outside = join(ws, '..', 'outside.txt').replaceAll('\\', '/');
  const read = guardRowOf(MODS, `Get-Content ${outside}`, 'powershell', ws);
  assert.ok(read.reasonKeys.includes('guard.touches_outside'), read.reasonKeys.join(','));
  const sw = guardRowOf(MODS, `switch -File ${outside} { default {} }`, 'powershell', ws);
  assert.ok(sw.reasonKeys.includes('guard.touches_outside'), `switch -File outside -> ${sw.reasonKeys.join(',')}`);
});

const OPAQUE = [
  'param([ValidateScript({ Get-Content ~/.ssh/id_rsa })]$x)',
  'param($x = (Get-Content ~/.ssh/id_rsa))',
  'function f([ValidateScript({ Remove-Item -Recurse -Force C:/Users })]$a) { 1 }',
  'class A { [void] M() { Get-Content ~/.ssh/id_rsa } }',
  'enum E { A; B }',
  'using module ./evil.psm1',
  'try { Get-Date }',
  'do { Get-Date }',
  'switch -Bogus ($x) { default { Get-Date } }',
  'until ($true) { Get-Date }',
  'data { "x" }',
  'function f { [CmdletBinding()] param($x) }',
  'param($x = "$(Remove-Item -Recurse -Force C:/Users)")',
  'function f($x = "$(Remove-Item -Recurse -Force C:/Users)") { 1 }',
];

test('control bodies: a body the reader cannot read falls back to skipping it, marked control_opaque (still a judge reason with the judge on)', t => {
  const ws = workspace(t);
  for (const command of OPAQUE) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, `${command}: ${lexed.ok ? '' : lexed.fail.code}`);
    assert.ok(lexed.ok && lexed.statements.some(s => s.shapes.some(x => x.startsWith('control_opaque:'))), `${command}: no control_opaque`);
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.ok(row.reasonKeys.includes('shape.control_opaque'), `${command} -> ${row.reasonKeys.join(',')}`);
    assert.ok(['owner', 'refused'].includes(routeOf(row, { judgeOff: true })), command);
  }
  const readable = lexShell('try { Get-Date } catch {}', 'powershell');
  assert.ok(readable.ok && !readable.statements.some(s => s.shapes.some(x => x.startsWith('control_opaque:'))));
});

test('control bodies: a control statement keeps its control:<kw> shape and comes before its body', () => {
  for (const [kw, command] of [['try', 'try { ls } catch {}'], ['while', 'while ($true) { ls }'], ['function', 'function f { ls }'], ['switch', 'switch (1) { 1 { ls } }'], ['return', 'return ls']] as const) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, command);
    if (!lexed.ok) continue;
    const at = lexed.statements.findIndex(s => s.shapes.includes(`control:${kw}`));
    const ls = lexed.statements.findIndex(s => s.kind === 'command' && s.words[0]?.text === 'ls');
    assert.ok(at >= 0 && ls > at, `${command}: control at ${at}, ls at ${ls}`);
  }
});

test('control bodies: a read body and a skipped body leave exactly their own statements (nothing from a probe or a failed read stays)', () => {
  const list = (command: string) => {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, command);
    return lexed.ok ? lexed.statements.map(s => `${s.kind}:${s.shapes.join('+')}:${s.words.map(w => w.text).join(' ')}`) : [];
  };
  assert.deepEqual(list('try { ls } catch { Get-Date }'), ['control:control:try:', 'command::ls', 'command::Get-Date']);
  assert.deepEqual(list('while ($x) { ls }'), ['control:control:while:', 'expr::', 'command::ls']);
  const opaque = list('try { ls; Get-Date }');
  assert.equal(opaque.length, 1, opaque.join(' | '));
  assert.ok(opaque[0]!.includes('control_opaque:try'), opaque.join(' | '));
});

test('control bodies: function and trap bodies are inBlock; body statements are nested; re-runnable bodies carry their entry (trap: 0)', () => {
  const flags = (command: string) => {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, command);
    const st = lexed.ok ? lexed.statements.find(s => s.words[0]?.text === 'ls') : undefined;
    return { inBlock: st?.inBlock === true, nested: st?.nested === true, reentry: st?.reentry ?? null };
  };
  assert.deepEqual(flags('function f { ls }'), { inBlock: true, nested: true, reentry: 1 });
  assert.deepEqual(flags('Get-Date; trap { ls }'), { inBlock: true, nested: true, reentry: 0 });
  assert.deepEqual(flags('while ($x) { ls }'), { inBlock: false, nested: true, reentry: 1 });
  assert.deepEqual(flags('do { ls } until ($x)'), { inBlock: false, nested: true, reentry: 1 });
  assert.deepEqual(flags('for (;;) { ls }'), { inBlock: false, nested: true, reentry: 1 });
  assert.deepEqual(flags('foreach ($i in 1..3) { ls }'), { inBlock: false, nested: true, reentry: 1 });
  assert.deepEqual(flags('try { ls } catch {}'), { inBlock: false, nested: true, reentry: null });
  assert.deepEqual(flags('if ($x) { ls }'), { inBlock: false, nested: true, reentry: null });
  assert.deepEqual(flags('process { ls }'), { inBlock: true, nested: true, reentry: 1 });
  assert.deepEqual(flags('1 | ForEach-Object { ls }'), { inBlock: true, nested: true, reentry: 1 });
  assert.deepEqual(flags('ls'), { inBlock: false, nested: false, reentry: null });
  assert.deepEqual(flags('Get-Date; ls'), { inBlock: false, nested: false, reentry: null });
  const pwsh = lexShell('Test-Path a && ls', 'pwsh');
  assert.ok(pwsh.ok && pwsh.statements.find(s => s.words[0]?.text === 'ls')?.nested === true, 'pwsh: a statement after && may not run');
});

test('control bodies: a cd inside a loop body makes the working folder unknown afterwards, and the known folders are still checked', t => {
  const ws = workspace(t);
  for (const command of ['foreach ($i in 1..3) { cd .. }; Remove-Item x', 'while ($true) { Set-Location ..; break }; Remove-Item x']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.ok(row.reasonKeys.includes('list.cwd_unknown'), `${command} -> ${row.reasonKeys.join(',')}`);
  }
  const home = guardRowOf(MODS, 'cd ~; while ($true) { cd .ssh; break }; Get-Content id_rsa', 'powershell', ws);
  assert.equal(home.decision, 'deny', `the folder the loop leaves you in is still checked: ${home.reasonKeys.join(',')}`);
});

test('control bodies: ordinary bodies stay readable and are not refused', t => {
  const ws = workspace(t);
  const ordinary = [
    'try { Get-ChildItem } catch { Write-Error $_ }', 'try { npm test } catch { exit 1 } finally { Write-Output done }', 'while ($i -lt 3) { $i++ }',
    'do { Start-Sleep 1 } until (Test-Path out.txt)', 'for ($i = 0; $i -lt 3; $i++) { Write-Output $i }', "switch -Wildcard ($name) { '*.md' { 'doc' } default { 'other' } }",
    'param([string]$Path = \'.\') Get-ChildItem $Path', 'exit $LASTEXITCODE', 'return', 'throw "bad input"',
  ];
  // A function body is read too. As before, a command after a function definition may be that function, so outbound counts it as sending (owner, not refused)
  for (const command of ['function Get-Thing([string]$Name) { Get-ChildItem $Name }', 'function f {\n  param([Parameter(Mandatory)][string]$Name)\n  process { Write-Output $Name }\n}']) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok && !lexed.statements.some(s => s.shapes.some(x => x.startsWith('control_opaque:'))), `${command}: fell back`);
    assert.notEqual(routeOf(guardRowOf(MODS, command, 'powershell', ws), { judgeOff: true }), 'refused', command);
  }
  for (const command of ordinary) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, `${command}: ${lexed.ok ? '' : lexed.fail.code}`);
    assert.ok(lexed.ok && !lexed.statements.some(s => s.shapes.some(x => x.startsWith('control_opaque:'))), `${command}: fell back`);
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.notEqual(routeOf(row, { judgeOff: true }), 'refused', `${command} -> ${row.reasonKeys.join(',')}`);
    assert.notEqual(routeOf(row, { judgeOff: true }), 'owner', `${command} -> ${row.reasonKeys.join(',')}`);
  }
});

test('control bodies: a depth failure inside a body is refused, not skipped', () => {
  const deep = `${'try { '.repeat(9)}Get-Date${' } catch {}'.repeat(9)}`;
  const lexed = lexShell(deep, 'powershell');
  assert.ok(!lexed.ok && lexed.fail.code === 'depth', lexed.ok ? 'read' : lexed.fail.code);
});

function world(t: { after: (fn: () => void) => void }, judgeMode: 'on' | 'off') {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.routing.judgeMode = judgeMode;
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  let ran = 0;
  const stubbed: ToolDef = { ...(shellRun as unknown as ToolDef), execute: async () => { ran++; return { content: 'ran' }; } };
  const registry = new ToolRegistry().register(stubbed);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const ws = defaultWorkspace(policy, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: ws, taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto', project: { id: 'p1', root: ws },
  };
  const deps = {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, lastUserRequest: () => 'clean up the project',
    config: () => parsed, permissionMode: () => 'auto' as const,
  };
  const run = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, deps);
  return { run, pending, ran: () => ran };
}

test('control bodies: through the pipeline with the judge off, the three commands in try are refused / refused / Pending and never run; an ordinary try body runs', async t => {
  const w = world(t, 'off');
  const rm = await w.run('try { Remove-Item -Path C:\\Users -Recurse -Force } catch {}');
  assert.equal(rm.decision, 'deny', `${rm.decidedBy}: ${rm.output.content}`);
  assert.notEqual(rm.decidedBy, 'pending');
  const key = await w.run('try { Get-Content ~/.ssh/id_rsa } catch {}');
  assert.equal(key.decision, 'deny', `${key.decidedBy}: ${key.output.content}`);
  assert.notEqual(key.decidedBy, 'pending');
  const push = await w.run('try { git push --force origin main } catch {}');
  assert.equal(push.decidedBy, 'pending', push.output.content);
  for (const command of OPAQUE.slice(0, 4)) {
    const out = await w.run(command);
    assert.equal(out.decidedBy === 'pending' || out.decision === 'deny', true, `${command} -> ${out.decidedBy}: ${out.output.content}`);
  }
  const owner = w.pending.list({ status: 'waiting' }).filter(p => /cannot read/u.test(p.reason));
  assert.ok(owner.length >= 1, w.pending.list({ status: 'waiting' }).map(p => p.reason).join(' | '));
  assert.equal(w.ran(), 0);
  const ok = await w.run('try { Get-ChildItem } catch {}');
  assert.equal(w.ran(), 1, `${ok.decidedBy}: ${ok.output.content}`);
  const loop = await w.run('for ($i = 0; $i -lt 2; $i++) { Get-ChildItem }; switch (1) { 1 { Write-Output one } }');
  assert.equal(w.ran(), 2, `${loop.decidedBy}: ${loop.output.content}`);
});

test('control bodies: through the pipeline with the judge on (no judge model), the three commands in try are refused / refused / Pending', async t => {
  const w = world(t, 'on');
  assert.equal((await w.run('try { Remove-Item -Path C:\\Users -Recurse -Force } catch {}')).decision, 'deny');
  assert.equal((await w.run('try { Get-Content ~/.ssh/id_rsa } catch {}')).decision, 'deny');
  assert.equal((await w.run('try { git push --force origin main } catch {}')).decidedBy, 'pending');
  assert.equal(w.ran(), 0);
});
