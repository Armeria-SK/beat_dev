import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

export const LOCK_FILE = 'beat.lock';

// 錠を書いた PC の起動の時刻（Date.now() - uptime）は、時計の合わせ直しで少しずれる。これ以上ずれていたら、別の起動のときの錠と見る
const BOOT_TOLERANCE_MS = 120_000;
// 錠のファイルは、作られてから pid が書かれるまでの一瞬、空になる。読めなかったときは、これだけ待って読み直す
const PARTIAL_WAIT_MS = 200;

export type InstanceLock =
  | { held: true; path: string; release: () => void }
  | { held: false; path: string; pid: number };

export interface LockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  bootTime?: () => number;
}

// EPERM は「ある、触れないだけ」なので生きている扱い（Windows の別ユーザーのプロセスなど）
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readLock(path: string): { pid: number; boot?: number } | undefined {
  try {
    const [first, second] = readFileSync(path, 'utf8').split(/\r?\n/u);
    const pid = Number.parseInt(first ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    const boot = second ? Number(second) : Number.NaN;
    return Number.isFinite(boot) ? { pid, boot } : { pid };
  } catch { return undefined; }
}

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// data/beat.lock を排他で作って、自分の pid と PC の起動の時刻を書く。生きている別の beat が持っていれば取らずに、その pid を返す。
// 持ち主の pid が動いていない・別の起動のときに書かれた（PC を入れ直したあとの、pid が別のプログラムに使われているかもしれない）錠は取り直す
export function acquireInstanceLock(dataDir: string, options: LockOptions = {}): InstanceLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const boot = Math.round((options.bootTime ?? (() => Date.now() - uptime() * 1000))());
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${pid}\n${boot}\n`, { flag: 'wx' });
      return { held: true, path, release: () => { if (readLock(path)?.pid === pid) try { unlinkSync(path); } catch { /* すでに無い・開いている: 次の起動が取り直す */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let other = readLock(path);
    if (!other && existsSync(path)) { sleep(PARTIAL_WAIT_MS); other = readLock(path); }
    const sameBoot = other?.boot === undefined || Math.abs(other.boot - boot) <= BOOT_TOLERANCE_MS;
    if (other && other.pid !== pid && sameBoot && isAlive(other.pid)) return { held: false, path, pid: other.pid };
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Could not take ${path}`);
}

export interface LockProcess {
  on(event: 'exit' | 'SIGHUP', listener: () => void): unknown;
  exit(code: number): unknown;
}

// 終わるとき（exit）と、窓を閉じたとき・ログオフ・シャットダウン（SIGHUP。リスナーが無いとプロセスは錠を残したまま止まる）に錠を消す。SIGHUP は、消してすぐ終わる（今までの止まり方のまま）
export function releaseOnExit(lock: Extract<InstanceLock, { held: true }>, proc: LockProcess = process): void {
  proc.on('exit', lock.release);
  proc.on('SIGHUP', () => { lock.release(); proc.exit(129); });
}
