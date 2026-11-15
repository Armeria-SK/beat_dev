import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildText } from '../shared/messages/build.ts';
import type { Task } from '../tasks/store.ts';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside, isSecretPath } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export const SNAPSHOT_REF = 'refs/beat/snapshots/';
export const SNAPSHOT_EVENT = 'snapshot';
export const SNAPSHOT_TIMEOUT_MS = 30_000;
const TASK_ID = /^[0-9a-f-]{36}$/u;
const LINKED_GIT_FILES = ['commondir', 'gitdir'];
const WRITTEN_GIT_DIRS = ['objects', 'refs', 'refs/beat', 'refs/beat/snapshots', 'logs', 'reftable'];
const LISTED_GIT_DIRS = ['objects', 'reftable'];
const CHUNK = 500;

export type SnapshotResult =
  | { kind: 'taken'; hash: string; ref: string }
  | { kind: 'not_git' }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

export function needsSnapshot(db: DatabaseSync, task: Task): boolean {
  if (!task.project_id || task.acceptance_items === null || task.spawned_by !== null || task.parent_id !== null) return false;
  return !db.prepare('SELECT 1 FROM task_events WHERE task_id = ? AND kind = ? LIMIT 1').get(task.id, SNAPSHOT_EVENT);
}

export function snapshotLine(result: SnapshotResult): string {
  switch (result.kind) {
    case 'taken': return buildText('en', 'snapshot_taken', { hash: result.hash, ref: result.ref });
    case 'not_git': return buildText('en', 'snapshot_not_git');
    case 'unavailable': return buildText('en', 'snapshot_unavailable');
    case 'timeout': return buildText('en', 'snapshot_timeout', { seconds: SNAPSHOT_TIMEOUT_MS / 1000 });
    case 'failed': return buildText('en', 'snapshot_failed');
  }
}

const dropIndex = (dir: string): void => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { return; }
};

const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};

const plainDir = (path: string): boolean => {
  const st = lstatOf(path);
  return st === undefined || (st !== null && st.isDirectory() && !st.isSymbolicLink());
};

function gitDirSafe(gitDir: string, taskId: string): boolean {
  if (LINKED_GIT_FILES.some(name => lstatOf(join(gitDir, name)) !== undefined)) return false;
  if (!WRITTEN_GIT_DIRS.every(name => plainDir(join(gitDir, name)))) return false;
  for (const name of LISTED_GIT_DIRS) {
    let entries: string[] = [];
    try { entries = readdirSync(join(gitDir, name)); } catch { entries = []; }
    if (entries.some(entry => lstatOf(join(gitDir, name, entry))?.isSymbolicLink() !== false)) return false;
  }
  return lstatOf(join(gitDir, ...SNAPSHOT_REF.split('/').filter(Boolean), taskId))?.isSymbolicLink() !== true;
}

function safePath(real: string, rel: string, seen: Map<string, boolean>): boolean {
  if (isSecretPath(rel)) return false;
  let path = real;
  for (const part of rel.split('/')) {
    path = join(path, part);
    let ok = seen.get(path);
    if (ok === undefined) {
      const st = lstatOf(path);
      if (st === undefined) return true;
      let inside = false;
      try { inside = st !== null && !st.isSymbolicLink() && isInside(real, realpathSync.native(path)); } catch { inside = false; }
      ok = inside;
      seen.set(path, ok);
    }
    if (!ok) return false;
  }
  return true;
}

export async function stagingPlan(real: string, listed: readonly string[], deadline: number): Promise<{ add: string[]; drop: string[] } | 'timeout'> {
  const seen = new Map<string, boolean>();
  const add: string[] = [];
  const drop: string[] = [];
  for (let i = 0; i < listed.length; i++) {
    if (i % CHUNK === 0) {
      if (Date.now() >= deadline) return 'timeout';
      await new Promise(resolve => setImmediate(resolve));
    }
    const rel = listed[i]!.replace(/\/$/u, '');
    if (!rel) continue;
    const abs = join(real, ...rel.split('/'));
    const st = lstatOf(abs);
    const ownRepo = st?.isDirectory() === true && lstatOf(join(abs, '.git')) !== undefined;
    if (st === undefined || !safePath(real, rel, seen) || (st?.isDirectory() === true && !ownRepo)) drop.push(rel);
    else add.push(rel);
  }
  return { add, drop };
}

export async function snapshotBeforeBuild(root: string, taskId: string, dataDir: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<SnapshotResult> {
  const deadline = Date.now() + timeoutMs;
  let real: string;
  try { real = realpathSync.native(root); } catch { return { kind: 'unavailable' }; }
  const gitDir = join(real, '.git');
  const dotGit = lstatOf(gitDir);
  if (dotGit === undefined) return { kind: 'not_git' };
  if (dotGit === null || !dotGit.isDirectory() || !TASK_ID.test(taskId) || !gitDirSafe(gitDir, taskId)) return { kind: 'unavailable' };
  const repo = inspectRepo(real);
  if (!repo.found || repo.unreadable || !repo.configOk) return { kind: 'unavailable' };
  const env = scrubEnv([]);
  const exe = findExecutable('git', env, real);
  if (!exe || isInside(real, exe) || !gitSupportsConfigOverride(exe)) return { kind: 'unavailable' };

  const run = prepareGitRun({ dataDir, env, gitExe: exe });
  const indexDir = join(dataDir, 'git-run', `index-${randomUUID()}`);
  let timedOut = false;
  try {
    mkdirSync(indexDir, { recursive: true });
    const childEnv = {
      ...env, ...run.env, GIT_DIR: gitDir, GIT_WORK_TREE: real, GIT_INDEX_FILE: join(indexDir, 'index'), GIT_CEILING_DIRECTORIES: dirname(real), GIT_OPTIONAL_LOCKS: '0',
      GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'beat', GIT_AUTHOR_EMAIL: 'beat@localhost', GIT_COMMITTER_NAME: 'beat', GIT_COMMITTER_EMAIL: 'beat@localhost',
    };
    const git = (args: string[], input?: string): Promise<string | null> => new Promise(done => {
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; done(null); return; }
      const child = execFile(exe, args, { cwd: real, env: childEnv, encoding: 'utf8', timeout: left, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error && (error.killed || Date.now() >= deadline)) timedOut = true;
        done(error ? null : stdout);
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input ?? '');
    });
    const end = (): SnapshotResult => ({ kind: timedOut ? 'timeout' : 'failed' });
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
    if (timedOut) return { kind: 'timeout' };
    if (head && await git(['read-tree', head]) === null) return end();
    const listed = await git(['ls-files', '-z', '-c', '-o', '-d', '--exclude-standard']);
    if (listed === null) return end();
    const plan = await stagingPlan(real, [...new Set(listed.split('\0').filter(Boolean))], deadline);
    if (plan === 'timeout') return { kind: 'timeout' };
    const stdin = (paths: readonly string[]): string => paths.map(path => `${path}\0`).join('');
    if (plan.drop.length && await git(['update-index', '--force-remove', '-z', '--stdin'], stdin(plan.drop)) === null) return end();
    if (plan.add.length && await git(['update-index', '--add', '--replace', '-z', '--stdin'], stdin(plan.add)) === null) return end();
    const treeHash = (await git(['write-tree']))?.trim();
    if (!treeHash) return end();
    const ref = `${SNAPSHOT_REF}${taskId}`;
    const hash = (await git(['commit-tree', '--no-gpg-sign', treeHash, ...(head ? ['-p', head] : []), '-m', `beat: snapshot before Build (task ${taskId})`]))?.trim();
    if (!hash) return end();
    if (await git(['update-ref', '--no-deref', '-m', 'beat: snapshot before Build', ref, hash, '0'.repeat(hash.length)]) === null) return end();
    return { kind: 'taken', hash, ref };
  } catch {
    return { kind: 'failed' };
  } finally {
    run.cleanup();
    dropIndex(indexDir);
  }
}
