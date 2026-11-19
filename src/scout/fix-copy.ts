// beat 8-6a D-10: 直す実行の、その回だけの製品の写し（git clone --shared）。写しは本体の .git と参照・設定・stash・フックの置き場・worktree の登録を
// 分け合わず、本体の中身（objects）を読むだけ。beat が本体の .git に書くのは finishFixCopy の最後の 2 つ（beat が確かめたコミットを取ってくる fetch と、
// 無いときだけ作る update-ref）だけで、その前後に本体の指紋を比べる。写しは通っても落ちてもすぐ消す（表 worktrees の kind = 'fix' の行が記録）
import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config/schema.ts';
import { withGit } from '../mesh/folders.ts';
import type { AppPaths } from '../paths.ts';
import { CHECK_TIMEOUT_MS, runProductCheck } from '../projects/check-run.ts';
import { changedScripts, flagsFrom, parseNameStatus } from '../projects/diff-flags.ts';
import { folderMissing, type ProjectStore } from '../projects/store.ts';
import { BEAT_BRANCH, branchSlug, HELD_NAME, mainGitSafe, placeUnsafe, removeTree, type Worktrees, type WorktreeRow } from '../projects/worktree.ts';
import type { RunJob } from '../os/run-job.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { isInside, isSecretPath } from '../tools/hooks/scope.ts';

export const FIX_LIMITS = { files: 20, lines: 400 } as const;
export const FIX_DIFF_LINES = 6;

export type FixReason = 'check_failed' | 'check_changed_files' | 'tests_removed' | 'check_touched' | 'has_links' | 'too_large' | 'not_descendant' | 'main_changed' | 'no_changes' | 'failed';
export type FixCreate = { ok: true; row: WorktreeRow } | { ok: false; reason: 'not_git' | 'unsafe' | 'unsafe_place' | 'no_commit' | 'failed' };
export type FixFinish =
  | { kept: true; branch: string; tip: string; files: number; added: number; removed: number; diff: string[]; unexpected?: string[] }
  | { kept: false; reason: FixReason; detail: string };

// 本体の指紋: 作業の木（status）・HEAD・.git/index・.git の中のファイル（objects/ を除く）の名前と中身のハッシュ
// objects は中身の置き場のファイルの名前と大きさ（あとの指紋は前の全部を同じ大きさで持っていなければならない。足すのはよい）
export interface MainPrint { status: string; head: string; index: string; files: ReadonlyMap<string, string>; objects: ReadonlyMap<string, number> }

const WINDOWS = process.platform === 'win32';
const fold = (p: string): string => (WINDOWS ? p.toLowerCase() : p);
const samePath = (a: string, b: string): boolean => fold(resolve(a)) === fold(resolve(b));
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};
const realOrNull = (path: string): string | null => {
  try { return realpathSync.native(path); } catch { return null; }
};
const plainDir = (path: string): boolean => { const st = lstatOf(path); return Boolean(st && st.isDirectory() && !st.isSymbolicLink()); };
const plainDirOrNone = (path: string): boolean => { const st = lstatOf(path); return st === undefined || (st !== null && st.isDirectory() && !st.isSymbolicLink()); };
const text = (out: Buffer | null | undefined): string | undefined => (out === null || out === undefined ? undefined : out.toString('utf8'));

// 本体の git のたびに、取ってくるついでの片づけ（gc・maintenance・commit-graph）が packed-refs などを書き換えないように
const NO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false'];
const MAX_GIT_FILES = 20_000;

const MAX_OBJECT_FILES = 200_000;
// 中身の置き場（objects・submodule の objects・LFS の objects）。中のファイルは名前と大きさだけ（足すだけなら変わったに数えない）。objects/info は中身で比べる
const objectStore = (key: string): boolean => key === 'objects' || key === 'lfs/objects' || /^modules\/(?:.+\/)?objects$/u.test(key);

// .git の中のファイル（別に比べる index を除く）。リンクと特殊なファイルは種類だけ（たどらない・読まない）。数が上限を超えたら undefined（見落とさないよう、比べない）
function gitDirFiles(gitDir: string): { files: Map<string, string>; objects: Map<string, number> } | undefined {
  const files = new Map<string, string>();
  const objects = new Map<string, number>();
  let over = false;
  const walk = (dir: string, rel: string, store: string | null): void => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { files.set(rel || '.', 'unreadable'); return; }
    for (const name of names) {
      if (files.size > MAX_GIT_FILES || objects.size > MAX_OBJECT_FILES) { over = true; return; }
      const key = rel ? `${rel}/${name}` : name;
      if (key === 'index') continue;
      const path = join(dir, name);
      const st = lstatOf(path);
      const inStore = store !== null && !key.startsWith(`${store}/info/`);
      if (st?.isDirectory() && !st.isSymbolicLink()) walk(path, key, store ?? (objectStore(key) ? key : null));
      else if (st?.isFile() && inStore) objects.set(key, st.size);
      else if (st?.isFile()) { try { files.set(key, sha(readFileSync(path))); } catch { files.set(key, 'unreadable'); } }
      else files.set(key, st?.isSymbolicLink() ? 'link' : st ? 'special' : 'gone');
    }
  };
  walk(gitDir, '', null);
  return over ? undefined : { files, objects };
}

// 本体の指紋。.git がふつうのフォルダでない・git を安全に動かせない（withGit が断る）なら undefined
export async function fingerprintMain(root: string, dataDir: string): Promise<MainPrint | undefined> {
  const real = realOrNull(root);
  if (!real || !plainDir(join(real, '.git'))) return undefined;
  const read = await withGit(real, dataDir, async git => ({
    status: text(await git(['status', '--porcelain=v2', '-z', '--untracked-files=all'])),
    head: text(await git(['rev-parse', '-q', '--verify', 'HEAD']))?.trim() ?? '',
  }));
  if (!read || read.status === undefined) return undefined;
  let index = 'none';
  try { index = sha(readFileSync(join(real, '.git', 'index'))); } catch { index = lstatOf(join(real, '.git', 'index')) === undefined ? 'none' : 'unreadable'; }
  const git = gitDirFiles(join(real, '.git'));
  if (!git) return undefined;
  return { status: sha(read.status + statusContents(real, read.status)), head: read.head, index, files: git.files, objects: git.objects };
}

// status に出た（変更・追っていない）ファイルの中身のハッシュ。status の行は同じでも中身だけ変わった、を見落とさないため
const STATUS_FIELDS: Record<string, number> = { '1': 8, '2': 9, u: 10, '?': 1 };
function statusContents(real: string, status: string): string {
  const entries = status.split('\0');
  const out: string[] = [];
  for (let i = 0; i < entries.length && out.length < MAX_GIT_FILES; i++) {
    const entry = entries[i]!;
    const fields = STATUS_FIELDS[entry[0] ?? ''];
    if (fields === undefined) continue;
    const rel = entry.split(' ').slice(fields).join(' ');
    if (entry[0] === '2') i++;
    const path = join(real, ...rel.split('/'));
    const st = lstatOf(path);
    let hash = st?.isFile() ? '' : st?.isSymbolicLink() ? 'link' : st ? 'other' : 'gone';
    if (st?.isFile()) { try { hash = sha(readFileSync(path)); } catch { hash = 'unreadable'; } }
    out.push(`${rel}\0${hash}`);
  }
  return out.join('\0');
}

// 変わった所の名前（持ち主に見せる。中身は出さない）
export function mainPrintChanges(before: MainPrint, after: MainPrint): string[] {
  const out: string[] = [];
  if (before.status !== after.status) out.push('working tree');
  if (before.head !== after.head) out.push('HEAD');
  if (before.index !== after.index) out.push('.git/index');
  for (const key of [...new Set([...before.files.keys(), ...after.files.keys()])].sort()) {
    if (before.files.get(key) !== after.files.get(key)) out.push(`.git/${key}`);
  }
  for (const [key, size] of before.objects) if (after.objects.get(key) !== size) out.push(`.git/${key}`);
  return out;
}

// 写しの .git が clone で作った形のままか: ふつうのフォルダ、ほかの .git を指す commondir・gitdir が無い、中身の置き場の
// 続き（alternates）が本体の objects の 1 行だけ。写しの中のコードはこれを書き換えうるので、beat が写しで git を動かすたびに見る
export function copyGitSafe(copy: string, mainObjects: string): boolean {
  const gitDir = join(copy, '.git');
  // 本体の .git と同じ確かめ（refs・logs・beat の置き場・objects の直下にリンクが無い、commondir・gitdir が無い）に、写しだけの確かめを足す
  if (!plainDir(gitDir) || !mainGitSafe(gitDir)) return false;
  if (!['objects', 'objects/info', 'refs'].every(name => plainDir(join(gitDir, ...name.split('/'))))) return false;
  if (!plainDirOrNone(join(gitDir, 'refs', 'heads'))) return false;
  const file = join(gitDir, 'objects', 'info', 'alternates');
  const st = lstatOf(file);
  if (!st || !st.isFile() || st.size > 4096) return false;
  let lines: string[];
  try { lines = readFileSync(file, 'utf8').split(/\r?\n/u).filter(line => line !== ''); } catch { return false; }
  const target = lines.length === 1 ? realOrNull(resolve(join(gitDir, 'objects'), lines[0]!)) : null;
  const main = realOrNull(mainObjects);
  return target !== null && main !== null && samePath(target, main);
}

// 写しの中の相対パス name の親のフォルダ（name 自身は含めない）のどれかがリンク・ジャンクションか。読めない所もリンク扱い
function underLink(root: string, name: string): boolean {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const st = lstatOf(join(root, ...parts.slice(0, i)));
    // 無い（消したファイルのフォルダ）ならその先も無い
    if (st === undefined) return false;
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return true;
  }
  return false;
}

// 本体に取ってきた base..tip の合否（本体の git で）: リンク・submodule を足していない → 試験の削除・確かめに関わる変更 → 大きさ → 子孫か。通れば大きさと 6 行の見本
async function judgeFix(git: Git, base: string, tip: string, check: string, limits: { files: number; lines: number }): Promise<{ reason: FixReason; detail: string } | { files: number; added: number; removed: number; diff: string[] }> {
  const raw = text(await git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', base, tip, '--']));
  if (raw === undefined) return { reason: 'failed', detail: 'git diff failed in the product folder' };
  // --raw -z: ":<元の型> <新しい型> <元> <新> <状態>\0<パス>\0"。新しい型が 120000（リンク）・160000（submodule）なら残さない
  const fields = raw.split('\0');
  const linked: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const mode = fields[i]!.split(' ')[1];
    if (mode === '120000' || mode === '160000') linked.push(fields[i + 1]!);
  }
  if (linked.length) return { reason: 'has_links', detail: linked.slice(0, 10).join(', ') };
  const listed = text(await git(['diff', '--name-status', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules', '--find-renames', base, tip, '--']));
  if (listed === undefined) return { reason: 'failed', detail: 'git diff failed in the product folder' };
  const entries = parseNameStatus(listed);
  const blob = async (rev: string, path: string): Promise<string | undefined> => text(await git(['cat-file', 'blob', `${rev}:${path}`]));
  const scripts = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.path.toLowerCase() === 'package.json' && (entry.status === 'M' || entry.status === 'T')) scripts.set(entry.path, changedScripts(await blob(base, entry.path), await blob(tip, entry.path), check));
  }
  const flags = flagsFrom(entries, check, path => scripts.get(path) ?? []);
  if (flags.testsDeleted.length) return { reason: 'tests_removed', detail: flags.testsDeleted.join(', ') };
  if (flags.checkChanged.length) return { reason: 'check_touched', detail: flags.checkChanged.map(c => c.path).join(', ') };
  const numstat = text(await git(['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', base, tip, '--']));
  if (numstat === undefined) return { reason: 'failed', detail: 'git diff failed in the product folder' };
  const lines = numstat.split('\n').filter(Boolean);
  const num = (s: string | undefined): number => (s && /^\d+$/u.test(s) ? Number(s) : 0);
  const added = lines.reduce((n, l) => n + num(l.split('\t')[0]), 0);
  const removed = lines.reduce((n, l) => n + num(l.split('\t')[1]), 0);
  if (lines.length > limits.files || added + removed > limits.lines) return { reason: 'too_large', detail: `${lines.length} files, ${added + removed} changed lines` };
  if (text(await git(['merge-base', base, tip]))?.trim() !== base) return { reason: 'not_descendant', detail: 'the fix does not build on the commit it started from' };
  const patch = text(await git(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', base, tip, '--'])) ?? '';
  const diff = patch.split('\n').filter(line => /^[+-]/u.test(line) && !/^(?:\+\+\+|---) /u.test(line)).slice(0, FIX_DIFF_LINES).map(line => redactSecrets(line).slice(0, 200));
  return { files: lines.length, added, removed, diff };
}

export interface FixCopyDeps {
  db: DatabaseSync;
  paths: Pick<AppPaths, 'data'>;
  config: () => AppConfig;
  projects: Pick<ProjectStore, 'get'>;
  worktrees: Pick<Worktrees, 'place' | 'get'>;
  now?: () => number;
  log?: (line: string) => void;
  random?: (bytes: number) => string;
}

// job: 直す実行のプロセスの入れ物。確かめのコマンドもここへ入れ、確かめが終わったら閉じる（残ったプロセスを止めてから比べる）
export interface FixFinishOptions { check: string; limits?: { files: number; lines: number }; signal?: AbortSignal; timeoutMs?: number; job?: RunJob }

type Git = (args: string[]) => Promise<Buffer | null>;

export class FixCopies {
  readonly #d: FixCopyDeps;
  readonly #now: () => number;
  readonly #random: (bytes: number) => string;
  // 写しを作る直前の本体の指紋（再起動をまたがない。またいだ写しは見回りが消す）
  readonly #before = new Map<string, MainPrint>();

  constructor(deps: FixCopyDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? (bytes => randomBytes(bytes).toString('hex'));
  }

  get(id: string): WorktreeRow | undefined { return this.#d.worktrees.get(id); }

  // fix の行の note は、捨てた理由（FixReason）か見回りの理由の短い語
  #set(id: string, fields: Partial<Pick<WorktreeRow, 'state' | 'tip' | 'own_tip' | 'path' | 'ending' | 'task_id'>> & { note?: string | null }): void {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    this.#d.db.prepare(`UPDATE worktrees SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND kind = 'fix'`)
      .run(...keys.map(k => fields[k] ?? null), this.#now(), id);
  }

  // 写しの置き場 <作業コピーの置き場>/fix。途中にリンクが無く、上に node_modules・package.json が無いこと（worktreeRoot と同じ決まり）
  #fixRoot(): string | null {
    const place = this.#d.worktrees.place();
    if (!place.ok) return null;
    const dir = join(place.root, 'fix');
    try { mkdirSync(dir, { recursive: true }); } catch { return null; }
    const real = realOrNull(dir);
    return real && plainDir(dir) && samePath(real, dir) && isInside(place.root, real) && !placeUnsafe(real, []) ? real : null;
  }

  // 行の写しが、いまの置き場の fix/<id> そのものか
  #ownCopy(row: WorktreeRow): { path: string; under: string } | null {
    const under = this.#fixRoot();
    if (!under || !row.path || row.kind !== 'fix' || !/^[0-9a-f]{8}$/u.test(row.id)) return null;
    return samePath(row.path, join(under, row.id)) ? { path: join(under, row.id), under } : null;
  }

  // 写しで git を動かす。動かすたびに、写しの .git が clone の形のままかを見てから（withGit は設定〔configOk〕と alternates も見る）
  async #inCopy<T>(row: WorktreeRow, use: (git: Git) => Promise<T>): Promise<T | undefined> {
    const own = this.#ownCopy(row);
    const repo = this.#repoHere(row);
    if (!own || !repo || !copyGitSafe(own.path, join(repo, '.git', 'objects'))) return undefined;
    return withGit(own.path, this.#d.paths.data, async git => use(args => git(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args])));
  }

  #repoHere(row: WorktreeRow): string | null {
    const project = this.#d.projects.get(row.project_id);
    if (!project || folderMissing(project)) return null;
    const real = realOrNull(project.root);
    return real && samePath(real, row.repo) ? real : null;
  }

  async createFixCopy(input: { projectId: string; root: string; proposalId: string; title: string; taskId?: string }): Promise<FixCreate> {
    const project = this.#d.projects.get(input.projectId);
    const real = realOrNull(input.root);
    if (!project || !real || folderMissing(project) || !samePath(realOrNull(project.root) ?? project.root, real)) return { ok: false, reason: 'failed' };
    const dotGit = lstatOf(join(real, '.git'));
    if (dotGit === undefined) return { ok: false, reason: 'not_git' };
    if (!dotGit || !plainDir(join(real, '.git'))) return { ok: false, reason: 'unsafe' };
    const under = this.#fixRoot();
    if (!under) return { ok: false, reason: 'unsafe_place' };
    const before = await fingerprintMain(real, this.#d.paths.data);
    if (!before) return { ok: false, reason: 'unsafe' };
    if (!/^[0-9a-f]{40,64}$/u.test(before.head)) return { ok: false, reason: 'no_commit' };
    const taken = text(await withGit(real, this.#d.paths.data, async git => git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])));
    if (taken === undefined) return { ok: false, reason: 'unsafe' };
    const names = new Set(taken.split('\n').filter(Boolean).map(name => name.toLowerCase()));
    const slug = branchSlug(input.title, 'fix');
    let branch: string | undefined;
    let id: string | undefined;
    for (let i = 0; i < 16 && !(branch && id); i++) {
      const candidate = `beat/${slug}-${this.#random(2)}`;
      if (!branch && BEAT_BRANCH.test(candidate) && !names.has(`refs/heads/${candidate}`)) branch = candidate;
      const cid = this.#random(4);
      if (!id && /^[0-9a-f]{8}$/u.test(cid) && !this.get(cid) && lstatOf(join(under, cid)) === undefined) id = cid;
    }
    if (!branch || !id) return { ok: false, reason: 'failed' };
    const path = join(under, id);
    const base = before.head;
    const now = this.#now();
    this.#d.db.prepare(`INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, own_tip, state, keep_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'fix', ?, ?, ?, ?, ?, 'creating', 1, ?, ?)`).run(id, input.projectId, real, input.taskId ?? null, input.proposalId, path, branch, base, base, base, now, now);
    const row = this.get(id)!;
    // 写しの .git は空のひな形（--template=）から作る: 本体のフックも、ひな形のフックも入らない
    const cloned = await withGit(real, this.#d.paths.data, async git => git([...NO_MAINTENANCE, 'clone', '--shared', '--no-checkout', '--no-tags', '--template=', '--', real, path]));
    const made = cloned ? await this.#inCopy(row, async git => {
      if (await git(['remote', 'remove', 'origin']) === null) return false;
      if (await git(['update-ref', `refs/heads/${branch}`, base, '']) === null) return false;
      if (await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]) === null) return false;
      return (await git(['read-tree', '--reset', '-u', 'HEAD'])) !== null;
    }) : undefined;
    if (made !== true) {
      await this.#drop(row, 'gone', made === undefined && cloned ? 'unsafe copy' : 'clone failed');
      return { ok: false, reason: made === undefined && cloned ? 'unsafe' : 'failed' };
    }
    this.#before.set(id, before);
    this.#set(id, { state: 'active' });
    return { ok: true, row: this.get(id)! };
  }

  // 合否の順: 書きかけのコミット → 確かめのコマンド → 作業の木と HEAD が変わっていない → 差分の印 → 大きさ → 元のコミットの子孫 → 本体の指紋 → 本体へ取ってくる → 写しを消す
  async finishFixCopy(id: string, options: FixFinishOptions): Promise<FixFinish> {
    const row = this.get(id);
    if (!row || row.kind !== 'fix' || row.state !== 'active') return { kept: false, reason: 'failed', detail: 'not an active fix copy' };
    const before = this.#before.get(id);
    const repo = this.#repoHere(row);
    if (!before || !repo || !this.#ownCopy(row) || !BEAT_BRANCH.test(row.branch)) return this.#fail(row, 'failed', 'the copy or the product folder is not the one beat made');
    const ref = `refs/heads/${row.branch}`;

    // 1. 書きかけを、フックなし・署名なしで 1 つのコミットに（鍵らしい新しいファイルは入れない）
    const committed = await this.#inCopy(row, async git => {
      if (text(await git(['symbolic-ref', '-q', 'HEAD']))?.trim() !== ref) return 'not_on_branch';
      if (await git(['add', '-A']) === null) return null;
      const added = text(await git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z']));
      if (added === undefined) return null;
      const held = added.split('\0').filter(name => name !== '' && (isSecretPath(name) || HELD_NAME.test(name)));
      for (let i = 0; i < held.length; i += 100) if (await git(['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...held.slice(i, i + 100)]) === null) return null;
      const staged = text(await git(['diff', '--cached', '--name-only', '-z']));
      if (staged === undefined) return null;
      // Windows の git はジャンクションをたどって先のファイルを足す。リンクの下のファイルが入るならコミットしない（写しの外の中身を本体へ持ち込まない）
      const copyRoot = this.#ownCopy(row)!.path;
      const viaLink = staged.split('\0').filter(Boolean).find(name => underLink(copyRoot, name));
      if (viaLink !== undefined) return { links: viaLink };
      if (staged !== '') {
        const message = ['-m', 'beat: fix from an unattended run', ...(row.task_id ? ['-m', `Beat-Task: ${row.task_id}`] : [])];
        if (await git(['-c', 'user.name=beat', '-c', 'user.email=beat@localhost', 'commit', '-q', '--no-verify', '--no-gpg-sign', ...message]) === null) return null;
      }
      const head = text(await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
      // コミットに入れなかった鍵らしいファイルは追っていないまま残る。確かめのあとの比べの元にする
      const status = text(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
      return head && status !== undefined ? { tip: head, status } : null;
    });
    if (committed === 'not_on_branch') return this.#fail(row, 'failed', 'the copy is not on its branch');
    if (committed && 'links' in committed) return this.#fail(row, 'has_links', `a file would come in through a link: ${committed.links}`.slice(0, 300));
    if (!committed) return this.#fail(row, 'failed', 'beat could not commit in the copy (its git folder or settings were changed)');
    const { tip, status: leftover } = committed;
    this.#set(id, { tip, own_tip: tip });
    if (tip === row.base) return this.#fail(row, 'no_changes', 'the run changed nothing');

    // 2. 確かめのコマンド（持ち主が書いたもの。見張りを通さずに、写しの中で。直す実行のプロセスの入れ物に入れる）
    const job = options.job;
    const check = await runProductCheck({ command: options.check, root: this.#ownCopy(row)!.path, ceiling: dirname(this.#ownCopy(row)!.path) }, {
      config: this.#d.config(), dataDir: this.#d.paths.data, signal: options.signal ?? new AbortController().signal, timeoutMs: options.timeoutMs ?? CHECK_TIMEOUT_MS,
      ...(job ? { onSpawn: (child: ChildProcess) => job.add(child) } : {}),
    });
    // 直す実行と確かめが起こして残ったプロセスを、ここで全部止める（このあと写しと本体を比べる）
    await job?.close();
    if (!check.ok) return this.#fail(row, 'check_failed', check.reason === 'aborted' ? 'the check was stopped' : `${check.reason}${check.exitCode !== null ? ` (exit ${check.exitCode})` : ''}: ${check.tail}`.slice(0, 2000));

    // 3. 確かめが写しの作業の木と HEAD を変えていないか（写しの git で）
    const moved = await this.#inCopy(row, async (git): Promise<{ reason: FixReason; detail: string } | 'same'> => {
      const head = text(await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
      const branchNow = text(await git(['symbolic-ref', '-q', 'HEAD']))?.trim();
      const status = text(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
      if (head === undefined || status === undefined) return { reason: 'failed', detail: 'git status failed in the copy' };
      if (head !== tip || branchNow !== ref || status !== leftover) return { reason: 'check_changed_files', detail: status.split('\0').filter(Boolean).slice(0, 10).map(line => line.slice(3)).join(', ') || 'HEAD moved' };
      return 'same';
    });
    if (!moved) return this.#fail(row, 'failed', "the copy's git folder or settings were changed");
    if (moved !== 'same') return this.#fail(row, moved.reason, moved.detail);

    // 4. 本体の指紋: 写しを作る前と同じか（持ち主が自分で変えたことも多い。変わった所の名前だけを返す）
    const now = await fingerprintMain(repo, this.#d.paths.data);
    if (!now) return this.#fail(row, 'main_changed', 'the product folder could not be read safely');
    const changed = mainPrintChanges(before, now);
    if (changed.length) return this.#fail(row, 'main_changed', changed.slice(0, 10).join(', '));

    // 5. 取ってくる直前に、写しのブランチがまだ確かめたコミットか（写しの .git もここでもう一度見る）
    const copyTip = await this.#inCopy(row, async git => text(await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.trim());
    if (copyTip !== tip) return this.#fail(row, 'failed', 'the copy changed after the check');

    // 6. 本体へ: 確かめたコミットの中身だけを取ってくる（参照は作らない）→ 本体の git で差分の印・大きさ・子孫か → 通ればブランチが無いときだけ作る。
    //    差分は写しの中身でなく、本体に入った中身で見る（写しの置き換え〔refs/replace〕や中身の置き場に左右されない）
    const copyPath = this.#ownCopy(row)!.path;
    const limits = options.limits ?? FIX_LIMITS;
    type Judged = { reason: FixReason; detail: string } | { files: number; added: number; removed: number; diff: string[] };
    let arrived = false;
    const kept = await withGit(repo, this.#d.paths.data, async (git): Promise<Judged | string> => {
      const run = (args: string[]): Promise<Buffer | null> => git(['--no-replace-objects', ...NO_MAINTENANCE, ...args]);
      const refs = text(await run(['for-each-ref', '--format=%(refname)', 'refs/heads/']));
      if (refs === undefined) return 'git failed';
      if (refs.split('\n').some(name => name.toLowerCase() === ref.toLowerCase())) return 'the branch name is taken';
      if (await run(['fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--no-auto-gc', '--no-auto-maintenance', '--', copyPath, ref]) === null) return 'git fetch failed';
      if (await run(['cat-file', '-e', `${tip}^{commit}`]) === null) return 'the checked commit did not arrive';
      arrived = true;
      const judged = await judgeFix(run, row.base, tip, options.check, limits);
      if ('reason' in judged) return judged;
      if (await run(['update-ref', '-m', `beat: fix ${row.id}`, ref, tip, '']) === null) return 'git update-ref failed';
      return judged;
    });
    // 落としたときに取ってきた中身は、どの参照からも指されないまま本体に残る（足しただけ。git gc がいずれ消す）
    const leftObjects = arrived ? ' (the fetched objects stay in the product repository, unreferenced, until git gc removes them)' : '';
    if (kept === undefined || typeof kept === 'string') return this.#fail(row, 'failed', `${kept ?? 'beat could not run git in the product folder'}${leftObjects}`);
    if ('reason' in kept) return this.#fail(row, kept.reason, `${kept.detail}${leftObjects}`);
    const judged = kept;

    // 7. 取ってきたあとの本体の違いは、そのブランチとその記録だけのはず（違えば知らせる。ブランチは残す）
    const after = await fingerprintMain(repo, this.#d.paths.data);
    const own = new Set([`.git/${ref}`, `.git/logs/${ref}`]);
    const unexpected = after ? mainPrintChanges(now, after).filter(name => !own.has(name)) : ['the product folder could not be read safely'];
    if (unexpected.length) this.#d.log?.(`[WARN] After keeping fix ${row.id}, the product folder changed in more than the new branch: ${unexpected.slice(0, 10).join(', ')}`);
    await this.#drop(row, 'branch', null);
    return { kept: true, branch: row.branch, tip, ...judged, ...(unexpected.length ? { unexpected } : {}) };
  }

  // 直す実行が始められなかった・落ちたときに写しを捨てる（本体には何もしない）
  async discardFixCopy(id: string, detail: string): Promise<void> {
    const row = this.get(id);
    if (row?.kind === 'fix' && (row.state === 'active' || row.state === 'creating')) await this.#fail(row, 'failed', detail);
  }

  async #fail(row: WorktreeRow, reason: FixReason, detail: string): Promise<FixFinish> {
    await this.#drop(row, 'discarded', reason);
    return { kept: false, reason, detail };
  }

  // 写しを消して行を閉じる（path は NULL）。消せなければ removing で残し、見回りがやり直す
  async #drop(row: WorktreeRow, ending: 'branch' | 'discarded' | 'gone', note: string | null): Promise<void> {
    this.#before.delete(row.id);
    this.#set(row.id, { state: 'removing', ending, note });
    const own = this.#ownCopy(row);
    if (row.path && lstatOf(row.path) !== undefined) {
      if (!own) { this.#d.log?.(`[WARN] beat did not remove fix copy ${row.id}: it is not in beat's place for copies`); return; }
      if (!(await removeTree(own.path, { under: own.under })).ok) return;
    }
    this.#set(row.id, { state: ending, path: null });
  }

  // 起動の見回り: 作りかけ・使いかけ（再起動で指紋を失ったもの）・消しかけの写しを消す。本体の .git には触らない
  async sweepFixCopies(): Promise<{ removed: number; left: number }> {
    const rows = this.#d.db.prepare("SELECT * FROM worktrees WHERE kind = 'fix' AND state IN ('creating', 'active', 'removing')").all() as unknown as WorktreeRow[];
    let removed = 0;
    let left = 0;
    for (const row of rows) {
      if (row.state !== 'removing' && this.#before.has(row.id)) continue;
      await this.#drop(row, row.state === 'removing' && row.ending ? row.ending as 'branch' | 'discarded' | 'gone' : 'discarded', row.note ?? 'beat restarted');
      if (this.get(row.id)?.state === 'removing') left++;
      else removed++;
    }
    return { removed, left };
  }
}
