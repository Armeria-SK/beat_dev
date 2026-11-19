import type { MemoryFileEvent, MemoryNote } from '../api.ts';

// 製品の記憶のファイル（memory/<name>.md）を Memory の画面で描くための、画面を持たない関数（beat 10-4a）

export const NOTE_TITLE_MAX = 80;
export const NOTE_CONTENT_MAX = 4000;

// サーバーの決まり（src/memory/files.ts）と同じ: 1 行目が「# 題」なら題と本文に分ける。無ければ題は名前、本文は全部
export function splitNote(text: string, name: string): { title: string; body: string } {
  const [first = '', ...rest] = text.split(/\r?\n/u);
  if (!/^#\s+\S/u.test(first)) return { title: name, body: text.trim() };
  return { title: first.replace(/^#\s+/u, '').trim(), body: rest.join('\n').trim() };
}

export const notePath = (name: string): string => `memory/${name}.md`;

// 一覧の 1 行: 持ち主が最後に触った（または beat の外で書かれた）ものは edited by you、beat が書いたものは saved by beat
export function noteStamp(note: Pick<MemoryNote, 'updatedBy' | 'mtime'>): { who: 'you' | 'beat'; edited: boolean; at: number } {
  const you = note.updatedBy === 'owner' || note.updatedBy === null;
  return { who: you ? 'you' : 'beat', edited: you, at: note.mtime };
}

export const eventWho = (event: Pick<MemoryFileEvent, 'actor'>): 'you' | 'beat' => (event.actor === 'owner' ? 'you' : 'beat');

// 行の増減（順は見ない。同じ行が何回あるかで数える）
export function lineDelta(before: string | null, after: string | null): { added: number; removed: number } {
  const count = (text: string | null) => {
    const out = new Map<string, number>();
    for (const line of (text ?? '').split(/\r?\n/u)) if (line.trim()) out.set(line, (out.get(line) ?? 0) + 1);
    return out;
  };
  const a = count(before);
  const b = count(after);
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

const CONTENT = new Set<MemoryFileEvent['action']>(['create', 'update', 'restore', 'outside']);

export type UndoTarget = { kind: 'delete' } | { kind: 'restore'; eventId: number };
export interface NoteVersion { event: MemoryFileEvent; action: 'undo' | 'restore' | null; undo?: UndoTarget | undefined }

// いちばん新しい版を 1 つ前に戻す先。作った版なら消す、ほかは前の版（after が今の版の before と同じ行）に戻す
export function undoTargetOf(events: readonly MemoryFileEvent[], index: number): UndoTarget | undefined {
  const event = events[index];
  if (!event || !CONTENT.has(event.action)) return undefined;
  if (event.before === null) return { kind: 'delete' };
  const older = events.slice(index + 1).find(e => e.after === event.before);
  return older ? { kind: 'restore', eventId: older.id } : undefined;
}

// 新しい順の履歴（GET …/history のまま）。中身を変えた版のうち、いちばん新しいものに Undo、今と違う中身の古い版に Restore
export function noteVersions(events: readonly MemoryFileEvent[], current: string): NoteVersion[] {
  const newest = events.findIndex(e => CONTENT.has(e.action));
  return events.map((event, index) => {
    if (!CONTENT.has(event.action) || event.after === null) return { event, action: null };
    if (index === newest && event.after === current) {
      const undo = undoTargetOf(events, index);
      return undo ? { event, action: 'undo', undo } : { event, action: null };
    }
    return { event, action: event.after === current ? null : 'restore' };
  });
}
