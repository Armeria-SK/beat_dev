import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { KV } from '../db/kv.ts';
import { inspectRepo } from '../tools/hooks/git-repo.ts';
import { isInside } from '../tools/hooks/scope.ts';
import type { Env } from '../tools/hooks/tool-config.ts';
import { gitSupportsConfigOverride, prepareGitRun } from '../tools/shell/git-env.ts';
import { findExecutable, scrubEnv } from '../tools/shell/runner.ts';

export interface CreatedScope { kind: 'task' | 'conv'; id: string }
export interface CreatedRunRef { runId: string; parent?: { runId: string } | undefined }

export const CREATED_LIMIT = 5000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface Known { exact: Set<string>; folders: Set<string>; ancestors: Set<string> }
interface RunRecord { scope: CreatedScope; root: string; mode: 'git' | 'plain' | 'unknown'; untracked?: Known; tracked?: Known; noted: Set<string> }

const scopeKey = (scope: CreatedScope): string => `created:${scope.kind}:${scope.id}`;
const baseKey = (runId: string): string => `created-base:${runId}`;

function emptyKnown(): Known { return { exact: new Set(), folders: new Set(), ancestors: new Set() }; }

function addKnown(known: Known, entry: string): void {
  const folder = entry.endsWith('/');
  const path = folder ? entry.slice(0, -1) : entry;
  if (!path) return;
  (folder ? known.folders : known.exact).add(path);
  for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) known.ancestors.add(path.slice(0, i));
}

function knownAt(known: Known, path: string): boolean {
  if (known.exact.has(path) || known.folders.has(path) || known.ancestors.has(path)) return true;
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const up = path.slice(0, i);
    if (known.exact.has(up) || known.folders.has(up)) return true;
  }
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
  readonly #env: Env;
  readonly #log: (line: string) => void;
  readonly #limit: number;
  readonly #windows: boolean;
  readonly #runs = new Map<string, RunRecord>();

  constructor(options: { kv: KV; dataDir: string; env?: Env; log?: (line: string) => void; limit?: number; windows?: boolean }) {
    this.#kv = options.kv;
    this.#dataDir = options.dataDir;
    this.#env = options.env ?? process.env;
    this.#log = options.log ?? (() => undefined);
    this.#limit = options.limit ?? CREATED_LIMIT;
    this.#windows = options.windows ?? process.platform === 'win32';
  }

  list(scope: CreatedScope): string[] {
    const value = this.#kv.getJson<unknown>(scopeKey(scope));
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : [];
  }

  async begin(runId: string, scope: CreatedScope, root: string): Promise<void> {
    let real: string;
    try { real = realpathSync.native(root); } catch { return; }
    const record: RunRecord = { scope, root: real, mode: 'unknown', noted: new Set() };
    this.#runs.set(runId, record);
    try {
      const dotGit = lstatSync(join(real, '.git'), { throwIfNoEntry: false });
      if (!dotGit) { record.mode = 'plain'; return; }
      if (dotGit.isSymbolicLink()) return;
      const out = await this.#git(real, [['rev-parse', '--verify', '-q', 'HEAD'], ['ls-files', '-z', '--others', '--directory'], ['ls-files', '-z'], ['ls-tree', '-r', '-z', '--name-only', 'HEAD']]);
      if (!out || !out[1] || !out[2]) return;
      const head = out[0]?.toString('utf8').trim() || null;
      const tree = head ? out[3] : Buffer.alloc(0);
      if (!tree) return;
      const untracked = emptyKnown();
      for (const entry of this.#entries(out[1])) addKnown(untracked, entry);
      const tracked = emptyKnown();
      for (const entry of [...this.#entries(out[2]), ...this.#entries(tree)]) addKnown(tracked, entry);
      Object.assign(record, { mode: 'git', untracked, tracked });
      this.#kv.setJson(baseKey(runId), { hash: createHash('sha256').update(out[1]).digest('hex'), head });
    } catch (error) {
      this.#log(`[WARN] Could not note the files that existed before run ${runId}: ${(error as Error).message}`);
    }
  }

  note(run: CreatedRunRef, path: string): void {
    const record = this.#runs.get(run.parent?.runId ?? run.runId);
    if (record?.mode !== 'plain') return;
    const place = this.#place(record.root, path);
    if (place) record.noted.add(place.rel);
  }

  isCreated(path: string, run: CreatedRunRef): boolean {
    const record = this.#runs.get(run.parent?.runId ?? run.runId);
    if (!record) return false;
    const place = this.#place(record.root, path);
    if (!place) return false;
    const listed = new Set(this.list(record.scope));
    const fresh = (rel: string, folder: boolean): boolean => {
      const tracked = record.tracked ? knownAt(record.tracked, rel) : false;
      if (listed.has(folder ? `${rel}/` : rel) && !tracked) return true;
      if (record.mode === 'git') return !tracked && !knownAt(record.untracked!, rel);
      return !folder && record.noted.has(rel);
    };
    let folder = false;
    try { folder = lstatSync(place.real, { throwIfNoEntry: false })?.isDirectory() ?? false; } catch { return false; }
    if (!folder) return fresh(place.rel, false);
    if (!fresh(place.rel, true)) return false;
    const inside: string[] = [];
    if (!this.#walk(place.real, place.rel, inside)) return false;
    return inside.every(entry => entry.endsWith('/') ? fresh(entry.slice(0, -1), true) : fresh(entry, false));
  }

  async end(runId: string): Promise<void> {
    const record = this.#runs.get(runId);
    if (!record) return;
    try {
      const added: string[] = [];
      let full = false;
      if (record.mode === 'plain') added.push(...record.noted);
      if (record.mode === 'git') {
        const now = (await this.#git(record.root, [['ls-files', '-z', '--others', '--directory']]))?.[0];
        if (!now) { this.#log(`[WARN] Could not list the files run ${runId} made, so they are not counted as made by this work`); return; }
        const before: Known[] = [record.untracked!, record.tracked!];
        for (const entry of this.#entries(now)) {
          const folder = entry.endsWith('/');
          const rel = folder ? entry.slice(0, -1) : entry;
          if (!rel || before.some(known => knownAt(known, rel))) continue;
          added.push(entry);
          if (folder && !this.#walk(join(record.root, ...rel.split('/')), rel, added)) { full = true; break; }
        }
      }
      if (!added.length) return;
      const merged = new Set([...this.list(record.scope), ...added]);
      if (full || merged.size > this.#limit) {
        this.#log(`[WARN] Run ${runId} made more files than can be remembered (${this.#limit}), so they are not counted as made by this work`);
        return;
      }
      this.#kv.setJson(scopeKey(record.scope), [...merged].sort());
    } catch (error) {
      this.#log(`[WARN] Could not record the files run ${runId} made: ${(error as Error).message}`);
    } finally {
      this.#runs.delete(runId);
      try { this.#kv.delete(baseKey(runId)); } catch { }
    }
  }

  #fold(text: string): string { return this.#windows ? text.toLowerCase() : text; }

  #entries(output: Buffer): string[] {
    return output.toString('utf8').split('\0').filter(Boolean).map(entry => this.#fold(entry));
  }

  #place(root: string, path: string): { rel: string; real: string } | null {
    const abs = resolve(root, path);
    let real: string;
    try {
      const parent = realOf(dirname(abs));
      const name = basename(abs);
      const stat = lstatSync(abs, { throwIfNoEntry: false });
      if (stat && !stat.isSymbolicLink()) real = realpathSync.native(abs);
      else if (stat && !readdirSync(parent).some(entry => this.#fold(entry) === this.#fold(name))) return null;
      else real = join(parent, name);
    } catch { return null; }
    const rel = relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return { rel: this.#fold(rel.split(sep).join('/')), real };
  }

  #walk(dir: string, rel: string, out: string[]): boolean {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const child = `${rel}/${this.#fold(entry.name)}`;
      const folder = entry.isDirectory();
      out.push(folder ? `${child}/` : child);
      if (out.length > this.#limit) return false;
      if (folder && !this.#walk(join(dir, entry.name), child, out)) return false;
    }
    return true;
  }

  async #git(root: string, commands: string[][]): Promise<Array<Buffer | null> | null> {
    const repo = inspectRepo(root);
    if (!repo.found || repo.unreadable || !repo.configOk) return null;
    const env = scrubEnv([], this.#env as NodeJS.ProcessEnv);
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
