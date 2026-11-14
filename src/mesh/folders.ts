import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export const MAP_DEPTH = 2;
export const MAP_PARTS_MAX = 200;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const WALK_MAX = 5000;
const DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)(\..*)?$/iu;
const PATH_CHARS = /^[\p{L}\p{N}\p{M}\-_./]+$/u;
const COMMIT = /^[0-9a-f]{40,64}$/u;

export interface FolderScan { mode: 'git' | 'plain'; head: string | null; folders: string[]; hidden: number }

export function cleanRelPath(input: string, max = 160): string | undefined {
  const path = input.trim().replaceAll('\\', '/').replace(/^(\.\/)+/u, '').replace(/\/+$/u, '');
  if (!path || Array.from(path).length > max || !PATH_CHARS.test(path)) return undefined;
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part) || DEVICE.test(part) || /~\d/u.test(part))) return undefined;
  return path;
}

const shownName = (rel: string): boolean => cleanRelPath(rel, 60) === rel;

function realInside(root: string, rel: string): string | undefined {
  try {
    const realRoot = realpathSync.native(root);
    const real = realpathSync.native(join(realRoot, ...rel.split('/')));
    return isInside(realRoot, real) ? real : undefined;
  } catch { return undefined; }
}

export function folderExists(root: string, rel: string): boolean {
  const real = realInside(root, rel);
  if (!real) return false;
  try { return lstatSync(join(root, ...rel.split('/'))).isDirectory() && lstatSync(real).isDirectory(); } catch { return false; }
}

export function fileInside(root: string, folder: string, rel: string): boolean {
  if (!rel.startsWith(`${folder}/`)) return false;
  const real = realInside(root, rel);
  const realFolder = realInside(root, folder);
  if (!real || !realFolder || !isInside(realFolder, real)) return false;
  try { return lstatSync(real).isFile(); } catch { return false; }
}

export function pathExists(root: string, rel: string): boolean {
  const real = realInside(root, rel);
  if (!real) return false;
  try { const stat = lstatSync(real); return stat.isFile() || stat.isDirectory(); } catch { return false; }
}

export function listingHash(root: string, rel: string): string | null {
  const real = realInside(root, rel);
  if (!real) return null;
  try {
    const rows = readdirSync(real, { withFileTypes: true }).map(entry => {
      let mtime = 0;
      try { mtime = Math.floor(lstatSync(join(real, entry.name)).mtimeMs); } catch { mtime = -1; }
      return `${entry.name}\0${entry.isDirectory() ? 'd' : 'f'}\0${mtime}`;
    }).sort();
    return createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);
  } catch { return null; }
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

function pick(found: Set<string>): { folders: string[]; hidden: number } {
  const all = [...found].sort();
  const shown = all.filter(shownName);
  const deep = shown.length > MAP_PARTS_MAX ? shown.filter(rel => !rel.includes('/')) : shown;
  return { folders: deep.slice(0, MAP_PARTS_MAX), hidden: all.length - shown.length };
}

function walkPlain(root: string): Set<string> {
  const found = new Set<string>();
  let visited = 0;
  const walk = (dir: string, prefix: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > WALK_MAX) return;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.add(rel);
      if (depth < MAP_DEPTH) walk(join(dir, entry.name), rel, depth + 1);
    }
  };
  walk(root, '', 1);
  return found;
}

export async function scanFolders(root: string, dataDir: string): Promise<FolderScan> {
  const viaGit = await withGit(root, dataDir, async git => {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.toString('utf8').trim() ?? '';
    const files = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (!files) return undefined;
    const found = new Set<string>();
    for (const file of files.toString('utf8').split('\0')) {
      const parts = file.split('/').slice(0, -1);
      for (let depth = 1; depth <= Math.min(MAP_DEPTH, parts.length); depth++) found.add(parts.slice(0, depth).join('/'));
    }
    const existing = new Set([...found].filter(rel => folderExists(root, rel)));
    return { mode: 'git' as const, head: COMMIT.test(head) ? head : null, ...pick(existing) };
  });
  if (viaGit) return viaGit;
  return { mode: 'plain', head: null, ...pick(walkPlain(root)) };
}

export async function changedFolders(root: string, dataDir: string, commits: readonly string[]): Promise<Map<string, string[] | null>> {
  const out = new Map<string, string[] | null>();
  const wanted = [...new Set(commits)].filter(commit => COMMIT.test(commit));
  if (!wanted.length) return out;
  await withGit(root, dataDir, async git => {
    for (const commit of wanted) {
      const diff = await git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', '--diff-filter=AD', commit, '--']);
      out.set(commit, diff ? diff.toString('utf8').split('\0').filter(Boolean) : null);
    }
  });
  return out;
}
