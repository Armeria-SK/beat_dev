import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../config/schema.ts';
import type { PendingChange, PendingStore } from '../pending/store.ts';
import { taskText } from '../shared/messages/tasks.ts';
import type { Task, TaskStore } from './store.ts';

export interface PendingWakeDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  pending: PendingStore;
  now: () => number;
  language: () => Language;
  log: (line: string) => void;
}

const OPEN = "status IN ('waiting', 'running')";

export function openPendingIds(db: DatabaseSync, taskId: string): number[] {
  return (db.prepare(`SELECT id FROM pending_actions WHERE task_id = ? AND ${OPEN} ORDER BY id`).all(taskId) as Array<{ id: number }>).map(row => Number(row.id));
}

export function waitingOnPending(task: Pick<Task, 'status' | 'waiting_kind'>): boolean {
  return task.status === 'waiting' && task.waiting_kind === 'approval';
}

export function pendingDecided(deps: PendingWakeDeps, change: PendingChange): void {
  if (change.status === 'waiting' || change.status === 'running' || !change.taskId) return;
  const task = deps.tasks.get(change.taskId);
  if (!task) return;
  const now = deps.now();
  const reason = taskText(deps.language(), 'reason.pending_decided', { id: change.id });
  if (waitingOnPending(task)) {
    deps.tasks.setReady(task.id, { runAt: now, reason });
    return;
  }
  if (task.status === 'ready' && task.run_at !== null && task.run_at > now) deps.tasks.setReady(task.id, { runAt: now, reason });
}

export function sweepPendingWaits(deps: PendingWakeDeps): number {
  const stuck = deps.db.prepare(`SELECT id FROM tasks t WHERE status = 'waiting' AND waiting_kind = 'approval'
    AND NOT EXISTS (SELECT 1 FROM pending_actions p WHERE p.task_id = t.id AND p.${OPEN})`).all() as Array<{ id: string }>;
  const reason = taskText(deps.language(), 'reason.pending_closed');
  for (const { id } of stuck) deps.tasks.setReady(id, { runAt: deps.now(), reason });
  if (stuck.length) deps.log(`[INFO] Put ${stuck.length} task(s) that were waiting on Pending items that are already closed back in the queue`);
  return stuck.length;
}
