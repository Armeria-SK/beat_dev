import { api, ApiError, type Task } from '../api.ts';
import { toast, type FeedbackItem } from '../feedback.ts';
import { t } from '../i18n/index.ts';
import type { SheetAction } from '../task-meta.ts';

export type TaskOp = SheetAction | 'reject' | 'restore' | 'stop';

export interface TaskOpOptions { reason?: string; runId?: string | undefined; busyWithOther?: boolean }

export interface TaskOpDeps {
  api: Pick<typeof api, 'taskAction' | 'unapproveTask' | 'cancelTask' | 'answerTask' | 'stop'>;
  toast: (item: FeedbackItem) => void;
}

const REAL: TaskOpDeps = { api, toast };

const reasonOf = (error: unknown): string | undefined => (error instanceof ApiError ? error.message : undefined);

export function reportOpError(error: unknown, deps: Pick<TaskOpDeps, 'toast'> = REAL, title = t('ui.task.toast.failed')): void {
  deps.toast({ icon: 'alert', title, body: reasonOf(error) });
}

function undo(run: () => Promise<unknown>, deps: TaskOpDeps): { label: string; run: () => void } {
  return { label: t('ui.toast.undo'), run: () => { void run().catch(error => reportOpError(error, deps, t('ui.task.toast.undoFailed'))); } };
}

export async function runTaskOp(op: TaskOp, task: Pick<Task, 'id' | 'title'>, options: TaskOpOptions = {}, deps: TaskOpDeps = REAL): Promise<boolean> {
  const uncancel = undo(() => deps.api.taskAction(task.id, 'uncancel'), deps);
  try {
    switch (op) {
      case 'approve':
        await deps.api.taskAction(task.id, 'approve');
        deps.toast({ kind: 'done', icon: 'check', title: t('ui.task.toast.approved'), body: task.title, action: undo(() => deps.api.unapproveTask(task.id), deps) });
        return true;
      case 'reject': {
        const reason = options.reason?.trim() ?? '';
        await deps.api.cancelTask(task.id, reason);
        deps.toast({ icon: 'x', title: t('ui.task.toast.rejected'), body: reason ? t('ui.task.toast.reason', reason) : task.title, action: uncancel });
        return true;
      }
      case 'cancel':
        await deps.api.cancelTask(task.id);
        deps.toast({ icon: 'x', title: t('ui.task.toast.cancelled'), body: task.title, action: uncancel });
        return true;
      case 'runNow': case 'retry':
        await deps.api.taskAction(task.id, 'run-now');
        deps.toast({ icon: 'check', title: t(options.busyWithOther ? 'ui.task.toast.runNext' : 'ui.task.toast.started'), body: task.title });
        return true;
      case 'done':
        await deps.api.taskAction(task.id, 'done');
        deps.toast({ kind: 'done', icon: 'check', title: t('ui.task.toast.done'), body: task.title });
        return true;
      case 'restore':
        await deps.api.taskAction(task.id, 'uncancel');
        deps.toast({ kind: 'done', icon: 'undo', title: t('ui.task.toast.restored'), body: task.title });
        return true;
      case 'stop':
        if (!options.runId) return false;
        await deps.api.stop(options.runId);
        deps.toast({ icon: 'square', title: t('ui.task.toast.stopped'), body: t('ui.task.toast.stoppedBody') });
        return true;
    }
  } catch (error) {
    if ((op === 'cancel' || op === 'reject' || op === 'done') && alreadyFinished(error)) {
      deps.toast({ icon: 'alert', title: t('ui.task.toast.alreadyFinished'), body: task.title });
      return true;
    }
    reportOpError(error, deps);
    return false;
  }
}

export const alreadyFinished = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 409 && (error.body as { code?: unknown } | null)?.code === 'http.already_finished';

export async function answerTaskOp(task: Pick<Task, 'id' | 'title'>, text: string, deps: TaskOpDeps = REAL): Promise<boolean> {
  try {
    await deps.api.answerTask(task.id, text);
    deps.toast({ kind: 'done', icon: 'check', title: t('ui.task.toast.answered'), body: task.title });
    return true;
  } catch (error) {
    reportOpError(error, deps);
    return false;
  }
}

export interface OpButton { op: TaskOp; primary: boolean }

export function taskButtons(status: Task['status'], actions: ReadonlyArray<{ action: SheetAction; primary: boolean }>, runningHere: boolean): OpButton[] {
  const buttons: OpButton[] = actions.map(({ action, primary }) => ({ op: status === 'inbox' && action === 'cancel' ? 'reject' : action, primary }));
  if (status === 'running' && runningHere) buttons.unshift({ op: 'stop', primary: false });
  if (status === 'cancelled') buttons.unshift({ op: 'restore', primary: true });
  return buttons;
}
