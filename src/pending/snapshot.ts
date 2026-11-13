import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
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
  hash?: string;
  real?: string;
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

const DESTINATION_FILES = [
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.curlrc', '_curlrc', '.wgetrc', '.netrc', '_netrc',
  join('.cargo', 'config'), join('.cargo', 'config.toml'), 'NuGet.Config', 'nuget.config', join('.hg', 'hgrc'), 'bunfig.toml', '.bunfig.toml',
];
const DESTINATION_DEPTH = 40;
const DESTINATION_MAX_BYTES = 1_048_576;

export function fileMark(path: string): string {
  let own: Stats;
  try { own = lstatSync(path); } catch { return `${path}\0none`; }
  let st: Stats;
  try { st = statSync(path); } catch { return `${path}\0broken-link\0${own.mtimeMs}`; }
  let real: string;
  try { real = realpathSync.native(path); } catch { real = path; }
  const head = `${path}\0${own.isSymbolicLink() ? `link\0${real}` : 'plain'}`;
  if (!st.isFile() || st.size > DESTINATION_MAX_BYTES) return `${head}\0${st.isFile() ? 'big' : 'other'}\0${st.size}\0${st.mtimeMs}`;
  try { return `${head}\0${createHash('sha256').update(readFileSync(path)).digest('hex')}`; } catch { return `${head}\0unreadable`; }
}

export function destinationFacts(cwd: string, places: readonly string[] = []): string {
  const marks: string[] = [];
  for (const start of new Set([cwd, ...places])) {
    let dir = start;
    for (let i = 0; i < DESTINATION_DEPTH; i++) {
      for (const name of DESTINATION_FILES) marks.push(fileMark(join(dir, name)));
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (!isRemotePath(start)) {
      const found = findGitDir(start);
      if (found) {
        marks.push(fileMark(join(found.gitDir, 'config')), fileMark(join(found.commonDir, 'config')), fileMark(join(found.gitDir, 'config.worktree')));
      }
    }
  }
  const home = homedir();
  for (const name of DESTINATION_FILES) marks.push(fileMark(join(home, name)));
  if (process.env.APPDATA) marks.push(fileMark(join(process.env.APPDATA, 'NuGet', 'NuGet.Config')));
  return createHash('sha256').update([...new Set(marks)].sort().join('\n')).digest('hex');
}

const CONTENT_MAX_BYTES = 4 * 1_048_576;

function contentHash(path: string, st: Stats): string {
  if (st.size > CONTENT_MAX_BYTES) return `big:${st.size}:${st.mtimeMs}:${st.ino}`;
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return 'unreadable'; }
}

function folderHash(dir: string): { hash: string; more: boolean } {
  const entries: string[] = [];
  const stack = [dir];
  let more = false;
  while (stack.length && !more) {
    const current = stack.pop()!;
    let names: string[];
    try { names = readdirSync(current); } catch { more = true; break; }
    for (const name of names) {
      if (entries.length >= WALK_LIMIT) { more = true; break; }
      const path = join(current, name);
      let st: Stats;
      try { st = lstatSync(path); } catch { more = true; break; }
      entries.push(`${relative(dir, path)}\0${typeOf(st)}\0${st.size}\0${st.mtimeMs}`);
      if (st.isDirectory()) stack.push(path);
    }
  }
  return { hash: createHash('sha256').update(entries.sort().join('\n')).digest('hex'), more };
}

export function boundFacts(paths: readonly string[]): PathFact[] {
  return paths.map(path => {
    if (isRemotePath(path)) return { path, exists: false, unverifiable: true } as PathFact;
    let st: Stats;
    try { st = statSync(path); } catch { return { path, exists: false }; }
    let real: string;
    try { real = realpathSync.native(path); } catch { real = path; }
    if (st.isDirectory()) {
      const inside = folderHash(path);
      return { path, exists: true, type: 'dir', real, hash: inside.hash, ...(inside.more ? { more: true } : {}) };
    }
    return { path, exists: true, type: st.isFile() ? 'file' : 'other', size: st.size, real, hash: st.isFile() ? contentHash(path, st) : `other:${st.ino}` };
  });
}

export function boundChanged(before: PathFact, now: PathFact): boolean {
  if (before.more || now.more || before.unverifiable || now.unverifiable) return true;
  return before.exists !== now.exists || before.type !== now.type || before.hash !== now.hash || before.real !== now.real || before.size !== now.size;
}

export function fileFacts(paths: readonly string[]): PathFact[] {
  return paths.map(path => {
    if (isRemotePath(path)) return { path, exists: false, unverifiable: true } as PathFact;
    let st: Stats;
    try { st = lstatSync(path); } catch { return { path, exists: false }; }
    return { path, exists: true, type: typeOf(st), size: st.size, mtime: st.mtimeMs };
  });
}

type GitRun = (args: string[]) => Promise<string | null>;

async function withGit<T>(cwd: string, dataDir: string, missing: T, unavailable: T, work: (git: GitRun) => Promise<T>): Promise<T> {
  const repo = inspectRepo(cwd);
  if (!repo.found) return missing;
  if (repo.unreadable || !repo.configOk) return unavailable;
  const base = scrubEnv();
  const gitExe = findExecutable('git', base, cwd);
  if (!gitExe || isInside(cwd, gitExe) || !gitSupportsConfigOverride(gitExe)) return unavailable;
  const prepared = prepareGitRun({ dataDir, env: base, gitExe });
  const git: GitRun = async args => {
    try {
      const { stdout } = await run(gitExe, ['--no-optional-locks', ...args], { cwd, env: { ...base, ...prepared.env }, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch { return null; }
  };
  try { return await work(git); } finally { prepared.cleanup(); }
}

async function gitFact(cwd: string, dataDir: string): Promise<GitFact | null> {
  return withGit<GitFact | null>(cwd, dataDir, null, { head: UNAVAILABLE, branch: UNAVAILABLE, status: UNAVAILABLE }, async git => {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || NO_COMMIT;
    const branch = (await git(['symbolic-ref', '-q', 'HEAD']))?.trim() || DETACHED;
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']);
    return { head, branch, status: status === null ? UNAVAILABLE : createHash('sha256').update(status).digest('hex') };
  });
}

export const PUSH_UNCONFIRMED = 'unconfirmed:';

export async function pushFacts(pushes: ReadonlyArray<{ dir: string | null }>, dataDir: string): Promise<string> {
  const never = (): string => `${PUSH_UNCONFIRMED}${Date.now()}:${randomUUID()}`;
  const lines: string[] = [];
  for (const { dir } of pushes) {
    if (dir === null) return never();
    const line = await withGit<string | null>(dir, dataDir, `${dir}\0no-repo`, null, async git => {
      const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || NO_COMMIT;
      const branch = (await git(['symbolic-ref', '-q', 'HEAD']))?.trim() || DETACHED;
      const refs = await git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']);
      return refs === null ? null : `${dir}\0${head}\0${branch}\0${createHash('sha256').update(refs).digest('hex')}`;
    });
    if (line === null) return never();
    lines.push(line);
  }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
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
