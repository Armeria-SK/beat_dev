import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { redactSecrets } from '../shared/redaction.ts';
import { findGitDir, inspectRepo, parseGitConfig, unusualKey, type ConfigEntry } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1_048_576;
const NOTICE_MAX = 400;

// 署名の設定。値はデータだけで、コードを動かす gpg.*.program は入れない（それは prepareGitRun が打ち消す）
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

// inspectRepo が設定で断ったリポジトリを、署名の設定を除いて同じ物差し（unusualKey と、remote の名前でない branch の宛先）で測り直す。残る項目の名前を返す（無ければ null）
function keyBesidesSigning(real: string, fallback: string): string | null {
  const found = findGitDir(real);
  if (!found || found.broken) return fallback;
  const files = [...new Set([join(found.commonDir, 'config'), join(found.gitDir, 'config'), join(found.gitDir, 'config.worktree'), join(found.commonDir, 'config.worktree')])];
  const rest: ConfigEntry[] = [];
  for (const file of files) {
    let text: string;
    try {
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (!st) continue;
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return fallback;
      text = readFileSync(file, 'utf8');
    } catch { return fallback; }
    const parsed = parseGitConfig(text);
    if (!parsed) return fallback;
    rest.push(...parsed.filter(entry => !SIGNING_KEYS.has(entry.key)));
  }
  const remotes = new Set(rest.filter(e => /^remote\..+\.url$/u.test(e.key)).map(e => e.key.slice('remote.'.length, -'.url'.length)));
  const dangling = rest.find(e => /^branch\..+\.(?:remote|pushremote)$/u.test(e.key) && e.value.trim() !== '.' && !remotes.has(e.value.trim()));
  return unusualKey(rest) ?? dangling?.key ?? null;
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
  const repo = inspectRepo(real);
  if (!repo.found) return undefined;
  if (repo.unreadable) { tell(real, 'its .git folder could not be checked safely'); return undefined; }
  const blocking = repo.configOk ? null : keyBesidesSigning(real, repo.badKey);
  if (blocking !== null) { tell(real, `its git settings have ${blocking.split(' = ')[0]}, which can run programs`); return undefined; }
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
