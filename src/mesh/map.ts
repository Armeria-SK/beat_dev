import { CONTROL, stripHidden } from '../shared/plain-text.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { meshWriteText, type MeshWriteMessageKey } from '../shared/messages/mesh-write.ts';

export const MAP_FILE = 'MAP.md';
export const MAP_LINE_MAX = 160;
export const MAP_ROWS_MAX = 200;

export type RowAuthor = 'conversation' | 'task' | 'child' | 'owner';
export interface Writer { by: Exclude<RowAuthor, 'owner'>; external: boolean }

export class MeshWriteError extends LocalizedError<MeshWriteMessageKey> {
  constructor(code: MeshWriteMessageKey, params?: MessageParams) { super(meshWriteText, code, params); }
}

export interface MapRow { path: string; what: string; entry: string | null; by: RowAuthor; at: string | null; external: boolean }
export interface ParsedRows<T> { rows: T[]; lines: string[]; at: number[]; unreadable: number }

const MAP_HEAD = ['# MAP', '', 'Parts of the product folder, one line each. beat lists the folders; the lines are written with mesh_map_set.', ''];
const ROW = /^- (\S+) — (.+?)(?:\. entry: (\S+))?(?: \[by (conversation|task|child)(?:, at ((?:git|dir):[0-9a-f]+))?(, src: external)?\])?$/u;

export const marker = (by: RowAuthor, at: string | null, external: boolean): string =>
  by === 'owner' ? '' : ` [by ${by}${at ? `, at ${at}` : ''}${external ? ', src: external' : ''}]`;

export function cleanLine(raw: string): string {
  return stripHidden(raw).replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
}

export function refuseSecret(text: string, field: string): void {
  if (sanitizeModelInputText(text).redaction_count > 0) throw new MeshWriteError('secret', { field });
}

export function parseMap(content: string): ParsedRows<MapRow> {
  const lines = content.split(/\r?\n/u);
  const rows: MapRow[] = [];
  const at: number[] = [];
  let unreadable = 0;
  lines.forEach((line, index) => {
    if (!line.startsWith('- ')) return;
    const m = ROW.exec(line);
    if (!m) { unreadable++; return; }
    rows.push({ path: m[1]!, what: m[2]!, entry: m[3] ?? null, by: (m[4] as RowAuthor | undefined) ?? 'owner', at: m[5] ?? null, external: m[6] !== undefined });
    at.push(index);
  });
  return { rows, lines, at, unreadable };
}

export const mapContent = (row: Pick<MapRow, 'path' | 'what' | 'entry'>): string => `- ${row.path} — ${row.what}${row.entry ? `. entry: ${row.entry}` : ''}`;

export const renderMapRow = (row: MapRow): string => `${mapContent(row)}${marker(row.by, row.at, row.external)}`;

export function cleanWhat(raw: string, entry: string | null): string {
  let what = cleanLine(raw);
  if (entry) what = what.replace(/\.+$/u, '').trim();
  if (!what) throw new MeshWriteError('map_what_empty');
  if (/entry:|[[\]]/iu.test(what)) throw new MeshWriteError('map_what_marks');
  refuseSecret(what, 'what');
  return what;
}

export function upsertLine(existing: string | undefined, head: readonly string[], parsed: Pick<ParsedRows<unknown>, 'lines' | 'at'>, index: number, line: string): string {
  if (existing === undefined) return [...head, line, ''].join('\n');
  const lines = [...parsed.lines];
  if (index >= 0) lines[parsed.at[index]!] = line;
  else {
    const after = parsed.at.length ? parsed.at[parsed.at.length - 1]! + 1 : lines.length - (lines.at(-1) === '' ? 1 : 0);
    lines.splice(after, 0, line);
  }
  const text = lines.join('\n');
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function upsertMap(existing: string | undefined, row: MapRow): { content: string; added: boolean } {
  const parsed = parseMap(existing ?? '');
  const index = parsed.rows.findIndex(r => r.path === row.path);
  if (index < 0 && parsed.rows.length >= MAP_ROWS_MAX) throw new MeshWriteError('map_full', { max: MAP_ROWS_MAX });
  return { content: upsertLine(existing, MAP_HEAD, parsed, index, renderMapRow(row)), added: index < 0 };
}

export function covered(folder: string, rows: readonly Pick<MapRow, 'path'>[]): boolean {
  return rows.some(row => folder === row.path || folder.startsWith(`${row.path}/`) || row.path.startsWith(`${folder}/`));
}

export function unlisted(folders: readonly string[], rows: readonly Pick<MapRow, 'path'>[]): string[] {
  const open = folders.filter(folder => !covered(folder, rows));
  const set = new Set(open);
  return open.filter(folder => !folder.includes('/') || !set.has(folder.slice(0, folder.lastIndexOf('/'))));
}
