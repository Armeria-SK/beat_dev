import { useSyncExternalStore } from 'react';
import { api, ApiError, type RefusedChange } from './api.ts';

export type RedoState =
  | { state: 'idle' }
  | { state: 'working' }
  | { state: 'done'; redone: number; refused: RefusedChange[] }
  | { state: 'failed'; message: string };

const IDLE: RedoState = { state: 'idle' };
const redos = new Map<string, RedoState>();
const revisions = new Map<string, number>();
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function changesTouched(projectId: string): void {
  revisions.set(projectId, (revisions.get(projectId) ?? 0) + 1);
  emit();
}

export function useChangesRevision(projectId: string): number {
  return useSyncExternalStore(subscribe, () => revisions.get(projectId) ?? 0);
}

export function useRedo(batch: string): RedoState {
  return useSyncExternalStore(subscribe, () => redos.get(batch) ?? IDLE);
}

export async function redoChanges(projectId: string, batch: string): Promise<void> {
  const now = redos.get(batch);
  if (now?.state === 'working' || now?.state === 'done') return;
  redos.set(batch, { state: 'working' });
  emit();
  try {
    const done = await api.redoChanges(projectId, batch);
    redos.set(batch, { state: 'done', redone: done.redone.length, refused: done.refused });
  } catch (error) {
    if (error instanceof ApiError && error.body?.code === 'project.changes_redo_done') redos.set(batch, { state: 'done', redone: 0, refused: [] });
    else redos.set(batch, { state: 'failed', message: error instanceof Error ? error.message : String(error) });
  }
  changesTouched(projectId);
}
