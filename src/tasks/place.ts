import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config/schema.ts';
import type { RunWorktree } from '../projects/run.ts';
import { folderMissing, type ProjectStore } from '../projects/store.ts';
import type { Worktrees, WorktreeRow } from '../projects/worktree.ts';
import { isScoutRun, type Task, type TaskStore } from './store.ts';

export const OPEN_WORKTREES_MAX = 5;
const CHAIN_MAX = 20;
const LIVE = "('creating', 'active', 'branch')";

export type Placement =
  | { kind: 'main' }
  | { kind: 'worktree'; row: WorktreeRow }
  | { kind: 'wait' }
  | { kind: 'gone'; row: WorktreeRow };

export interface PlaceDeps {
  db: DatabaseSync;
  tasks: Pick<TaskStore, 'get' | 'list'>;
  projects: Pick<ProjectStore, 'get'>;
  worktrees: Pick<Worktrees, 'get' | 'createWorktree' | 'reactivate' | 'place'>;
  config: () => Pick<AppConfig, 'worker'>;
}

const exists = (path: string): boolean => {
  try { return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true && lstatSync(join(path, '.git'), { throwIfNoEntry: false })?.isFile() === true; } catch { return false; }
};

// タスクの置き場（D-13）。作業コピーの行はタスク自身か、生んだタスク（spawned_by をたどる）の行を見る
export class TaskPlaces {
  readonly #d: PlaceDeps;
  constructor(deps: PlaceDeps) { this.#d = deps; }

  // タスク（か生んだタスク）の、片づいていない作業コピーの行。自分の行を先に見る
  rowOf(taskId: string): WorktreeRow | undefined {
    let id: string | null = taskId;
    for (let i = 0; id && i < CHAIN_MAX; i++) {
      const row = this.#d.db.prepare(`SELECT * FROM worktrees WHERE task_id = ? AND kind = 'task' AND state IN ${LIVE} ORDER BY created_at DESC, id DESC LIMIT 1`).get(id) as WorktreeRow | undefined;
      if (row) return row;
      id = this.#d.tasks.get(id)?.spawned_by ?? null;
    }
    return undefined;
  }

  // 実行が使う作業コピー（active の行だけ）
  runPlace(taskId: string): RunWorktree | undefined {
    const row = this.rowOf(taskId);
    if (!row || row.state !== 'active' || !row.path) return undefined;
    return { id: row.id, path: row.path, branch: row.branch, base: row.base, ceiling: dirname(dirname(row.path)) };
  }

  #onMain(task: Task): boolean {
    const row = this.rowOf(task.id);
    if (row) return row.state === 'branch' && row.task_id === task.id;
    return this.#ancestorRow(task) === undefined;
  }

  // 生んだタスク（spawned_by をたどる。自分は含めない）の作業コピーのうち、このタスクができたときに開いていた行。
  // いまは片づいていても、子が本体へ移らない印になる。子ができる前に閉じた行は見ない
  #ancestorRow(task: Task): WorktreeRow | undefined {
    let id: string | null = task.spawned_by;
    for (let i = 0; id && i < CHAIN_MAX; i++) {
      const row = this.#d.db.prepare(`SELECT * FROM worktrees WHERE task_id = ? AND kind = 'task' AND created_at <= ? AND (state IN ${LIVE} OR updated_at >= ?)
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(id, task.created_at, task.created_at) as WorktreeRow | undefined;
      if (row) return row;
      id = this.#d.tasks.get(id)?.spawned_by ?? null;
    }
    return undefined;
  }

  // 作業コピーの置き場（Pending の再実行が、積んだ場所が作業コピーかを見分けるのに使う）
  placeRoot(): string | undefined {
    const place = this.#d.worktrees.place();
    return place.ok ? place.root : undefined;
  }

  // 本体に置いたタスクが、ほかに動いているか
  mainBusy(task: Task): boolean {
    if (!task.project_id) return false;
    return this.#d.tasks.list({ statuses: ['running'], project: task.project_id }).some(other => other.id !== task.id && !isScoutRun(other) && this.#onMain(other));
  }

  #ranBefore(task: Task): boolean {
    return this.#d.db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND kind = 'run' LIMIT 1").get(task.id) !== undefined;
  }

  #hadWorktree(task: Task): boolean {
    return this.#d.db.prepare("SELECT 1 FROM worktrees WHERE task_id = ? AND kind = 'task' LIMIT 1").get(task.id) !== undefined;
  }

  // 本体が埋まっていても、新しい作業コピーで並べられるか（git の製品・Build の家族でない・まだ本体で動いていない・設定・開いた作業コピーの数）
  branchable(task: Task): boolean {
    const c = this.#d.config();
    if (c.worker.worktrees === false || c.worker.maxParallel < 2) return false;
    if (!task.project_id || task.spawned_by !== null || task.acceptance_items !== null) return false;
    if (this.#ranBefore(task) && !this.#hadWorktree(task)) return false;
    const project = this.#d.projects.get(task.project_id);
    if (!project || folderMissing(project)) return false;
    try {
      const dotGit = lstatSync(join(project.root, '.git'), { throwIfNoEntry: false });
      if (!dotGit || dotGit.isSymbolicLink() || !dotGit.isDirectory()) return false;
    } catch { return false; }
    const open = this.#d.db.prepare(`SELECT COUNT(*) AS n FROM worktrees WHERE project_id = ? AND kind = 'task' AND state IN ${LIVE}`).get(task.project_id) as { n: number };
    return open.n < OPEN_WORKTREES_MAX;
  }

  // 選べないか（置き場が埋まっている）
  busy(task: Task): boolean {
    const row = this.rowOf(task.id);
    if (row && row.state !== 'branch') {
      return this.#d.tasks.list({ statuses: ['running'], project: task.project_id }).some(other => other.id !== task.id && this.rowOf(other.id)?.id === row.id);
    }
    return this.mainBusy(task) && !this.branchable(task);
  }

  // 動かす直前（claim のあと）に置き場を決める。作業コピーが要れば作る
  async decide(task: Task): Promise<Placement> {
    const row = this.rowOf(task.id);
    if (row?.state === 'active') return row.path && exists(row.path) ? { kind: 'worktree', row } : { kind: 'gone', row };
    if (row?.state === 'creating') return { kind: 'wait' };
    // 生んだタスクの作業コピーを引き継ぐ子は、その作業コピーが閉じた（branch・片づいた）なら本体へ移らない
    const inherited = row && row.task_id !== task.id ? row : this.#ancestorRow(task);
    if (inherited) return { kind: 'gone', row: inherited };
    if (row?.state === 'branch' && row.task_id === task.id) {
      const back = await this.#d.worktrees.reactivate(row.id);
      if (back.ok) return { kind: 'worktree', row: back.row };
    }
    if (!this.mainBusy(task)) return { kind: 'main' };
    if (!this.branchable(task) || !task.project_id) return { kind: 'wait' };
    const project = this.#d.projects.get(task.project_id);
    if (!project) return { kind: 'wait' };
    const made = await this.#d.worktrees.createWorktree({ projectId: project.id, root: project.root, kind: 'task', taskId: task.id, title: task.title });
    return made.ok ? { kind: 'worktree', row: made.row } : { kind: 'wait' };
  }
}
