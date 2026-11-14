import type { NotificationItem } from '../api.ts';
import type { FeedbackItem } from '../feedback.ts';
import { FAILED_KINDS, notificationGo, WAITING_KINDS } from './notifications.ts';

export interface ToastLimits { max: number; ms: number; undoMs: number; tag: string }
export const TOAST_A: ToastLimits = { max: 2, ms: 5000, undoMs: 6000, tag: 'a' };
export const TOAST_B: ToastLimits = { max: 3, ms: 3600, undoMs: 6000, tag: 'toast-b-three-3600' };
export const TOAST_LEAVE_MS = 240;

export interface ToastEntry { id: number; item: FeedbackItem; leaving: boolean }

export const toastDuration = (item: FeedbackItem, limits: ToastLimits = TOAST_A): number => item.durationMs ?? (item.action ? limits.undoMs : limits.ms);

export function pushToast(list: readonly ToastEntry[], entry: ToastEntry, max = TOAST_A.max): ToastEntry[] {
  return [...list, entry].slice(-max);
}

export const leaveToast = (list: readonly ToastEntry[], id: number): ToastEntry[] => list.map(e => (e.id === id ? { ...e, leaving: true } : e));

export const dropToast = (list: readonly ToastEntry[], id: number): ToastEntry[] => list.filter(e => e.id !== id);

export interface ToastClock { remaining: number; startedAt: number | null }

export const startClock = (ms: number, now: number): ToastClock => ({ remaining: ms, startedAt: now });

export const pauseClock = (clock: ToastClock, now: number): ToastClock =>
  (clock.startedAt === null ? clock : { remaining: Math.max(0, clock.remaining - (now - clock.startedAt)), startedAt: null });

export const resumeClock = (clock: ToastClock, now: number): ToastClock => (clock.startedAt === null ? { ...clock, startedAt: now } : clock);

export interface ToastHold { hover: boolean; focus: boolean }
export const NO_HOLD: ToastHold = { hover: false, focus: false };
export const isHeld = (hold: ToastHold): boolean => hold.hover || hold.focus;

export function holdChange(hold: ToastHold, part: keyof ToastHold, on: boolean): { hold: ToastHold; flip: boolean | null } {
  const next = { ...hold, [part]: on };
  return { hold: next, flip: isHeld(next) === isHeld(hold) ? null : isHeld(next) };
}

export function notificationToast(n: Pick<NotificationItem, 'kind' | 'title' | 'body' | 'link' | 'project_id' | 'action'>): FeedbackItem {
  const go = notificationGo(n);
  const body = n.body?.split('\n').find(line => line.trim())?.trim();
  return {
    title: n.title,
    ...(body ? { body } : {}),
    ...(WAITING_KINDS.has(n.kind) ? { lead: 'dot' as const } : { icon: FAILED_KINDS.has(n.kind) ? 'alert' as const : 'check' as const }),
    ...(go ? { href: go.hash } : {}),
  };
}
