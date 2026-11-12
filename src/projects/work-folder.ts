import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import type { ProjectMessageKey } from '../shared/messages/projects.ts';
import { isInside, isRemotePath, isSecretPath, resolveConfigPath, windowsHazard } from '../tools/hooks/scope.ts';

const WINDOWS = process.platform === 'win32';
export const FOLDER_LIST_LIMIT = 500;

export type FolderReason = Extract<ProjectMessageKey, `folder_${string}` | 'root_in_use'>;
export type ProjectNote = 'nested_inside' | 'contains_product' | 'inside_config_root' | 'config_root_read_only' | 'not_git';

export interface FolderFs {
  stat: (path: string) => { isDirectory: () => boolean };
  realpath: (path: string) => string;
  exists: (path: string) => boolean;
}

const REAL_FS: FolderFs = { stat: path => statSync(path), realpath: path => realpathSync.native(path), exists: path => existsSync(path) };

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

export const rootKeyOf = (real: string): string => (WINDOWS ? real.toLowerCase() : real);

export function folderTextProblem(input: string): FolderReason | undefined {
  if (isRemotePath(input)) return 'folder_remote';
  if (windowsHazard(input)) return 'folder_hazard';
  if (!isAbsolute(input) || input.split(/[\\/]/u).some(part => part === '.' || part === '..')) return 'folder_not_absolute';
  return undefined;
}

const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

export function checkWorkFolder(input: string, ctx: WorkFolderContext): WorkFolderResult {
  const refuse = (reason: FolderReason): WorkFolderResult => ({ ok: false, reason });
  const text = folderTextProblem(input);
  if (text) return refuse(text);
  const fs = ctx.fs ?? REAL_FS;
  const env = ctx.env ?? process.env;
  const abs = resolve(input);
  if (!fs.exists(abs)) return refuse('folder_not_found');
  let real: string;
  try {
    if (!fs.stat(abs).isDirectory()) return refuse('folder_not_directory');
    real = fs.realpath(abs);
  } catch { return refuse('folder_unreadable'); }
  if (isRemotePath(real)) return refuse('folder_remote');
  if (windowsHazard(real)) return refuse('folder_hazard');
  const realOf = (path: string): string => { try { return fs.realpath(path); } catch { return resolve(path); } };
  const zone = (paths: ReadonlyArray<string | undefined>): string[] => paths.filter((p): p is string => Boolean(p && isAbsolute(p))).map(realOf);

  if (!ctx.exempt?.length || !zone(ctx.exempt).some(dir => isInside(dir, real))) {
    if (dirname(real) === real) return refuse('folder_drive_root');
    const home = realOf(ctx.home ?? homedir());
    if (isInside(real, home)) return refuse('folder_home');
    const appData = WINDOWS
      ? zone([env.APPDATA, env.LOCALAPPDATA, join(home, 'AppData')])
      : zone(['.config', '.local', 'Library'].map(name => join(home, name)));
    if (appData.some(dir => overlaps(dir, real))) return refuse('folder_app_data');
    const system = WINDOWS
      ? zone([env.SystemRoot ?? env.windir, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData])
      : zone(['/etc', '/usr', '/bin', '/sbin', '/var', '/opt', '/lib', '/boot', '/dev', '/proc', '/sys', '/System', '/Library', '/Applications']);
    if (system.some(dir => overlaps(dir, real))) return refuse('folder_system');
    if (overlaps(realOf(ctx.appRoot), real)) return refuse('folder_clive');
  }
  if (overlaps(realOf(ctx.paths.data), real)) return refuse('folder_clive');
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
  const isGit = fs.exists(join(real, '.git'));
  if (!isGit) notes.push('not_git');
  return { ok: true, root: real, rootKey, notes, isGit };
}

export interface FolderEntry { name: string; path: string; selectable: boolean; reason?: string; isGit: boolean; link: boolean }
export interface FolderListing { path: string | null; parent: string | null; entries: FolderEntry[]; truncated: boolean }

function entryOf(name: string, path: string, ctx: WorkFolderContext): FolderEntry {
  const checked = checkWorkFolder(path, ctx);
  return checked.ok
    ? { name, path, selectable: true, isGit: checked.isGit, link: false }
    : { name, path, selectable: false, reason: `project.${checked.reason}`, isGit: existsSync(join(path, '.git')), link: false };
}

export function listFolders(input: string | undefined, ctx: WorkFolderContext): FolderListing | { reason: FolderReason } {
  if (input === undefined) {
    const home = ctx.home ?? homedir();
    const starts = [home, resolve(home, '/'), ...ctx.config.tools.roots.map(r => resolveConfigPath(r.path, ctx.paths.data))]
      .filter(path => !folderTextProblem(path) && !isSecretPath(path));
    const seen = new Set<string>();
    const entries = starts.filter(path => !seen.has(rootKeyOf(path)) && Boolean(seen.add(rootKeyOf(path))) && existsSync(path)).map(path => entryOf(path, path, ctx));
    return { path: null, parent: null, entries, truncated: false };
  }
  const text = folderTextProblem(input);
  if (text) return { reason: text };
  const abs = resolve(input);
  let real: string;
  try {
    const own = lstatSync(abs, { throwIfNoEntry: false });
    if (!own) return { reason: 'folder_not_found' };
    if (own.isSymbolicLink()) {
      const target = resolve(dirname(abs), readlinkSync(abs));
      const targetText = folderTextProblem(target);
      if (targetText) return { reason: targetText };
    }
    real = realpathSync.native(abs);
    if (isRemotePath(real)) return { reason: 'folder_remote' };
    if (!statSync(real).isDirectory()) return { reason: 'folder_not_directory' };
  } catch { return { reason: 'folder_unreadable' }; }
  if (isSecretPath(real) || isSecretPath(abs)) return { reason: 'folder_secret' };
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

export const defaultProjectName = (root: string): string => basename(root) || root;
