// beat 8-6a: 直す実行の、その回だけのプロセスの入れ物。直す実行のシェルと確かめのコマンドが起こしたプロセスを入れ、close で残ったものを全部止める
// （本体の指紋を比べる前に。残ったプロセスがあとから本体や写しを書き換えないように）。
// Windows: 手伝いの PowerShell がジョブ（閉じたら中を全部止める）を 1 つ持ち、渡されたプロセスをそこへ入れる。入れたあとに起こされた子・孫もジョブに入る。
//   手伝いが終わる（close・beat が止まる）とジョブの最後のハンドルが閉じ、中のプロセスは全部止まる。入れられなかったプロセスはその場で止める。
//   手伝いは、PID の行のほかに「q <番号> <ポート>」の問い合わせにも答える（browser-rethink P7）: そのポートで待ち受けているプロセスが全部このジョブの中かを、
//   待ち受けの表（iphlpapi の GetExtendedTcpTable）と IsProcessInJob で調べ、「q <番号> yes|no|none|unknown」と返す。PID の行の扱いは変えない
// POSIX: 子はそれぞれ自分のプロセスグループで動く（runner.ts の detached）。close でそのグループを全部止める。
// 残る穴（deviations.md 8-6a）: 入れる前の数ミリ秒に起こされた孫、setsid でグループを抜けたもの、WMI・タスク スケジューラなど別のプロセスに起こさせたもの
import { spawn, type ChildProcess } from 'node:child_process';
import { killTree, scrubEnv } from '../tools/shell/runner.ts';
import { powershellPath } from './win-job.ts';

export interface RunJob {
  // onFail を渡すと、入れられなかったプロセスを止めずに理由を返す（裏のコマンド）。渡さなければ止める（直す実行）
  add(child: ChildProcess, onFail?: (reason: string) => void): void;
  close(): Promise<void>;
  // 入れ物が無くなった（close・手伝いが止まった）
  readonly ended: Promise<void>;
  // そのポートで待ち受けているプロセスが、全部このジョブの中か。yes: 1 つ以上あり全部ジョブの中 / no: ジョブの外のものがある / none: 待ち受けが無い / unknown: 調べられない
  // （POSIX・手伝いがいない・閉じたあと・時間切れ）。yes のときだけ「ジョブの中で動いている」と言える
  listens(port: number): Promise<ListenAnswer>;
}

export type ListenAnswer = 'yes' | 'no' | 'none' | 'unknown';

const NOT_ASSIGNED = 'the process could not be put in the job';
const HELPER_GONE = 'the job helper stopped';
type Waiter = { child: ChildProcess; onFail: ((reason: string) => void) | undefined };
const refuse = (waiter: Waiter, reason: string): void => { if (waiter.onFail) waiter.onFail(reason); else killTree(waiter.child); };

const READY_MS = 15_000;
const CLOSE_MS = 10_000;
const LISTEN_MS = 4000;
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
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("iphlpapi.dll")] public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);

  // Collect the owner PIDs of the listeners on this port from the listener table (TCP_TABLE_OWNER_PID_LISTENER = 3). family 2 = IPv4 (24 bytes per row), 23 = IPv6 (56 bytes per row).
  // The port is stored in network byte order inside the row.
  static bool Collect(int family, int port, System.Collections.Generic.List<uint> pids) {
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
    for (int attempt = 0; attempt < 6; attempt++) {
      if (size <= 0) return false;
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        uint rc = GetExtendedTcpTable(buffer, ref size, false, family, 3, 0);
        if (rc == 122) { size += 4096; continue; }
        if (rc != 0) return false;
        int rows = Marshal.ReadInt32(buffer, 0);
        int stride = family == 2 ? 24 : 56;
        int portAt = family == 2 ? 8 : 20;
        int pidAt = family == 2 ? 20 : 52;
        for (int i = 0; i < rows; i++) {
          int row = 4 + i * stride;
          int raw = Marshal.ReadInt32(buffer, row + portAt);
          int local = ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF);
          if (local == port) pids.Add((uint)Marshal.ReadInt32(buffer, row + pidAt));
        }
        return true;
      } finally { Marshal.FreeHGlobal(buffer); }
    }
    return false;
  }

  // yes / no / none / unknown. A process that cannot be opened (not enough rights) cannot be shown to be in the job, so the answer is no.
  public static string Listens(int port, IntPtr job) {
    try {
      if (port < 1 || port > 65535) return "unknown";
      System.Collections.Generic.List<uint> pids = new System.Collections.Generic.List<uint>();
      if (!Collect(2, port, pids)) return "unknown";
      if (!Collect(23, port, pids)) return "unknown";
      if (pids.Count == 0) return "none";
      foreach (uint pid in pids) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return "no";
        bool inside;
        bool known = IsProcessInJob(process, job, out inside);
        CloseHandle(process);
        if (!known) return "unknown";
        if (!inside) return "no";
      }
      return "yes";
    } catch (Exception) { return "unknown"; }
  }
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
  $parts = $line.Trim().Split(' ')
  if ($parts.Length -eq 3 -and $parts[0] -eq 'q') {
    $seq = [uint32]0; $port = [uint32]0
    if ([uint32]::TryParse($parts[1], [ref]$seq) -and [uint32]::TryParse($parts[2], [ref]$port) -and $port -le 65535) {
      [Console]::Out.WriteLine('q ' + $seq + ' ' + [BeatRunJob]::Listens([int]$port, $job)); [Console]::Out.Flush()
    }
    continue
  }
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
  readonly #waiting = new Map<number, Waiter>();
  // 「そのポートの待ち受けはジョブの中か」の問い合わせ（番号ごと。手伝いは順に答えるが、時間切れで番号がずれないよう番号で結ぶ）
  readonly #asks = new Map<number, (answer: ListenAnswer) => void>();
  #askSeq = 0;
  #closed = false;
  readonly #exited: Promise<void>;
  readonly ended: Promise<void>;

  constructor(helper: ChildProcess, exited: Promise<void>) {
    this.#helper = helper;
    this.#exited = exited;
    this.ended = exited;
    let buffer = '';
    helper.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const asked = /^q (\d+) (yes|no|none|unknown)$/u.exec(line);
        if (asked) {
          const ask = this.#asks.get(Number(asked[1]));
          this.#asks.delete(Number(asked[1]));
          ask?.(asked[2] as ListenAnswer);
          continue;
        }
        const m = /^(ok|fail) (\d+)$/u.exec(line);
        if (!m) continue;
        const waiter = this.#waiting.get(Number(m[2]));
        this.#waiting.delete(Number(m[2]));
        if (m[1] === 'fail' && waiter) refuse(waiter, NOT_ASSIGNED);
      }
    });
    void exited.then(() => {
      for (const waiter of this.#waiting.values()) refuse(waiter, HELPER_GONE);
      this.#waiting.clear();
      for (const ask of this.#asks.values()) ask('unknown');
      this.#asks.clear();
    });
  }

  listens(port: number): Promise<ListenAnswer> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return Promise.resolve('unknown');
    if (this.#closed || this.#helper.exitCode !== null || !this.#helper.stdin?.writable) return Promise.resolve('unknown');
    const seq = ++this.#askSeq;
    return new Promise<ListenAnswer>(resolve => {
      const timer = setTimeout(() => { this.#asks.delete(seq); resolve('unknown'); }, LISTEN_MS);
      this.#asks.set(seq, answer => { clearTimeout(timer); resolve(answer); });
      this.#helper.stdin!.write(`q ${seq} ${port}\n`);
    });
  }

  // 入れられない（手伝いがもういない・閉じたあと）プロセスは止める（onFail があれば理由を返す）
  add(child: ChildProcess, onFail?: (reason: string) => void): void {
    const pid = child.pid;
    if (!pid) return;
    if (this.#closed || this.#helper.exitCode !== null || !this.#helper.stdin?.writable) { refuse({ child, onFail }, HELPER_GONE); return; }
    this.#waiting.set(pid, { child, onFail });
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
  #end!: () => void;
  readonly ended = new Promise<void>(r => { this.#end = r; });
  add(child: ChildProcess, onFail?: (reason: string) => void): void {
    if (!child.pid) return;
    if (this.#closed) { refuse({ child, onFail }, HELPER_GONE); return; }
    this.#groups.add(child.pid);
  }
  // プロセスのグループには、待ち受けの持ち主を引く口が無い
  listens(): Promise<ListenAnswer> { return Promise.resolve('unknown'); }
  async close(): Promise<void> {
    this.#closed = true;
    this.#end();
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
