import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import type { ProjectMessageKey } from '../shared/messages/projects.ts';
import { isInside, isRemotePath, isSecretPath, resolveConfigPath, windowsHazard } from '../tools/hooks/scope.ts';

const WINDOWS = process.platform === 'win32';
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/u;
export const FOLDER_LIST_LIMIT = 500;
export const MAX_LINK_HOPS = 40;
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export type FolderReason = Extract<ProjectMessageKey, `folder_${string}` | 'root_in_use'>;
export type ProjectNote = 'nested_inside' | 'contains_product' | 'inside_config_root' | 'config_root_read_only' | 'not_git';

export interface FolderFs {
  lstat: (path: string) => { isDirectory: () => boolean; isSymbolicLink: () => boolean } | undefined;
  readlink: (path: string) => string;
  realpath: (path: string) => string;
}

const REAL_FS: FolderFs = {
  lstat: path => lstatSync(path, { throwIfNoEntry: false }),
  readlink: path => readlinkSync(path),
  realpath: path => realpathSync.native(path),
};

export interface WorkFolderContext {
  paths: AppPaths;
  appRoot: string;
  config: AppConfig;
  active: ReadonlyArray<{ root: string; root_key: string }>;
  exempt?: readonly string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  fs?: FolderFs | undefined;
}

export type WorkFolderResult =
  | { ok: true; root: string; rootKey: string; notes: ProjectNote[]; isGit: boolean }
  | { ok: false; reason: FolderReason };

export type WalkedFolder = { ok: true; path: string; directory: boolean } | { ok: false; reason: FolderReason };

export const rootKeyOf = (real: string): string => (WINDOWS ? real.toLowerCase() : real);

export function folderTextProblem(input: string): FolderReason | undefined {
  if (isRemotePath(input)) return 'folder_remote';
  if (windowsHazard(input) || LINE_BREAKING.test(input)) return 'folder_hazard';
  if (!isAbsolute(input) || input.split(/[\\/]/u).some(part => part === '.' || part === '..')) return 'folder_not_absolute';
  return undefined;
}

const partsOf = (abs: string): string[] => abs.slice(parse(abs).root.length).split(/[\\/]/u).filter(Boolean);

export function walkFolder(input: string, fs: FolderFs = REAL_FS): WalkedFolder {
  const text = folderTextProblem(input);
  if (text) return { ok: false, reason: text };
  const abs = resolve(input);
  let current = parse(abs).root;
  let directory = true;
  let hops = 0;
  const rest = partsOf(abs);
  try {
    while (rest.length > 0) {
      const next = join(current, rest.shift()!);
      const own = fs.lstat(next);
      if (!own) return { ok: false, reason: 'folder_not_found' };
      if (!own.isSymbolicLink()) {
        current = next;
        directory = own.isDirectory();
        continue;
      }
      if (++hops > MAX_LINK_HOPS) return { ok: false, reason: 'folder_link' };
      const stored = fs.readlink(next);
      if (isRemotePath(stored)) return { ok: false, reason: 'folder_remote' };
      if (WINDOWS && !DRIVE_ABSOLUTE.test(stored)) return { ok: false, reason: 'folder_link' };
      const target = WINDOWS ? stored : resolve(current, stored);
      if (windowsHazard(target) || !isAbsolute(target) || target.split(/[\\/]/u).some(part => part === '.' || part === '..')) return { ok: false, reason: 'folder_link' };
      const targetAbs = resolve(target);
      current = parse(targetAbs).root;
      directory = true;
      rest.unshift(...partsOf(targetAbs));
    }
  } catch { return { ok: false, reason: 'folder_unreadable' }; }
  return { ok: true, path: current, directory };
}

export function gitFolder(path: string, fs: FolderFs = REAL_FS): boolean {
  const walked = walkFolder(path, fs);
  if (!walked.ok) return false;
  try { return Boolean(fs.lstat(join(walked.path, '.git'))); } catch { return false; }
}

export function folderGone(root: string, rootKey: string, fs: FolderFs = REAL_FS): boolean {
  if (folderTextProblem(root)) return true;
  const abs = resolve(root);
  let current = parse(abs).root;
  try {
    for (const part of partsOf(abs)) {
      current = join(current, part);
      const own = fs.lstat(current);
      if (!own || own.isSymbolicLink() || !own.isDirectory()) return true;
    }
    return rootKeyOf(fs.realpath(abs)) !== rootKey;
  } catch { return true; }
}

const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

export function checkWorkFolder(input: string, ctx: WorkFolderContext): WorkFolderResult {
  const refuse = (reason: FolderReason): WorkFolderResult => ({ ok: false, reason });
  const fs = ctx.fs ?? REAL_FS;
  const env = ctx.env ?? process.env;
  const walked = walkFolder(input, fs);
  if (!walked.ok) return refuse(walked.reason);
  if (!walked.directory) return refuse('folder_not_directory');
  const abs = resolve(input);
  let real: string;
  try { real = fs.realpath(walked.path); } catch { return refuse('folder_unreadable'); }
  if (isRemotePath(real)) return refuse('folder_remote');
  if (windowsHazard(real) || LINE_BREAKING.test(real)) return refuse('folder_hazard');
  const realOf = (path: string): string => { try { return fs.realpath(path); } catch { return resolve(path); } };
  const zone = (paths: ReadonlyArray<string | undefined>): string[] => paths.filter((p): p is string => Boolean(p && isAbsolute(p))).map(realOf);

  const exempted = Boolean(ctx.exempt?.length) && zone(ctx.exempt ?? []).some(dir => isInside(dir, real));
  const home = realOf(ctx.home ?? homedir());
  if (!exempted) {
    if (dirname(real) === real) return refuse('folder_drive_root');
    if (isInside(real, home)) return refuse('folder_home');
    const appData = WINDOWS
      ? zone([env.APPDATA, env.LOCALAPPDATA, join(home, 'AppData')])
      : zone(['.config', '.local', 'Library'].map(name => join(home, name)));
    if (appData.some(dir => overlaps(dir, real))) return refuse('folder_app_data');
    const system = WINDOWS
      ? zone([env.SystemRoot ?? env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData])
      : zone(['/etc', '/usr', '/bin', '/sbin', '/var', '/opt', '/lib', '/boot', '/dev', '/proc', '/sys', '/System', '/Library', '/Applications']);
    if (system.some(dir => overlaps(dir, real))) return refuse('folder_system');
    if (overlaps(realOf(ctx.appRoot), real)) return refuse('folder_beat');
  }
  if (overlaps(realOf(ctx.paths.data), real)) return refuse('folder_beat');
  const profiles = dirname(home);
  if (!exempted && dirname(profiles) !== profiles && isInside(profiles, real) && !isInside(home, real)) return refuse('folder_home');
  if (isSecretPath(real) || isSecretPath(abs)) return refuse('folder_secret');
  if (ctx.config.tools.deny.map(p => resolveConfigPath(p, ctx.paths.data)).some(dir => overlaps(dir, real))) return refuse('folder_denied');
  const rootKey = rootKeyOf(real);
  if (ctx.active.some(p => p.root_key === rootKey)) return refuse('root_in_use');

  const notes: ProjectNote[] = [];
  if (ctx.active.some(p => isInside(p.root, real))) notes.push('nested_inside');
  if (ctx.active.some(p => isInside(real, p.root))) notes.push('contains_product');
  const roots = ctx.config.tools.roots.map(r => ({ path: resolveConfigPath(r.path, ctx.paths.data), mode: r.mode }));
  if (roots.some(r => rootKeyOf(r.path) === rootKey && r.mode === 'read')) notes.push('config_root_read_only');
  if (roots.some(r => isInside(r.path, real) && !(rootKeyOf(r.path) === rootKey && r.mode === 'read'))) notes.push('inside_config_root');
  let isGit = false;
  try { isGit = Boolean(fs.lstat(join(walked.path, '.git'))); } catch { isGit = false; }
  if (!isGit) notes.push('not_git');
  return { ok: true, root: real, rootKey, notes, isGit };
}

export interface FolderEntry { name: string; path: string; selectable: boolean; reason?: string; isGit: boolean; link: boolean }
export interface FolderListing { path: string | null; parent: string | null; entries: FolderEntry[]; truncated: boolean }

function entryOf(name: string, path: string, ctx: WorkFolderContext): FolderEntry {
  const checked = checkWorkFolder(path, ctx);
  return checked.ok
    ? { name, path, selectable: true, isGit: checked.isGit, link: false }
    : { name, path, selectable: false, reason: `project.${checked.reason}`, isGit: gitFolder(path, ctx.fs ?? REAL_FS), link: false };
}

export function listFolders(input: string | undefined, ctx: WorkFolderContext): FolderListing | { reason: FolderReason } {
  const fs = ctx.fs ?? REAL_FS;
  if (input === undefined) {
    const home = ctx.home ?? homedir();
    const starts = [home, resolve(home, '/'), ...ctx.config.tools.roots.map(r => resolveConfigPath(r.path, ctx.paths.data))]
      .filter(path => !folderTextProblem(path) && !isSecretPath(path));
    const seen = new Set<string>();
    const entries = starts.filter(path => !seen.has(rootKeyOf(path)) && Boolean(seen.add(rootKeyOf(path))) && walkFolder(path, fs).ok).map(path => entryOf(path, path, ctx));
    return { path: null, parent: null, entries, truncated: false };
  }
  const walked = walkFolder(input, fs);
  if (!walked.ok) return { reason: walked.reason };
  if (!walked.directory) return { reason: 'folder_not_directory' };
  let real: string;
  try { real = fs.realpath(walked.path); } catch { return { reason: 'folder_unreadable' }; }
  if (isRemotePath(real)) return { reason: 'folder_remote' };
  if (isSecretPath(real) || isSecretPath(resolve(input))) return { reason: 'folder_secret' };
  let names: Array<{ name: string; link: boolean }>;
  try {
    names = readdirSync(real, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => ({ name: entry.name, link: entry.isSymbolicLink() }));
  } catch { return { reason: 'folder_unreadable' }; }
  const visible = names.filter(entry => !isSecretPath(join(real, entry.name))).sort((a, b) => a.name.localeCompare(b.name));
  const entries = visible.slice(0, FOLDER_LIST_LIMIT).map(({ name, link }): FolderEntry => {
    const path = join(real, name);
    return link ? { name, path, selectable: false, reason: 'project.folder_link', isGit: false, link: true } : entryOf(name, path, ctx);
  });
  const parent = dirname(real);
  return { path: real, parent: parent === real ? null : parent, entries, truncated: visible.length > FOLDER_LIST_LIMIT };
}
