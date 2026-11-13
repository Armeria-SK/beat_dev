import { execFile } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { KV } from '../db/kv.ts';
import { inspectRepo, insideGitDir, isGitDir } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export interface CreatedScope { kind: 'task' | 'conv'; id: string }
export interface CreatedRunRef { runId: string; parent?: { runId: string } | undefined }

export const CREATED_LIMIT = 5000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const CLOCK_SLACK_MS = 2000;
const WINDOW_BEFORE_MS = 20;
const WINDOW_AFTER_MS = 5;
const WINDOWS = process.platform === 'win32';
let birthWarned = false;

interface Known { exact: Set<string>; ancestors: Set<string> }
interface RunRecord {
  scope: CreatedScope; root: string; start: number; mode: 'git' | 'plain' | 'unknown'; shared: boolean;
  untracked?: Known; tracked?: Known; noted: Map<string, string>; windows: Array<{ start: number; end?: number }>;
}
interface Item { rel: string; abs: string; folder: boolean }

const scopeKey = (scope: CreatedScope): string => `created:${scope.kind}:${scope.id}`;
const fold = (text: string): string => (WINDOWS ? text.toLowerCase() : text);

function emptyKnown(): Known { return { exact: new Set(), ancestors: new Set() }; }

function addKnown(known: Known, entry: string): void {
  const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  if (!path) return;
  known.exact.add(path);
  for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) known.ancestors.add(path.slice(0, i));
}

function knownAt(known: Known, path: string): boolean {
  if (known.exact.has(path) || known.ancestors.has(path)) return true;
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) if (known.exact.has(path.slice(0, i))) return true;
  return false;
}

function realOf(path: string): string {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try { return join(realpathSync.native(at), ...rest); } catch { }
    const up = dirname(at);
    if (up === at) throw new Error(`no existing folder above ${path}`);
    rest.unshift(basename(at));
    at = up;
  }
}

function statOf(abs: string): BigIntStats | undefined {
  try { return lstatSync(abs, { bigint: true, throwIfNoEntry: false }); } catch { return undefined; }
}

function identity(stat: BigIntStats): string {
  return stat.isDirectory() ? `d:${stat.ino}:${stat.birthtimeNs}` : `f:${stat.ino}:${stat.birthtimeNs}:${stat.mtimeNs}:${stat.size}`;
}

export function identityOf(path: string): string | undefined {
  const stat = statOf(path);
  return stat ? identity(stat) : undefined;
}

function badWindowsName(path: string): boolean {
  if (/:/u.test(path.replace(/^[A-Za-z]:/u, '')) || /[?*"<>|]/u.test(path)) return true;
  return path.split(/[\\/]/u).some(part => part !== '.' && part !== '..' && /[. ]$/u.test(part));
}

function runGit(exe: string, cwd: string, args: string[], env: Record<string, string>): Promise<Buffer | null> {
  return new Promise(done => {
    execFile(exe, args, { cwd, env, encoding: 'buffer', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      done(error ? null : stdout);
    });
  });
}

export class CreatedFiles {
  readonly #kv: KV;
  readonly #dataDir: string;
  readonly #log: (line: string) => void;
  readonly #limit: number;
  readonly #runs = new Map<string, RunRecord>();

  constructor(options: { kv: KV; dataDir: string; log?: (line: string) => void; limit?: number }) {
    this.#kv = options.kv;
    this.#dataDir = options.dataDir;
    this.#log = options.log ?? (() => undefined);
    this.#limit = options.limit ?? CREATED_LIMIT;
  }

  list(scope: CreatedScope): string[] { return [...this.#read(scope).keys()]; }

  async begin(runId: string, scope: CreatedScope, root: string): Promise<void> {
    const start = Date.now() - CLOCK_SLACK_MS;
    let real: string;
    try { real = realpathSync.native(root); } catch { return; }
    const record: RunRecord = { scope, root: real, start, mode: 'unknown', shared: false, noted: new Map(), windows: [] };
    for (const other of this.#runs.values()) {
      if (!isInside(other.root, real) && !isInside(real, other.root)) continue;
      other.shared = true;
      record.shared = true;
    }
    this.#runs.set(runId, record);
    this.#prune(scope, real);
    try {
      const dotGit = lstatSync(join(real, '.git'), { throwIfNoEntry: false });
      if (!dotGit) {
        if (!inspectRepo(real).found) { record.mode = 'plain'; return; }
        this.#log(`[WARN] The folder of run ${runId} is inside another git repository, so nothing it makes counts as made by this work`);
        return;
      }
      const out = dotGit.isSymbolicLink() ? null : await this.#git(real, [['rev-parse', '--verify', '-q', 'HEAD'], ['ls-files', '-z', '--others', '--directory'], ['ls-files', '-z'], ['ls-tree', '-r', '-z', '--name-only', 'HEAD']]);
      const head = out?.[0]?.toString('utf8').trim() || null;
      const tree = head ? out?.[3] : Buffer.alloc(0);
      if (!out?.[1] || !out[2] || !tree) {
        this.#log(`[WARN] git could not list the files of run ${runId}, so nothing it makes counts as made by this work`);
        return;
      }
      const untracked = emptyKnown();
      for (const entry of this.#entries(out[1])) addKnown(untracked, entry);
      const tracked = emptyKnown();
      for (const entry of [...this.#entries(out[2]), ...this.#entries(tree)]) addKnown(tracked, entry);
      Object.assign(record, { mode: 'git', untracked, tracked });
    } catch (error) {
      this.#log(`[WARN] Could not note the files that existed before run ${runId}: ${(error as Error).message}`);
    }
  }

  note(run: CreatedRunRef, path: string): void {
    const record = this.#runs.get(run.parent?.runId ?? run.runId);
    if (record?.mode !== 'plain' || !isAbsolute(path)) return;
    const place = this.#place(record.root, path);
    if (place) record.noted.set(place.rel, place.real);
  }

  open(run: CreatedRunRef): () => void {
    const record = this.#runs.get(run.parent?.runId ?? run.runId);
    if (!record) return () => undefined;
    const window: { start: number; end?: number } = { start: Date.now() };
    record.windows.push(window);
    return () => { window.end ??= Date.now(); };
  }

  isCreated(path: string, run: CreatedRunRef): boolean {
    const record = this.#runs.get(run.parent?.runId ?? run.runId);
    if (!record || record.mode === 'unknown' || !isAbsolute(path)) return false;
    const place = this.#place(record.root, path);
    if (!place) return false;
    const listed = this.#read(record.scope);
    const fresh = (item: Item): boolean => {
      const stat = statOf(item.abs);
      if (!stat || stat.isDirectory() !== item.folder) return false;
      if (record.tracked && knownAt(record.tracked, item.rel)) return false;
      const id = listed.get(item.folder ? `${item.rel}/` : item.rel);
      if (id !== undefined) return id === identity(stat);
      if (record.shared || !this.#newSince(stat, record)) return false;
      if (record.mode === 'git') return !knownAt(record.untracked!, item.rel);
      return !item.folder && record.noted.has(item.rel);
    };
    const stat = statOf(place.real);
    if (!stat?.isDirectory()) return fresh({ rel: place.rel, abs: place.real, folder: false });
    const inside: Item[] = [];
    return fresh({ rel: place.rel, abs: place.real, folder: true }) && this.#walk(place.real, place.rel, inside, 'refuse') && inside.every(fresh);
  }

  async end(runId: string): Promise<void> {
    const record = this.#runs.get(runId);
    if (!record) return;
    this.#runs.delete(runId);
    try {
      if (record.shared) {
        this.#log(`[WARN] Another run worked in the same folder as run ${runId}, so the files it made are not counted as made by this work`);
        return;
      }
      const items: Item[] = [];
      let full = false;
      if (record.mode === 'plain') for (const [rel, abs] of record.noted) items.push({ rel, abs, folder: false });
      if (record.mode === 'git') {
        const now = (await this.#git(record.root, [['ls-files', '-z', '--others', '--directory']]))?.[0];
        if (!now) { this.#log(`[WARN] Could not list the files run ${runId} made, so they are not counted as made by this work`); return; }
        for (const entry of this.#entries(now)) {
          const rel = entry.endsWith('/') ? entry.slice(0, -1) : entry;
          if (!rel || knownAt(record.untracked!, rel) || knownAt(record.tracked!, rel)) continue;
          const abs = join(record.root, ...rel.split('/'));
          const stat = statOf(abs);
          if (!stat || stat.isSymbolicLink() || this.#unsafe(abs, rel)) continue;
          items.push({ rel, abs, folder: stat.isDirectory() });
          if (stat.isDirectory() && !this.#walk(abs, rel, items, 'skip')) { full = true; break; }
        }
      }
      const added = new Map<string, string>();
      for (const item of items) {
        const stat = statOf(item.abs);
        if (stat && stat.isDirectory() === item.folder && this.#newSince(stat, record)) added.set(item.folder ? `${item.rel}/` : item.rel, identity(stat));
      }
      if (!added.size) return;
      const merged = new Map([...this.#read(record.scope), ...added]);
      if (full || merged.size > this.#limit) {
        this.#log(`[WARN] Run ${runId} made more files than can be remembered (${this.#limit}), so they are not counted as made by this work`);
        return;
      }
      this.#write(record.scope, merged);
    } catch (error) {
      this.#log(`[WARN] Could not record the files run ${runId} made: ${(error as Error).message}`);
    }
  }

  #read(scope: CreatedScope): Map<string, string> {
    const value = this.#kv.getJson<unknown>(scopeKey(scope));
    const ok = Array.isArray(value) && value.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string');
    return new Map(ok ? value as Array<[string, string]> : []);
  }

  #write(scope: CreatedScope, entries: Map<string, string>): void {
    if (entries.size) this.#kv.setJson(scopeKey(scope), [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    else this.#kv.delete(scopeKey(scope));
  }

  #prune(scope: CreatedScope, root: string): void {
    try {
      const entries = this.#read(scope);
      const kept = new Map([...entries].filter(([key, id]) => {
        const stat = statOf(join(root, ...key.replace(/\/$/u, '').split('/')));
        return stat !== undefined && !stat.isSymbolicLink() && identity(stat) === id;
      }));
      if (kept.size !== entries.size) this.#write(scope, kept);
    } catch (error) {
      this.#log(`[WARN] Could not check the files made earlier by this work: ${(error as Error).message}`);
    }
  }

  #newSince(stat: BigIntStats, record: RunRecord): boolean {
    if (stat.birthtimeNs === 0n && !birthWarned) {
      birthWarned = true;
      this.#log('[WARN] This file system does not report when a file was made, so files made by a run cannot be told apart there');
    }
    const inWindow = (time: number): boolean => time >= record.start && record.windows.some(w => time >= w.start - WINDOW_BEFORE_MS && time <= (w.end ?? Infinity) + WINDOW_AFTER_MS);
    return inWindow(Number(stat.birthtimeMs)) && inWindow(Number(stat.mtimeMs));
  }

  #entries(output: Buffer): string[] {
    return output.toString('utf8').split('\0').filter(Boolean).map(fold);
  }

  #unsafe(abs: string, rel: string): boolean {
    return rel.split('/').includes('.git') || insideGitDir(abs);
  }

  #place(root: string, path: string): { rel: string; real: string } | null {
    if (WINDOWS && badWindowsName(path)) return null;
    let real: string;
    try {
      const parent = realOf(dirname(path));
      const name = basename(path);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) return null;
      real = stat ? realpathSync.native(path) : join(parent, name);
    } catch { return null; }
    const rel = relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const folded = fold(rel.split(sep).join('/'));
    return this.#unsafe(real, folded) ? null : { rel: folded, real };
  }

  #walk(dir: string, rel: string, out: Item[], links: 'refuse' | 'skip'): boolean {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const child = `${rel}/${fold(entry.name)}`;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink() || fold(entry.name) === '.git' || (entry.isDirectory() && isGitDir(abs))) {
        if (links === 'refuse') return false;
        continue;
      }
      const folder = entry.isDirectory();
      out.push({ rel: child, abs, folder });
      if (out.length > this.#limit) return false;
      if (folder && !this.#walk(abs, child, out, links)) return false;
    }
    return true;
  }

  async #git(root: string, commands: string[][]): Promise<Array<Buffer | null> | null> {
    const repo = inspectRepo(root);
    if (!repo.found || repo.unreadable || !repo.configOk) return null;
    const env = scrubEnv([]);
    const exe = findExecutable('git', env, root);
    if (!exe || isInside(root, exe) || !gitSupportsConfigOverride(exe)) return null;
    const run = prepareGitRun({ dataDir: this.#dataDir, env, gitExe: exe });
    try {
      const childEnv = { ...env, ...run.env, GIT_CEILING_DIRECTORIES: dirname(root) };
      const out: Array<Buffer | null> = [];
      for (const args of commands) out.push(await runGit(exe, root, args, childEnv));
      return out;
    } finally {
      run.cleanup();
    }
  }
}
