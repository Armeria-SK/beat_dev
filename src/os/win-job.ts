import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { scrubEnv } from '../tools/shell/runner.ts';

export type JobResult = { state: 'joined' | 'skipped' } | { state: 'failed'; reason: string };

export type JobOptions = {
  timeoutMs?: number;
  failAt?: number;
  haltAfter?: number;
};

const TIMEOUT_MS = 15_000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_DUP_HANDLE_SET_QUOTA_TERMINATE = 0x141;

export const powershellPath = (): string => join(process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function jobHelperScript(pid: number, inject: { failAt?: number; haltAfter?: number } = {}): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  const failAt = Number.isSafeInteger(inject.failAt) ? inject.failAt : 0;
  const haltAfter = Number.isSafeInteger(inject.haltAfter) ? inject.haltAfter : 0;
  return `$ErrorActionPreference = 'Stop'
$targetPid = ${pid}; $failAt = ${failAt}; $haltAfter = ${haltAfter}
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeatJob {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
'@
function Done($n) { [Console]::Out.WriteLine("stage:$n"); [Console]::Out.Flush(); if ($haltAfter -eq $n) { Start-Sleep -Seconds 600 } }
function Fail($n, $what, $code) { throw "stage $n ($what) failed with Win32 error $code" }
function Inject($n) { if ($failAt -eq $n) { throw "stage $n failed (injected)" } }
Inject 1
$job = [BeatJob]::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($job -eq [IntPtr]::Zero) { Fail 1 'CreateJobObject' $code }
Done 1
$process = [BeatJob]::OpenProcess(${PROCESS_DUP_HANDLE_SET_QUOTA_TERMINATE}, $false, $targetPid); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($process -eq [IntPtr]::Zero) { Fail 2 'OpenProcess' $code }
$target = $process
if ($failAt -eq 2) { $target = [IntPtr]::Zero }
$copy = [IntPtr]::Zero
$ok = [BeatJob]::DuplicateHandle([BeatJob]::GetCurrentProcess(), $job, $target, [ref]$copy, 0, $false, 2); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if (-not $ok) { Fail 2 'DuplicateHandle' $code }
Done 2
Inject 3
$size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
$info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
[Runtime.InteropServices.Marshal]::WriteInt32($info, 16, ${JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE})
$ok = [BeatJob]::SetInformationJobObject($job, 9, $info, $size); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if (-not $ok) { Fail 3 'SetInformationJobObject' $code }
Done 3
Inject 4
$ok = [BeatJob]::AssignProcessToJobObject($job, $process); $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
if (-not $ok) { Fail 4 'AssignProcessToJobObject' $code }
Done 4
[Console]::Out.WriteLine('ok')
} catch {
  [Console]::Out.WriteLine('error: ' + $_.Exception.Message)
  exit 1
}
`;
}

function lastStage(stdout: string): number {
  const stages = [...stdout.matchAll(/^stage:(\d)\s*$/gmu)].map(m => Number(m[1]));
  return stages.length ? Math.max(...stages) : 0;
}

export function enterKillOnCloseJob(options: JobOptions = {}): Promise<JobResult> {
  if (process.platform !== 'win32') return Promise.resolve({ state: 'skipped' });
  let script: string;
  try { script = jobHelperScript(process.pid, options); } catch (error) { return Promise.resolve({ state: 'failed', reason: (error as Error).message }); }
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  return new Promise(resolve => {
    let streamed = '';
    let settled = false;
    const reached = (stdout: string) => `last completed stage ${lastStage(stdout)} of 4`;
    const finish = (result: JobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess | undefined;
    const timer = setTimeout(() => {
      child?.kill();
      finish({ state: 'failed', reason: `the helper timed out after ${timeout} ms (${reached(streamed)})` });
    }, timeout);
    try {
      child = execFile(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: scrubEnv(), windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (!error && /^ok\s*$/mu.test(stdout)) { finish({ state: 'joined' }); return; }
        const detail = /^error: (.*?)\s*$/mu.exec(stdout)?.[1] ?? (error?.message ?? 'no confirmation from the helper').split(/\r?\n/u)[0];
        finish({ state: 'failed', reason: `${detail} (${reached(stdout)})` });
      });
      child.stdout?.on('data', (chunk: string) => { streamed += chunk; });
    } catch (error) {
      finish({ state: 'failed', reason: (error as Error).message });
    }
  });
}
