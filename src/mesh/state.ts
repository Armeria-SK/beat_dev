import { CONTROL, stripHidden } from '../shared/plain-text.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { MeshError } from './files.ts';

export const STATE_FILE = 'STATE.md';
export const NOTE_FIELDS = ['goal', 'now', 'next', 'blocked'] as const;
export type NoteField = (typeof NOTE_FIELDS)[number];
export const NOTE_LIMITS: Record<NoteField, number> = { goal: 200, now: 120, next: 120, blocked: 120 };
export type NoteAuthor = 'conversation' | 'task' | 'child' | 'owner';
export interface StateNote { field: NoteField; text: string; by: NoteAuthor; external: boolean }
export type StatePatch = Partial<Record<NoteField, string>>;

const NOTE = /^- (goal|now|next|blocked): (.*?)(?: \[by (conversation|task|child)(, src: external)?\])?$/u;

export function parseNotes(content: string): StateNote[] {
  const notes = new Map<NoteField, StateNote>();
  for (const line of content.split(/\r?\n/u)) {
    const m = NOTE.exec(line);
    if (!m || notes.has(m[1] as NoteField) || !m[2]!.trim()) continue;
    notes.set(m[1] as NoteField, { field: m[1] as NoteField, text: m[2]!.trim(), by: (m[3] as NoteAuthor | undefined) ?? 'owner', external: m[4] !== undefined });
  }
  return NOTE_FIELDS.flatMap(field => notes.get(field) ?? []);
}

export function cleanNote(field: NoteField, raw: string): string {
  const text = stripHidden(raw).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  const length = Array.from(text).length;
  if (length > NOTE_LIMITS[field]) throw new MeshError('mesh.state_too_long', { field, length, max: NOTE_LIMITS[field] });
  if (sanitizeModelInputText(text).redaction_count > 0) throw new MeshError('mesh.state_secret', { field });
  return text.replace(/-{5,}/gu, '----');
}

export function applyPatch(notes: readonly StateNote[], patch: StatePatch, writer: { by: NoteAuthor; external: boolean }): StateNote[] {
  const next = new Map(notes.map(note => [note.field, note]));
  for (const field of NOTE_FIELDS) {
    const raw = patch[field];
    if (raw === undefined) continue;
    const text = cleanNote(field, raw);
    if (text) next.set(field, { field, text, by: writer.by, external: writer.external });
    else next.delete(field);
  }
  return NOTE_FIELDS.flatMap(field => next.get(field) ?? []);
}

export function renderState(status: readonly string[], notes: readonly StateNote[]): string {
  const marker = (note: StateNote) => (note.by === 'owner' ? '' : ` [by ${note.by}${note.external ? ', src: external' : ''}]`);
  return [
    '# STATE',
    '',
    '## Status (kept by beat)',
    ...status.map(line => `- ${line}`),
    '',
    '## Notes (mesh_state_set)',
    ...notes.map(note => `- ${note.field}: ${note.text}${marker(note)}`),
    '',
  ].join('\n');
}

const KNOWN_LINE = /^(# STATE|## Status \(kept by beat\)|## Notes \(mesh_state_set\)|- (running tasks|acceptance|plan\.md|goal|now|next|blocked): .*|)$/u;

export const hasForeignLines = (content: string): boolean => content.split(/\r?\n/u).some(line => !KNOWN_LINE.test(line));
