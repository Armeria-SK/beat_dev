import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../shared/redaction.ts';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const NOTICE_MAX = 400;

// 署名の設定。値はデータだけで、コードを動かす gpg.*.program は入れない。inspectRepo の設定の判定で数えない
const SIGNING_KEYS: ReadonlySet<string> = new Set([
  'commit.gpgsign', 'tag.gpgsign', 'tag.forcesignannotated', 'push.gpgsign', 'user.signingkey',
  'gpg.format', 'gpg.mintrustlevel', 'gpg.ssh.allowedsignersfile', 'gpg.ssh.revocationfile',
]);

let notice: ((line: string) => void) | undefined;
const told = new Set<string>();

export function setGitNotice(log: (line: string) => void): () => void {
  notice = log;
  return () => { if (notice === log) notice = undefined; };
}

function tell(real: string, why: string): void {
  const key = `${real}\0${why}`;
  if (!notice || told.has(key)) return;
  told.add(key);
  notice(redactSecrets(`[WARN] beat does not run git in ${real} (${why}); checks that need git use file times there or are skipped`).slice(0, NOTICE_MAX));
}

// ログに出す項目の名前。値は出さず、副の名前（URL・remote・branch の名前など）は <…> に伏せる
function keyLabel(badKey: string): string {
  const parts = badKey.split('.');
  if (parts.length === 2 && !badKey.includes(' = ')) return badKey;
  const name = /\.(url|pushurl|remote|pushremote) = /u.exec(badKey)?.[1] ?? (badKey.includes(' = ') ? undefined : parts.at(-1));
  return `${parts[0]}.<…>${name ? `.${name}` : ''}`;
}

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
  const repo = inspectRepo(real, SIGNING_KEYS);
  if (!repo.found) return undefined;
  if (repo.unreadable) { tell(real, 'its .git folder could not be checked safely'); return undefined; }
  if (!repo.configOk) { tell(real, `its git settings have ${keyLabel(repo.badKey)}, which beat does not run git with`); return undefined; }
  const env = scrubEnv([]);
  const exe = findExecutable('git', env, real);
  if (!exe || isInside(real, exe) || !gitSupportsConfigOverride(exe)) { tell(real, 'git 2.32 or newer was not found outside the folder'); return undefined; }
  const run = prepareGitRun({ dataDir, env, gitExe: exe });
  try {
    const childEnv = { ...env, ...run.env, GIT_CEILING_DIRECTORIES: dirname(real), GIT_OPTIONAL_LOCKS: '0' };
    return await use(args => runGit(exe, real, args, childEnv));
  } finally {
    run.cleanup();
  }
}
