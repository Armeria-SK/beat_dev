import type { NewTask, RepeatingTask, Task, TaskLastRun, TaskStatus } from '../api.ts';
import { parseZonedInput } from '../i18n/index.ts';
import { emptyDraft, FREQS, type Freq, type TaskDraft } from '../task-form.ts';
import { WEEKDAYS } from '../weekdays.ts';

export type RepeatState = 'active' | 'paused' | 'ended';
export type DeleteBlock = 'run_open' | 'ran' | 'linked';

export interface RepeatingRow { task: RepeatingTask; state: RepeatState; next: number | null; last: TaskLastRun | null; runOpen: boolean; blocked: DeleteBlock | null }
export interface TimedRow { task: Task; at: number; blocked: DeleteBlock | null }

const OPEN: ReadonlySet<TaskStatus> = new Set(['ready', 'running', 'waiting']);
const STATE_ORDER: Record<RepeatState, number> = { active: 0, paused: 1, ended: 2 };

export function repeatingRow(task: RepeatingTask): RepeatingRow {
  const state: RepeatState = task.status === 'scheduled' ? 'active' : task.status === 'cancelled' ? 'paused' : 'ended';
  const runOpen = task.last_run !== null && OPEN.has(task.last_run.status);
  return {
    task, state, next: state === 'active' ? task.run_at : null, last: task.last_run, runOpen,
    blocked: runOpen ? 'run_open' : task.conversation_id !== null ? 'linked' : null,
  };
}

export const isTimed = (task: Pick<Task, 'status' | 'cron' | 'parent_id' | 'run_at'>): boolean =>
  task.status === 'ready' && task.cron === null && task.parent_id === null && task.run_at !== null;

export function splitSchedule(input: { repeating: readonly RepeatingTask[]; active: readonly Task[] }): { repeating: RepeatingRow[]; timed: TimedRow[] } {
  const repeating = input.repeating.map(repeatingRow)
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.next ?? 0) - (b.next ?? 0) || a.task.created_at - b.task.created_at);
  const timed = input.active.filter(isTimed)
    .map(task => ({ task, at: task.run_at!, blocked: task.conversation_id !== null ? 'ran' as const : null }))
    .sort((a, b) => a.at - b.at || a.task.created_at - b.task.created_at);
  return { repeating, timed };
}

export const runNowKind = (state: RepeatState): 'run' | 'restart' | null => (state === 'active' ? 'run' : state === 'ended' ? 'restart' : null);

export const confirmStale = (confirming: string | null, rows: ReadonlyArray<{ task: Pick<Task, 'id'>; blocked: DeleteBlock | null }>): boolean =>
  confirming !== null && rows.some(row => row.task.id === confirming && row.blocked !== null);

export const RELOAD_DELAY_MS = 150;
export const RELOAD_FLOOR_MS = 2000;

export const reloadWait = (lastAt: number, now: number): number => Math.max(RELOAD_DELAY_MS, lastAt + RELOAD_FLOOR_MS - now);

export const otherZone = (taskZone: string | null | undefined, current: string): string | null => (taskZone && taskZone !== current ? taskZone : null);

const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const two = (text: string): string => text.padStart(2, '0');
const num = (text: string, max: number): boolean => /^\d{1,2}$/u.test(text) && Number(text) <= max;

export function repeatFromCron(cron: string | null): Pick<TaskDraft, 'freq' | 'time' | 'day' | 'minute' | 'interval'> | null {
  const parts = (cron ?? '').trim().split(/\s+/u);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const base = emptyDraft();
  const rest = { time: base.time, day: base.day, minute: base.minute, interval: base.interval };
  if (dom !== '*' || mon !== '*') return null;
  const every = /^\*\/(\d{1,2})$/u.exec(m);
  if (every) return h === '*' && dow === '*' && Number(every[1]) >= 1 && Number(every[1]) <= 59 ? { ...rest, freq: 'interval', interval: String(Number(every[1])) } : null;
  if (!num(m, 59)) return null;
  if (h === '*') return dow === '*' ? { ...rest, freq: 'hourly', minute: String(Number(m)) } : null;
  if (!num(h, 23)) return null;
  const time = `${two(h)}:${two(m)}`;
  if (dow === '*') return { ...rest, freq: 'daily', time };
  if (dow.toUpperCase() === 'MON-FRI') return { ...rest, freq: 'weekday', time };
  const day = DOW.indexOf(dow.toUpperCase());
  return day >= 0 ? { ...rest, freq: 'weekly', time, day: WEEKDAYS[day]!.value } : null;
}

export function draftFromTask(task: Pick<Task, 'title' | 'body' | 'priority' | 'cron'>): { draft: TaskDraft; ruleKnown: boolean } {
  const rule = repeatFromCron(task.cron);
  const priority = ([1, 2, 3] as const).find(p => p === task.priority) ?? 2;
  return { draft: { ...emptyDraft(), title: task.title, body: task.body, priority, when: 'repeat', ...(rule ?? {}) }, ruleKnown: rule !== null };
}

const FIELDS_OF: Record<Freq, ReadonlyArray<'time' | 'day' | 'minute' | 'interval'>> = {
  daily: ['time'], weekday: ['time'], weekly: ['time', 'day'], hourly: ['minute'], interval: ['interval'],
};

export const sameRule = (a: TaskDraft, b: TaskDraft): boolean =>
  a.freq === b.freq && FIELDS_OF[a.freq].every(field => (field === 'day' ? a.day === b.day : field === 'time' ? a.time.trim() === b.time.trim() : Number(a[field]) === Number(b[field])));

export function timePatch(initial: string, input: string, zone?: string): { when: string } | null | 'invalid' {
  const ms = parseZonedInput(input, zone);
  if (ms === null) return 'invalid';
  return input.trim() === initial ? null : { when: new Date(ms).toISOString() };
}

export interface RepeatPatch { title?: string; body?: string; priority?: number; repeat?: NonNullable<NewTask['repeat']> }

export function repeatPatch(original: TaskDraft, draft: TaskDraft, rule: { known: boolean; open: boolean }): RepeatPatch {
  const patch: RepeatPatch = {};
  const changeRule = rule.open && !(rule.known && sameRule(original, draft));
  if (draft.title.trim() !== original.title.trim()) patch.title = draft.title.trim();
  if (draft.body !== original.body) patch.body = draft.body;
  if (draft.priority !== original.priority) patch.priority = draft.priority;
  if (changeRule && FREQS.includes(draft.freq)) patch.repeat = { freq: draft.freq, values: { time: draft.time, day: draft.day, minute: draft.minute, interval: draft.interval } };
  return patch;
}
