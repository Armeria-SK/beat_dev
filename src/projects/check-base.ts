import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { findChecks, readPackage, type CheckCommand, type FindOptions, type FoundChecks } from './check-find.ts';
import { changedScripts, isTestPath, parseNameStatus } from './diff-flags.ts';
import { SNAPSHOT_TIMEOUT_MS } from './snapshot-before.ts';
import { gitFolder } from './work-folder.ts';

export const DIRTY_PATH_MAX = 2000;
export const DIRTY_FILE_MAX = 1024 * 1024;
export const SCRIPTS_MAX = 64 * 1024;
export const TAMPERING_SHOWN_MAX = 50;
const GUARD_FILE_MAX = 8 * 1024 * 1024;
const YIELD_EVERY = 200;
const HEAD = /^[0-9a-f]{40,64}$/u;

export interface BaseGit { head: string | null; dirty: Record<string, string> | 'over' }

export interface BasePrint {
  checks: FoundChecks;
  scripts: Record<string, string> | 'over' | null;
  guards: Record<string, string | null>;
  git: BaseGit | null;
  at: number;
}

export type CheckBase = BasePrint | { unavailable: true };

export interface CaptureOptions { timeoutMs?: number; find?: FindOptions }

export type Tampering =
  | { kind: 'commands'; before: string[]; after: string[] }
  | { kind: 'script'; name: string }
  | { kind: 'guard'; path: string }
  | { kind: 'test_removed'; path: string };

export type Unverified = 'no_base' | 'unavailable' | 'now_unavailable' | 'over' | 'git' | 'unreadable';

export interface BaseComparison {
  unchanged: boolean | null;
  tampering: Tampering[];
  tamperingMore: number;
  verified: boolean;
  unverified?: Unverified;
}

const unavailable = (): CheckBase => ({ unavailable: true });
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringMap = (value: unknown, orNull = false): boolean => isObject(value) && Object.values(value).every(item => typeof item === 'string' || (orNull && item === null));
const isCommand = (value: unknown): value is CheckCommand => isObject(value) && typeof value.command === 'string' && typeof value.source === 'string';
const optionalText = (value: unknown): boolean => value === undefined || typeof value === 'string';

function isChecks(value: unknown): value is FoundChecks {
  return isObject(value) && Array.isArray(value.commands) && value.commands.every(isCommand) && Array.isArray(value.guards) && value.guards.every(item => typeof item === 'string') && optionalText(value.none) && optionalText(value.blocked);
}

const isGit = (value: unknown): value is BaseGit => isObject(value) && (value.head === null || typeof value.head === 'string') && (value.dirty === 'over' || isStringMap(value.dirty));

export function isBasePrint(value: unknown): value is BasePrint {
  return isObject(value) && isChecks(value.checks) && (value.scripts === null || value.scripts === 'over' || isStringMap(value.scripts)) && isStringMap(value.guards, true)
    && (value.git === null || isGit(value.git)) && typeof value.at === 'number';
}

function fingerprint(real: string, rel: string, cap: number): string | null {
  const clean = rel.replace(/\/$/u, '');
  const parts = clean.split('/');
  if (!clean || parts.some(part => part === '' || part === '.' || part === '..') || /^[A-Za-z]:|\\/u.test(clean)) return 'unreadable';
  const path = join(real, ...parts);
  let stat;
  try { stat = lstatSync(path); } catch (error) { return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') ? null : 'unreadable'; }
  try {
    if (stat.isSymbolicLink()) return `link:${sha256(readlinkSync(path))}`;
    if (stat.isDirectory()) return 'dir';
    if (!stat.isFile()) return 'special';
    return stat.size > cap ? `over:${stat.size}` : sha256(readFileSync(path));
  } catch { return 'unreadable'; }
}

function viaLink(real: string, rel: string, seen: Map<string, boolean>): boolean {
  const parts = rel.replace(/\/$/u, '').split('/');
  let path = real;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    let link = seen.get(path);
    if (link === undefined) {
      try { link = !lstatSync(path).isDirectory(); } catch { link = false; }
      seen.set(path, link);
    }
    if (link) return true;
  }
  return false;
}

const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

function sameMap(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

const mapOf = (entries: Array<[string, string]>): Record<string, string> => Object.fromEntries(entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

async function gitPart(real: string, dataDir: string, deadline: number): Promise<BaseGit | null | undefined> {
  if (!gitFolder(real)) return null;
  return withGit(real, dataDir, async git => {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all']);
    if (!status) return undefined;
    const raw = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.toString('utf8').trim();
    const head = raw && HEAD.test(raw) ? raw : null;
    const paths = [...new Set(status.toString('utf8').split('\0').filter(record => record.length > 3 && record[2] === ' ').map(record => record.slice(3)))];
    if (paths.length > DIRTY_PATH_MAX) return { head, dirty: 'over' as const };
    const seen = new Map<string, boolean>();
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < paths.length; i++) {
      if (i % YIELD_EVERY === 0) {
        if (Date.now() >= deadline) return undefined;
        await new Promise(resolve => setImmediate(resolve));
      }
      const rel = paths[i]!;
      const value = viaLink(real, rel, seen) ? 'unreadable' : fingerprint(real, rel, DIRTY_FILE_MAX);
      if (value?.startsWith('over:')) return { head, dirty: 'over' as const };
      entries.push([rel, value ?? 'deleted']);
    }
    return { head, dirty: mapOf(entries) };
  });
}

async function capture(root: string, dataDir: string, find: FindOptions | undefined, deadline: number): Promise<CheckBase> {
  if (Date.now() >= deadline) return unavailable();
  let real: string;
  try {
    real = realpathSync.native(root);
    if (!statSync(real).isDirectory()) return unavailable();
  } catch { return unavailable(); }
  const checks = findChecks(real, find);
  const info = readPackage(real);
  const scripts = info ? (Buffer.byteLength(JSON.stringify(info.scripts)) > SCRIPTS_MAX ? 'over' as const : info.scripts) : null;
  const guards = Object.fromEntries(checks.guards.filter(name => name !== 'package.json').map(name => [name, fingerprint(real, name, GUARD_FILE_MAX)]));
  const git = await gitPart(real, dataDir, deadline);
  if (git === undefined) return unavailable();
  return { checks, scripts, guards, git, at: Date.now() };
}

export async function captureBase(root: string, dataDir: string, options: CaptureOptions = {}): Promise<CheckBase> {
  const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<CheckBase>(resolve => { timer = setTimeout(() => resolve(unavailable()), Math.max(0, timeoutMs)); timer.unref(); });
  try { return await Promise.race([capture(root, dataDir, options.find, deadline), limit]); } catch { return unavailable(); } finally { clearTimeout(timer); }
}

const scriptsText = (scripts: BasePrint['scripts']): string | undefined => (scripts && scripts !== 'over' ? JSON.stringify({ scripts }) : undefined);

function unchangedOf(base: BaseGit | null, now: BaseGit | null): boolean | null {
  if (!base || !now) return null;
  if (base.head !== now.head) return false;
  if (base.dirty === 'over') return null;
  if (now.dirty === 'over') return false;
  return sameMap(base.dirty, now.dirty);
}

async function removedTests(base: BaseGit, real: string, dataDir: string): Promise<string[] | undefined> {
  const dirty = base.dirty === 'over' ? {} : base.dirty;
  const goneAtStart = (path: string): boolean => own(dirty, path) === 'deleted';
  const removed = new Set<string>();
  for (const [path, value] of Object.entries(dirty)) {
    if (isTestPath(path) && value !== 'deleted' && value !== 'dir' && fingerprint(real, path, DIRTY_FILE_MAX) === null) removed.add(path);
  }
  if (base.head) {
    const listed = await withGit(real, dataDir, git => git(['diff-index', '--name-status', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--find-renames', base.head!, '--']));
    if (!listed) return undefined;
    for (const entry of parseNameStatus(listed.toString('utf8'))) {
      if (entry.status === 'D' && isTestPath(entry.path) && !goneAtStart(entry.path)) removed.add(entry.path);
      if (entry.status === 'R' && entry.from && isTestPath(entry.from) && !isTestPath(entry.path) && !goneAtStart(entry.from)) removed.add(entry.from);
    }
  }
  return [...removed].sort();
}

export async function compareBase(base: unknown, root: string, dataDir: string, options: CaptureOptions = {}): Promise<BaseComparison> {
  const blank = (unverified: Unverified): BaseComparison => ({ unchanged: null, tampering: [], tamperingMore: 0, verified: false, unverified });
  if (isObject(base) && base.unavailable === true) return blank('unavailable');
  if (!isBasePrint(base)) return blank('no_base');
  const now = await captureBase(root, dataDir, options);
  if (!isBasePrint(now)) return blank('now_unavailable');
  let real: string;
  try { real = realpathSync.native(root); } catch { return blank('now_unavailable'); }

  const found: Tampering[] = [];
  let unverified: Unverified | undefined;
  const unsure = (why: Unverified): void => { unverified ??= why; };

  const before = base.checks.blocked ? null : base.checks.commands.map(entry => entry.command);
  const after = now.checks.commands.map(entry => entry.command);
  if (before && (before.length !== after.length || before.some((command, i) => command !== after[i]))) found.push({ kind: 'commands', before, after });

  if (base.scripts === 'over' || now.scripts === 'over') unsure('over');
  else {
    try {
      for (const name of changedScripts(scriptsText(base.scripts), scriptsText(now.scripts), [...(before ?? []), ...after].join(' && '))) found.push({ kind: 'script', name });
    } catch { unsure('unreadable'); }
  }

  const names = [...new Set([...Object.keys(base.guards), ...now.checks.guards])].filter(name => name !== 'package.json').sort();
  for (const name of names) {
    const was = own(base.guards, name) ?? null;
    const is = Object.hasOwn(now.guards, name) ? now.guards[name] ?? null : fingerprint(real, name, GUARD_FILE_MAX);
    if (was !== is) found.push({ kind: 'guard', path: name });
  }

  if (base.git) {
    if (!now.git) unsure('git');
    else if (base.git.dirty === 'over') unsure('over');
    else {
      const removed = await removedTests(base.git, real, dataDir);
      if (removed) for (const path of removed) found.push({ kind: 'test_removed', path });
      else unsure('git');
    }
  }

  return {
    unchanged: unchangedOf(base.git, now.git),
    tampering: found.slice(0, TAMPERING_SHOWN_MAX),
    tamperingMore: Math.max(0, found.length - TAMPERING_SHOWN_MAX),
    verified: unverified === undefined,
    ...(unverified ? { unverified } : {}),
  };
}
