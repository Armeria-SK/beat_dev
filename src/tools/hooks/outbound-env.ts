import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Language } from '../../config/schema.ts';
import type { Remote } from '../../projects/remotes.ts';
import { inspectRepo } from './git-repo.ts';
import { isInside, realish } from './scope.ts';
import { prepareGitRun } from '../shell/git-env.ts';
import type { OutboundEnv } from './outbound.ts';
import type { Env } from './tool-config.ts';

const MAX_WALK = 20_000;
const REMOTE_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/u;

export interface GitOutboundOptions {
  productRoot?: string | undefined;
  remotes?: readonly Remote[] | undefined;
  workspaceRoots?: readonly string[];
  dataDir: string;
  env?: Env;
  gitExe: string;
  language?: Language;
  isCreated: (path: string) => boolean;
}

interface RepoState { top: string; ok: ReadonlySet<string>; dirty: readonly string[] }

function filesUnder(dir: string): string[] | undefined {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full); else out.push(full);
      if (out.length + stack.length > MAX_WALK) return undefined;
    }
  }
  return out;
}

export function isolatedGit(options: { dataDir: string; env?: Env | undefined; gitExe: string; productRoot?: string | undefined }): (dir: string, args: string[]) => string | undefined {
  const base: Env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([k]) => !/^git_/iu.test(k)));
  const exe = options.gitExe;
  const trusted = (dir: string): boolean => isAbsolute(exe) && ![dir, ...(options.productRoot ? [options.productRoot] : [])].some(d => isInside(d, exe) || isInside(realish(d), realish(exe)));
  return (dir, args) => {
    if (!trusted(dir)) return undefined;
    const run = prepareGitRun({ dataDir: options.dataDir, env: base, gitExe: exe });
    try {
      return execFileSync(exe, args, { cwd: dir, env: { ...base, ...run.env }, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch { return undefined; } finally { run.cleanup(); }
  };
}

export function gitOutboundEnv(options: GitOutboundOptions): OutboundEnv {
  const git = isolatedGit(options);
  let state: RepoState | null | undefined;
  const load = (): RepoState | null => {
    if (state !== undefined) return state;
    state = null;
    if (!options.productRoot) return state;
    const top = git(options.productRoot, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top) return state;
    const repo = inspectRepo(options.productRoot);
    if (!repo.found || repo.unreadable || !repo.configOk) return state;
    const listed = git(top, ['ls-files', '-s', '-v', '-z', '--full-name']);
    const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']);
    if (listed === undefined || status === undefined) return state;
    const ok = new Set(listed.split('\0').flatMap(e => {
      const m = /^H (\d+) [0-9a-f]+ 0\t(.*)$/su.exec(e);
      return m && m[1] !== '160000' ? [m[2]!] : [];
    }));
    const dirty = status.split('\0').filter(Boolean).map(e => e.slice(3));
    state = { top: resolve(top), ok, dirty };
    return state;
  };
  const relOf = (s: RepoState, path: string): string | undefined => {
    const rel = relative(s.top, path);
    return rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) ? undefined : rel.split(sep).join('/');
  };
  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
  return {
    ...(options.language ? { language: options.language } : {}),
    productRoot: options.productRoot,
    remotes: options.remotes,
    ...(options.workspaceRoots ? { workspaceRoots: options.workspaceRoots } : {}),
    isCreated: options.isCreated,
    pushUrls(dir, remote) {
      if (!REMOTE_NAME.test(remote)) return undefined;
      const out = git(dir, ['remote', 'get-url', '--push', '--all', remote]);
      return out?.split(/\r?\n/u).map(l => l.trim()).filter(Boolean);
    },
    pushRemote(dir) {
      const branch = git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
      const get = (key: string): string | undefined => git(dir, ['config', '--get', key])?.trim() || undefined;
      return (branch ? get(`branch.${branch}.pushRemote`) : undefined) ?? get('remote.pushDefault') ?? (branch ? get(`branch.${branch}.remote`) : undefined) ?? 'origin';
    },
    isTracked(path) {
      const s = load();
      const rel = s && relOf(s, path);
      if (!s || !rel) return false;
      if (!isDir(path)) return s.ok.has(rel);
      const files = filesUnder(path);
      return !!files && files.length > 0 && files.every(f => { const r = relOf(s, f); return !!r && s.ok.has(r); });
    },
    isClean(path) {
      const s = load();
      const rel = s && relOf(s, path);
      if (!s || !rel) return false;
      return !s.dirty.some(d => d === rel || d.startsWith(`${rel}/`));
    },
  };
}

export function ownerHooksPathSet(gitExe: string, cwd: string): boolean {
  const env: Env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^git_/iu.test(k) || /^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)$/iu.test(k)));
  for (const scope of ['--global', '--system']) {
    try {
      const out = execFileSync(gitExe, ['config', scope, '--get', 'core.hooksPath'], { cwd, env, encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.trim() !== '') return true;
    } catch (error) {
      if ((error as { status?: number }).status !== 1) return true;
    }
  }
  return false;
}
