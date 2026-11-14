import type { DatabaseSync } from 'node:sqlite';
import type { Language } from '../config/schema.ts';
import type { PendingChange, PendingStore } from '../pending/store.ts';
import type { TaskStore } from './store.ts';

export interface PendingWakeDeps {
  db: DatabaseSync;
  tasks: TaskStore;
  pending: PendingStore;
  now: () => number;
  language: () => Language;
  log: (line: string) => void;
}

export function pendingDecided(_deps: PendingWakeDeps, _change: PendingChange): void {}

export function sweepPendingWaits(_deps: PendingWakeDeps): number { return 0; }
