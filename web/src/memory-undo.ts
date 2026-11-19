import { useSyncExternalStore } from 'react';
import { api } from './api.ts';
import { undoTargetOf } from './ui/memory-notes.ts';

const undone = new Set<number>();
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export async function undoMemoryEvent(eventId: number): Promise<boolean> {
  if (undone.has(eventId)) return true;
  try {
    await api.undoMemory(eventId);
  } catch {
    return false;
  }
  undone.add(eventId);
  emit();
  return true;
}

export function useMemoryUndone(eventId: number): boolean {
  return useSyncExternalStore(subscribe, () => undone.has(eventId));
}

// 製品の記憶のファイル（beat 10-4a）の会話の Notice の Undo。その版のあとに誰かが変えていたら（履歴の行の無い外の書き換えも）戻さない（false）
const undoneNotes = new Set<string>();

export async function undoMemoryNoteEvent(projectId: string, name: string, eventId: number): Promise<boolean> {
  const key = `${projectId}:${eventId}`;
  if (undoneNotes.has(key)) return true;
  try {
    const { events } = await api.memoryNoteHistory(projectId, name);
    if (events[0]?.id !== eventId) return false;
    if (events[0].action === 'forget') await api.restoreMemoryNote(projectId, name, eventId, null);
    else {
      const target = undoTargetOf(events, 0);
      if (!target) return false;
      const { note, text } = await api.memoryNote(projectId, name);
      if (text !== events[0].after) return false;
      if (target.kind === 'delete') await api.forgetMemoryNote(projectId, name, note.hash);
      else await api.restoreMemoryNote(projectId, name, target.eventId, note.hash);
    }
  } catch {
    return false;
  }
  undoneNotes.add(key);
  emit();
  return true;
}

export function useMemoryNoteUndone(projectId: string, eventId: number): boolean {
  return useSyncExternalStore(subscribe, () => undoneNotes.has(`${projectId}:${eventId}`));
}
