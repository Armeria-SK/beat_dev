import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export interface PathFact {
  path: string;
  exists: boolean;
  type?: 'file' | 'dir' | 'link' | 'other';
  size?: number;
  mtime?: number;
  files?: number;
  newest?: number;
  more?: boolean;
}

export interface GitFact { head: string; branch: string; status: string }

export interface Snapshot { git: GitFact | null; paths: PathFact[] }

export interface Change { what: string; before: string; now: string }

const WALK_LIMIT = 50_000;
const GIT_TIMEOUT_MS = 15_000;
const UNAVAILABLE = 'unavailable';

function typeOf(st: Stats): NonNullable<PathFact['type']> {
  return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

function walk(dir: string): { files: number; size: number; newest: number; more: boolean } {
  const out = { files: 0, size: 0, newest: 0, more: false };
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try { names = readdirSync(current); } catch { out.more = true; continue; }
    for (const name of names) {
      if (++seen > WALK_LIMIT) { out.more = true; return out; }
      const path = join(current, name);
      let st: Stats;
      try { st = lstatSync(path); } catch { out.more = true; continue; }
      out.newest = Math.max(out.newest, st.mtimeMs);
      if (st.isDirectory()) { stack.push(path); continue; }
      out.files += 1;
      out.size += st.size;
    }
  }
  return out;
}

export function pathFact(path: string, deep: boolean): PathFact {
  let st: Stats;
  try { st = lstatSync(path); } catch { return { path, exists: false }; }
  const fact: PathFact = { path, exists: true, type: typeOf(st), size: st.size, mtime: st.mtimeMs };
  if (!deep || !st.isDirectory()) return fact;
  const inside = walk(path);
  return { ...fact, files: inside.files, size: inside.size, newest: Math.max(st.mtimeMs, inside.newest), ...(inside.more ? { more: true } : {}) };
}

export function fileFacts(paths: readonly string[]): PathFact[] {
  return paths.map(path => pathFact(path, false));
}

function gitFact(cwd: string, dataDir: string): GitFact | null {
  const repo = inspectRepo(cwd);
  if (!repo.found) return null;
  const unavailable: GitFact = { head: UNAVAILABLE, branch: UNAVAILABLE, status: UNAVAILABLE };
  if (repo.unreadable || !repo.configOk) return unavailable;
  const base = scrubEnv();
  const gitExe = findExecutable('git', base, cwd);
  if (!gitExe || isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe)) return unavailable;
  const run = prepareGitRun({ dataDir, env: base, gitExe });
  const git = (args: string[]): string | null => {
    try {
      return execFileSync(gitExe, ['--no-optional-locks', ...args], { cwd, env: { ...base, ...run.env }, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch { return null; }
  };
  try {
    const head = git(['rev-parse', '--verify', '-q', 'HEAD'])?.trim() || 'none';
    const branch = git(['symbolic-ref', '-q', 'HEAD'])?.trim() || 'detached';
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return { head, branch, status: status === null ? UNAVAILABLE : createHash('sha256').update(status).digest('hex') };
  } finally { run.cleanup(); }
}

export function takeSnapshot(cwd: string, targets: readonly string[], dataDir: string): Snapshot {
  return { git: gitFact(cwd, dataDir), paths: targets.map(path => pathFact(path, true)) };
}

const describe = (fact: PathFact | undefined): string => {
  if (!fact || !fact.exists) return 'missing';
  const parts = [fact.type ?? 'other', `${fact.size ?? 0} bytes`];
  if (fact.files !== undefined) parts.push(`${fact.files}${fact.more ? '+' : ''} files`);
  const time = fact.newest ?? fact.mtime;
  if (time !== undefined) parts.push(`modified ${new Date(time).toISOString()}`);
  return parts.join(', ');
};

const same = (a: PathFact | undefined, b: PathFact | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function compareSnapshot(before: Snapshot, now: Snapshot): Change[] {
  const changes: Change[] = [];
  const gitBefore = before.git;
  const gitNow = now.git;
  if ((gitBefore === null) !== (gitNow === null)) changes.push({ what: 'git repository', before: gitBefore ? 'present' : 'none', now: gitNow ? 'present' : 'none' });
  else if (gitBefore && gitNow) {
    if (gitBefore.head !== gitNow.head) changes.push({ what: 'HEAD', before: gitBefore.head, now: gitNow.head });
    if (gitBefore.branch !== gitNow.branch) changes.push({ what: 'branch', before: gitBefore.branch, now: gitNow.branch });
    if (gitBefore.status !== gitNow.status) changes.push({ what: 'git status', before: gitBefore.status.slice(0, 12), now: gitNow.status.slice(0, 12) });
  }
  const nowByPath = new Map(now.paths.map(p => [p.path, p]));
  for (const fact of before.paths) {
    const current = nowByPath.get(fact.path);
    if (!same(fact, current)) changes.push({ what: fact.path, before: describe(fact), now: describe(current) });
  }
  return changes;
}
