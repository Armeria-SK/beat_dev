// beat 8-6a: 直す実行の、その回だけのプロセスの入れ物。直す実行のシェルと確かめのコマンドが起こしたプロセスを入れ、close で残ったものを全部止める
// （本体の指紋を比べる前に。残ったプロセスがあとから本体や写しを書き換えないように）。
// Windows: 手伝いの PowerShell がジョブ（閉じたら中を全部止める）を 1 つ持ち、渡されたプロセスをそこへ入れる。入れたあとに起こされた子・孫もジョブに入る。
//   手伝いが終わる（close・beat が止まる）とジョブの最後のハンドルが閉じ、中のプロセスは全部止まる。入れられなかったプロセスはその場で止める。
// POSIX: 子はそれぞれ自分のプロセスグループで動く（runner.ts の detached）。close でそのグループを全部止める。
// 残る穴（deviations.md 8-6a）: 入れる前の数ミリ秒に起こされた孫、setsid でグループを抜けたもの、WMI・タスク スケジューラなど別のプロセスに起こさせたもの
import { spawn, type ChildProcess } from 'node:child_process';
import { killTree, scrubEnv } from '../tools/shell/runner.ts';
import { powershellPath } from './win-job.ts';

export interface RunJob {
  add(child: ChildProcess): void;
  close(): Promise<void>;
}

const READY_MS = 15_000;
const CLOSE_MS = 10_000;
// PROCESS_SET_QUOTA | PROCESS_TERMINATE
const ASSIGN_ACCESS = 0x0101;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

const HELPER = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeatRunJob {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
}
'@
try {
  $job = [BeatRunJob]::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
  if ($job -eq [IntPtr]::Zero) { throw 'CreateJobObject' }
  $size = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
  $info = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  for ($i = 0; $i -lt $size; $i++) { [Runtime.InteropServices.Marshal]::WriteByte($info, $i, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($info, 16, ${JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE})
  if (-not [BeatRunJob]::SetInformationJobObject($job, 9, $info, $size)) { throw 'SetInformationJobObject' }
} catch { [Console]::Out.WriteLine('error'); exit 1 }
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $n = 0
  if (-not [uint32]::TryParse($line.Trim(), [ref]$n) -or $n -eq 0) { continue }
  $p = [BeatRunJob]::OpenProcess(${ASSIGN_ACCESS}, $false, $n)
  $ok = $p -ne [IntPtr]::Zero -and [BeatRunJob]::AssignProcessToJobObject($job, $p)
  if ($p -ne [IntPtr]::Zero) { [void][BeatRunJob]::CloseHandle($p) }
  [Console]::Out.WriteLine($(if ($ok) { "ok $n" } else { "fail $n" })); [Console]::Out.Flush()
}
[void][BeatRunJob]::TerminateJobObject($job, 1)
exit 0
`;

class WindowsRunJob implements RunJob {
  readonly #helper: ChildProcess;
  readonly #waiting = new Map<number, ChildProcess>();
  #closed = false;
  readonly #exited: Promise<void>;

  constructor(helper: ChildProcess, exited: Promise<void>) {
    this.#helper = helper;
    this.#exited = exited;
    let buffer = '';
    helper.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const m = /^(ok|fail) (\d+)$/u.exec(line);
        if (!m) continue;
        const child = this.#waiting.get(Number(m[2]));
        this.#waiting.delete(Number(m[2]));
        if (m[1] === 'fail' && child) killTree(child);
      }
    });
    void exited.then(() => { for (const child of this.#waiting.values()) killTree(child); this.#waiting.clear(); });
  }

  // 入れられない（手伝いがもういない・閉じたあと）プロセスは止める
  add(child: ChildProcess): void {
    const pid = child.pid;
    if (!pid) return;
    if (this.#closed || this.#helper.exitCode !== null || !this.#helper.stdin?.writable) { killTree(child); return; }
    this.#waiting.set(pid, child);
    this.#helper.stdin.write(`${pid}\n`);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#helper.stdin?.end();
      const timer = setTimeout(() => this.#helper.kill(), CLOSE_MS);
      await this.#exited;
      clearTimeout(timer);
    }
    await this.#exited;
  }
}

class PosixRunJob implements RunJob {
  readonly #groups = new Set<number>();
  #closed = false;
  add(child: ChildProcess): void {
    if (!child.pid) return;
    if (this.#closed) { killTree(child); return; }
    this.#groups.add(child.pid);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const group of this.#groups) { try { process.kill(-group, 'SIGKILL'); } catch { /* the group is already gone */ } }
    this.#groups.clear();
  }
}

// 入れ物を作る。Windows で作れなければ理由を返す（直す実行は始めない）
export function openRunJob(): Promise<RunJob | { failed: string }> {
  if (process.platform !== 'win32') return Promise.resolve(new PosixRunJob());
  return new Promise(resolve => {
    let helper: ChildProcess;
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
    try {
      helper = spawn(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: scrubEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) { resolve({ failed: (error as Error).message }); return; }
    const exited = new Promise<void>(done => { helper.once('exit', () => done()); helper.once('error', () => done()); });
    helper.stdin?.on('error', () => undefined);
    let seen = '';
    let settled = false;
    const finish = (value: RunJob | { failed: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      helper.stdout?.off('data', onData);
      if ('failed' in value) helper.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ failed: 'the job helper did not start in time' }), READY_MS);
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString('utf8');
      if (/^ready\s*$/mu.test(seen)) finish(new WindowsRunJob(helper, exited));
      else if (/^error\s*$/mu.test(seen)) finish({ failed: 'the job could not be made' });
    };
    helper.stdout?.on('data', onData);
    void exited.then(() => finish({ failed: 'the job helper stopped' }));
  });
}
