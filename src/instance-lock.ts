import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'beat.lock';

export type InstanceLock =
  | { held: true; path: string; release: () => void }
  | { held: false; path: string; pid: number };

export interface LockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

// EPERM は「ある、触れないだけ」なので生きている扱い（Windows の別ユーザーのプロセスなど）
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function pidIn(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8'), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

// data/beat.lock を排他で作って自分の pid を書く。生きている別の beat が持っていれば取らずに、その pid を返す。持ち主の pid が生きていない（異常終了のあとの）錠は取り直す
export function acquireInstanceLock(dataDir: string, options: LockOptions = {}): InstanceLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const path = join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx' });
      return { held: true, path, release: () => { if (pidIn(path) === pid) try { unlinkSync(path); } catch { /* すでに無い・開いている: 次の起動が取り直す */ } } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const other = pidIn(path);
    if (other !== undefined && other !== pid && isAlive(other)) return { held: false, path, pid: other };
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Could not take ${path}`);
}
