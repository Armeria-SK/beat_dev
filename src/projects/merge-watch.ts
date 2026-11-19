import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KV } from '../db/kv.ts';
import type { Task } from '../tasks/store.ts';
import { BEAT_BRANCH, type RemoveResult, type WorktreeRow, type Worktrees } from './worktree.ts';
import { withGit } from '../mesh/folders.ts';

// beat 8-3: 取り込み待ち（done のタスク + 作業コピーの行が branch）の見回りと、持ち主の Mark merged / Discard
export const MERGE_WATCH_MS = 5 * 60_000;
export const BRANCH_COMMITS_MAX = 20;
export const BRANCH_FILES_MAX = 200;
const PRINT_STAT_MAX = 5000;

const FINISHED = new Set(['done', 'failed', 'cancelled']);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export type MergeOutcome = 'merged' | 'kept' | 'discarded';
type RemoveFailure = Extract<RemoveResult, { ok: false }>['reason'];
export type BranchAction = { ok: true; outcome: MergeOutcome; row: WorktreeRow }
  | { ok: false; reason: 'no_branch' | 'busy' | 'moved' | 'changed' | 'unreadable' | RemoveFailure; path?: string | null };

export interface BranchCommit { sha: string; subject: string }
// 作業コピーにしか無いファイル（Discard で一緒に消えるもの）。changed = 追っているファイルの書きかけ、untracked = 追っていない、ignored = git が無視するもの
export interface LocalFile { path: string; kind: 'changed' | 'untracked' | 'ignored' }
export interface LocalFiles { files: LocalFile[]; total: number; ignored: number; print: string }
export interface BranchPreview { tip: string; commits: BranchCommit[]; more: number; path: string | null; files: LocalFile[]; filesTotal: number; print: string }
// 取り込まれたのに作業コピーにファイルが残っていて、beat が消さずに残した印（kv の worktree-held:<id>）。先端とファイルの指紋が同じあいだは見回りでやり直さない
interface HeldMark { tip: string; print: string; files: number }

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

export class MergeWatch {
  readonly #d: MergeWatchDeps;
  readonly #busy = new Set<string>();
  readonly #warned = new Map<string, string>();
  #last = Number.NEGATIVE_INFINITY;
  #sweep: Promise<number> | null = null;

  constructor(deps: MergeWatchDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  // App の 5 分ごとの見回りから呼ぶ。前の見回りから 5 分たっていなければ何もしない。待たずに裏で見る
  due(): void {
    if (this.#sweep || this.#now() - this.#last < MERGE_WATCH_MS) return;
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
        if (done.ok) { changed++; this.#d.onChanged?.(done.row, 'merged', 'beat'); }
      } finally { this.#busy.delete(id); }
    }
    return changed;
  }

  // 取り込まれた行の片づけ。作業コピーに書きかけ・追っていない・無視されるファイルがあれば消さずに残し（held）、同じ形のあいだは見回りでやり直さない
  async #cleanMerged(row: WorktreeRow, watch: boolean): Promise<{ ok: true; row: WorktreeRow } | Extract<BranchAction, { ok: false }>> {
    const tip = await this.#d.worktrees.tipOf(row.id);
    const local = await this.localFiles(row);
    if (!tip || !local) return this.#failed(row, 'unreadable', `${tip}|${local?.print}`);
    const held = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    if (watch && held && held.tip === tip && held.print === local.print) return { ok: false, reason: 'dirty', path: row.path };
    if (local.ignored > 0) return this.#hold(row, tip, local);
    const done = await this.#remove(row, { keepBranch: false, state: 'merged' });
    if (!done.ok) return done.reason === 'dirty' || done.reason === 'locked' ? this.#hold(row, tip, local) : this.#failed(row, done.reason, `${tip}|${local.print}`);
    return { ok: true, row: done.row };
  }

  #hold(row: WorktreeRow, tip: string, local: LocalFiles): Extract<BranchAction, { ok: false }> {
    const held = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    if (!held || held.tip !== tip || held.print !== local.print) {
      this.#d.kv.setJson(heldKey(row.id), { tip, print: local.print, files: local.total } satisfies HeldMark);
      this.#d.log?.(`[WARN] The beat branch ${row.branch} is merged, but its working copy ${row.path} still has ${local.total} file(s) that are not on the branch, so beat left it in place`);
    }
    return { ok: false, reason: 'dirty', path: row.path };
  }

  #failed(row: WorktreeRow, reason: Extract<BranchAction, { ok: false }>['reason'], state: string): Extract<BranchAction, { ok: false }> {
    if (this.#warned.get(row.id) !== `${reason}|${state}`) {
      this.#warned.set(row.id, `${reason}|${state}`);
      this.#d.log?.(`[WARN] Could not clean up the beat branch ${row.branch}: ${reason}`);
    }
    return { ok: false, reason, path: row.path };
  }

  // 取り込まれたのに作業コピーを残した行（画面の「merged — the working copy still has files」）
  held(row: WorktreeRow): { path: string; files: number } | null {
    if (row.state !== 'branch' || !row.path) return null;
    const mark = this.#d.kv.getJson<HeldMark>(heldKey(row.id));
    return mark ? { path: row.path, files: mark.files } : null;
  }

  // 持ち主の Mark merged: 本体の今のブランチに入っていれば見回りと同じ。入っていなければ（squash など）作業コピーだけ片づけてブランチを残す。どちらも作業コピーのファイルは消さない
  async markMerged(id: string): Promise<BranchAction> {
    return this.#owned(id, async row => {
      const merged = (await this.#d.worktrees.isMerged(id, { mark: false })) === true;
      const now = this.#d.worktrees.get(id);
      if (now?.state !== 'branch') return { ok: false, reason: 'no_branch' };
      let done: { ok: true; row: WorktreeRow } | Extract<BranchAction, { ok: false }>;
      if (merged) done = await this.#cleanMerged(now, false);
      else {
        const tip = await this.#d.worktrees.tipOf(id);
        const local = await this.localFiles(now);
        if (!tip || !local) return { ok: false, reason: 'unreadable', path: now.path };
        if (local.ignored > 0) return this.#hold(now, tip, local);
        const removed = await this.#remove(now, { keepBranch: true, state: 'merged' });
        done = removed.ok ? { ok: true, row: removed.row } : removed.reason === 'dirty' || removed.reason === 'locked' ? this.#hold(now, tip, local) : { ...removed, path: now.path };
      }
      if (!done.ok) return done;
      const outcome: MergeOutcome = merged ? 'merged' : 'kept';
      this.#d.onChanged?.(done.row, outcome, 'user');
      return { ok: true, outcome, row: done.row };
    });
  }

  // 持ち主の Discard: 見せた先端（tip）とファイルの指紋（print）のままのときだけ、作業コピーとブランチを捨てる。見せたものは持ち主のコミットやファイルでも消す
  async discard(id: string, tip: string, print: string): Promise<BranchAction> {
    return this.#owned(id, async row => {
      if (await this.#d.worktrees.tipOf(id) !== tip) return { ok: false, reason: 'moved' };
      const local = await this.localFiles(row);
      if (!local) return { ok: false, reason: 'unreadable', path: row.path };
      if (local.print !== print) return { ok: false, reason: 'changed' };
      const done = await this.#remove(row, { keepBranch: false, state: 'discarded', discardLocal: true, confirmedTip: tip });
      if (!done.ok) return { ...done, path: row.path };
      if (done.branchKept) return { ok: false, reason: 'moved' };
      this.#d.onChanged?.(done.row, 'discarded', 'user');
      return { ok: true, outcome: 'discarded', row: done.row };
    });
  }

  // Discard の前に持ち主に見せるもの: ブランチの base..tip のコミット（新しい順、20 件まで）と、作業コピーにしか無いファイル（200 件まで）、それぞれの指紋
  async preview(row: WorktreeRow, repo: string): Promise<BranchPreview | null> {
    if (!BEAT_BRANCH.test(row.branch)) return null;
    const tip = await this.#d.worktrees.tipOf(row.id);
    if (!tip || !OID.test(tip) || !OID.test(row.base)) return null;
    const out = await withGit(repo, this.#d.dataDir, async git => {
      const count = (await git(['rev-list', '--count', `${row.base}..${tip}`]))?.toString('utf8').trim();
      const log = await git(['log', '-z', `--max-count=${BRANCH_COMMITS_MAX}`, '--format=%H%x1f%s', `${row.base}..${tip}`]);
      return count === undefined || log === null ? null : { count: Number(count) || 0, log: log.toString('utf8') };
    });
    const local = await this.localFiles(row);
    if (!out || !local) return null;
    const commits = out.log.split('\0').filter(Boolean).map(line => { const [sha = '', subject = ''] = line.split('\x1f'); return { sha, subject }; });
    return { tip, commits, more: Math.max(0, out.count - commits.length), path: row.path && exists(row.path) ? row.path : null, files: local.files, filesTotal: local.total, print: local.print };
  }

  // 作業コピーにしか無いファイルの一覧と指紋（HEAD・git status〔無視されるものも〕・各ファイルの大きさと変えた時刻）。読めなければ null
  async localFiles(row: WorktreeRow): Promise<LocalFiles | null> {
    const hash = createHash('sha256');
    if (!row.path || !exists(row.path)) return { files: [], total: 0, ignored: 0, print: hash.update('none').digest('hex') };
    const out = await withGit(row.path, this.#d.dataDir, async git => {
      const head = (await git(['symbolic-ref', '-q', 'HEAD']))?.toString('utf8').trim() ?? '-';
      const oid = (await git(['rev-parse', '-q', '--verify', 'HEAD']))?.toString('utf8').trim() ?? '-';
      const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
      return status === null ? null : { head, oid, status: status.toString('utf8') };
    });
    if (!out) return null;
    hash.update(`${out.head}\0${out.oid}\0`);
    const files: LocalFile[] = [];
    let total = 0;
    let ignored = 0;
    const parts = out.status.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const path = entry.slice(3);
      if (code[0] === 'R' || code[0] === 'C') i++;
      const kind: LocalFile['kind'] = code === '!!' ? 'ignored' : code === '??' ? 'untracked' : 'changed';
      if (kind === 'ignored') ignored++;
      hash.update(`${entry}\0`);
      if (total < PRINT_STAT_MAX) {
        try { const stat = lstatSync(join(row.path, path), { throwIfNoEntry: false }); hash.update(`${stat?.size ?? '-'}:${stat?.mtimeMs ?? '-'}\0`); } catch { hash.update('?\0'); }
      }
      if (files.length < BRANCH_FILES_MAX) files.push({ path, kind });
      total++;
    }
    return { files, total, ignored, print: hash.digest('hex') };
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
