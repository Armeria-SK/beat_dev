import type { Task, TaskStatus } from './api.ts';
import type { PlainKey } from './i18n/types.ts';

// タスク画面の、画面を使わない部分（行の補足の 1 行・どの操作を出すか）。文字は辞書のキーで持ち、表示のときに引く。

export const STATUS_KEY: Record<TaskStatus, PlainKey> = {
  inbox: 'task.status.inbox', ready: 'task.status.ready', running: 'task.status.running', waiting: 'task.status.waiting',
  scheduled: 'task.status.scheduled', done: 'task.status.done', failed: 'task.status.failed', cancelled: 'task.status.cancelled',
};
export const ORIGIN_KEY: Record<Task['origin'], PlainKey> = {
  user: 'tasks.origin.user', self: 'tasks.origin.self', schedule: 'tasks.origin.schedule', curiosity: 'tasks.origin.curiosity',
};

const EVENT_KEYS = {
  created: 'tasks.event.created', note: 'tasks.event.note', requeued: 'tasks.event.requeued', question: 'tasks.event.question', approval: 'tasks.event.approval',
  answer: 'tasks.event.answer', run: 'tasks.event.run', done: 'tasks.event.done', failed: 'tasks.event.failed', cancelled: 'tasks.event.cancelled',
  approved: 'tasks.event.approved', reopened: 'tasks.event.reopened', skipped: 'tasks.event.skipped', edited: 'tasks.event.edited', context: 'tasks.event.context',
  uncancelled: 'tasks.event.uncancelled', gate_passed: 'tasks.event.gate_passed', gate_refused: 'tasks.event.gate_refused', gate_closed: 'tasks.event.gate_closed',
  gate_list_changed: 'tasks.event.gate_list_changed', gate_list_notified: 'tasks.event.gate_list_notified', item_check_failed: 'tasks.event.item_check_failed',
  check_failed: 'tasks.event.check_failed', check_passed: 'tasks.event.check_passed', owner_check: 'tasks.event.owner_check', owner_fix: 'tasks.event.owner_fix',
  worktree: 'tasks.event.worktree', prefix: 'tasks.event.prefix',
} as const satisfies Record<string, PlainKey>;
export function eventKey(kind: string, content?: string | null): PlainKey | null {
  if (kind === 'owner_fix' && content) {
    try {
      const value = JSON.parse(content) as { question?: unknown } | null;
      if (value && typeof value === 'object' && value.question !== undefined) return 'tasks.event.owner_fix_answer';
    } catch { return 'tasks.event.owner_fix'; }
  }
  return Object.hasOwn(EVENT_KEYS, kind) ? EVENT_KEYS[kind as keyof typeof EVENT_KEYS] : null;
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
