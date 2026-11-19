import type { DatabaseSync } from 'node:sqlite';
import type { Task } from '../tasks/store.ts';
import { BEAT_BRANCH, type RemoveResult, type WorktreeRow, type Worktrees } from './worktree.ts';
import { withGit } from '../mesh/folders.ts';

// beat 8-3: 取り込み待ち（done のタスク + 作業コピーの行が branch）の見回りと、持ち主の Mark merged / Discard
export const MERGE_WATCH_MS = 5 * 60_000;
export const BRANCH_COMMITS_MAX = 20;

const FINISHED = new Set(['done', 'failed', 'cancelled']);
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export type MergeOutcome = 'merged' | 'kept' | 'discarded' | 'discard_kept';
export type BranchAction = { ok: true; outcome: MergeOutcome; row: WorktreeRow } | { ok: false; reason: 'no_branch' | 'busy' | 'moved' | RemoveFailure };
type RemoveFailure = Extract<RemoveResult, { ok: false }>['reason'];

export interface BranchCommit { sha: string; subject: string }

export interface MergeWatchDeps {
  db: DatabaseSync;
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

export class MergeWatch {
  readonly #d: MergeWatchDeps;
  readonly #busy = new Set<string>();
  #last = Number.NEGATIVE_INFINITY;
  #sweep: Promise<number> | null = null;

  constructor(deps: MergeWatchDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  // ワーカーの見回りから呼ぶ。5 分に 1 回だけ、待たずに裏で見る
  due(): void {
    if (this.#sweep || this.#now() - this.#last < MERGE_WATCH_MS) return;
    this.#last = this.#now();
    void this.check().catch(error => this.#d.log?.(`[WARN] Could not check merged beat branches: ${(error as Error).message}`));
  }

  // 取り込み待ちの行（kind を問わない）を見て、本体の今のブランチに入っていれば片づける。片づけそこねた merged の行もやり直す
  check(projectId?: string): Promise<number> {
    if (this.#sweep) return this.#sweep.then(() => this.check(projectId));
    const run = this.#check(projectId).finally(() => { this.#sweep = null; });
    this.#sweep = run;
    return run;
  }

  async #check(projectId?: string): Promise<number> {
    const rows = this.#d.db.prepare(`SELECT id FROM worktrees WHERE (state = 'branch' OR (state = 'merged' AND path IS NOT NULL))${projectId ? ' AND project_id = ?' : ''} ORDER BY created_at, id`)
      .all(...(projectId ? [projectId] : [])) as Array<{ id: string }>;
    let changed = 0;
    for (const { id } of rows) {
      const row = this.#d.worktrees.get(id);
      if (!row || !this.#settled(row) || this.#busy.has(id)) continue;
      this.#busy.add(id);
      try {
        if (row.state === 'branch' && (await this.#d.worktrees.isMerged(id)) !== true) continue;
        const now = this.#d.worktrees.get(id);
        if (now?.state !== 'merged') continue;
        const done = await this.#remove(now, { keepBranch: false, state: 'merged' });
        if (done.ok) { changed++; this.#d.onChanged?.(done.row, 'merged', 'beat'); }
      } finally { this.#busy.delete(id); }
    }
    return changed;
  }

  // 持ち主の Mark merged: 本体の今のブランチに入っていれば見回りと同じ。入っていなければ（squash など）作業コピーだけ片づけてブランチを残す
  async markMerged(id: string): Promise<BranchAction> {
    return this.#owned(id, async row => {
      const merged = row.state === 'merged' || (await this.#d.worktrees.isMerged(id)) === true;
      const now = this.#d.worktrees.get(id);
      if (!now || (now.state !== 'branch' && now.state !== 'merged')) return { ok: false, reason: 'no_branch' };
      const done = await this.#remove(now, { keepBranch: !merged, state: 'merged' });
      if (!done.ok) return done;
      const outcome: MergeOutcome = merged ? 'merged' : 'kept';
      this.#d.onChanged?.(done.row, outcome, 'user');
      return { ok: true, outcome, row: done.row };
    });
  }

  // 持ち主の Discard: 見せた先端（tip）のままのときだけ、作業コピーとブランチを捨てる。beat の書いていないコミットのあるブランチは残す（worktree.ts の branch_moved）
  async discard(id: string, tip: string): Promise<BranchAction> {
    return this.#owned(id, async row => {
      if (row.state !== 'branch') return { ok: false, reason: 'no_branch' };
      if (await this.#d.worktrees.tipOf(id) !== tip) return { ok: false, reason: 'moved' };
      const done = await this.#remove(row, { keepBranch: false, state: 'discarded', discardLocal: true });
      if (!done.ok) return done;
      const outcome: MergeOutcome = done.branchKept ? 'discard_kept' : 'discarded';
      this.#d.onChanged?.(done.row, outcome, 'user');
      return { ok: true, outcome, row: done.row };
    });
  }

  // Discard の前に持ち主に見せる、ブランチの base..tip のコミット（新しい順、20 件まで）
  async commits(row: WorktreeRow, repo: string): Promise<{ tip: string; commits: BranchCommit[]; more: number } | null> {
    if (!BEAT_BRANCH.test(row.branch)) return null;
    const tip = await this.#d.worktrees.tipOf(row.id);
    if (!tip || !OID.test(tip) || !OID.test(row.base)) return null;
    const out = await withGit(repo, this.#d.dataDir, async git => {
      const count = (await git(['rev-list', '--count', `${row.base}..${tip}`]))?.toString('utf8').trim();
      const log = await git(['log', '-z', `--max-count=${BRANCH_COMMITS_MAX}`, '--format=%H%x1f%s', `${row.base}..${tip}`]);
      return count === undefined || log === null ? null : { count: Number(count) || 0, log: log.toString('utf8') };
    });
    if (!out) return null;
    const commits = out.log.split('\0').filter(Boolean).map(line => { const [sha = '', subject = ''] = line.split('\x1f'); return { sha, subject }; });
    return { tip, commits, more: Math.max(0, out.count - commits.length) };
  }

  // 終わったタスクの行だけを触る（動いている・また動くタスクの作業コピーには触らない）。行にタスクが無いもの（8-6 の直す実行）はそのまま
  #settled(row: WorktreeRow): boolean {
    if (!row.task_id) return true;
    const task = this.#d.db.prepare('SELECT status FROM tasks WHERE id = ?').get(row.task_id) as { status: string } | undefined;
    return task === undefined || FINISHED.has(task.status);
  }

  async #owned(id: string, work: (row: WorktreeRow) => Promise<BranchAction>): Promise<BranchAction> {
    const row = this.#d.worktrees.get(id);
    if (!row || !this.#settled(row) || (row.state !== 'branch' && !(row.state === 'merged' && row.path !== null))) return { ok: false, reason: 'no_branch' };
    if (this.#busy.has(id)) return { ok: false, reason: 'busy' };
    this.#busy.add(id);
    try { return await work(row); } finally { this.#busy.delete(id); }
  }

  async #remove(row: WorktreeRow, options: Parameters<Worktrees['removeWorktree']>[1]): Promise<{ ok: true; row: WorktreeRow; branchKept: boolean } | { ok: false; reason: RemoveFailure }> {
    if (row.task_id && row.path) await this.#d.stopBackground?.(row.task_id).catch(() => undefined);
    const result = await this.#d.worktrees.removeWorktree(row.id, options);
    if (!result.ok) {
      this.#d.log?.(`[WARN] Could not clean up the beat branch ${row.branch}: ${result.reason}`);
      return result;
    }
    return { ok: true, row: this.#d.worktrees.get(row.id) ?? row, branchKept: result.branchKept };
  }
}
