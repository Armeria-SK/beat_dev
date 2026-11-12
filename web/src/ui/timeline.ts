import type { ScheduleSlot } from '../api.ts';

export type Range = 'day' | 'week';
export type SlotState = ScheduleSlot['state'];

const HOUR_MS = 3_600_000;
export const MERGE_GAP = 0.25;
export const WEEK_BACK = 3;

export interface TimeWindow { from: number; to: number; days: number[] }

export function windowOf(range: Range, now: number, dayStart: (ms: number) => number): TimeWindow {
  const next = (day: number): number => dayStart(day + 26 * HOUR_MS);
  const today = dayStart(now);
  if (range === 'day') return { from: today, to: next(today), days: [today, next(today)] };
  let first = today;
  for (let i = 0; i < WEEK_BACK; i++) first = dayStart(first - 2 * HOUR_MS);
  const days = [first];
  for (let i = 0; i < 7; i++) days.push(next(days[i]!));
  return { from: first, to: days[7]!, days };
}

export const nowAt = (now: number, w: Pick<TimeWindow, 'from' | 'to'>): number => Math.min(1, Math.max(0, (now - w.from) / (w.to - w.from)));

export interface Bar { at: number; len: number; state: SlotState; count: number; title: string; start: number; end: number; band: boolean }

const round = (n: number): number => Math.round(n * 1000) / 1000;

function bar(start: number, end: number, state: SlotState, title: string, w: Pick<TimeWindow, 'from' | 'to'>, count = 1, band = false): Bar | null {
  const from = Math.max(start, w.from);
  const to = Math.min(Math.max(end, start), w.to);
  if (to < w.from || from >= w.to) return null;
  const span = w.to - w.from;
  return { at: round(((from - w.from) / span) * 100), len: round(((to - from) / span) * 100), state, count, title, start: from, end: to, band };
}

export function dayBars(slots: readonly ScheduleSlot[], w: Pick<TimeWindow, 'from' | 'to'>): Bar[] {
  const bars: Bar[] = [];
  for (const slot of [...slots].sort((a, b) => a.start - b.start)) {
    const next = bar(slot.start, slot.start + slot.length, slot.state, slot.title, w);
    if (!next) continue;
    const last = bars.at(-1);
    if (last && last.state === next.state && next.at - (last.at + last.len) <= MERGE_GAP) {
      const end = Math.max(last.end, next.end);
      bars[bars.length - 1] = { ...last, len: round(Math.max(last.len, next.at + next.len - last.at)), end, count: last.count + 1 };
    } else bars.push(next);
  }
  return bars;
}

export function weekBars(slots: readonly ScheduleSlot[], w: TimeWindow): Bar[] {
  const bars: Bar[] = [];
  const span = w.to - w.from;
  for (let i = 0; i + 1 < w.days.length; i++) {
    const from = w.days[i]!;
    const to = w.days[i + 1]!;
    let ran = 0; let planned = 0; let ranCount = 0; let plannedCount = 0; let live = false; let ranTitle = ''; let plannedTitle = '';
    for (const slot of slots) {
      const end = slot.start + Math.max(slot.length, 1);
      if (slot.start >= to || end <= from) continue;
      const length = Math.min(end, to) - Math.max(slot.start, from);
      if (slot.state === 'planned') { planned += length; plannedCount += 1; plannedTitle ||= slot.title; } else { ran += length; ranCount += 1; ranTitle ||= slot.title; live ||= slot.state === 'live'; }
    }
    const room = to - from;
    const ranLength = Math.min(ran, room);
    if (ranCount > 0) bars.push({ at: round(((from - w.from) / span) * 100), len: round((ranLength / span) * 100), state: live ? 'live' : 'past', count: ranCount, title: ranTitle, start: from, end: from + ranLength, band: false });
    if (plannedCount > 0) {
      const offset = ranCount > 0 ? Math.min(room * 0.9, Math.max(ranLength, room * 0.08)) : 0;
      const length = Math.min(planned, room - offset);
      bars.push({ at: round(((from + offset - w.from) / span) * 100), len: round((length / span) * 100), state: 'planned', count: plannedCount, title: plannedTitle, start: from + offset, end: from + offset + length, band: false });
    }
  }
  return bars;
}

export interface Stream { id: string; title: string; paused: boolean; ended?: boolean; rule: string | null; truncated: boolean }
export interface TimelineRow { id: string; title: string; paused: boolean; ended?: boolean; rule: string | null; bars: Bar[] }

export interface RowsInput {
  slots: readonly ScheduleSlot[];
  streams: readonly Stream[];
  tasksTitle: string;
  range: Range;
  window: TimeWindow;
  now: number;
}

export function buildRows({ slots, streams, tasksTitle, range, window: w, now }: RowsInput): TimelineRow[] {
  const own = new Set(streams.map(stream => stream.id));
  const draw = (list: readonly ScheduleSlot[]): Bar[] => (range === 'day' ? dayBars(list, w) : weekBars(list, w));
  const rows: TimelineRow[] = [{ id: '', title: tasksTitle, paused: false, rule: null, bars: draw(slots.filter(slot => !own.has(slot.taskId))) }];
  for (const stream of streams) {
    const mine = slots.filter(slot => slot.taskId === stream.id);
    const ran = mine.filter(slot => slot.state !== 'planned');
    const planned = stream.paused ? [] : mine.filter(slot => slot.state === 'planned');
    if (stream.truncated && planned.length > 0) {
      const start = Math.max(w.from, Math.min(now, planned.reduce((min, slot) => Math.min(min, slot.start), Number.POSITIVE_INFINITY)));
      const band = bar(start, w.to, 'planned', stream.title, w, planned.length, true);
      rows.push({ id: stream.id, title: stream.title, paused: false, rule: stream.rule, bars: [...draw(ran), ...(band ? [band] : [])] });
    } else {
      rows.push({ id: stream.id, title: stream.title, paused: stream.paused, ...(stream.paused && stream.ended ? { ended: true } : {}), rule: null, bars: draw([...ran, ...planned]) });
    }
  }
  return rows;
}

export const dayHours = (): string[] => [0, 3, 6, 9, 12, 15, 18, 21].map(hour => String(hour).padStart(2, '0'));

export function scrollToNow(now: number, bodyWidth: number, gutter: number, viewWidth: number): number {
  return Math.max(0, Math.round((bodyWidth - gutter) * now - (viewWidth - gutter) / 2));
}
