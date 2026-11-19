import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KV } from '../db/kv.ts';
import type { Task } from '../tasks/store.ts';
import { BEAT_BRANCH, HELD_NAME, type RemoveResult, type WorktreeRow, type Worktrees } from './worktree.ts';
import { withGit } from '../mesh/folders.ts';
import { inDependencies, isSecretPath } from '../tools/hooks/scope.ts';

// beat 8-3: 取り込み待ち（done のタスク + 作業コピーの行が branch）の見回りと、持ち主の Mark merged / Discard
export const MERGE_WATCH_MS = 5 * 60_000;
// 見回りの時計のずれで 1 回飛ばさないための余裕
const DUE_SLACK_MS = 5_000;
export const BRANCH_COMMITS_MAX = 20;
export const BRANCH_FILES_MAX = 200;
const PRINT_STAT_MAX = 5000;

const FINISHED = new Set(['done', 'failed', 'cancelled']);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
// git が無視するファイルのうち、鍵らしい名前（beat の isSecretPath と worktree.ts の HELD_NAME）を探す pathspec。見つけた名前は heldSecret で確かめ直す。
// node_modules の中は除く（依存パッケージは試験用の鍵を同梱することがあり、npm で入れ直せる。isSecretPath の歩きも node_modules では止めない）
const SECRET_SPECS = [
  '**/.env*', '**/*.env', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.keystore', '**/*.jks',
  '**/id_rsa*', '**/id_dsa*', '**/id_ecdsa*', '**/id_ed25519*', '**/.netrc', '**/.npmrc', '**/.pypirc', '**/.git-credentials',
  '**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.docker/**', '**/.kube/**', '**/secret/**', '**/secrets/**',
  '**/credentials.json', '**/secrets.*',
].map(glob => `:(glob,icase)${glob}`).concat(':(exclude,glob,icase)**/node_modules/**');
const heldSecret = (name: string): boolean => !inDependencies(name) && (isSecretPath(name) || HELD_NAME.test(name));

// merged = 取り込まれて作業コピーとブランチを片づけた。kept = Mark merged（squash など）で作業コピーだけ片づけブランチを残した
// copy_removed = 取り込まれた先端より先にブランチが進んでいたので、作業コピーだけ片づけてブランチを残した（まだ取り込み待ち）
export type MergeOutcome = 'merged' | 'kept' | 'copy_removed' | 'discarded';
type RemoveFailure = Extract<RemoveResult, { ok: false }>['reason'];
export type BranchAction = { ok: true; outcome: MergeOutcome; row: WorktreeRow }
  | { ok: false; reason: 'no_branch' | 'busy' | 'moved' | 'changed' | 'unreadable' | RemoveFailure; path?: string | null };
type Failure = Extract<BranchAction, { ok: false }>;

export interface BranchCommit { sha: string; subject: string }
// 作業コピーにしか無いファイル（消すと一緒に消えるもの）。changed = 追っているファイルの書きかけ、untracked = 追っていない、ignored = git が無視するもの
export interface LocalFile { path: string; kind: 'changed' | 'untracked' | 'ignored' }
// blocking = 自動では消さないもの（書きかけ・追っていない・鍵らしい名前の無視されるファイル）。無視されるほかのファイル（node_modules など）は git worktree remove と同じく消してよい
export interface LocalFiles { files: LocalFile[]; total: number; blocking: number; secrets: number; print: string; detached: boolean }
export interface BranchPreview {
  tip: string; commits: BranchCommit[]; more: number;
  // 作業コピーの HEAD が外れていれば、ブランチの外にあるそのコミット（消すと一緒に消える）
  headCommits: BranchCommit[]; headMore: number;
  path: string | null; files: LocalFile[]; filesTotal: number; print: string;
}
export type PreviewResult = { ok: true; preview: BranchPreview } | { ok: false; reason: 'no_branch' | 'unreadable'; path?: string | null };
// 取り込まれたのに作業コピーに残るファイルがあって、beat が消さずに残した印（kv の worktree-held:<id>）。先端とファイルの指紋が同じあいだは見回りでやり直さない
interface HeldMark { tip: string; print: string; files: number }
export interface Confirmed { tip: string; print: string }

export interface MergeWatchDeps {
  db: DatabaseSync;
  kv: KV;
  worktrees: Pick<Worktrees, 'get' | 'isMerged' | 'tipOf' | 'removeWorktree'>;
  dataDir: string;
  stopBackground?: ((taskId: string) => Promise<unknown>) | undefined;
  onChanged?: ((row: WorktreeRow, outcome: MergeOutcome, by: 'beat' | 'user') => void) | undefined;
  log?: ((line: string) => void) | undefined;
  now?: (() => number) | undefined;
}

// 取り込み待ちのタスク（done で、いちばん新しい作業コピーの行が branch）。tasks.awaiting と合わせて Kanban の Awaiting check に出す
export function mergeWaiting(db: DatabaseSync, project?: string | null): Task[] {
  const where = project === undefined ? '' : project === null ? ' AND t.project_id IS NULL' : ' AND t.project_id = ?';
  return db.prepare(`SELECT t.* FROM tasks t WHERE t.status = 'done'${where}
    AND (SELECT w.state FROM worktrees w WHERE w.task_id = t.id AND w.kind = 'task' ORDER BY w.created_at DESC, w.id DESC LIMIT 1) = 'branch'
    AND (t.project_id IS NULL OR t.project_id NOT IN (SELECT id FROM projects WHERE archived_at IS NOT NULL))
    ORDER BY COALESCE(t.completed_at, t.updated_at) DESC LIMIT 200`).all(...(project ? [project] : [])) as unknown as Task[];
}

const heldKey = (id: string): string => `worktree-held:${id}`;
const exists = (path: string): boolean => { try { return lstatSync(path, { throwIfNoEntry: false }) !== undefined; } catch { return false; } };
const commitsOf = (log: string): BranchCommit[] => log.split('\0').filter(Boolean).map(line => { const [sha = '', subject = ''] = line.split('\x1f'); return { sha, subject }; });

export class MergeWatch {
  readonly #d: MergeWatchDeps;
  readonly #busy = new Set<string>();
  readonly #warned = new Map<string, string>();
  #last = Number.NEGATIVE_INFINITY;
  #sweep: Promise<number> | null = null;

  constructor(deps: MergeWatchDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  // App の 5 分ごとの見回りから呼ぶ。前の見回りから 5 分（時計のずれの余裕つき）たっていなければ何もしない。待たずに裏で見る
  due(): void {
    if (this.#sweep || this.#now() - this.#last < MERGE_WATCH_MS - DUE_SLACK_MS) return;
    this.#last = this.#now();
    void this.check().catch(error => this.#d.log?.(`[WARN] Could not check merged beat branches: ${(error as Error).message}`));
  }

  // 取り込み待ちの行（kind を問わない）を見て、本体の今のブランチに入っていれば片づける
  check(projectId?: string): Promise<number> {
    if (this.#sweep) return this.#sweep.then(() => this.check(projectId));
    const run = this.#check(projectId).finally(() => { this.#sweep = null; });
    this.#sweep = run;
    return run;
  }

  async #check(projectId?: string): Promise<number> {
    const rows = this.#d.db.prepare(`SELECT id FROM worktrees WHERE state = 'branch'${projectId ? ' AND project_id = ?' : ''} ORDER BY created_at, id`)
      .all(...(projectId ? [projectId] : [])) as Array<{ id: string }>;
    let changed = 0;
    for (const { id } of rows) {
      const row = this.#d.worktrees.get(id);
      if (!row || !this.#settled(row) || this.#busy.has(id)) continue;
      this.#busy.add(id);
      try {
        if ((await this.#d.worktrees.isMerged(id, { mark: false })) !== true) { this.#d.kv.delete(heldKey(id)); continue; }
        const now = this.#d.worktrees.get(id);
        if (now?.state !== 'branch') continue;
        const done = await this.#cleanMerged(now, true);
        if (done.ok) { changed++; this.#d.onChanged?.(done.row, done.outcome, 'beat'); }
      } finally { this.#busy.delete(id); }
    }
    return changed;
  }

  // 取り込まれた行の片づけ。作業コピーに書きかけ・追っていない・鍵らしい名前の無視されるファイルがあれば消さずに残し（held）、同じ形のあいだは見回りでやり直さない
  async #cleanMerged(row: WorktreeRow, watch: boolean): Promise<{ ok: true; outcome: MergeOutcome; row: WorktreeRow } | Failure> {
    const tip = await this.#d.worktrees.tipOf(row.id);
    const local = await this.localFiles(row);
    if (!tip || !local) return this.#failed(row, 'unreadable', `${tip}|${local?.print}`);
    const held = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    if (watch && held && held.tip === tip && held.print === local.print) return { ok: false, reason: 'dirty', path: row.path };
    if (local.secrets > 0) return this.#hold(row, tip, local);
    const done = await this.#remove(row, { keepBranch: false, state: 'merged' });
    if (!done.ok) return done.reason === 'dirty' || done.reason === 'locked' ? this.#hold(row, tip, local) : this.#failed(row, done.reason, `${tip}|${local.print}`);
    return { ok: true, outcome: done.branchKept ? 'copy_removed' : 'merged', row: done.row };
  }

  #hold(row: WorktreeRow, tip: string, local: LocalFiles): Failure {
    const held = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    if (!held || held.tip !== tip || held.print !== local.print) {
      this.#d.kv.setJson(heldKey(row.id), { tip, print: local.print, files: local.total } satisfies HeldMark);
      this.#d.log?.(`[WARN] The beat branch ${row.branch} is merged, but its working copy ${row.path} still has ${local.blocking} file(s) beat does not delete by itself, so beat left it in place`);
    }
    return { ok: false, reason: 'dirty', path: row.path };
  }

  #failed(row: WorktreeRow, reason: Failure['reason'], state: string): Failure {
    if (this.#warned.get(row.id) !== `${reason}|${state}`) {
      this.#warned.set(row.id, `${reason}|${state}`);
      this.#d.log?.(`[WARN] Could not clean up the beat branch ${row.branch}: ${reason}`);
    }
    return { ok: false, reason, path: row.path };
  }

  // 取り込まれたのに作業コピーを残した行（画面の「Merged — the working copy still has files」）
  held(row: WorktreeRow): { path: string; files: number } | null {
    if (row.state !== 'branch' || !row.path) return null;
    const mark = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    return mark ? { path: row.path, files: mark.files } : null;
  }

  // 持ち主の Mark merged: 本体の今のブランチに入っていれば見回りと同じ。入っていなければ（squash など）作業コピーだけ片づけてブランチを残す。
  // 作業コピーに残るファイルは、持ち主が見て確かめた（confirmed: 見せた先端と指紋）ときだけ一緒に消す
  async markMerged(id: string, confirmed?: Confirmed): Promise<BranchAction> {
    return this.#owned(id, async row => {
      const merged = (await this.#d.worktrees.isMerged(id, { mark: false })) === true;
      const now = this.#d.worktrees.get(id);
      if (now?.state !== 'branch') return { ok: false, reason: 'no_branch' };
      let done: { ok: true; outcome: MergeOutcome; row: WorktreeRow } | Failure;
      if (confirmed) {
        const checked = await this.#confirm(now, confirmed);
        if (checked) return checked;
        const removed = await this.#remove(now, { keepBranch: !merged, state: 'merged', discardLocal: true });
        done = removed.ok ? { ok: true, outcome: !merged ? 'kept' : removed.branchKept ? 'copy_removed' : 'merged', row: removed.row } : { ...removed, path: now.path };
      } else if (merged) done = await this.#cleanMerged(now, false);
      else {
        // 取り込まれていない（squash など）ブランチの作業コピーにファイルが残っていれば、「取り込まれた」とは書かずに断る（画面は見せて確かめる欄を開く）
        const local = await this.localFiles(now);
        if (!local) return { ok: false, reason: 'unreadable', path: now.path };
        if (local.blocking > 0) return { ok: false, reason: 'dirty', path: now.path };
        const removed = await this.#remove(now, { keepBranch: true, state: 'merged' });
        done = removed.ok ? { ok: true, outcome: 'kept', row: removed.row } : { ...removed, reason: removed.reason === 'locked' ? 'dirty' : removed.reason, path: now.path };
      }
      if (!done.ok) return done;
      this.#d.onChanged?.(done.row, done.outcome, 'user');
      return { ok: true, outcome: done.outcome, row: done.row };
    });
  }

  // 持ち主の Discard: 見せた先端（tip）とファイルの指紋（print）のままのときだけ、作業コピーとブランチを捨てる。見せたものは持ち主のコミットやファイルでも消す
  async discard(id: string, confirmed: Confirmed): Promise<BranchAction> {
    return this.#owned(id, async row => {
      const checked = await this.#confirm(row, confirmed);
      if (checked) return checked;
      const done = await this.#remove(row, { keepBranch: false, state: 'discarded', discardLocal: true, confirmedTip: confirmed.tip });
      if (!done.ok) return { ...done, path: row.path };
      if (done.branchKept) return { ok: false, reason: 'moved' };
      this.#d.onChanged?.(done.row, 'discarded', 'user');
      return { ok: true, outcome: 'discarded', row: done.row };
    });
  }

  async #confirm(row: WorktreeRow, confirmed: Confirmed): Promise<Failure | null> {
    if (await this.#d.worktrees.tipOf(row.id) !== confirmed.tip) return { ok: false, reason: 'moved' };
    const local = await this.localFiles(row);
    if (!local) return { ok: false, reason: 'unreadable', path: row.path };
    return local.print === confirmed.print ? null : { ok: false, reason: 'changed' };
  }

  // 消す前に持ち主に見せるもの: ブランチの base..tip のコミット（新しい順、20 件まで）、作業コピーの HEAD が外れていればその先のコミット、
  // 作業コピーにしか無いファイル（200 件まで）と、その指紋
  async preview(row: WorktreeRow, repo: string): Promise<PreviewResult> {
    if (row.state !== 'branch' || !BEAT_BRANCH.test(row.branch)) return { ok: false, reason: 'no_branch' };
    const tip = await this.#d.worktrees.tipOf(row.id);
    if (!tip || !OID.test(tip) || !OID.test(row.base)) return { ok: false, reason: 'no_branch' };
    const out = await withGit(repo, this.#d.dataDir, async git => {
      const count = (await git(['rev-list', '--count', `${row.base}..${tip}`]))?.toString('utf8').trim();
      const log = await git(['log', '-z', `--max-count=${BRANCH_COMMITS_MAX}`, '--format=%H%x1f%s', `${row.base}..${tip}`]);
      return count === undefined || log === null ? null : { count: Number(count) || 0, log: log.toString('utf8') };
    });
    if (!out) return { ok: false, reason: 'no_branch' };
    const local = await this.localFiles(row);
    if (!local) return { ok: false, reason: 'unreadable', path: row.path };
    let head = { commits: [] as BranchCommit[], more: 0 };
    if (local.detached && row.path) {
      const found = await withGit(row.path, this.#d.dataDir, async git => {
        const count = (await git(['rev-list', '--count', 'HEAD', '--not', tip, row.base]))?.toString('utf8').trim();
        const log = await git(['log', '-z', `--max-count=${BRANCH_COMMITS_MAX}`, '--format=%H%x1f%s', 'HEAD', '--not', tip, row.base]);
        return count === undefined || log === null ? null : { count: Number(count) || 0, log: log.toString('utf8') };
      });
      if (!found) return { ok: false, reason: 'unreadable', path: row.path };
      const commits = commitsOf(found.log);
      head = { commits, more: Math.max(0, found.count - commits.length) };
    }
    const commits = commitsOf(out.log);
    return {
      ok: true,
      preview: {
        tip, commits, more: Math.max(0, out.count - commits.length), headCommits: head.commits, headMore: head.more,
        path: row.path && exists(row.path) ? row.path : null, files: local.files, filesTotal: local.total, print: local.print,
      },
    };
  }

  // 作業コピーにしか無いファイルの一覧と指紋（HEAD・git status〔無視されるものも〕・無視される鍵らしい名前・各ファイルの大きさと変えた時刻）。読めなければ null
  async localFiles(row: WorktreeRow): Promise<LocalFiles | null> {
    const hash = createHash('sha256');
    if (!row.path || !exists(row.path)) return { files: [], total: 0, blocking: 0, secrets: 0, print: hash.update('none').digest('hex'), detached: false };
    const out = await withGit(row.path, this.#d.dataDir, async git => {
      const head = (await git(['symbolic-ref', '-q', 'HEAD']))?.toString('utf8').trim() ?? '-';
      const oid = (await git(['rev-parse', '-q', '--verify', 'HEAD']))?.toString('utf8').trim() ?? '-';
      const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
      const secrets = await git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...SECRET_SPECS]);
      return status === null || secrets === null ? null : { head, oid, status: status.toString('utf8'), secrets: secrets.toString('utf8') };
    });
    if (!out) return null;
    hash.update(`${out.head}\0${out.oid}\0`);
    const files: LocalFile[] = [];
    let total = 0;
    let blocking = 0;
    const add = (path: string, kind: LocalFile['kind'], entry: string) => {
      hash.update(`${entry}\0`);
      if (total < PRINT_STAT_MAX) {
        try { const stat = lstatSync(join(row.path!, path), { throwIfNoEntry: false }); hash.update(`${stat?.size ?? '-'}:${stat?.mtimeMs ?? '-'}\0`); } catch { hash.update('?\0'); }
      }
      if (files.length < BRANCH_FILES_MAX) files.push({ path, kind });
      total++;
    };
    const parts = out.status.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      if (code[0] === 'R' || code[0] === 'C') i++;
      const kind: LocalFile['kind'] = code === '!!' ? 'ignored' : code === '??' ? 'untracked' : 'changed';
      if (kind !== 'ignored') blocking++;
      add(entry.slice(3), kind, entry);
    }
    // 無視されるフォルダの中の鍵らしいファイルは status では見えない（フォルダ 1 行にまとまる）ので、名前で探して 1 つずつ数える
    // 上の status に同じ名前で出た無視されるファイル（作業コピーの直下の .env.local など）は、数えるだけで 2 度は並べない
    const secrets = out.secrets.split('\0').filter(name => name !== '' && heldSecret(name));
    const listed = new Set(parts.filter(entry => entry.startsWith('!! ')).map(entry => entry.slice(3)));
    for (const name of secrets) if (!listed.has(name)) add(name, 'ignored', `!s ${name}`);
    blocking += secrets.length;
    return { files, total, blocking, secrets: secrets.length, print: hash.digest('hex'), detached: out.head === '-' };
  }

  // 終わったタスクの行だけを触る（動いている・また動くタスクの作業コピーには触らない）。行にタスクが無いもの（8-6 の直す実行）はそのまま
  #settled(row: WorktreeRow): boolean {
    if (!row.task_id) return true;
    const task = this.#d.db.prepare('SELECT status FROM tasks WHERE id = ?').get(row.task_id) as { status: string } | undefined;
    return task === undefined || FINISHED.has(task.status);
  }

  async #owned(id: string, work: (row: WorktreeRow) => Promise<BranchAction>): Promise<BranchAction> {
    const row = this.#d.worktrees.get(id);
    if (!row || !this.#settled(row) || row.state !== 'branch') return { ok: false, reason: 'no_branch' };
    if (this.#busy.has(id)) return { ok: false, reason: 'busy' };
    this.#busy.add(id);
    try { return await work(row); } finally { this.#busy.delete(id); }
  }

  // 消しかけ（removing）にする直前に、行が今も branch でタスクが終わったままかを読み直す（開き直し・作業コピーの再開と取り合わない）
  async #remove(row: WorktreeRow, options: Parameters<Worktrees['removeWorktree']>[1]): Promise<{ ok: true; row: WorktreeRow; branchKept: boolean } | { ok: false; reason: RemoveFailure }> {
    if (row.task_id && row.path) await this.#d.stopBackground?.(row.task_id).catch(() => undefined);
    const result = await this.#d.worktrees.removeWorktree(row.id, { ...options, ready: fresh => fresh.state === 'branch' && this.#settled(fresh) });
    if (!result.ok) return result;
    this.#d.kv.delete(heldKey(row.id));
    this.#warned.delete(row.id);
    return { ok: true, row: this.#d.worktrees.get(row.id) ?? row, branchKept: result.branchKept };
  }
}
