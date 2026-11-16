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
import { checkShellCommand, type ShellVerdict } from '../src/tools/hooks/shell-guard.ts';
import type { ShellKind } from '../src/tools/hooks/shell-lex.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// Q-62-1: disk-wiping commands are refused before any judge or Pending, however they are written.
// Every case here goes through the guard only (checkShellCommand / preCheck); nothing is executed.

function check(t: { after: (fn: () => void) => void }, command: string, shell: ShellKind): ShellVerdict {
  const ws = join(tempDir(t), 'workspace');
  mkdirSync(ws, { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: realish(ws), mode: 'write' }], deny: [] };
  return checkShellCommand(command, realish(ws), { policy, outsideRoots: 'ask', shell, windows: shell !== 'bash' });
}

const hardDenied = (v: ShellVerdict): boolean => v.decision === 'deny' && v.reasonKeys.includes('guard.hard_denied');

const DENIED_PS = [
  'Format-Volume -DriveLetter Z', 'format-volume -driveletter z', 'FORMAT-VOLUME -DriveLetter Z', 'Storage\\Format-Volume -DriveLetter Z',
  'Initialize-Volume -DriveLetter Z', 'New-Volume -FriendlyName x -FileSystem NTFS',
  'Clear-Disk -Number 1 -RemoveData', 'Initialize-Disk -Number 1', 'Remove-Partition -DriveLetter Z', 'Set-Partition -DriveLetter Z -IsActive $true',
  'Resize-Partition -DriveLetter Z -Size 1GB', 'New-Partition -DiskNumber 1 -UseMaximumSize', 'Set-Disk -Number 1 -PartitionStyle GPT',
  'Remove-VirtualDisk -FriendlyName x', 'Remove-StoragePool -FriendlyName x', 'Reset-PhysicalDisk -FriendlyName x',
  'cipher /w:C:\\', 'cipher.exe /W:Z:', 'fsutil file setzerodata offset=0 length=100 a.txt', 'fsutil.exe FILE SetZeroData offset=0 length=1 a.txt',
  'wbadmin delete catalog', 'wbadmin start recovery -version:x', 'vssadmin delete shadows /all', 'bcdedit /deletevalue x',
  '& Format-Volume -DriveLetter Z', "& 'Format-Volume' -DriveLetter Z", 'Invoke-Expression "Clear-Disk -Number 1 -RemoveData"', "iex 'Remove-Partition -DriveLetter Z'",
  'powershell -c "Format-Volume -DriveLetter Z"', 'pwsh -NoProfile -Command "Storage\\Clear-Disk -Number 1"', 'cmd /c cipher /w:C:\\', 'cmd /c "wbadmin delete catalog"', 'cmd /c call cipher /w:C:\\',
  'Get-Disk; Clear-Disk -Number 1 -RemoveData', 'Get-Volume -DriveLetter Z | Format-Volume',
];

const DENIED_BASH = [
  'wipefs -a /dev/sdb', '/sbin/wipefs /dev/sdb', 'sgdisk --zap-all /dev/sdb', 'sgdisk -Z /dev/sdb', 'gdisk /dev/sdb', 'sfdisk /dev/sdb < t', 'cfdisk /dev/sdb',
  'blkdiscard /dev/sdb', 'mkfs.ext4 /dev/sdb1', 'mke2fs /dev/sdb1', 'mkswap /dev/sdb2', 'mkntfs /dev/sdb1', 'mkdosfs /dev/sdb1',
  'dd if=/dev/zero of=/dev/sdb', 'shred /dev/sdb', 'shred -n 1 -z /dev/sdb', 'shred -- /dev/sdb',
  'bash -c "wipefs -a /dev/sdb"', "sh -c 'blkdiscard /dev/sdb'", 'nohup shred /dev/sdb', 'echo ok && sgdisk -o /dev/sdb',
];

test('disk wipe: PowerShell / cmd forms are hard-denied before any judge', t => {
  for (const command of DENIED_PS) {
    const v = check(t, command, 'powershell');
    assert.ok(hardDenied(v), `${command} -> ${v.decision} ${v.reasonKeys.join(',')}`);
  }
  for (const command of ['Format-Volume -DriveLetter Z', 'cipher /w:C:\\', 'powershell -c "Clear-Disk -Number 1"']) {
    const v = check(t, command, 'pwsh');
    assert.ok(hardDenied(v), `pwsh: ${command} -> ${v.decision} ${v.reasonKeys.join(',')}`);
  }
});

test('disk wipe: POSIX forms are hard-denied before any judge', t => {
  for (const command of DENIED_BASH) {
    const v = check(t, command, 'bash');
    assert.equal(v.decision, 'deny', `${command} -> ${v.decision} ${v.reasons.join(' / ')}`);
    if (!command.startsWith('dd ')) assert.ok(hardDenied(v), `${command} -> ${v.reasonKeys.join(',')}`);
  }
});

test('disk wipe: read-only storage commands and file-level forms are not hard-denied', t => {
  const ps = ['Get-Disk', 'Get-Volume', 'Get-Partition -DiskNumber 0', 'fsutil fsinfo drives', 'fsutil volume diskfree C:', 'fsutil file queryvaliddata a.txt', 'cipher', 'cipher /c a.txt', 'manage-bde -status'];
  for (const command of ps) {
    const v = check(t, command, 'powershell');
    assert.ok(!v.reasonKeys.includes('guard.hard_denied'), `${command} -> ${v.reasonKeys.join(',')}`);
  }
  for (const command of ['shred a.txt', 'dd if=a.img of=b.img', 'lsblk', 'blkid']) {
    const v = check(t, command, 'bash');
    assert.ok(!v.reasonKeys.includes('guard.hard_denied'), `${command} -> ${v.reasonKeys.join(',')}`);
  }
});

test('disk wipe: with the judge off and a user request, shell_run still refuses and never reaches execute', async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.routing.judgeMode = 'off';
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  let ran = 0;
  const stubbed: ToolDef = { ...(shellRun as unknown as ToolDef), execute: async () => { ran++; return { content: 'ran' }; } };
  const registry = new ToolRegistry().register(stubbed);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const deps = {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, lastUserRequest: () => 'format drive Z for me',
    config: () => parsed, permissionMode: () => 'auto' as const,
  };
  for (const command of ['Format-Volume -DriveLetter Z', 'Clear-Disk -Number 1 -RemoveData', 'Initialize-Disk -Number 1', 'Remove-Partition -DriveLetter Z']) {
    const outcome = await runToolCall({ id: `call-${command}`, name: 'shell_run', arguments: { command } }, ctx, deps);
    assert.equal(outcome.decidedBy !== 'pending' && outcome.output.content.startsWith('Not run (denied)'), true, `${command} -> ${outcome.decidedBy}: ${outcome.output.content}`);
  }
  assert.equal(ran, 0);
  assert.equal(pending.list({ status: 'waiting' }).length, 0);
});
