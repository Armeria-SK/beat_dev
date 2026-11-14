import type { CuriosityItem, Task, TaskStatus } from './api.ts';
import type { PlainKey } from './i18n/types.ts';

// タスク画面の、画面を使わない部分（分け方・並べ方・どの操作を出すか）。文字は辞書のキーで持ち、表示のときに引く。

export type TaskSection = 'attn' | 'act' | 'sch' | 'done';

export const STATUS_KEY: Record<TaskStatus, PlainKey> = {
  inbox: 'task.status.inbox', ready: 'task.status.ready', running: 'task.status.running', waiting: 'task.status.waiting',
  scheduled: 'task.status.scheduled', done: 'task.status.done', failed: 'task.status.failed', cancelled: 'task.status.cancelled',
};
export const ORIGIN_KEY: Record<Task['origin'], PlainKey> = {
  user: 'tasks.origin.user', self: 'tasks.origin.self', schedule: 'tasks.origin.schedule', curiosity: 'tasks.origin.curiosity',
};
export const CURIOSITY_STATUS_KEY: Record<CuriosityItem['status'], PlainKey> = {
  open: 'curiosity.status.open', researching: 'curiosity.status.researching', done: 'curiosity.status.done', dropped: 'curiosity.status.dropped',
};

const PRIORITY_KEYS = { 1: 'tasks.priority.1', 2: 'tasks.priority.2', 3: 'tasks.priority.3' } as const satisfies Record<number, PlainKey>;
export const priorityKey = (priority: number): PlainKey => (priority === 1 ? PRIORITY_KEYS[1] : priority === 3 ? PRIORITY_KEYS[3] : PRIORITY_KEYS[2]);

const EVENT_KEYS = {
  created: 'tasks.event.created', note: 'tasks.event.note', requeued: 'tasks.event.requeued', question: 'tasks.event.question', approval: 'tasks.event.approval',
  answer: 'tasks.event.answer', run: 'tasks.event.run', done: 'tasks.event.done', failed: 'tasks.event.failed', cancelled: 'tasks.event.cancelled',
  approved: 'tasks.event.approved', reopened: 'tasks.event.reopened', skipped: 'tasks.event.skipped', edited: 'tasks.event.edited', context: 'tasks.event.context',
  uncancelled: 'tasks.event.uncancelled',
} as const satisfies Record<string, PlainKey>;
export function eventKey(kind: string): PlainKey | null {
  return Object.hasOwn(EVENT_KEYS, kind) ? EVENT_KEYS[kind as keyof typeof EVENT_KEYS] : null;
}

const isFinished = (status: TaskStatus): boolean => status === 'done' || status === 'failed' || status === 'cancelled';
const needsAttention = (status: TaskStatus): boolean => status === 'waiting' || status === 'inbox';

// 実行待ちで開始の時刻がこれから先のもの（日時指定、再試行までの休み、止めたあとの 20 秒）は「予定」に置く。
export function sectionOf(task: Task, now: number): TaskSection {
  if (needsAttention(task.status)) return 'attn';
  if (isFinished(task.status)) return 'done';
  if (task.status === 'scheduled' || (task.status === 'ready' && task.run_at !== null && task.run_at > now)) return 'sch';
  return 'act';
}

export interface TaskSummary { attention: number; running: number; ready: number; scheduled: number }

export function summarize(tasks: readonly Task[], now: number): TaskSummary {
  const summary: TaskSummary = { attention: 0, running: 0, ready: 0, scheduled: 0 };
  for (const task of tasks) {
    const section = sectionOf(task, now);
    if (section === 'attn') summary.attention += 1;
    else if (section === 'sch') summary.scheduled += 1;
    else if (task.status === 'running') summary.running += 1;
    else if (section === 'act') summary.ready += 1;
  }
  return summary;
}

// 行の補足の 1 行。Markdown や改行は平らにして、長い本文も 1 行に収まる長さで切る。
export function plainLine(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const line = text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/^[\s#>*+-]+/gmu, '')
    .replace(/[*_`~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...line].length > max ? `${[...line].slice(0, max).join('')}…` : line;
}

export type SheetAction = 'approve' | 'runNow' | 'retry' | 'done' | 'cancel';
export interface SheetActionSpec { action: SheetAction; primary: boolean }

// 詳細のシートの操作。デザインの並びに、終わったタスクをもう一度動かす操作（今の画面にあった）を足してある。
export function sheetActions(status: TaskStatus): SheetActionSpec[] {
  const spec = (action: SheetAction, primary = false): SheetActionSpec => ({ action, primary });
  switch (status) {
    case 'inbox': return [spec('approve', true), spec('cancel')];
    case 'ready': return [spec('runNow', true), spec('done'), spec('cancel')];
    case 'scheduled': return [spec('runNow', true), spec('cancel')];
    case 'running': return [spec('done'), spec('cancel')];
    case 'waiting': return [spec('done'), spec('cancel')];
    case 'failed':
    case 'done':
    case 'cancelled': return [spec('retry', status === 'failed')];
  }
}
