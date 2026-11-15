import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync, type Stats } from 'node:fs';
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
const WRITTEN_GIT_DIRS = ['objects', 'refs', 'refs/beat', 'refs/beat/snapshots', 'logs'];

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

function gitDirSafe(gitDir: string): boolean {
  if (LINKED_GIT_FILES.some(name => lstatOf(join(gitDir, name)) !== undefined)) return false;
  return WRITTEN_GIT_DIRS.every(name => {
    const st = lstatOf(join(gitDir, name));
    return st === undefined || (st !== null && st.isDirectory() && !st.isSymbolicLink());
  });
}

function keepable(real: string, rel: string, seen: Map<string, boolean>): boolean {
  const clean = rel.replace(/\/$/u, '');
  if (!clean || isSecretPath(clean)) return false;
  let path = real;
  for (const part of clean.split('/')) {
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

export async function snapshotBeforeBuild(root: string, taskId: string, dataDir: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<SnapshotResult> {
  const deadline = Date.now() + timeoutMs;
  let real: string;
  try { real = realpathSync.native(root); } catch { return { kind: 'unavailable' }; }
  const gitDir = join(real, '.git');
  const dotGit = lstatOf(gitDir);
  if (dotGit === undefined) return { kind: 'not_git' };
  if (dotGit === null || !dotGit.isDirectory() || !TASK_ID.test(taskId) || !gitDirSafe(gitDir)) return { kind: 'unavailable' };
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
    const git = (args: string[]): Promise<string | null> => new Promise(done => {
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; done(null); return; }
      execFile(exe, args, { cwd: real, env: childEnv, encoding: 'utf8', timeout: left, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error && (error.killed || Date.now() >= deadline)) timedOut = true;
        done(error ? null : stdout);
      });
    });
    const end = (): SnapshotResult => ({ kind: timedOut ? 'timeout' : 'failed' });
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
    if (timedOut) return { kind: 'timeout' };
    if (head && await git(['read-tree', head]) === null) return end();
    const listed = await git(['ls-files', '-z', '-o', '-m', '-d', '--exclude-standard']);
    if (listed === null) return end();
    const seen = new Map<string, boolean>();
    const paths = [...new Set(listed.split('\0').filter(Boolean))].filter(rel => keepable(real, rel, seen));
    if (paths.length) {
      const list = join(indexDir, 'paths');
      writeFileSync(list, `${paths.join('\0')}\0`);
      if (await git(['add', '-A', `--pathspec-from-file=${list}`, '--pathspec-file-nul']) === null) return end();
    }
    const treeHash = (await git(['write-tree']))?.trim();
    if (!treeHash) return end();
    const ref = `${SNAPSHOT_REF}${taskId}`;
    const hash = (await git(['commit-tree', '--no-gpg-sign', treeHash, ...(head ? ['-p', head] : []), '-m', `beat: snapshot before Build (task ${taskId})`]))?.trim();
    if (!hash) return end();
    if (await git(['update-ref', '-m', 'beat: snapshot before Build', ref, hash, '0'.repeat(hash.length)]) === null) return end();
    return { kind: 'taken', hash, ref };
  } catch {
    return { kind: 'failed' };
  } finally {
    run.cleanup();
    dropIndex(indexDir);
  }
}
