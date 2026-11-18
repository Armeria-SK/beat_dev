import type { App } from '../app.ts';
import { languageOf } from '../shared/language.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { taskView, type RepeatingTask, type Task, type TaskEvent, type TaskView } from '../tasks/store.ts';

function masked(app: App, text: string | null): string | null {
  return text === null ? null : redactSecrets(text, app.registry.secrets());
}

export function maskedTaskView(app: App, task: Task): TaskView {
  const view = taskView(task, languageOf(app.config()));
  return { ...view, result_summary: masked(app, view.result_summary) };
}

export function maskedEvents(app: App, events: readonly TaskEvent[]): TaskEvent[] {
  return events.map(event => ({ ...event, content: masked(app, event.content) }));
}

export function maskedLastRun(app: App, run: RepeatingTask['last_run']): RepeatingTask['last_run'] {
  return run ? { ...run, summary: masked(app, run.summary) } : null;
}
