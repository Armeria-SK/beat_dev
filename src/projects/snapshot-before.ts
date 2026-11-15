import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildText } from '../shared/messages/build.ts';
import { OWNER_FIX, type Task } from '../tasks/store.ts';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export const SNAPSHOT_REF = 'refs/beat/snapshots/';
export const SNAPSHOT_EVENT = 'snapshot';
export const SNAPSHOT_TIMEOUT_MS = 30_000;
const TASK_ID = /^[0-9a-f-]{36}$/u;

export type SnapshotResult =
  | { kind: 'taken'; hash: string; ref: string }
  | { kind: 'not_git' }
  | { kind: 'unavailable' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

export function needsSnapshot(db: DatabaseSync, task: Task): boolean {
  if (!task.project_id || task.acceptance_items === null || task.spawned_by !== null || task.parent_id !== null) return false;
  return !db.prepare('SELECT 1 FROM task_events WHERE task_id = ? AND kind IN (?, ?) LIMIT 1').get(task.id, SNAPSHOT_EVENT, OWNER_FIX);
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

export async function snapshotBeforeBuild(root: string, taskId: string, dataDir: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<SnapshotResult> {
  const deadline = Date.now() + timeoutMs;
  let real: string;
  try { real = realpathSync.native(root); } catch { return { kind: 'unavailable' }; }
  const gitDir = join(real, '.git');
  const dotGit = lstatSync(gitDir, { throwIfNoEntry: false });
  if (!dotGit) return { kind: 'not_git' };
  if (!dotGit.isDirectory() || !TASK_ID.test(taskId)) return { kind: 'unavailable' };
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
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'beat', GIT_AUTHOR_EMAIL: 'beat@localhost', GIT_COMMITTER_NAME: 'beat', GIT_COMMITTER_EMAIL: 'beat@localhost',
    };
    const git = (args: string[]): Promise<string | null> => new Promise(done => {
      const left = deadline - Date.now();
      if (left <= 0) { timedOut = true; done(null); return; }
      execFile(exe, args, { cwd: real, env: childEnv, encoding: 'utf8', timeout: left, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error && (error.killed || Date.now() >= deadline)) timedOut = true;
        done(error ? null : stdout.trim());
      });
    });
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    if (timedOut) return { kind: 'timeout' };
    if (head && await git(['read-tree', head]) === null) return { kind: timedOut ? 'timeout' : 'failed' };
    if (await git(['add', '-A', '--', '.']) === null) return { kind: timedOut ? 'timeout' : 'failed' };
    const treeHash = await git(['write-tree']);
    if (!treeHash) return { kind: timedOut ? 'timeout' : 'failed' };
    const ref = `${SNAPSHOT_REF}${taskId}`;
    const hash = await git(['commit-tree', '--no-gpg-sign', treeHash, ...(head ? ['-p', head] : []), '-m', `beat: snapshot before Build (task ${taskId})`]);
    if (!hash) return { kind: timedOut ? 'timeout' : 'failed' };
    if (await git(['update-ref', '-m', 'beat: snapshot before Build', ref, hash, '0'.repeat(hash.length)]) === null) return { kind: timedOut ? 'timeout' : 'failed' };
    return { kind: 'taken', hash, ref };
  } catch {
    return { kind: 'failed' };
  } finally {
    run.cleanup();
    dropIndex(indexDir);
  }
}
