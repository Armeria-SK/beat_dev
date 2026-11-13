import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pendingText, type PendingMessageKey } from '../shared/messages/pending.ts';
import { findGitDir, inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside, isRemotePath } from '../tools/hooks/scope.ts';
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
  unverifiable?: true;
}

export interface GitFact { head: string; branch: string; status: string }

export interface Snapshot { git: GitFact | null; paths: PathFact[] }

export interface Change { what: string; before: string; now: string }

const WALK_LIMIT = 50_000;
const GIT_TIMEOUT_MS = 15_000;
const UNAVAILABLE = 'unavailable';
const NO_COMMIT = 'none';
const DETACHED = 'detached';

const run = promisify(execFile);

function typeOf(st: Stats): NonNullable<PathFact['type']> {
  return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
}

async function walk(dir: string): Promise<{ files: number; size: number; newest: number; more: boolean }> {
  const out = { files: 0, size: 0, newest: 0, more: false };
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let names: string[];
    try { names = await readdir(current); } catch { out.more = true; continue; }
    for (const name of names) {
      if (++seen > WALK_LIMIT) { out.more = true; return out; }
      const path = join(current, name);
      let st: Stats;
      try { st = await lstat(path); } catch { out.more = true; continue; }
      out.newest = Math.max(out.newest, st.mtimeMs);
      if (st.isDirectory()) { stack.push(path); continue; }
      out.files += 1;
      out.size += st.size;
    }
  }
  return out;
}

export async function pathFact(path: string, deep: boolean): Promise<PathFact> {
  if (isRemotePath(path)) return { path, exists: false, unverifiable: true };
  let st: Stats;
  try { st = await lstat(path); } catch { return { path, exists: false }; }
  const fact: PathFact = { path, exists: true, type: typeOf(st), size: st.size, mtime: st.mtimeMs };
  if (!deep || !st.isDirectory()) return fact;
  const inside = await walk(path);
  return { ...fact, files: inside.files, size: inside.size, newest: Math.max(st.mtimeMs, inside.newest), ...(inside.more ? { more: true } : {}) };
}

const DESTINATION_FILES = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.curlrc', '_curlrc', '.wgetrc', '.netrc', '_netrc'];
const DESTINATION_DEPTH = 40;
const DESTINATION_MAX_BYTES = 1_048_576;

function fileMark(path: string): string {
  let st: Stats;
  try { st = lstatSync(path); } catch { return `${path}\0none`; }
  if (!st.isFile() || st.size > DESTINATION_MAX_BYTES) return `${path}\0${st.isFile() ? 'big' : 'other'}\0${st.size}\0${st.mtimeMs}`;
  try { return `${path}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}`; } catch { return `${path}\0unreadable`; }
}

export function destinationFacts(cwd: string): string {
  const marks: string[] = [];
  let dir = cwd;
  for (let i = 0; i < DESTINATION_DEPTH; i++) {
    for (const name of DESTINATION_FILES) marks.push(fileMark(join(dir, name)));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const home = homedir();
  for (const name of DESTINATION_FILES) marks.push(fileMark(join(home, name)));
  if (!isRemotePath(cwd)) {
    const found = findGitDir(cwd);
    if (found) {
      marks.push(fileMark(join(found.gitDir, 'config')), fileMark(join(found.commonDir, 'config')), fileMark(join(found.gitDir, 'config.worktree')));
    }
  }
  return createHash('sha256').update([...new Set(marks)].join('\n')).digest('hex');
}

export function fileFacts(paths: readonly string[]): PathFact[] {
  return paths.map(path => {
    if (isRemotePath(path)) return { path, exists: false, unverifiable: true } as PathFact;
    let st: Stats;
    try { st = lstatSync(path); } catch { return { path, exists: false }; }
    return { path, exists: true, type: typeOf(st), size: st.size, mtime: st.mtimeMs };
  });
}

async function gitFact(cwd: string, dataDir: string): Promise<GitFact | null> {
  const repo = inspectRepo(cwd);
  if (!repo.found) return null;
  const unavailable: GitFact = { head: UNAVAILABLE, branch: UNAVAILABLE, status: UNAVAILABLE };
  if (repo.unreadable || !repo.configOk) return unavailable;
  const base = scrubEnv();
  const gitExe = findExecutable('git', base, cwd);
  if (!gitExe || isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe)) return unavailable;
  const prepared = prepareGitRun({ dataDir, env: base, gitExe });
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await run(gitExe, ['--no-optional-locks', ...args], { cwd, env: { ...base, ...prepared.env }, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch { return null; }
  };
  try {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || NO_COMMIT;
    const branch = (await git(['symbolic-ref', '-q', 'HEAD']))?.trim() || DETACHED;
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
    return { head, branch, status: status === null ? UNAVAILABLE : createHash('sha256').update(status).digest('hex') };
  } finally { prepared.cleanup(); }
}

export async function takeSnapshot(cwd: string, targets: readonly string[], dataDir: string): Promise<Snapshot> {
  const [git, paths] = await Promise.all([gitFact(cwd, dataDir), Promise.all(targets.map(path => pathFact(path, true)))]);
  return { git, paths };
}

const unverifiable = (): string => pendingText('en', 'snap.unverifiable');

const describe = (fact: PathFact | undefined): string => {
  if (fact?.unverifiable) return unverifiable();
  if (!fact || !fact.exists) return pendingText('en', 'snap.missing');
  const parts = [pendingText('en', `snap.${fact.type ?? 'other'}` as PendingMessageKey), pendingText('en', 'snap.size', { size: fact.size ?? 0 })];
  if (fact.files !== undefined) parts.push(pendingText('en', fact.more ? 'snap.files_more' : 'snap.files', { count: fact.files }));
  const time = fact.newest ?? fact.mtime;
  if (time !== undefined) parts.push(pendingText('en', 'snap.modified', { time: new Date(time).toISOString() }));
  return parts.join(', ');
};

const headText = (value: string): string =>
  value === UNAVAILABLE ? unverifiable() : value === NO_COMMIT ? pendingText('en', 'snap.no_commit') : value === DETACHED ? pendingText('en', 'snap.detached') : value;

const same = (a: PathFact | undefined, b: PathFact | undefined): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const unsure = (fact: PathFact | undefined): boolean => fact?.more === true || fact?.unverifiable === true;

const gitUnavailable = (fact: GitFact): boolean => fact.head === UNAVAILABLE || fact.branch === UNAVAILABLE || fact.status === UNAVAILABLE;

export function compareSnapshot(before: Snapshot, now: Snapshot): Change[] {
  const changes: Change[] = [];
  const gitBefore = before.git;
  const gitNow = now.git;
  if ((gitBefore === null) !== (gitNow === null)) {
    const presence = (fact: GitFact | null): string => pendingText('en', fact ? 'snap.present' : 'snap.none');
    changes.push({ what: pendingText('en', 'snap.repo'), before: presence(gitBefore), now: presence(gitNow) });
  } else if (gitBefore && gitNow) {
    if (gitUnavailable(gitBefore) || gitUnavailable(gitNow)) {
      changes.push({ what: pendingText('en', 'snap.status'), before: unverifiable(), now: unverifiable() });
    } else {
      if (gitBefore.head !== gitNow.head) changes.push({ what: pendingText('en', 'snap.head'), before: headText(gitBefore.head), now: headText(gitNow.head) });
      if (gitBefore.branch !== gitNow.branch) changes.push({ what: pendingText('en', 'snap.branch'), before: headText(gitBefore.branch), now: headText(gitNow.branch) });
      if (gitBefore.status !== gitNow.status) changes.push({ what: pendingText('en', 'snap.status'), before: gitBefore.status.slice(0, 12), now: gitNow.status.slice(0, 12) });
    }
  }
  const nowByPath = new Map(now.paths.map(p => [p.path, p]));
  for (const fact of before.paths) {
    const current = nowByPath.get(fact.path);
    if (unsure(fact) || unsure(current) || !same(fact, current)) changes.push({ what: fact.path, before: describe(fact), now: describe(current) });
  }
  return changes;
}
