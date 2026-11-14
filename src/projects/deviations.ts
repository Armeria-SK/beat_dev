import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceFile } from '../mesh/files.ts';
import { neutralizeFence } from '../shared/fence.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { deviationText, type DeviationMessageKey } from '../shared/messages/deviations.ts';
import { plainLine } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { ITEM_ID, type AcceptanceDoc } from './acceptance.ts';
import { projectDir } from './store.ts';

export const DEVIATIONS_FILE = 'deviations.md';
export const DEVIATION_TEXT_MAX = 400;
export const DEVIATIONS_MAX = 200;
const NO_ITEM = 'general';
const ITEMS_IN_ERROR = 40;

export class DeviationError extends LocalizedError<DeviationMessageKey> {
  constructor(code: DeviationMessageKey, params?: MessageParams) { super(deviationText, code, params); }
}

export interface DeviationRow { item: string | null; what: string; why: string; task: string | null; date: string | null; by: 'task' | 'owner'; external: boolean }

export interface DeviationLog { rows: DeviationRow[]; unreadable: number }

export interface DeviationInput { item?: string | undefined; what: string; why: string }

export interface DeviationMeta { taskId: string; external: boolean; now: number; timezone: string; language: string | null; acceptance: AcceptanceDoc | undefined | 'unreadable' }

const ROW = /^- (A-[1-9]\d{0,3}|general) \| ([^|]+?) \| why: ([^|]+?)(?:( \[by task)(?: ([A-Za-z0-9-]{1,64}))?(?:, (\d{4}-\d{2}-\d{2}))?(, src: external)?\])?$/u;

export function isoDate(ms: number, timezone: string): string {
  const parts = (zone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone }).formatToParts(ms).map(part => [part.type, part.value]));
  let p: Record<string, string>;
  try { p = parts(timezone); } catch { p = parts('UTC'); }
  return `${p.year}-${p.month}-${p.day}`;
}

const head = (language: string | null): string[] => [
  '# Deviations from the plan',
  '',
  `Where the work differs from the plan, and why. One entry per line, written with deviation_add${language ? `. Owner-facing language: ${language}` : ''}.`,
  '',
];

export function parseDeviations(content: string): DeviationLog {
  const rows: DeviationRow[] = [];
  let unreadable = 0;
  for (const line of content.split(/\r?\n/u)) {
    if (!line.startsWith('- ')) continue;
    const m = ROW.exec(line);
    if (!m) { unreadable++; continue; }
    rows.push({ item: m[1] === NO_ITEM ? null : m[1]!, what: m[2]!, why: m[3]!, task: m[5] ?? null, date: m[6] ?? null, by: m[4] ? 'task' : 'owner', external: m[7] !== undefined });
  }
  return { rows, unreadable };
}

export function cleanDeviationText(raw: string, field: 'what' | 'why'): { text: string; hidden: boolean } {
  const plain = neutralizeFence(plainLine(raw, Infinity).replaceAll('|', '/').replaceAll('[', '(').replaceAll(']', ')'));
  if (!plain) throw new DeviationError('empty', { field });
  const length = Array.from(plain).length;
  if (length > DEVIATION_TEXT_MAX) throw new DeviationError('too_long', { field, length, max: DEVIATION_TEXT_MAX });
  const redacted = redactSecrets(plain);
  return { text: redacted.replace(/-{5,}/gu, '----'), hidden: redacted !== plain };
}

export function itemOf(raw: string | undefined, doc: DeviationMeta['acceptance']): string | null {
  const asked = raw?.trim();
  if (!asked) return null;
  if (doc === 'unreadable') throw new DeviationError('items_unreadable');
  const items = (Array.isArray(doc?.items) ? doc.items : []).filter(entry => !entry.removedIn).map(entry => entry.id).filter(id => ITEM_ID.test(id));
  if (!doc || !items.length) throw new DeviationError('no_items');
  const id = asked.toUpperCase();
  if (!ITEM_ID.test(id) || !items.includes(id)) {
    const more = items.length > ITEMS_IN_ERROR ? ` and ${items.length - ITEMS_IN_ERROR} more` : '';
    throw new DeviationError('bad_item', { item: plainLine(asked, 20).replaceAll('"', "'"), items: `${items.slice(0, ITEMS_IN_ERROR).join(', ')}${more}` });
  }
  return id;
}

function readOwn(file: string): string | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1) throw new DeviationError('file_unusable');
  return readFileSync(file, 'utf8');
}

const fileOf = (projectsDir: string, projectId: string): string => join(projectDir(projectsDir, projectId), DEVIATIONS_FILE);

export function readDeviations(projectsDir: string, projectId: string): DeviationLog {
  const content = readOwn(fileOf(projectsDir, projectId));
  return content === undefined ? { rows: [], unreadable: 0 } : parseDeviations(content);
}

const fold = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ');

export function addDeviation(projectsDir: string, projectId: string, input: DeviationInput, meta: DeviationMeta): { row: DeviationRow; hidden: boolean } {
  const item = itemOf(input.item, meta.acceptance);
  const what = cleanDeviationText(input.what, 'what');
  const why = cleanDeviationText(input.why, 'why');
  const dir = projectDir(projectsDir, projectId);
  const file = join(dir, DEVIATIONS_FILE);
  const existing = readOwn(file);
  const log = parseDeviations(existing ?? '');
  if (log.rows.length + log.unreadable >= DEVIATIONS_MAX) throw new DeviationError('full', { max: DEVIATIONS_MAX });
  if (log.rows.some(row => row.item === item && fold(row.what) === fold(what.text))) throw new DeviationError('duplicate', { item: item ?? NO_ITEM });
  const task = /^[A-Za-z0-9-]{1,64}$/u.test(meta.taskId) ? ` ${meta.taskId}` : '';
  const date = isoDate(meta.now, meta.timezone);
  const line = `- ${item ?? NO_ITEM} | ${what.text} | why: ${why.text} [by task${task}, ${date}${meta.external ? ', src: external' : ''}]`;
  const lines = existing === undefined ? head(meta.language) : existing.replace(/\n+$/u, '').split(/\r?\n/u);
  mkdirSync(dir, { recursive: true });
  replaceFile(file, `${[...lines, line].join('\n')}\n`);
  return { row: { item, what: what.text, why: why.text, task: task ? meta.taskId : null, date, by: 'task', external: meta.external }, hidden: what.hidden || why.hidden };
}
