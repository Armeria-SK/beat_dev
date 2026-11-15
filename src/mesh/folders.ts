import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function runGit(exe: string, cwd: string, args: string[], env: Record<string, string>): Promise<Buffer | null> {
  return new Promise(done => {
    execFile(exe, args, { cwd, env, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout) => done(error ? null : stdout));
  });
}

export async function withGit<T>(root: string, dataDir: string, use: (git: (args: string[]) => Promise<Buffer | null>) => Promise<T>): Promise<T | undefined> {
  let real: string;
  try { real = realpathSync.native(root); } catch { return undefined; }
  try {
    const dotGit = lstatSync(join(real, '.git'), { throwIfNoEntry: false });
    if (!dotGit || dotGit.isSymbolicLink()) return undefined;
  } catch { return undefined; }
  const repo = inspectRepo(real);
  if (!repo.found || repo.unreadable || !repo.configOk) return undefined;
  const env = scrubEnv([]);
  const exe = findExecutable('git', env, real);
  if (!exe || isInside(real, exe) || !gitSupportsConfigOverride(exe)) return undefined;
  const run = prepareGitRun({ dataDir, env, gitExe: exe });
  try {
    const childEnv = { ...env, ...run.env, GIT_CEILING_DIRECTORIES: dirname(real), GIT_OPTIONAL_LOCKS: '0' };
    return await use(args => runGit(exe, real, args, childEnv));
  } finally {
    run.cleanup();
  }
}
