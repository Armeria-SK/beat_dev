import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config/schema.ts';
import { GIT_TIMEOUT_MS, withGit } from '../mesh/folders.ts';
import type { AppPaths } from '../paths.ts';
import { isInside, isSecretPath, windowsHazard } from '../tools/hooks/scope.ts';
import { folderMissing, type ProjectStore } from './store.ts';

export type WorktreeKind = 'task' | 'fix';
export type WorktreeState = 'creating' | 'active' | 'branch' | 'merged' | 'discarded' | 'removing' | 'gone';
export type WorktreeEnding = 'branch' | 'merged' | 'discarded' | 'gone';
export type WorktreeNote = 'not_on_branch' | 'in_progress' | 'missing';

// 本体の git の状態（作業コピーのタスクの実行の前後で比べる。変われば持ち主に知らせるだけで、止めも戻しもしない）。
// beat の作業ブランチ（refs/heads/beat/）・beat の控え（refs/beat/）・取ってきた宛先の参照（refs/remotes/）は、並べたタスクと fetch で正しく変わるので入れない
// フック（*.sample を除く名前と中身）と worktree の登録（beat の作業コピーの置き場の中を指すものを除く）も見る。
// 共有の .git は --git-common-dir で探す（.git がファイルの製品も）。フックは <共有の .git>/hooks を読む（beat の git は core.hooksPath を差し替えるので --git-path hooks は使えない。core.hooksPath を変えたら設定の変化として出る）
// git を動かせない（設定に beat が使わない鍵がある・.git がファイルなど）ときは、ファイルで読める分（設定・フック・登録）だけ比べ、git で読む分は git: false にする
export interface MainGitPrint { git: boolean; head: string; branch: string; refs: string; stash: string; config: string; hooks: string; worktrees: string }
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const readOr = (path: string): Buffer | string => { try { return readFileSync(path); } catch { return 'unreadable'; } };
// フックの置き場の中身: ふつうのファイルは中身ごと（下のフォルダもたどる）、ほかの種類（リンク・FIFO など）は種類だけ（読まない）
function treeDigest(dir: string, keep: (name: string) => boolean, depth = 0): string {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return 'none'; }
  return names.filter(keep).map(name => {
    const path = join(dir, name);
    const stat = lstatOf(path);
    if (stat?.isFile()) return `${name} file ${sha(readOr(path))}`;
    if (stat?.isDirectory()) return `${name} dir ${depth < 8 ? sha(treeDigest(path, () => true, depth + 1)) : 'deep'}`;
    return `${name} ${stat?.isSymbolicLink() ? 'link' : stat ? 'special' : 'gone'}`;
  }).join('\n');
}
function folderDigest(dir: string, keep: (name: string, path: string) => boolean): string {
  let names: string[];
  try { names = readdirSync(dir).sort(); } catch { return 'none'; }
  return names.filter(name => keep(name, join(dir, name))).map(name => {
    const path = join(dir, name);
    return `${name} ${lstatOf(path)?.isDirectory() ? sha(readOr(join(path, 'gitdir'))) : sha(readOr(path))}`;
  }).join('\n');
}
export async function mainGitPrint(root: string, dataDir: string, ownCopies?: string): Promise<MainGitPrint | undefined> {
  const print = await withGit(root, dataDir, async git => {
    const text = async (args: string[]): Promise<string> => (await git(args))?.toString('utf8').trim() ?? '';
    const refs = (await text(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n')
      .filter(line => line && !/^refs\/(?:heads\/beat\/|beat\/|remotes\/)/u.test(line)).join('\n');
    return {
      head: await text(['rev-parse', '-q', '--verify', 'HEAD']), branch: await text(['symbolic-ref', '-q', 'HEAD']), refs,
      stash: await text(['reflog', 'show', '--format=%H', 'refs/stash', '--']),
      common: await text(['rev-parse', '--git-common-dir']),
    };
  });
  const { common: commonText, ...rest } = print ?? { head: '', branch: '', refs: '', stash: '', common: '' };
  const common = commonText ? resolve(root, commonText) : fileCommonDir(root);
  if (!common) return undefined;
  const hooks = treeDigest(join(common, 'hooks'), name => !name.endsWith('.sample'));
  const worktrees = folderDigest(join(common, 'worktrees'), (_, path) => {
    const gitdir = readOr(join(path, 'gitdir')).toString().trim();
    return !(ownCopies && gitdir !== 'unreadable' && isInside(ownCopies, dirname(gitdir)));
  });
  return { git: print !== undefined, ...rest, config: sha(readOr(join(common, 'config'))), hooks, worktrees };
}

// git を使わずに共有の .git を探す（.git のフォルダ、または gitdir: の行と commondir）
function fileCommonDir(root: string): string | undefined {
  const dotGit = join(root, '.git');
  const stat = lstatOf(dotGit);
  if (stat?.isDirectory()) return dotGit;
  if (!stat?.isFile()) return undefined;
  const line = /^gitdir:\s*(.+?)\s*$/mu.exec(readOr(dotGit).toString());
  if (!line) return undefined;
  const gitdir = resolve(root, line[1]!);
  const commondir = readOr(join(gitdir, 'commondir')).toString().trim();
  return commondir !== 'unreadable' && commondir ? resolve(gitdir, commondir) : gitdir;
}

// 変わった所。前は git で読めて後で読めなくなったら git（設定を変えて見えなくした場合も伝える）
export const mainGitChanges = (before: MainGitPrint, after: MainGitPrint): string[] => [
  ...(before.git && after.git ? (['branch', 'head', 'refs', 'stash'] as const).filter(key => before[key] !== after[key]) : before.git && !after.git ? ['git'] : []),
  ...(['config', 'hooks', 'worktrees'] as const).filter(key => before[key] !== after[key]),
];

export interface WorktreeRow {
  id: string;
  project_id: string;
  repo: string;
  task_id: string | null;
  proposal_id: string | null;
  kind: WorktreeKind;
  path: string | null;
  branch: string;
  base: string;
  tip: string | null;
  own_tip: string | null;
  state: WorktreeState;
  keep_branch: number;
  ending: WorktreeEnding | null;
  note: WorktreeNote | null;
  created_at: number;
  updated_at: number;
}

export type PlaceResult = { ok: true; root: string } | { ok: false; reason: 'unsafe_place' };
export type CreateResult = { ok: true; row: WorktreeRow } | { ok: false; reason: 'not_git' | 'unsafe' | 'unsafe_place' | 'dirty_git_dir' | 'timeout' | 'failed' };
export type FinishResult = { ok: true; tip: string; committed: boolean; changed: boolean; held?: string[] } | { ok: false; reason: 'unknown' | 'not_active' | 'foreign' | 'unsafe' | 'not_on_branch' | 'in_progress' | 'missing' | 'timeout' | 'failed' };
export type ReactivateResult = { ok: true; row: WorktreeRow } | { ok: false; reason: 'unknown' | 'not_branch' | 'foreign' | 'moved' | 'unsafe' };
export type RemoveResult = { ok: true; branchKept: boolean; note?: 'branch_moved' | 'not_merged' } | { ok: false; reason: 'unknown' | 'foreign' | 'repo_moved' | 'unsafe' | 'locked' | 'dirty' | 'busy' | 'failed' };

export const BEAT_BRANCHES = 'refs/heads/beat/';
export const BEAT_BRANCH = /^beat\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/u;
const WORKTREE_ID = /^[0-9a-f]{8}$/u;
const STALE_CREATING_MS = 10 * 60 * 1000;
const MAX_ADMIN_FILE = 4096;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'];
// 仕上げのコミットと片付けが止める新しいファイルの名前（.env* と *.env・鍵・credentials.json・secrets.*・service-account*.json。名前に secret を含むだけのソースは入れる）
export const HELD_NAME = /(?:^|\/)(?:\.env[^/]*|[^/]+\.env|[^/]+\.(?:pem|key)|credentials\.json|secrets\.[^/]+|service-account[^/]*\.json)$/iu;
const NO_MAINTENANCE = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const WINDOWS = process.platform === 'win32';
const fold = (p: string): string => (WINDOWS ? p.toLowerCase() : p);
const samePath = (a: string, b: string): boolean => fold(resolve(a)) === fold(resolve(b));

const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};
const plainDirOrNone = (path: string): boolean => {
  const st = lstatOf(path);
  return st === undefined || (st !== null && st.isDirectory() && !st.isSymbolicLink());
};
const realOrNull = (path: string): string | null => {
  try { return realpathSync.native(path); } catch { return null; }
};
const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 8);

// 置き場の途中（ある所まで）にリンク・ジャンクション・フォルダでないものがあるか
function linkOnChain(abs: string): boolean {
  const { root } = parse(abs);
  let current = root;
  for (const part of abs.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    const st = lstatOf(current);
    if (st === undefined) return false;
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return true;
  }
  return false;
}

// そのフォルダか上のどこかに node_modules か package.json がある（Node と npm がそこまでさかのぼる）
function depsAbove(abs: string): boolean {
  let dir = abs;
  for (;;) {
    if (lstatOf(join(dir, 'node_modules')) !== undefined || lstatOf(join(dir, 'package.json')) !== undefined) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export function placeUnsafe(abs: string, productRoots: readonly string[]): boolean {
  if (!isAbsolute(abs) || windowsHazard(abs) || linkOnChain(abs) || depsAbove(abs)) return true;
  return productRoots.some(root => isInside(realOrNull(root) ?? resolve(root), abs));
}

export function worktreeRoot(paths: Pick<AppPaths, 'data'>, config: Pick<AppConfig, 'worker'>, options: { home?: string; productRoots?: readonly string[] } = {}): PlaceResult {
  const configured = config.worker.worktreeRoot?.trim();
  const data = realOrNull(paths.data) ?? resolve(paths.data);
  let root: string;
  if (configured) {
    if (!isAbsolute(configured)) return { ok: false, reason: 'unsafe_place' };
    root = resolve(configured);
  } else {
    root = depsAbove(data) ? join(resolve(options.home ?? homedir()), '.beat', 'worktrees', shortHash(fold(data))) : join(data, 'worktrees');
  }
  const inData = (p: string): boolean => isInside(data, p) && !isInside(join(data, 'worktrees'), p);
  if (inData(root) || placeUnsafe(root, options.productRoots ?? [])) return { ok: false, reason: 'unsafe_place' };
  const real = realOrNull(root);
  if (real && (inData(real) || placeUnsafe(real, options.productRoots ?? []))) return { ok: false, reason: 'unsafe_place' };
  return { ok: true, root: real ?? root };
}

export function branchSlug(title: string, kind: WorktreeKind): string {
  const slug = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+/u, '').slice(0, 30).replace(/-+$/u, '');
  return slug || kind;
}

// リンク・ジャンクションをたどらずに消す（リンクはリンクだけを外す）。under の外（under 自身も）は断る
export async function removeTree(path: string, options: { under: string }): Promise<{ ok: true } | { ok: false; reason: 'outside' | 'busy' }> {
  const under = realOrNull(options.under);
  const abs = resolve(path);
  if (!under || windowsHazard(abs)) return { ok: false, reason: 'outside' };
  const parent = realOrNull(dirname(abs));
  if (!parent) return isInside(under, abs) && lstatOf(abs) === undefined ? { ok: true } : { ok: false, reason: 'outside' };
  const name = WINDOWS ? basename(abs).replace(/[. ]+$/u, '') : basename(abs);
  if (!name || name === '.' || name === '..') return { ok: false, reason: 'outside' };
  const target = join(parent, name);
  if (!isInside(under, target) || samePath(under, target)) return { ok: false, reason: 'outside' };
  const st = lstatOf(target);
  if (st === undefined) return { ok: true };
  if (st === null) return { ok: false, reason: 'busy' };
  try { await drop(target, st); } catch { return { ok: false, reason: 'busy' }; }
  return lstatOf(target) === undefined ? { ok: true } : { ok: false, reason: 'busy' };
}

// node_modules のような大きなフォルダでもサーバーを止めないよう、ファイルの操作はどれも待つ形で行う
async function drop(path: string, st: Stats): Promise<void> {
  if (st.isSymbolicLink()) {
    try { await unlink(path); } catch { await rmdir(path); }
    return;
  }
  if (st.isDirectory()) {
    for (const name of await readdir(path)) await drop(join(path, name), await lstat(join(path, name)));
    await rmdir(path);
    return;
  }
  try { await unlink(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    await chmod(path, 0o666);
    await unlink(path);
  }
}

function adminFile(path: string): string | null {
  const st = lstatOf(path);
  if (!st || !st.isFile() || st.size > MAX_ADMIN_FILE) return null;
  try {
    const text = readFileSync(path, 'utf8').replace(/[\r\n]+$/u, '');
    return text === '' || /[\r\n\0]/u.test(text) ? null : text;
  } catch { return null; }
}

// 本体の .git の、worktree を足すときに git が書く所。リンク・ほかの worktree の管理フォルダ（commondir・gitdir）・リンクを含む objects は断る
export function mainGitSafe(gitDir: string): boolean {
  if (lstatOf(join(gitDir, 'commondir')) !== undefined || lstatOf(join(gitDir, 'gitdir')) !== undefined) return false;
  const dirs = ['objects', 'refs', 'refs/heads', 'refs/heads/beat', 'logs', 'logs/refs', 'logs/refs/heads', 'logs/refs/heads/beat', 'worktrees', 'reftable'];
  if (!dirs.every(name => plainDirOrNone(join(gitDir, ...name.split('/'))))) return false;
  for (const name of ['objects', 'worktrees']) {
    let entries: string[] = [];
    try { entries = readdirSync(join(gitDir, name)); } catch { entries = []; }
    if (entries.some(entry => lstatOf(join(gitDir, name, entry))?.isSymbolicLink() !== false)) return false;
  }
  return true;
}

// worktree の .git のファイル → 本体の .git/worktrees/<名前>（commondir が本体の .git、gitdir がこの worktree の .git）。合わなければ null
function linkedAdmin(mainGitReal: string, path: string): string | null {
  const dotGit = adminFile(join(path, '.git'));
  if (!dotGit?.startsWith('gitdir: ')) return null;
  const place = dotGit.slice(8);
  const admin = realOrNull(isAbsolute(place) ? place : resolve(path, place));
  if (!admin || !samePath(dirname(admin), join(mainGitReal, 'worktrees')) || !plainDirOrNone(join(mainGitReal, 'worktrees'))) return null;
  const adminSt = lstatOf(admin);
  if (!adminSt || adminSt.isSymbolicLink() || !adminSt.isDirectory()) return null;
  const back = adminFile(join(admin, 'gitdir'));
  const common = adminFile(join(admin, 'commondir'));
  const pathReal = realOrNull(path);
  if (!back || !common || !pathReal) return null;
  if (!samePath(isAbsolute(back) ? back : resolve(admin, back), join(pathReal, '.git'))) return null;
  const commonReal = realOrNull(isAbsolute(common) ? common : resolve(admin, common));
  return commonReal && samePath(commonReal, mainGitReal) ? admin : null;
}

// 本体の .git/worktrees のうち、gitdir がこの場所の .git を指す管理フォルダ（git worktree prune は持ち主の worktree まで片づけるので使わない）
function adminFor(mainGitReal: string, path: string): string | null {
  const dir = join(mainGitReal, 'worktrees');
  if (!plainDirOrNone(dir)) return null;
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    const admin = join(dir, name);
    const st = lstatOf(admin);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
    const back = adminFile(join(admin, 'gitdir'));
    if (back && samePath(isAbsolute(back) ? back : resolve(admin, back), join(path, '.git'))) return admin;
  }
  return null;
}

// 行の作業コピーが、いまの置き場の <製品>/<id> そのもので、途中にリンクが無く、実体のパスも同じか（書き方の違い・リンクへの差し替えは断る）
function ownFolder(placeRoot: string, row: Pick<WorktreeRow, 'path' | 'id' | 'project_id'>): boolean {
  if (!row.path) return false;
  const abs = resolve(row.path);
  const expected = join(placeRoot, shortHash(row.project_id), row.id);
  if (windowsHazard(abs) || !samePath(abs, expected) || linkOnChain(abs)) return false;
  const st = lstatOf(abs);
  const real = realOrNull(abs);
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink() && real && samePath(real, expected));
}

interface ListedWorktree { path: string; branch: string | null; detached: boolean; locked: boolean }

function parseWorktreeList(out: string): ListedWorktree[] {
  const list: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) { current = { path: field.slice(9), branch: null, detached: false, locked: false }; list.push(current); }
    else if (current && field.startsWith('branch ')) current.branch = field.slice(7);
    else if (current && field === 'detached') current.detached = true;
    else if (current && (field === 'locked' || field.startsWith('locked '))) current.locked = true;
  }
  return list;
}

type Git = (args: string[]) => Promise<Buffer | null>;

// withGit の git は時間切れも失敗も null を返す。上限の時間に届いていれば時間切れとみなす
function timed(git: Git, flag: { timedOut: boolean }): (args: string[]) => Promise<string | null> {
  return async args => {
    const started = Date.now();
    const out = await git([...NO_MAINTENANCE, ...args]);
    if (out === null && Date.now() - started >= GIT_TIMEOUT_MS - 250) flag.timedOut = true;
    return out === null ? null : out.toString('utf8');
  };
}

export interface WorktreeDeps {
  db: DatabaseSync;
  paths: Pick<AppPaths, 'data'>;
  config: () => Pick<AppConfig, 'worker'>;
  projects: Pick<ProjectStore, 'get' | 'list'>;
  now?: () => number;
  log?: (line: string) => void;
  home?: string;
  random?: (bytes: number) => string;
}

export class Worktrees {
  readonly #d: WorktreeDeps;
  readonly #now: () => number;

  readonly #random: (bytes: number) => string;

  constructor(deps: WorktreeDeps) { this.#d = deps; this.#now = deps.now ?? Date.now; this.#random = deps.random ?? (bytes => randomBytes(bytes).toString('hex')); }

  get(id: string): WorktreeRow | undefined {
    return this.#d.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as WorktreeRow | undefined;
  }

  // タスクの作業コピーの行（いちばん新しいもの）
  forTask(taskId: string): WorktreeRow | undefined {
    return this.#d.db.prepare("SELECT * FROM worktrees WHERE task_id = ? AND kind = 'task' ORDER BY created_at DESC, id DESC LIMIT 1").get(taskId) as WorktreeRow | undefined;
  }

  // 取り込み待ちのブランチの変わった量（base..tip）。先端ごとに 1 回だけ裏で数え、数え終わるまでは null
  readonly #stats = new Map<string, { files: number; added: number; removed: number } | 'pending' | 'failed'>();
  statsOf(row: WorktreeRow): { files: number; added: number; removed: number } | null {
    if (!row.tip || row.state === 'active' || row.state === 'creating') return null;
    const key = `${row.id}:${row.tip}`;
    const known = this.#stats.get(key);
    if (known === 'pending' || known === 'failed') return null;
    if (known) return known;
    const repo = this.#repoHere(row);
    if (!repo) return null;
    this.#stats.set(key, 'pending');
    void withGit(repo, this.#d.paths.data, async git => git(['diff', '--numstat', '--no-renames', row.base, row.tip!])).then(out => {
      if (out === null || out === undefined) { this.#stats.set(key, 'failed'); return; }
      const lines = out.toString('utf8').split('\n').filter(Boolean);
      const num = (s: string | undefined): number => (s && /^\d+$/u.test(s) ? Number(s) : 0);
      this.#stats.set(key, { files: lines.length, added: lines.reduce((n, l) => n + num(l.split('\t')[0]), 0), removed: lines.reduce((n, l) => n + num(l.split('\t')[1]), 0) });
    }, () => { this.#stats.set(key, 'failed'); });
    return null;
  }

  list(projectId?: string): WorktreeRow[] {
    return (projectId === undefined
      ? this.#d.db.prepare('SELECT * FROM worktrees ORDER BY created_at, id').all()
      : this.#d.db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at, id').all(projectId)) as unknown as WorktreeRow[];
  }

  place(): PlaceResult {
    const roots = [...this.#d.projects.list(), ...this.#d.projects.list({ archived: true })].map(p => p.root);
    return worktreeRoot(this.#d.paths, this.#d.config(), { ...(this.#d.home ? { home: this.#d.home } : {}), productRoots: roots });
  }

  // when: その状態の行だけを書き直す（待っているあいだにほかの呼び出しが removing などに変えていたら書かない）
  #set(id: string, fields: Partial<Pick<WorktreeRow, 'state' | 'tip' | 'own_tip' | 'path' | 'keep_branch' | 'ending' | 'note'>>, when?: WorktreeState): void {
    const keys = Object.keys(fields) as Array<keyof typeof fields>;
    this.#d.db.prepare(`UPDATE worktrees SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?${when ? ' AND state = ?' : ''}`)
      .run(...keys.map(k => fields[k] ?? null), this.#now(), id, ...(when ? [when] : []));
  }

  // 製品のいまのフォルダが、作ったときの本体と同じか
  #repoHere(row: WorktreeRow): string | null {
    const project = this.#d.projects.get(row.project_id);
    if (!project || folderMissing(project)) return null;
    const real = realOrNull(project.root);
    return real && samePath(real, row.repo) ? real : null;
  }

  async createWorktree(input: { projectId: string; root: string; kind: 'task'; taskId?: string; title: string }): Promise<CreateResult> {
    const project = this.#d.projects.get(input.projectId);
    const real = realOrNull(input.root);
    if (!project || !real || folderMissing(project) || !samePath(realOrNull(project.root) ?? project.root, real)) return { ok: false, reason: 'failed' };
    const dotGit = lstatOf(join(real, '.git'));
    if (dotGit === undefined) return { ok: false, reason: 'not_git' };
    if (!dotGit || dotGit.isSymbolicLink() || !dotGit.isDirectory()) return { ok: false, reason: 'unsafe' };
    const mainGit = realOrNull(join(real, '.git'));
    if (!mainGit) return { ok: false, reason: 'unsafe' };
    const place = this.place();
    if (!place.ok) return place;
    if (!mainGitSafe(mainGit)) return { ok: false, reason: 'dirty_git_dir' };
    const parentPath = join(place.root, shortHash(input.projectId));
    try { mkdirSync(parentPath, { recursive: true }); } catch { return { ok: false, reason: 'failed' }; }
    const parent = realOrNull(parentPath);
    if (!parent || !isInside(place.root, parent) || placeUnsafe(parent, [])) return { ok: false, reason: 'unsafe_place' };

    const flag = { timedOut: false };
    let created: WorktreeRow | undefined;
    const outcome = await withGit<CreateResult>(real, this.#d.paths.data, async raw => {
      const git = timed(raw, flag);
      const base = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
      if (!base) return { ok: false, reason: flag.timedOut ? 'timeout' : 'failed' };
      const refs = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
      if (refs === null) return { ok: false, reason: flag.timedOut ? 'timeout' : 'failed' };
      const taken = new Set(refs.split('\n').filter(Boolean).map(name => name.toLowerCase()));
      const slug = branchSlug(input.title, input.kind);
      let branch: string | undefined;
      let id: string | undefined;
      for (let i = 0; i < 16 && !(branch && id); i++) {
        const candidate = `beat/${slug}-${this.#random(2)}`;
        if (!branch && BEAT_BRANCH.test(candidate) && !taken.has(`refs/heads/${candidate}`) && lstatOf(join(mainGit, 'refs', 'heads', ...candidate.split('/'))) === undefined
          && lstatOf(join(mainGit, 'logs', 'refs', 'heads', ...candidate.split('/'))) === undefined) branch = candidate;
        const cid = this.#random(4);
        if (!id && !this.get(cid) && lstatOf(join(parent, cid)) === undefined && lstatOf(join(mainGit, 'worktrees', cid)) === undefined) id = cid;
      }
      if (!branch || !id) return { ok: false, reason: 'failed' };
      const path = join(parent, id);
      const now = this.#now();
      this.#d.db.prepare(`INSERT INTO worktrees (id, project_id, repo, task_id, proposal_id, kind, path, branch, base, tip, own_tip, state, keep_branch, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 'task', ?, ?, ?, ?, ?, 'creating', 0, ?, ?)`).run(id, input.projectId, real, input.taskId ?? null, path, branch, base, base, base, now, now);
      created = this.get(id)!;
      if (await git(['worktree', 'add', '--no-checkout', '-b', branch, '--', path, base]) === null) return { ok: false, reason: flag.timedOut ? 'timeout' : 'failed' };
      if (!linkedAdmin(mainGit, path)) return { ok: false, reason: 'dirty_git_dir' };
      return { ok: true, row: created };
    });
    if (outcome?.ok) {
      const filled = await withGit(outcome.row.path!, this.#d.paths.data, async raw => (await timed(raw, flag)(['read-tree', '--reset', '-u', 'HEAD'])) !== null);
      if (filled === true && linkedAdmin(mainGit, outcome.row.path!)) {
        this.#set(outcome.row.id, { state: 'active' });
        return { ok: true, row: this.get(outcome.row.id)! };
      }
    }
    if (created) await this.removeWorktree(created.id, { keepBranch: false, state: 'gone', discardLocal: true });
    if (outcome && !outcome.ok) return outcome;
    return { ok: false, reason: outcome === undefined ? 'unsafe' : flag.timedOut ? 'timeout' : 'failed' };
  }

  // 書きかけを、フックなし・署名なしで 1 つのコミットにして、行を branch（取り込み待ち）にする。HEAD が行のブランチの上でなければ何もしない
  async finishWorktree(id: string, options: { commitLeftovers: boolean; message: string }): Promise<FinishResult> {
    const row = this.get(id);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.kind !== 'task' || row.state !== 'active' || !row.path) return { ok: false, reason: 'not_active' };
    // 作業コピー（か中の .git のファイル）が外で消された: コミットできないので、ブランチだけを取り込み待ちに残す
    if (!lstatOf(row.path)?.isDirectory() || !lstatOf(join(row.path, '.git'))?.isFile()) {
      this.#set(id, { state: 'branch', note: 'missing' }, 'active');
      return { ok: false, reason: 'missing' };
    }
    const repo = this.#repoHere(row);
    const mainGit = repo && realOrNull(join(repo, '.git'));
    const admin = mainGit ? linkedAdmin(mainGit, row.path) : null;
    if (!BEAT_BRANCH.test(row.branch) || !mainGit || !admin) return { ok: false, reason: 'foreign' };
    if (IN_PROGRESS.some(name => lstatOf(join(admin, name)) !== undefined)) {
      this.#set(id, { state: 'branch', note: 'in_progress' }, 'active');
      return { ok: false, reason: 'in_progress' };
    }
    const flag = { timedOut: false };
    let branchTip: string | undefined;
    let held: string[] = [];
    const result = await withGit<FinishResult>(row.path, this.#d.paths.data, async raw => {
      const git = timed(raw, flag);
      const failed = (): FinishResult => ({ ok: false, reason: flag.timedOut ? 'timeout' : 'failed' });
      if ((await git(['symbolic-ref', '-q', 'HEAD']))?.trim() !== `refs/heads/${row.branch}`) {
        const line = (await git(['for-each-ref', '--format=%(refname) %(objectname)', BEAT_BRANCHES]))?.split('\n').find(l => l.split(' ')[0] === `refs/heads/${row.branch}`);
        branchTip = line?.split(' ')[1];
        return { ok: false, reason: 'not_on_branch' };
      }
      let committed = false;
      if (options.commitLeftovers) {
        if (await git(['add', '-A']) === null) return failed();
        const added = await git(['diff', '--cached', '--name-only', '--diff-filter=A', '-z']);
        if (added === null) return failed();
        held = added.split('\0').filter(name => name !== '' && (isSecretPath(name) || HELD_NAME.test(name)));
        for (let i = 0; i < held.length; i += 100) {
          if (await git(['--literal-pathspecs', 'rm', '--cached', '-q', '--', ...held.slice(i, i + 100)]) === null) return failed();
        }
        const staged = await git(['diff', '--cached', '--name-only', '-z']);
        if (staged === null) return failed();
        if (staged !== '') {
          const name = (await git(['config', '--get', 'user.name']))?.trim();
          const email = (await git(['config', '--get', 'user.email']))?.trim();
          const ident = name && email ? [] : ['-c', 'user.name=beat', '-c', 'user.email=beat@localhost'];
          const trailer = row.task_id ? ['-m', `Beat-Task: ${row.task_id}`] : [];
          if (await git([...ident, 'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', options.message || 'beat: work left in the working copy', ...trailer]) === null) return failed();
          committed = true;
        }
      }
      const tip = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.trim();
      return tip ? { ok: true, tip, committed, changed: tip !== row.base, ...(held.length ? { held } : {}) } : failed();
    });
    if (!result) return { ok: false, reason: 'unsafe' };
    if (result.ok) this.#set(id, { tip: result.tip, own_tip: result.tip, state: 'branch', note: null }, 'active');
    else if (result.reason === 'not_on_branch') this.#set(id, { state: 'branch', note: 'not_on_branch', ...(branchTip ? { tip: branchTip } : {}) }, 'active');
    return result;
  }

  // 取り消したタスクを開き直したとき（D-13）: 取り込み待ちの作業コピーをもう一度使う。ブランチの先端が beat の書いた先端（own_tip）と違う・
  // 作業コピーが自分のブランチの上にない・取り込みなどの途中・D-13 の印がある行は使い回さない（持ち主のコミットをタスクの仕事として受け取らないため）
  async reactivate(id: string): Promise<ReactivateResult> {
    const row = this.get(id);
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.kind !== 'task' || row.state !== 'branch' || row.note !== null || !row.path || !row.own_tip) return { ok: false, reason: 'not_branch' };
    const repo = this.#repoHere(row);
    const mainGit = repo && realOrNull(join(repo, '.git'));
    const place = this.place();
    const admin = mainGit ? linkedAdmin(mainGit, row.path) : null;
    if (!BEAT_BRANCH.test(row.branch) || !repo || !admin || !place.ok || !ownFolder(place.root, row)) return { ok: false, reason: 'foreign' };
    if (IN_PROGRESS.some(name => lstatOf(join(admin, name)) !== undefined)) return { ok: false, reason: 'moved' };
    const tip = await this.#branchTip(repo, row.branch);
    if (tip === undefined) return { ok: false, reason: 'unsafe' };
    if (tip !== row.own_tip) return { ok: false, reason: 'moved' };
    const head = await withGit(row.path, this.#d.paths.data, async git => ({
      ref: (await git(['symbolic-ref', '-q', 'HEAD']))?.toString('utf8').trim(),
      commit: (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']))?.toString('utf8').trim(),
    }));
    if (!head) return { ok: false, reason: 'unsafe' };
    if (head.ref !== `refs/heads/${row.branch}` || head.commit !== row.own_tip) return { ok: false, reason: 'moved' };
    this.#set(id, { state: 'active', tip }, 'branch');
    const now = this.get(id)!;
    return now.state === 'active' ? { ok: true, row: now } : { ok: false, reason: 'not_branch' };
  }

  async #branchTip(repo: string, branch: string): Promise<string | null | undefined> {
    return withGit(repo, this.#d.paths.data, async git => {
      const refs = (await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/beat/']))?.toString('utf8');
      if (refs === undefined) return undefined;
      const line = refs.split('\n').find(l => l.split(' ')[0] === `refs/heads/${branch}`);
      return line ? line.split(' ')[1]! : null;
    });
  }

  // ブランチの今の先端（本体で、名前の大文字小文字まで同じものだけ）。行の tip（見た先端）だけを書き直し、own_tip（beat が書いた先端）は変えない
  async tipOf(id: string): Promise<string | null> {
    const row = this.get(id);
    const repo = row && BEAT_BRANCH.test(row.branch) ? this.#repoHere(row) : null;
    if (!row || !repo) return null;
    const tip = await this.#branchTip(repo, row.branch);
    if (tip) this.#set(id, { tip });
    return tip ?? null;
  }

  // tip が本体の今のブランチ（refs/heads/ の下で beat/ でないもの）の先端の祖先か。HEAD が外れている・beat/ のブランチの上なら false
  async #mergedIntoBranch(repo: string, tip: string): Promise<boolean | undefined> {
    return withGit(repo, this.#d.paths.data, async git => {
      const ref = (await git(['symbolic-ref', '-q', 'HEAD']))?.toString('utf8').trim();
      if (!ref || !ref.startsWith('refs/heads/') || ref.startsWith(BEAT_BRANCHES)) return false;
      const head = (await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]))?.toString('utf8').trim();
      if (!head) return false;
      const base = (await git(['merge-base', tip, head]))?.toString('utf8').trim();
      return base === undefined ? false : base === tip;
    });
  }

  // ブランチの先端が本体の今のブランチの祖先か。祖先なら、取り込み待ちの行を merged にする。D-13 の行（not_on_branch）と、先端が作ったときのままの行は取り込み済みにしない
  async isMerged(id: string, options: { mark?: boolean } = {}): Promise<boolean | undefined> {
    const row = this.get(id);
    const repo = row && BEAT_BRANCH.test(row.branch) ? this.#repoHere(row) : null;
    if (!row || !repo) return undefined;
    const tip = await this.#branchTip(repo, row.branch);
    if (!tip) return undefined;
    if (row.note !== null || tip === row.base) return false;
    const merged = await this.#mergedIntoBranch(repo, tip);
    if (merged && row.state === 'branch' && options.mark !== false) this.#set(id, { state: 'merged', tip }, 'branch');
    return merged;
  }

  // 作業コピーにしか無いもの（書きかけ・追っていないファイル・行のブランチの外の HEAD・取り込みや rebase の途中）があるか。調べられなければ undefined
  async #localWork(row: WorktreeRow, admin: string | null): Promise<boolean | undefined> {
    if (!row.path) return false;
    if (admin && IN_PROGRESS.some(name => lstatOf(join(admin, name)) !== undefined)) return true;
    return withGit(row.path, this.#d.paths.data, async raw => {
      const git = timed(raw, { timedOut: false });
      if ((await git(['symbolic-ref', '-q', 'HEAD']))?.trim() !== `refs/heads/${row.branch}`) return true;
      const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (status === null) return true;
      let names: string[] = [];
      try { names = readdirSync(row.path!); } catch { return true; }
      return status !== '' && !(names.length === 1 && names[0] === '.git');
    });
  }

  // 作りかけの行の作業コピーが、checkout の途中で止まった形か: 行のブランチの上で先端が作ったときのまま、途中の操作が無く、違いは追うファイルが欠けていることだけ
  async #halfCheckedOut(row: WorktreeRow): Promise<boolean> {
    if (!row.path || lstatOf(row.path) === undefined) return false;
    const repo = this.#repoHere(row);
    const mainGit = repo ? realOrNull(join(repo, '.git')) : null;
    const admin = mainGit ? adminFor(mainGit, row.path) : null;
    if (!admin || IN_PROGRESS.some(name => lstatOf(join(admin, name)) !== undefined)) return false;
    return (await withGit(row.path, this.#d.paths.data, async raw => {
      const git = timed(raw, { timedOut: false });
      if ((await git(['symbolic-ref', '-q', 'HEAD']))?.trim() !== `refs/heads/${row.branch}`) return false;
      if ((await git(['rev-parse', '-q', '--verify', 'HEAD']))?.trim() !== (row.own_tip ?? row.base)) return false;
      // checkout が書いている途中で止まると、索引が無く古い index.lock が残る。ファイルには触らずに HEAD から索引だけ作り直して比べる（持ち主の書きかけは M や ?? で残る）
      let rebuilt = false;
      if (lstatOf(join(admin, 'index')) === undefined) {
        if (lstatOf(join(admin, 'index.lock')) !== undefined) await unlink(join(admin, 'index.lock'));
        if (await git(['read-tree', 'HEAD']) === null) return false;
        rebuilt = true;
      }
      const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      if (status === null) return false;
      const entries = status.split('\0').filter(Boolean);
      if (entries.length === 0) return false;
      let cut = 0;
      for (const entry of entries) {
        if (/^(?: D|D |DD) /u.test(entry)) continue;
        // 止まった checkout が書いていたファイル: HEAD の中身より短く、その頭と同じ（1 つまで）
        if (!rebuilt || !entry.startsWith(' M ') || ++cut > 1) return false;
        const name = entry.slice(3);
        const blob = await raw([...NO_MAINTENANCE, 'cat-file', 'blob', `HEAD:${name}`]);
        let file: Buffer;
        try { file = readFileSync(join(row.path!, name)); } catch { return false; }
        if (!blob || file.length >= blob.length || !blob.subarray(0, file.length).equals(file)) return false;
      }
      return true;
    })) === true;
  }

  // 消すブランチの名前が、大文字小文字まで同じ 1 つの ref だけに当たり、その先端が tip か（Windows では大文字小文字だけ違う持ち主のブランチまで消えるので）
  async #onlyBranch(repo: string, branch: string, tip: string): Promise<boolean> {
    return (await withGit(repo, this.#d.paths.data, async git => {
      const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/']))?.toString('utf8');
      if (refs === undefined) return false;
      const full = `refs/heads/${branch}`;
      const same = refs.split('\n').filter(name => name.toLowerCase() === full.toLowerCase());
      if (same.length !== 1 || same[0] !== full) return false;
      return (await git(['rev-parse', '--verify', '-q', `${full}^{commit}`]))?.toString('utf8').trim() === tip;
    })) === true;
  }

  // 自分が作ったと表にある作業コピーとブランチだけを片づける。消せなければ removing で残し、見回りがやり直す
  // confirmedTip: 持ち主が見て捨てると決めたブランチの先端（beat の書いていないコミットも消す）。ready: 消しかけにする直前に、読み直した行で呼ぶ（同じ同期の区切りで行を removing にする）
  async removeWorktree(id: string, options: { keepBranch: boolean; state?: 'merged' | 'discarded' | 'gone'; discardLocal?: boolean; confirmedTip?: string; ready?: (row: WorktreeRow) => boolean }): Promise<RemoveResult> {
    const row = this.get(id);
    if (!row) return { ok: false, reason: 'unknown' };
    if (!BEAT_BRANCH.test(row.branch) || !WORKTREE_ID.test(row.id)) return { ok: false, reason: 'foreign' };
    const repo = this.#repoHere(row);
    if (!repo) return { ok: false, reason: 'repo_moved' };
    const mainGit = realOrNull(join(repo, '.git'));
    if (!mainGit) return { ok: false, reason: 'repo_moved' };
    const listed = await withGit(repo, this.#d.paths.data, async git => (await git(['worktree', 'list', '--porcelain', '-z']))?.toString('utf8') ?? null);
    if (listed === undefined) return { ok: false, reason: 'unsafe' };
    if (listed === null) return { ok: false, reason: 'failed' };
    const entries = parseWorktreeList(listed);
    const ours = `refs/heads/${row.branch}`;
    if (entries.some(e => e.branch === ours && (!row.path || !samePath(e.path, row.path)))) return { ok: false, reason: 'foreign' };
    const here = row.path ? entries.find(e => samePath(e.path, row.path!)) : undefined;
    if (here?.locked) return { ok: false, reason: 'locked' };
    const admin = row.path ? adminFor(mainGit, row.path) : null;
    const place = this.place();
    if (row.path && lstatOf(row.path) !== undefined) {
      if (!place.ok || !ownFolder(place.root, row)) return { ok: false, reason: 'foreign' };
      if (here) {
        if (!admin || (here.branch !== ours && !here.detached)) return { ok: false, reason: 'foreign' };
      } else {
        const dotGit = adminFile(join(row.path, '.git'));
        const pointsHome = dotGit?.startsWith('gitdir: ') && samePath(dirname(resolve(row.path, dotGit.slice(8))), join(mainGit, 'worktrees'));
        if (lstatOf(join(row.path, '.git')) !== undefined && !pointsHome) return { ok: false, reason: 'foreign' };
      }
      if (row.state !== 'removing' && !options.discardLocal) {
        const local = here ? await this.#localWork(row, admin) : readdirSync(row.path).some(name => name !== '.git');
        if (local === undefined) return { ok: false, reason: 'unsafe' };
        if (local) return { ok: false, reason: 'dirty' };
      }
    }

    let ending: WorktreeEnding | null = options.state ?? (row.state === 'removing' ? row.ending : row.state === 'merged' ? 'merged' : null);
    const ownTip = options.confirmedTip ?? row.own_tip ?? row.base;
    if (options.ready) {
      const fresh = this.get(id);
      if (!fresh || fresh.state !== row.state || !options.ready(fresh)) return { ok: false, reason: 'busy' };
    }
    this.#set(id, { state: 'removing', keep_branch: options.keepBranch ? 1 : 0, ending });
    if (row.path && lstatOf(row.path) !== undefined) {
      if (!place.ok || !ownFolder(place.root, row)) return { ok: false, reason: 'foreign' };
      if (here && await removeLinksInside(row.path)) await withGit(repo, this.#d.paths.data, async git => git([...NO_MAINTENANCE, 'worktree', 'remove', '--force', '--', row.path!]));
      if (lstatOf(row.path) !== undefined && !(await removeTree(row.path, { under: place.root })).ok) return { ok: false, reason: 'busy' };
    }
    if (admin && lstatOf(admin) !== undefined && !(await removeTree(admin, { under: join(mainGit, 'worktrees') })).ok) return { ok: false, reason: 'busy' };
    this.#set(id, { path: null });

    let branchKept = true;
    let note: 'branch_moved' | 'not_merged' | undefined;
    let merged = false;
    if (!options.keepBranch) {
      const tip = await this.#branchTip(repo, row.branch);
      if (tip === undefined) return { ok: false, reason: 'unsafe' };
      if (tip === null) branchKept = false;
      else {
        merged = (await this.#mergedIntoBranch(repo, tip)) === true;
        if (tip !== ownTip && !merged) note = 'branch_moved';
        else if (ending === 'merged' && !merged) note = 'not_merged';
        else {
          if (!(await this.#onlyBranch(repo, row.branch, tip))) return { ok: false, reason: 'foreign' };
          ending ??= merged ? 'merged' : 'discarded';
          this.#set(id, { ending });
          const gone = await withGit(repo, this.#d.paths.data, async git => {
            const deleted = await git([...NO_MAINTENANCE, 'branch', merged ? '-d' : '-D', '--', row.branch]);
            if (deleted || !merged) return deleted;
            // 取り込み済みと beat が確かめたのに branch -d が断られた: 持ち主が upstream を付けたブランチは、git が本体の今のブランチでなく upstream と比べて断る（毎回 removing のまま残る）。
            // upstream が付いていて、先端が読んだ tip のままのときだけ、upstream の設定を外して git にもう一度 branch -d をさせる（別の作業コピーが使っている・本体の今のブランチに取り込まれていない、は git がここで改めて断る）。
            // それでも断られたら、外した設定を元の値に戻す（remote・merge は値が複数のこともあるので全部）。戻せなければ、値は書かずに [WARN] を残す
            const saved = async (key: string) => ((await git([...NO_MAINTENANCE, 'config', '--get-all', `branch.${row.branch}.${key}`]))?.toString('utf8') ?? '').split('\n').map(v => v.replace(/\r$/u, '')).filter(Boolean);
            const upstream = { remote: await saved('remote'), merge: await saved('merge') };
            if (!upstream.merge.length) return deleted;
            const current = (await git([...NO_MAINTENANCE, 'rev-parse', '--verify', '-q', `refs/heads/${row.branch}^{commit}`]))?.toString('utf8').trim();
            if (current !== tip) return null;
            const unset = await git([...NO_MAINTENANCE, 'branch', '--unset-upstream', '--', row.branch]);
            const again = unset ? await git([...NO_MAINTENANCE, 'branch', '-d', '--', row.branch]) : null;
            if (again) return again;
            const lost: string[] = [];
            for (const key of ['remote', 'merge'] as const) {
              for (const [i, value] of upstream[key].entries()) {
                if (!(await git([...NO_MAINTENANCE, 'config', i === 0 ? '--replace-all' : '--add', `branch.${row.branch}.${key}`, value])) && !lost.includes(key)) lost.push(key);
              }
            }
            if (lost.length) this.#d.log?.(`[WARN] beat could not write back the ${lost.join(' and ')} setting of the git branch ${row.branch} after failing to delete it; check "git config --get-regexp branch.${row.branch}" (values are not logged)`);
            return null;
          });
          if (!gone) return { ok: false, reason: 'failed' };
          branchKept = false;
        }
      }
    }
    const final: WorktreeState = note ? 'branch' : ending ?? (merged ? 'merged' : branchKept ? 'branch' : 'discarded');
    this.#set(id, { state: final, ...(note ? { ending: null } : {}) });
    return { ok: true, branchKept, ...(note ? { note } : {}) };
  }

  // 起動のときの見回り: 作りかけで止まった行と、消しかけの行を片づける。表に無いものと、本体の場所が変わった行には触らない
  async sweepWorktrees(): Promise<{ removed: number; left: number }> {
    const rows = this.#d.db.prepare("SELECT * FROM worktrees WHERE kind = 'task' AND (state = 'removing' OR (state = 'creating' AND updated_at < ?))").all(this.#now() - STALE_CREATING_MS) as unknown as WorktreeRow[];
    let removed = 0;
    let left = 0;
    for (const row of rows) {
      const result = row.state === 'creating'
        // checkout の途中で止まった作業コピー（追うファイルが欠けているだけ）は、書きかけとして残さず消す。持ち主の書きかけは残す
        ? await this.removeWorktree(row.id, { keepBranch: false, state: 'gone', discardLocal: await this.#halfCheckedOut(row) })
        : await this.removeWorktree(row.id, { keepBranch: row.keep_branch === 1 });
      if (result.ok) removed++;
      else left++;
    }
    if (left) this.#d.log?.(`[WARN] ${left} beat working cop${left === 1 ? 'y' : 'ies'} could not be cleaned up yet; beat tries again at the next start`);
    return { removed, left };
  }
}

// 作業コピーの中のリンク・ジャンクションを、git に消させる前に外す（git がたどって外のファイルを消さないように）。外せないものがあれば false
export async function removeLinksInside(root: string): Promise<boolean> {
  const top = lstatOf(root);
  if (!top || top.isSymbolicLink() || !top.isDirectory()) return false;
  const walk = async (dir: string): Promise<boolean> => {
    let names: string[];
    try { names = await readdir(dir); } catch { return false; }
    for (const name of names) {
      if (dir === root && name === '.git') continue;
      const path = join(dir, name);
      let st: Stats;
      try { st = await lstat(path); } catch { return false; }
      if (st.isSymbolicLink()) {
        try { await unlink(path); } catch { try { await rmdir(path); } catch { return false; } }
      } else if (st.isDirectory() && !(await walk(path))) return false;
    }
    return true;
  };
  return walk(root);
}
