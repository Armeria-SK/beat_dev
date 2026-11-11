import type { IconName } from './icon-name.ts';

export type FeedbackKind = 'info' | 'done' | 'approval' | 'memory';

export interface FeedbackItem {
  kind?: FeedbackKind;
  icon?: IconName;
  title: string;
  body?: string | undefined;
  action?: { label: string; run: () => void };
  durationMs?: number;
}

type Listener = (item: FeedbackItem) => void;

const listeners = new Set<Listener>();

export function toast(item: FeedbackItem): void {
  for (const listener of listeners) listener(item);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
