import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { plainLine } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { isInside } from '../tools/hooks/scope.ts';

export type Area = 'whole' | string[];

export type GitRun = (args: string[]) => Promise<Buffer | null>;

export interface StaleInput { area: Area | null; commit: string | null; at: number | null }

const WINDOWS = process.platform === 'win32';
const CONTROLS = /[\u0000-\u001f\u007f]/u;
const COMMIT = /^[0-9a-f]{7,64}$/u;
const PLACE_DEPTH = 2;
const WALK_DEPTH = 8;
const WALK_FILES = 20_000;
const SKIPPED = new Set(['.git', 'node_modules']);

const fold = (path: string): string => (WINDOWS ? path.toLowerCase() : path);

export const validCommit = (commit: string | null | undefined): commit is string => typeof commit === 'string' && COMMIT.test(commit);

export function cleanAreaPath(input: string): string | null {
  if (!input || CONTROLS.test(input) || input.includes(':')) return null;
  const slashed = input.trim().replaceAll('\\', '/');
  if (!slashed || slashed.startsWith('/') || slashed.startsWith('-')) return null;
  const parts = slashed.split('/').filter(part => part !== '' && part !== '.');
  if (!parts.length || parts.some(part => part === '..' || part.startsWith('-'))) return null;
  const path = parts.join('/');
  return /^\((whole product|none)\)$/u.test(path) ? null : path;
}

export function usableAreaPath(raw: string, max: number): string | null {
  const shown = plainLine(raw, max);
  if (shown !== raw.trim() || redactSecrets(shown) !== shown || shown.includes(',')) return null;
  return cleanAreaPath(shown);
}

export function under(path: string, base: string): boolean {
  const p = fold(path);
  const b = fold(base);
  return p === b || p.startsWith(`${b}/`);
}

export function placeOf(file: string): string {
  const parts = file.split('/');
  return parts.length === 1 ? file : parts.slice(0, Math.min(PLACE_DEPTH, parts.length - 1)).join('/');
}

export function placesFrom(files: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const file of files) {
    const place = placeOf(file);
    if (!seen.has(fold(place))) seen.set(fold(place), place);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function ownerOf(path: string, places: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const place of places) if (under(path, place) && (!best || place.length > best.length)) best = place;
  return best;
}

export function seenPlaces(places: readonly string[], areas: ReadonlyArray<Area | null>): Set<string> {
  const seen = new Set<string>();
  for (const area of areas) {
    if (area === null) continue;
    if (area === 'whole') { for (const place of places) seen.add(place); continue; }
    for (const path of area) {
      const owner = ownerOf(path, places);
      if (owner) seen.add(owner);
      for (const place of places) if (under(place, path)) seen.add(place);
    }
  }
  return seen;
}

export function touches(area: Area, changed: readonly string[]): boolean {
  if (area === 'whole') return changed.length > 0;
  return changed.some(file => area.some(path => under(file, path)));
}

function insideRoot(root: string, rel: string): string | undefined {
  try {
    const real = realpathSync.native(join(root, ...rel.split('/')));
    return isInside(root, real) ? real : undefined;
  } catch { return undefined; }
}

function walkFiles(root: string, start: string, prefix: string, depth: number, visit: (rel: string, abs: string, depth: number, directory: boolean) => boolean): void {
  let count = 0;
  const walk = (dir: string, rel: string, level: number): boolean => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return true; }
    for (const name of names) {
      if (SKIPPED.has(name.toLowerCase()) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      let stat;
      try { stat = lstatSync(abs); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (++count > WALK_FILES) return false;
      if (!visit(path, abs, level, stat.isDirectory())) return false;
      if (stat.isDirectory() && level < depth && !walk(abs, path, level + 1)) return false;
    }
    return true;
  };
  if (isInside(root, start)) walk(start, prefix, 1);
}

export function walkPlaces(root: string): string[] {
  let real: string;
  try { real = realpathSync.native(root); } catch { return []; }
  const files: string[] = [];
  walkFiles(real, real, '', PLACE_DEPTH, (rel, _abs, level, directory) => {
    if (directory ? level === PLACE_DEPTH : level <= PLACE_DEPTH) files.push(directory ? `${rel}/_` : rel);
    return true;
  });
  return placesFrom(files);
}

function newerThan(root: string, area: Area, at: number): boolean {
  const starts = area === 'whole' ? [''] : area;
  for (const rel of starts) {
    const abs = rel ? insideRoot(root, rel) : root;
    if (!abs) continue;
    let stat;
    try { stat = statSync(abs); } catch { continue; }
    if (!stat.isDirectory()) { if (stat.mtimeMs > at) return true; continue; }
    let found = false;
    walkFiles(root, abs, rel, WALK_DEPTH, (_path, file, _level, directory) => {
      if (directory) return true;
      try { if (statSync(file).mtimeMs > at) found = true; } catch { /* gone */ }
      return !found;
    });
    if (found) return true;
  }
  return false;
}

export async function gitHead(git: GitRun): Promise<string | null> {
  const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.toString('utf8').trim() ?? '';
  return validCommit(head) ? head : null;
}

export async function gitStale(git: GitRun, entries: readonly StaleInput[]): Promise<boolean[]> {
  const head = await gitHead(git);
  const changes = new Map<string, string[] | null>();
  const changedSince = async (commit: string): Promise<string[] | null> => {
    if (changes.has(commit)) return changes.get(commit)!;
    let out: string[] | null = null;
    if (head && await git(['merge-base', '--is-ancestor', commit, head]) !== null) {
      const listed = await git(['diff', '--name-only', '-z', '--no-renames', '--no-color', '--no-ext-diff', `${commit}..${head}`, '--']);
      out = listed === null ? null : listed.toString('utf8').split('\0').filter(Boolean);
    }
    changes.set(commit, out);
    return out;
  };
  const result: boolean[] = [];
  for (const entry of entries) {
    if (entry.area === null) { result.push(false); continue; }
    if (!validCommit(entry.commit) || !head) { result.push(true); continue; }
    if (head.startsWith(entry.commit)) { result.push(false); continue; }
    if (entry.area === 'whole') { result.push(true); continue; }
    const changed = await changedSince(entry.commit);
    result.push(changed === null ? true : touches(entry.area, changed));
  }
  return result;
}

export function mtimeStale(root: string, entries: readonly StaleInput[]): boolean[] {
  let real: string;
  try { real = realpathSync.native(root); } catch { return entries.map(entry => entry.area !== null); }
  return entries.map(entry => (entry.area === null ? false : entry.at === null ? true : newerThan(real, entry.area, entry.at)));
}

export async function gitPlaces(git: GitRun): Promise<string[] | null> {
  const listed = await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--']);
  if (listed === null) return null;
  return placesFrom(listed.toString('utf8').split('\0').filter(Boolean));
}

export interface AreaReport { mode: 'git' | 'mtime'; head: string | null; stale: boolean[]; places: string[] }

export async function examineAreas(root: string, dataDir: string, entries: readonly StaleInput[]): Promise<AreaReport> {
  const viaGit = await withGit(root, dataDir, async git => {
    const places = await gitPlaces(git);
    if (places === null) return undefined;
    const head = await gitHead(git);
    if (!head) return { mode: 'mtime' as const, head, stale: mtimeStale(root, entries), places };
    return { mode: 'git' as const, head, stale: await gitStale(git, entries), places };
  });
  if (viaGit) return viaGit;
  return { mode: 'mtime', head: null, stale: mtimeStale(root, entries), places: walkPlaces(root) };
}

export async function headOf(root: string, dataDir: string): Promise<string | null> {
  return (await withGit(root, dataDir, gitHead)) ?? null;
}
