import type { App } from '../app.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { taskView, type RepeatingTask, type Task, type TaskEvent, type TaskView } from '../tasks/store.ts';

function masked(app: App, text: string | null): string | null {
  return text === null ? null : redactSecrets(text, app.registry.secrets());
}

export interface TaskWorktree { id: string; branch: string; base: string; state: string; files: number | null; added: number | null; removed: number | null; note: string | null }

// beat 8-2: タスクの作業コピー（8-3 の画面が使う）。変わった量は数え終わるまで null
function worktreeOf(app: App, task: Task): TaskWorktree | null {
  const row = app.worktrees?.forTask(task.id);
  if (!row) return null;
  const stats = app.worktrees.statsOf(row);
  return { id: row.id, branch: row.branch, base: row.base, state: row.state, files: stats?.files ?? null, added: stats?.added ?? null, removed: stats?.removed ?? null, note: row.note };
}

export function maskedTaskView(app: App, task: Task): TaskView & { reject_reason?: string | null; worktree: TaskWorktree | null } {
  const view = taskView(task, languageOf(app.config()));
  const out = { ...view, result_summary: masked(app, view.result_summary), worktree: worktreeOf(app, task) };
  if (task.status !== 'cancelled' || task.cancelled_from !== 'inbox') return out;
  const reason = app.db.prepare(`SELECT content FROM task_events WHERE task_id = ?1 AND kind = 'reason'
    AND id > COALESCE((SELECT MAX(id) FROM task_events WHERE task_id = ?1 AND kind = 'uncancelled'), 0) ORDER BY id DESC LIMIT 1`).get(task.id) as { content: string | null } | undefined;
  return { ...out, reject_reason: masked(app, reason?.content ?? null) };
}

export function maskedEvents(app: App, events: readonly TaskEvent[]): TaskEvent[] {
  return events.map(event => ({ ...event, content: masked(app, event.content) }));
}

export function maskedLastRun(app: App, run: RepeatingTask['last_run']): RepeatingTask['last_run'] {
  return run ? { ...run, summary: masked(app, run.summary) } : null;
}
