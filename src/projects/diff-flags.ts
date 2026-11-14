import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withGit } from '../mesh/folders.ts';
import { plainLine } from '../shared/plain-text.ts';
import { gitFolder } from './work-folder.ts';

export type FileChange = 'added' | 'modified' | 'deleted';

export interface CheckFileChange { path: string; change: FileChange; scripts?: string[] }

export type DiffFlags =
  | { checked: false; reason: 'no_git' | 'git_unusable' | 'failed' | 'folder_missing' }
  | { checked: true; since: 'build' | 'head'; testsDeleted: string[]; testsDeletedMore: number; checkChanged: CheckFileChange[]; checkChangedMore: number };

const SHOWN_MAX = 50;
const PACKAGE_MAX = 1024 * 1024;
const SCRIPT_DEPTH = 5;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e)\//iu;
const TEST_FILE = /[._-](test|spec)s?\.[^/]+$|(^|\/)test_[^/]+\.py$/iu;
const CHECK_CONFIG = /(^|\/)((jest|vitest|vitest\.workspace|playwright|cypress|karma|ava|babel)\.config\.[^/]+|karma\.conf\.[^/]+|\.mocharc[^/]*|\.c8rc[^/]*|\.nycrc[^/]*|pytest\.ini|conftest\.py|tox\.ini|noxfile\.py|phpunit\.xml(\.dist)?)$/iu;
const RUNNER = /^(npm|pnpm|yarn|bun)$/u;
const SKIP_WORDS = new Set(['run', 'run-script', '--if-present', '--silent', '-s', 'exec']);

export const isTestPath = (path: string): boolean => TEST_DIR.test(path) || TEST_FILE.test(path);

const words = (command: string): string[] => command.split(/\s+|&&|\|\||;|\|/u).map(word => word.replace(/^['"]|['"]$/gu, '')).filter(Boolean);

export function scriptsNamed(command: string | null): string[] {
  const out = new Set<string>();
  const list = words(command ?? '');
  list.forEach((word, i) => {
    if (!RUNNER.test(word)) return;
    let j = i + 1;
    while (j < list.length && SKIP_WORDS.has(list[j]!)) j++;
    const name = list[j];
    if (!name || name.startsWith('-')) return;
    out.add(name === 't' || name === 'tst' ? 'test' : name);
  });
  return [...out];
}

export function filesNamed(command: string | null): string[] {
  return words(command ?? '').filter(word => !word.startsWith('-') && !/^[a-z][a-z0-9+.-]*:/iu.test(word) && (word.includes('/') || word.includes('\\') || /\.[A-Za-z0-9]{1,6}$/u.test(word)))
    .map(word => word.replaceAll('\\', '/').replace(/^(\.\/)+/u, ''))
    .filter(word => word && !word.startsWith('/') && !word.split('/').includes('..'));
}

function scriptsOf(text: string | undefined): Record<string, string> {
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    const scripts = parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

export function changedScripts(before: string | undefined, after: string | undefined, command: string | null): string[] {
  const a = scriptsOf(before);
  const b = scriptsOf(after);
  const seen = new Set<string>();
  let wave = [...new Set(['test', ...scriptsNamed(command)])];
  for (let depth = 0; depth < SCRIPT_DEPTH && wave.length; depth++) {
    const next: string[] = [];
    for (const name of wave) {
      for (const each of [`pre${name}`, name, `post${name}`]) {
        if (seen.has(each)) continue;
        seen.add(each);
        for (const body of [a[each], b[each]]) if (body) next.push(...scriptsNamed(body));
      }
    }
    wave = next.filter(name => !seen.has(name));
  }
  return [...seen].filter(name => a[name] !== b[name]).sort();
}

interface NameStatus { status: string; path: string; from?: string }

export function parseNameStatus(raw: string): NameStatus[] {
  const parts = raw.split('\0');
  const out: NameStatus[] = [];
  for (let i = 0; i + 1 < parts.length;) {
    const status = parts[i]!;
    if (!status) { i++; continue; }
    if (/^[RC]/u.test(status)) { out.push({ status: status[0]!, from: parts[i + 1]!, path: parts[i + 2] ?? '' }); i += 3; }
    else { out.push({ status: status[0]!, path: parts[i + 1]! }); i += 2; }
  }
  return out;
}

const changeOf = (status: string): FileChange => (status === 'A' || status === 'C' ? 'added' : status === 'D' ? 'deleted' : 'modified');

function readCurrent(root: string, rel: string): string | undefined {
  try {
    const file = join(root, rel);
    const stat = lstatSync(file);
    return stat.isFile() && stat.size <= PACKAGE_MAX ? readFileSync(file, 'utf8') : undefined;
  } catch { return undefined; }
}

const shown = (path: string): string => plainLine(path, 300);

export function flagsFrom(entries: readonly NameStatus[], command: string | null, packageScripts: (path: string) => string[]): { testsDeleted: string[]; testsDeletedMore: number; checkChanged: CheckFileChange[]; checkChangedMore: number } {
  const named = new Set(filesNamed(command).map(path => path.toLowerCase()));
  const make = /^(make|gmake|mingw32-make)$/u.test(words(command ?? '')[0] ?? '');
  const isCheckFile = (path: string): boolean => CHECK_CONFIG.test(path) || named.has(path.toLowerCase()) || (make && /^(GNU)?makefile$/iu.test(path));
  const testsDeleted: string[] = [];
  const checkChanged: CheckFileChange[] = [];
  for (const entry of entries) {
    if (entry.status === 'D' && isTestPath(entry.path)) testsDeleted.push(shown(entry.path));
    if (entry.status === 'R' && entry.from && isTestPath(entry.from) && !isTestPath(entry.path)) testsDeleted.push(shown(entry.from));
    const paths = entry.status === 'R' && entry.from ? [entry.from, entry.path] : [entry.path];
    for (const path of paths) {
      if (path.toLowerCase() === 'package.json') {
        const scripts = entry.status === 'M' || entry.status === 'T' ? packageScripts(path) : [];
        if (entry.status === 'M' || entry.status === 'T' ? scripts.length > 0 : true) checkChanged.push({ path: shown(path), change: entry.status === 'R' ? (path === entry.from ? 'deleted' : 'added') : changeOf(entry.status), ...(scripts.length ? { scripts } : {}) });
      } else if (isCheckFile(path)) {
        checkChanged.push({ path: shown(path), change: entry.status === 'R' ? (path === entry.from ? 'deleted' : 'added') : changeOf(entry.status) });
      }
    }
  }
  return {
    testsDeleted: testsDeleted.slice(0, SHOWN_MAX), testsDeletedMore: Math.max(0, testsDeleted.length - SHOWN_MAX),
    checkChanged: checkChanged.slice(0, SHOWN_MAX), checkChangedMore: Math.max(0, checkChanged.length - SHOWN_MAX),
  };
}

export async function diffFlags(root: string, command: string | null, dataDir: string, since: number | null): Promise<DiffFlags> {
  if (!gitFolder(root)) return { checked: false, reason: 'no_git' };
  const result = await withGit(root, dataDir, async git => {
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD']))?.toString('utf8').trim();
    if (!head) return { checked: true as const, since: 'head' as const, testsDeleted: [], testsDeletedMore: 0, checkChanged: [], checkChangedMore: 0 };
    const before = since === null ? '' : (await git(['rev-list', '-1', `--before=${Math.floor(since / 1000)}`, 'HEAD']))?.toString('utf8').trim() ?? '';
    const base = /^[0-9a-f]{40,64}$/u.test(before) ? before : 'HEAD';
    const listed = await git(['diff', '--name-status', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--find-renames', base, '--']);
    if (!listed) return 'failed' as const;
    const entries = parseNameStatus(listed.toString('utf8'));
    const old = new Map<string, string | undefined>();
    for (const entry of entries) {
      if (entry.path.toLowerCase() === 'package.json' && (entry.status === 'M' || entry.status === 'T')) old.set(entry.path, (await git(['cat-file', 'blob', `${base}:${entry.path}`]))?.toString('utf8'));
    }
    const flags = flagsFrom(entries, command, path => changedScripts(old.get(path), readCurrent(root, path), command));
    return { checked: true as const, since: base === 'HEAD' ? 'head' as const : 'build' as const, ...flags };
  });
  if (result === undefined) return { checked: false, reason: 'git_unusable' };
  if (result === 'failed') return { checked: false, reason: 'failed' };
  return result;
}
