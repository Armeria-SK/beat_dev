import type { App } from '../app.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { taskView, type RepeatingTask, type Task, type TaskEvent, type TaskView } from '../tasks/store.ts';

function masked(app: App, text: string | null): string | null {
  return text === null ? null : redactSecrets(text, app.registry.secrets());
}

export function maskedTaskView(app: App, task: Task): TaskView & { reject_reason?: string | null } {
  const view = taskView(task, languageOf(app.config()));
  const out = { ...view, result_summary: masked(app, view.result_summary) };
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
