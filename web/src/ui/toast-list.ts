import type { FeedbackItem } from '../feedback.ts';

export const TOAST_MAX = 2;
export const TOAST_MS = 5000;
export const TOAST_UNDO_MS = 6000;
export const TOAST_LEAVE_MS = 240;

export interface ToastEntry { id: number; item: FeedbackItem; leaving: boolean }

export const toastDuration = (item: FeedbackItem): number => item.durationMs ?? (item.action ? TOAST_UNDO_MS : TOAST_MS);

export function pushToast(list: readonly ToastEntry[], entry: ToastEntry, max = TOAST_MAX): ToastEntry[] {
  return [...list, entry].slice(-max);
}

export const leaveToast = (list: readonly ToastEntry[], id: number): ToastEntry[] => list.map(e => (e.id === id ? { ...e, leaving: true } : e));

export const dropToast = (list: readonly ToastEntry[], id: number): ToastEntry[] => list.filter(e => e.id !== id);
