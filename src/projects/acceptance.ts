import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SpeechRow } from '../db/conversations.ts';
import { transaction } from '../db/database.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { acceptanceText, type AcceptanceMessageKey } from '../shared/messages/acceptance.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { stripAttachments } from '../uploads/store.ts';
import { conversationDraftFile, CONVERSATION_ID, isPlanConversation } from './plan.ts';
import { CHECK_COMMAND_MAX, checkCommandOf, PROJECT_ID, projectDir, type ProjectStore } from './store.ts';

export const ACCEPTANCE_FILE = 'acceptance.json';
export const ACCEPTANCE_MAX_ITEMS = 60;
export const ACCEPTANCE_RESULT_MAX = 300;
export const ACCEPTANCE_QUOTE_MAX = 1000;
export const MIN_QUOTE_WEIGHT = 12;

export type AcceptanceState = 'open' | 'met' | 'unverified';
export type UncheckedReason = 'not_found' | 'too_short' | 'choice_unverified' | 'scan_budget';
export type AcceptanceCheck = { kind: 'command'; command: string } | { kind: 'look' } | { kind: 'read' };
export type ClaimedSource =
  | { kind: 'owner_words'; quote: string }
  | { kind: 'owner_choice'; question: string; answer: string }
  | { kind: 'ai_added' };
export type FirstSource =
  | { kind: 'owner_words'; quote: string; messageId: number; conversationId: string; context?: string }
  | { kind: 'owner_choice'; question: string; questionMessageId: number; answer: string; answerMessageId: number; conversationId: string }
  | { kind: 'ai_added'; claimed?: 'owner_words' | 'owner_choice'; reason?: UncheckedReason; quote?: string; question?: string; answer?: string }
  | { kind: 'owner_edit' };
export type AcceptanceSource = FirstSource | { kind: 'owner_answer'; questionId: number; answer: string; picked: 'option' | 'text'; was: FirstSource };

export interface AcceptanceItem {
  id: string;
  result: string;
  source: AcceptanceSource;
  check: AcceptanceCheck;
  state: AcceptanceState;
  evidence: unknown[];
  changedIn: number | null;
  removedIn: number | null;
}

export interface NotDoingItem { id: string; text: string; source: AcceptanceSource }

export interface AcceptanceDoc {
  schema: 1;
  version: number;
  language: string | null;
  items: AcceptanceItem[];
  notDoing: NotDoingItem[];
  taintedRuns?: string[];
}

export interface AcceptanceVersionRow {
  project_id: string;
  version: number;
  hash: string;
  content: string;
  plan_hash: string | null;
  source: 'build' | 'change' | 'question' | 'proposal';
  build_task_id: string | null;
  created_at: number;
  item_states: string | null;
}

export type ItemMarker = 'gate' | 'owner';
export interface ItemState { state: AcceptanceState; evidence: unknown[]; by: ItemMarker; taskId: string; at: number }
export type ItemStates = Record<string, ItemState>;
export interface ItemMark { id: string; state: AcceptanceState; evidence: unknown[] }

export interface DraftInput {
  items: Array<{ result: string; source: ClaimedSource; check: AcceptanceCheck }>;
  notDoing?: Array<{ text: string; source: ClaimedSource }> | undefined;
}

export class AcceptanceError extends LocalizedError<AcceptanceMessageKey> {
  constructor(code: AcceptanceMessageKey, params?: MessageParams) { super(acceptanceText, code, params); }
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TEMP_NAME = /^acceptance\.json\.tmp-[0-9a-f]+$/u;
export const SCAN_BUDGET = 400_000_000;
export const FOLD_COST = 16;
const CONTEXT_MAX = 500;
const ELLIPSIS = '…';
const STOPS = '.!?\\u3002\\uFF01\\uFF1F';
const SENTENCE = new RegExp(`[^${STOPS}\\n]+[${STOPS}]*|[${STOPS}]+`, 'gu');

export const normalizeQuote = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

export function quoteWeight(text: string): number {
  let weight = 0;
  for (const char of normalizeQuote(text)) weight += WIDE.test(char) ? 2 : 1;
  return weight;
}

interface OwnerView { text: string; norm: string; at: number[]; starts: number[]; ends: number[] }
interface Spoken { id: number; conversationId: string; raw: string; view?: OwnerView | undefined }

export interface Speech { owner: Spoken[]; budget: { left: number } }

export function prepareSpeech(rows: readonly SpeechRow[], scanBudget = SCAN_BUDGET): Speech {
  const owner = rows
    .filter(row => row.role === 'user' && row.generated !== 1)
    .map(row => ({ id: row.id, conversationId: row.conversation_id, raw: stripAttachments(row.text) }))
    .sort((a, b) => b.id - a.id);
  return { owner, budget: { left: scanBudget } };
}

function foldChar(text: string, i: number): [string, number] {
  const code = text.codePointAt(i)!;
  if (code < 128) {
    if (code === 32 || (code >= 9 && code <= 13)) return ['', 1];
    return [code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]!, 1];
  }
  const char = String.fromCodePoint(code);
  return [char.normalize('NFKD').toLowerCase().replace(/\s+/gu, ''), char.length];
}

const fold = (text: string): string => {
  let out = '';
  for (let i = 0; i < text.length;) { const [part, size] = foldChar(text, i); out += part; i += size; }
  return out;
};

function ownerViewOf(message: Spoken): OwnerView {
  const text = sanitizeModelInputText(clean(message.raw)).text;
  let norm = '';
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    const [part, size] = foldChar(text, i);
    for (let k = 0; k < part.length; k++) at.push(i);
    norm += part;
    i += size;
  }
  const starts: number[] = [];
  const ends: number[] = [];
  for (const match of text.matchAll(SENTENCE)) { starts.push(match.index); ends.push(match.index + match[0].length); }
  return { text, norm, at, starts, ends };
}

function partOf(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (starts[mid]! <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

const isHigh = (code: number) => code >= 0xD800 && code <= 0xDBFF;
const isLow = (code: number) => code >= 0xDC00 && code <= 0xDFFF;

function contextOf(view: OwnerView, from: number, to: number): string {
  const { text } = view;
  let a = view.starts[partOf(view.starts, from)]!;
  let b = view.ends[partOf(view.starts, to - 1)]!;
  while (a < b && /\s/u.test(text[a]!)) a++;
  while (b > a && /\s/u.test(text[b - 1]!)) b--;
  if (b - a <= CONTEXT_MAX) return text.slice(a, b);
  const room = CONTEXT_MAX - 2;
  let start = Math.max(a, from - Math.max(0, Math.floor((room - (to - from)) / 2)));
  let end = Math.min(b, start + room);
  start = Math.max(a, end - room);
  if (start > a && isLow(text.charCodeAt(start))) start++;
  if (end < b && isHigh(text.charCodeAt(end - 1))) end--;
  return `${start > a ? ELLIPSIS : ''}${text.slice(start, end)}${end < b ? ELLIPSIS : ''}`;
}

export function verifySource(speech: Speech, claimed: ClaimedSource): AcceptanceSource {
  if (claimed.kind === 'ai_added') return { kind: 'ai_added' };
  if (claimed.kind === 'owner_choice') return { kind: 'ai_added', claimed: 'owner_choice', reason: 'choice_unverified', question: claimed.question, answer: claimed.answer };
  const unchecked = (reason: UncheckedReason): AcceptanceSource => ({ kind: 'ai_added', claimed: 'owner_words', reason, quote: claimed.quote });
  if (quoteWeight(claimed.quote) < MIN_QUOTE_WEIGHT) return unchecked('too_short');
  const folded = fold(claimed.quote);
  for (const message of speech.owner) {
    const cost = message.view ? message.view.norm.length : message.raw.length * FOLD_COST;
    if (speech.budget.left < cost) { speech.budget.left = 0; return unchecked('scan_budget'); }
    speech.budget.left -= cost;
    const view = message.view ??= ownerViewOf(message);
    const index = view.norm.indexOf(folded);
    if (index < 0) continue;
    const from = view.at[index]!;
    const last = view.at[index + folded.length - 1]!;
    const to = last + (isHigh(view.text.charCodeAt(last)) ? 2 : 1);
    return { kind: 'owner_words', quote: view.text.slice(from, to), messageId: message.id, conversationId: message.conversationId, context: contextOf(view, from, to) };
  }
  return unchecked('not_found');
}

const clean = (text: string): string => stripHidden(text).replace(CONTROLS, '').trim();

function cleanText(raw: string, field: string, max: number): string {
  const text = clean(raw);
  if (text.length > max) throw new AcceptanceError('too_long', { field, max });
  return text;
}

function cleanClaim(claimed: ClaimedSource): ClaimedSource {
  if (claimed.kind === 'owner_words') return { kind: 'owner_words', quote: cleanText(claimed.quote, 'quote', ACCEPTANCE_QUOTE_MAX) };
  if (claimed.kind === 'owner_choice') return { kind: 'owner_choice', question: cleanText(claimed.question, 'question', ACCEPTANCE_QUOTE_MAX), answer: cleanText(claimed.answer, 'answer', ACCEPTANCE_QUOTE_MAX) };
  return { kind: 'ai_added' };
}

export const checkedSource = (speech: Speech, claimed: ClaimedSource): AcceptanceSource => verifySource(speech, cleanClaim(claimed));

function cleanCheck(check: AcceptanceCheck): AcceptanceCheck {
  if (check.kind !== 'command') return { kind: check.kind };
  let command: string | null;
  try { command = checkCommandOf(check.command); } catch { command = null; }
  if (command === null) throw new AcceptanceError('bad_command', { max: CHECK_COMMAND_MAX });
  return { kind: 'command', command };
}

export function buildDraft(input: DraftInput, speech: Speech, options: { language: string | null; taintedRuns: string[] }): { doc: AcceptanceDoc; verified: number; changed: Partial<Record<UncheckedReason, number>> } {
  const notDoing = input.notDoing ?? [];
  if (input.items.length > ACCEPTANCE_MAX_ITEMS || notDoing.length > ACCEPTANCE_MAX_ITEMS) throw new AcceptanceError('too_many', { max: ACCEPTANCE_MAX_ITEMS });
  let verified = 0;
  const changed: Partial<Record<UncheckedReason, number>> = {};
  const sourceOf = (raw: ClaimedSource): AcceptanceSource => {
    const source = verifySource(speech, cleanClaim(raw));
    if (source.kind === 'owner_words' || source.kind === 'owner_choice') verified++;
    else if (source.kind === 'ai_added' && source.reason) changed[source.reason] = (changed[source.reason] ?? 0) + 1;
    return source;
  };
  const doc: AcceptanceDoc = {
    schema: 1, version: 0, language: options.language,
    items: input.items.map((entry, i) => {
      const result = cleanText(entry.result, 'result', ACCEPTANCE_RESULT_MAX);
      const check = cleanCheck(entry.check);
      return { id: `A-${i + 1}`, result, source: sourceOf(entry.source), check, state: 'open', evidence: [], changedIn: null, removedIn: null };
    }),
    notDoing: notDoing.map((entry, i) => ({ id: `N-${i + 1}`, text: cleanText(entry.text, 'text', ACCEPTANCE_RESULT_MAX), source: sourceOf(entry.source) })),
    taintedRuns: options.taintedRuns,
  };
  if (sanitizeModelInputText(JSON.stringify(doc)).redaction_count > 0) throw new AcceptanceError('secret');
  return { doc, verified, changed };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const byId = <T extends { id: string }>(list: readonly T[]): T[] => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function frozenHash(doc: AcceptanceDoc): string {
  const frozen = {
    schema: doc.schema, version: doc.version, language: doc.language,
    items: byId(doc.items).map(({ id, result, source, check, changedIn, removedIn }) => ({ id, result, source, check, changedIn, removedIn })),
    notDoing: byId(doc.notDoing),
  };
  return createHash('sha256').update(canonical(frozen)).digest('hex');
}

export function docOf(raw: string): AcceptanceDoc | undefined {
  try {
    const doc = JSON.parse(raw) as AcceptanceDoc;
    if (doc?.schema !== 1 || !Number.isInteger(doc.version) || doc.version < 0 || !Array.isArray(doc.items) || !Array.isArray(doc.notDoing)) return undefined;
    return doc;
  } catch { return undefined; }
}

export const ACCEPTANCE_MAX_CHANGES = 60;
export const ACCEPTANCE_MAX_TOTAL = 200;
export const ITEM_ID = /^A-[1-9]\d{0,3}$/u;
export const EVIDENCE_MAX = 4000;
const STATES: ReadonlySet<unknown> = new Set<AcceptanceState>(['open', 'met', 'unverified']);

export function itemStatesOf(raw: string | null): ItemStates {
  const out: ItemStates = {};
  let parsed: unknown;
  try { parsed = raw === null ? null : JSON.parse(raw); } catch { return out; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  for (const [id, value] of Object.entries(parsed)) {
    const entry = value as Partial<ItemState> | null;
    if (!ITEM_ID.test(id) || !entry || typeof entry !== 'object' || !STATES.has(entry.state) || !Array.isArray(entry.evidence)
      || (entry.by !== 'gate' && entry.by !== 'owner') || typeof entry.taskId !== 'string' || typeof entry.at !== 'number') continue;
    out[id] = { state: entry.state!, evidence: entry.evidence, by: entry.by, taskId: entry.taskId, at: entry.at };
  }
  return out;
}

const stateIn = (states: ItemStates, id: unknown): Pick<AcceptanceItem, 'state' | 'evidence'> => {
  const found = typeof id === 'string' && Object.hasOwn(states, id) ? states[id]! : undefined;
  return { state: found?.state ?? 'open', evidence: found?.evidence ?? [] };
};

const isItem = (entry: unknown): entry is AcceptanceItem => entry !== null && typeof entry === 'object' && !Array.isArray(entry);

const withStates = (doc: AcceptanceDoc, states: ItemStates): AcceptanceDoc => ({
  ...doc, items: doc.items.map(entry => (isItem(entry) ? { ...entry, ...stateIn(states, entry.id) } : entry)),
});

const statesText = (doc: AcceptanceDoc): string => canonical([doc.taintedRuns, doc.items.map(entry => (isItem(entry) ? [entry.state, entry.evidence] : null))]);

export type ChangeOpKind = 'add' | 'change' | 'remove';
export interface ChangeItem { result: string; check: AcceptanceCheck }
export interface ChangeOp { op: ChangeOpKind; id?: string; item?: ChangeItem; source: AcceptanceSource }
export type OwnerChange = Omit<ChangeOp, 'source'>;
export type DecisionSource = 'question' | 'proposal';

export interface AcceptanceChangeRow {
  id: string;
  project_id: string;
  base_version: number;
  ops: string;
  language: string | null;
  conversation_id: string | null;
  tainted: number;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  created_at: number;
  decided_at: number | null;
}

export type AcceptanceVersionSummary = Omit<AcceptanceVersionRow, 'content' | 'item_states'>;

const badChange = (detail: string) => new AcceptanceError('bad_change', { detail });

function cleanItem(item: ChangeItem | undefined, op: ChangeOpKind): ChangeItem {
  if (!item || typeof item.result !== 'string' || !item.check || typeof item.check !== 'object') throw badChange(`${op} needs result and check`);
  const result = cleanText(item.result, 'result', ACCEPTANCE_RESULT_MAX);
  if (!result) throw badChange(`${op} needs result and check`);
  if (!['command', 'look', 'read'].includes(item.check.kind)) throw badChange('check must be command, look or read');
  return { result, check: cleanCheck(item.check) };
}

export function cleanChanges(ops: readonly ChangeOp[]): ChangeOp[] {
  if (ops.length === 0) throw badChange('no changes');
  if (ops.length > ACCEPTANCE_MAX_CHANGES) throw new AcceptanceError('too_many', { max: ACCEPTANCE_MAX_CHANGES });
  const seen = new Set<string>();
  const cleaned = ops.map((op): ChangeOp => {
    if (op.op === 'add') return { op: 'add', item: cleanItem(op.item, 'add'), source: op.source };
    if (op.op !== 'change' && op.op !== 'remove') throw badChange('op must be add, change or remove');
    if (typeof op.id !== 'string' || !ITEM_ID.test(op.id)) throw badChange(`${op.op} needs the id of an item`);
    if (seen.has(op.id)) throw badChange(`${op.id} appears twice`);
    seen.add(op.id);
    return op.op === 'remove' ? { op: 'remove', id: op.id, source: op.source } : { op: 'change', id: op.id, item: cleanItem(op.item, 'change'), source: op.source };
  });
  if (sanitizeModelInputText(JSON.stringify(cleaned)).redaction_count > 0) throw new AcceptanceError('secret');
  return cleaned;
}

export function applyChanges(doc: AcceptanceDoc, ops: readonly ChangeOp[], next: number | null): AcceptanceItem[] {
  const items = doc.items.map(entry => ({ ...entry }));
  let top = items.reduce((max, entry) => Math.max(max, Number(/^A-(\d+)$/u.exec(entry.id)?.[1] ?? 0)), 0);
  const drop = new Set<string>();
  const live = new Set(doc.items.filter(entry => entry.removedIn === null).map(entry => entry.id));
  for (const op of cleanChanges(ops)) {
    if (op.op === 'add') {
      items.push({ id: `A-${++top}`, result: op.item!.result, source: op.source, check: op.item!.check, state: 'open', evidence: [], changedIn: next, removedIn: null });
      continue;
    }
    const target = live.has(op.id!) ? items.find(entry => entry.id === op.id) : undefined;
    if (!target) throw badChange(`there is no item ${op.id}`);
    if (op.op === 'remove') {
      if (next === null) drop.add(target.id); else target.removedIn = next;
      continue;
    }
    Object.assign(target, { result: op.item!.result, check: op.item!.check, source: op.source, state: 'open', evidence: [], changedIn: next });
  }
  const out = items.filter(entry => !drop.has(entry.id));
  if (out.filter(entry => entry.removedIn === null).length > ACCEPTANCE_MAX_ITEMS) throw new AcceptanceError('too_many', { max: ACCEPTANCE_MAX_ITEMS });
  if (out.length > ACCEPTANCE_MAX_TOTAL) throw new AcceptanceError('too_many_total', { max: ACCEPTANCE_MAX_TOTAL });
  return out;
}

export function ownerChanges(raw: unknown): OwnerChange[] {
  if (!Array.isArray(raw)) throw badChange('ops must be a list');
  return raw.map((entry): OwnerChange => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw badChange('each op must be an object');
    const { op, id, item, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw badChange(`unknown field ${Object.keys(rest)[0]!.slice(0, 20)}`);
    if (op !== 'add' && op !== 'change' && op !== 'remove') throw badChange('op must be add, change or remove');
    if (id !== undefined && typeof id !== 'string') throw badChange('id must be text');
    let changeItem: ChangeItem | undefined;
    if (item !== undefined) {
      const { result, check } = (item ?? {}) as Record<string, unknown>;
      const kind = (check as Record<string, unknown> | null | undefined)?.kind;
      const command = (check as Record<string, unknown> | null | undefined)?.command;
      if (typeof result !== 'string' || (kind !== 'command' && kind !== 'look' && kind !== 'read')) throw badChange(`${op} needs result and check`);
      if (kind === 'command' && typeof command !== 'string') throw new AcceptanceError('bad_command', { max: CHECK_COMMAND_MAX });
      changeItem = { result, check: kind === 'command' ? { kind, command: command as string } : { kind } };
    }
    return { op, ...(id !== undefined ? { id } : {}), ...(changeItem ? { item: changeItem } : {}) };
  });
}

export const UNREFERENCED_PAGE = 50;
export const UNREFERENCED_TEXT_MAX = 300;

export interface Coverage {
  owner_words: number;
  owner_choice: number;
  owner_edit: number;
  ai_added: number;
  by_hand: number;
  unreferenced: Array<{ message_id: number; conversation_id: string; text: string; created_at: number }>;
  unreferenced_total: number;
}

function clip(text: string): string {
  if (text.length <= UNREFERENCED_TEXT_MAX) return text;
  const end = isHigh(text.charCodeAt(UNREFERENCED_TEXT_MAX - 1)) ? UNREFERENCED_TEXT_MAX - 1 : UNREFERENCED_TEXT_MAX;
  return text.slice(0, end);
}

export function coverageOf(doc: AcceptanceDoc | undefined, rows: readonly SpeechRow[], before?: number): Coverage {
  const items = (doc?.items ?? []).filter(entry => entry.removedIn === null);
  const counts = { owner_words: 0, owner_choice: 0, owner_edit: 0, ai_added: 0 };
  const origin = (source: AcceptanceSource | undefined): FirstSource | undefined => (source?.kind === 'owner_answer' ? source.was : source);
  for (const entry of items) {
    const kind = origin(entry.source)?.kind;
    if (kind !== undefined && Object.hasOwn(counts, kind)) counts[kind]++;
  }
  const cited = new Set<number>();
  for (const entry of [...items, ...(doc?.notDoing ?? [])]) {
    const source = origin(entry.source);
    if (source?.kind === 'owner_words') cited.add(source.messageId);
    if (source?.kind === 'owner_choice') cited.add(source.answerMessageId);
  }
  const at = (row: SpeechRow) => row.created_at ?? 0;
  const loose = rows.filter(row => row.role === 'user' && row.generated !== 1 && !cited.has(row.id)).sort((a, b) => at(b) - at(a) || b.id - a.id);
  const page = before === undefined ? loose : loose.filter(row => at(row) < before);
  let end = Math.min(page.length, UNREFERENCED_PAGE);
  while (end > 0 && end < page.length && at(page[end]!) === at(page[end - 1]!)) end++;
  return {
    ...counts,
    by_hand: items.filter(entry => entry.check?.kind === 'look' || entry.check?.kind === 'read').length,
    unreferenced: page.slice(0, end).map(row => ({ message_id: row.id, conversation_id: row.conversation_id, text: clip(stripAttachments(row.text)), created_at: at(row) })),
    unreferenced_total: loose.length,
  };
}

export interface AcceptanceIo {
  writeFileSync?: (path: string, data: string) => void;
  renameSync?: (from: string, to: string) => void;
  archived?: (projectId: string) => boolean;
  log?: (line: string) => void;
  now?: () => number;
  languages?: Pick<ProjectStore, 'get' | 'detectDocLanguage'>;
}

export class AcceptanceStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #write: (path: string, data: string) => void;
  readonly #rename: (from: string, to: string) => void;
  readonly #archived: (projectId: string) => boolean;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  readonly #languages: Pick<ProjectStore, 'get' | 'detectDocLanguage'> | undefined;

  constructor(db: DatabaseSync, projectsDir: string, io: AcceptanceIo = {}) {
    this.#db = db;
    this.#dir = projectsDir;
    this.#write = io.writeFileSync ?? ((path, data) => writeFileSync(path, data));
    this.#rename = io.renameSync ?? renameSync;
    this.#archived = io.archived ?? (() => false);
    this.#log = io.log ?? (() => undefined);
    this.#now = io.now ?? Date.now;
    this.#languages = io.languages;
  }

  atomically<T>(work: () => T): T { return transaction(this.#db, work); }

  versions(projectId: string): AcceptanceVersionSummary[] {
    return this.#db.prepare('SELECT project_id, version, hash, plan_hash, source, build_task_id, created_at FROM acceptance_versions WHERE project_id = ? ORDER BY version').all(projectId) as unknown as AcceptanceVersionSummary[];
  }

  version(projectId: string, version: number): AcceptanceVersionRow | undefined {
    return this.#db.prepare('SELECT * FROM acceptance_versions WHERE project_id = ? AND version = ?').get(projectId, version) as AcceptanceVersionRow | undefined;
  }

  itemStates(projectId: string): ItemStates {
    return itemStatesOf(this.latest(projectId)?.item_states ?? null);
  }

  markItems(projectId: string, mark: { version: number; taskId: string; items: readonly ItemMark[] }): AcceptanceDoc {
    return this.#mark(projectId, 'gate', mark.taskId, mark.version, mark.items);
  }

  ownerCheck(projectId: string, mark: { taskId: string; itemId: string; version: number }): AcceptanceDoc {
    return this.#mark(projectId, 'owner', mark.taskId, mark.version, [{ id: mark.itemId, state: 'met', evidence: null }]);
  }

  #mark(projectId: string, by: ItemMarker, taskId: string, version: number, marks: ReadonlyArray<{ id: string; state: AcceptanceState; evidence: unknown[] | null }>): AcceptanceDoc {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    const doc = transaction(this.#db, () => {
      const row = this.latest(projectId);
      const truth = row && this.#truth(row);
      if (!row || !truth) throw new AcceptanceError('not_frozen');
      if (version !== row.version) throw new AcceptanceError('stale', { version: row.version });
      if (typeof taskId !== 'string' || !this.#db.prepare('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?').get(taskId, projectId)) throw badChange('there is no such task for this product');
      const states = itemStatesOf(row.item_states);
      const at = this.#now();
      for (const mark of marks) {
        const id = mark?.id;
        const target = typeof id === 'string' && ITEM_ID.test(id) ? truth.items.find(entry => entry.id === id && entry.removedIn === null) : undefined;
        if (!target) throw badChange(`there is no item ${String(id).slice(0, 20)}`);
        if (!STATES.has(mark.state)) throw badChange('state must be open, met or unverified');
        if (by === 'gate' && mark.state === 'met' && target.check?.kind !== 'command') throw badChange(`${target.id} is checked by look or read, so only the owner can mark it met`);
        const evidence = mark.evidence ?? target.evidence;
        if (!Array.isArray(evidence)) throw badChange('evidence must be a list');
        if (JSON.stringify(evidence).length > EVIDENCE_MAX) throw new AcceptanceError('too_long', { field: 'evidence', max: EVIDENCE_MAX });
        states[target.id] = { state: mark.state, evidence, by, taskId, at };
      }
      this.#db.prepare('UPDATE acceptance_versions SET item_states = ? WHERE project_id = ? AND version = ?').run(JSON.stringify(states), projectId, row.version);
      return withStates(truth, states);
    });
    try { this.repair(projectId); } catch (error) {
      this.#log(`[WARN] Saved the acceptance item states of product ${projectId}, but could not update acceptance.json (${(error as Error).message}). It is restored from the saved version before the next write or at startup`);
    }
    return doc;
  }

  #truth(row: AcceptanceVersionRow): AcceptanceDoc | undefined {
    const stored = docOf(row.content);
    return stored && withStates(stored, itemStatesOf(row.item_states));
  }

  pending(projectId: string): AcceptanceChangeRow | undefined {
    return this.#db.prepare("SELECT * FROM acceptance_changes WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(projectId) as AcceptanceChangeRow | undefined;
  }

  #change(projectId: string, changeId: string): AcceptanceChangeRow {
    const row = this.#db.prepare('SELECT * FROM acceptance_changes WHERE id = ? AND project_id = ?').get(changeId, projectId) as AcceptanceChangeRow | undefined;
    if (!row) throw new AcceptanceError('no_change');
    return row;
  }

  #pendingChange(projectId: string, changeId: string): AcceptanceChangeRow {
    const row = this.#change(projectId, changeId);
    if (row.status !== 'pending') throw new AcceptanceError('not_pending', { status: row.status });
    return row;
  }

  #base(projectId: string): { row: AcceptanceVersionRow; doc: AcceptanceDoc } {
    const row = this.latest(projectId);
    const doc = row && this.#truth(row);
    if (!row || !doc) throw new AcceptanceError('not_frozen');
    return { row, doc };
  }

  propose(projectId: string, ops: readonly ChangeOp[], meta: { language: string | null; conversationId: string | null; tainted: boolean }): AcceptanceChangeRow {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    const { row, doc } = this.#base(projectId);
    const cleaned = cleanChanges(ops);
    applyChanges(doc, cleaned, row.version + 1);
    const now = this.#now();
    const made: AcceptanceChangeRow = {
      id: randomUUID(), project_id: projectId, base_version: row.version, ops: JSON.stringify(cleaned), language: meta.language,
      conversation_id: meta.conversationId, tainted: meta.tainted ? 1 : 0, status: 'pending', created_at: now, decided_at: null,
    };
    transaction(this.#db, () => {
      this.#db.prepare("UPDATE acceptance_changes SET status = 'superseded', decided_at = ? WHERE project_id = ? AND status = 'pending'").run(now, projectId);
      this.#db.prepare('INSERT INTO acceptance_changes (id, project_id, base_version, ops, language, conversation_id, tainted, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(made.id, made.project_id, made.base_version, made.ops, made.language, made.conversation_id, made.tainted, made.status, made.created_at, made.decided_at);
    });
    return made;
  }

  approve(projectId: string, changeId: string): AcceptanceVersionRow {
    const change = this.#change(projectId, changeId);
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    const latest = this.latest(projectId);
    if ((change.status === 'pending' || change.status === 'superseded') && latest?.version !== change.base_version) throw new AcceptanceError('stale', { version: latest?.version ?? 0 });
    if (change.status !== 'pending') throw new AcceptanceError('not_pending', { status: change.status });
    return this.#advance(projectId, JSON.parse(change.ops) as ChangeOp[], 'change', { language: change.language, taint: change.tainted === 1 ? `change:${change.id}` : null, decide: change.id });
  }

  reject(projectId: string, changeId: string): AcceptanceChangeRow {
    const change = this.#pendingChange(projectId, changeId);
    const now = this.#now();
    this.#db.prepare("UPDATE acceptance_changes SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'").run(now, change.id);
    return { ...change, status: 'rejected', decided_at: now };
  }

  ownerEdit(projectId: string, edit: { baseVersion: number; baseHash?: string | null | undefined; ops: readonly OwnerChange[]; conversationId?: string | undefined }): number {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    const ops: ChangeOp[] = edit.ops.map(op => ({ ...op, source: { kind: 'owner_edit' } }));
    this.repair(projectId);
    const latest = this.latest(projectId);
    if (!latest) {
      if (edit.baseVersion !== 0) throw new AcceptanceError('stale', { version: 0 });
      const conversationId = this.#draftConversation(projectId, edit.conversationId);
      const current = this.#readDraft(projectId, conversationId);
      if ((current ? frozenHash(current) : null) !== edit.baseHash) throw new AcceptanceError('stale', { version: 0 });
      const base: AcceptanceDoc = current ?? { schema: 1, version: 0, language: this.#languages?.get(projectId)?.doc_language ?? null, items: [], notDoing: [] };
      this.writeDraft(projectId, conversationId, { ...base, version: 0, items: applyChanges(base, ops, null) });
      return 0;
    }
    if (edit.baseVersion !== latest.version) throw new AcceptanceError('stale', { version: latest.version });
    if (edit.baseHash !== undefined) {
      const shown = this.read(projectId);
      if ((shown ? frozenHash(shown) : null) !== edit.baseHash) throw new AcceptanceError('stale', { version: latest.version });
    }
    return this.#advance(projectId, ops, 'change', { language: null, taint: null, decide: null }).version;
  }

  applyOwnerDecision(projectId: string, ops: readonly ChangeOp[], source: DecisionSource, taint: string | null = null): AcceptanceVersionRow {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    return this.#advance(projectId, ops, source, { language: null, taint, decide: null });
  }

  #liveItem(projectId: string, itemId: string): AcceptanceItem | undefined {
    return this.#base(projectId).doc.items.find(entry => entry.id === itemId && entry.removedIn === null);
  }

  hasLiveItem(projectId: string, itemId: string): boolean {
    if (this.#archived(projectId)) return false;
    try { return this.#liveItem(projectId, itemId) !== undefined; } catch (error) {
      if (error instanceof AcceptanceError) return false;
      throw error;
    }
  }

  reopenForAnswer(projectId: string, itemId: string, answer: { questionId: number; answer: string; picked: 'option' | 'text'; taint: string | null }): AcceptanceVersionRow | undefined {
    const target = this.#liveItem(projectId, itemId);
    if (!target) return undefined;
    const was = target.source.kind === 'owner_answer' ? target.source.was : target.source;
    const source: AcceptanceSource = { kind: 'owner_answer', questionId: answer.questionId, answer: answer.answer, picked: answer.picked, was };
    return this.applyOwnerDecision(projectId, [{ op: 'change', id: itemId, item: { result: target.result, check: target.check }, source }], 'question', answer.taint);
  }

  #advance(projectId: string, ops: readonly ChangeOp[], source: 'change' | DecisionSource, o: { language: string | null; taint: string | null; decide: string | null }): AcceptanceVersionRow {
    this.repair(projectId);
    const { row, doc } = this.#base(projectId);
    const next = row.version + 1;
    const carried = itemStatesOf(row.item_states);
    const states: ItemStates = {};
    const items = applyChanges(doc, ops, next);
    for (const entry of items) if (entry.changedIn !== next && entry.removedIn === null && Object.hasOwn(carried, entry.id)) states[entry.id] = carried[entry.id]!;
    const project = o.language ? this.#languages?.get(projectId) : undefined;
    const moves = Boolean(o.language && project && project.doc_language_pinned === 0 && project.doc_language !== o.language);
    const taintedRuns = [...new Set([...(doc.taintedRuns ?? []), ...(o.taint ? [o.taint] : [])])];
    const made: AcceptanceDoc = withStates({ ...doc, version: next, language: moves ? o.language : doc.language, items, taintedRuns }, states);
    const now = this.#now();
    return this.#freeze(projectId, made, states, { plan_hash: null, source, created_at: now }, () => {
      this.#db.prepare("UPDATE acceptance_changes SET status = CASE WHEN id = ? THEN 'approved' ELSE 'superseded' END, decided_at = ? WHERE project_id = ? AND status = 'pending'").run(o.decide ?? '', now, projectId);
      if (moves) this.#languages!.detectDocLanguage(projectId, o.language!);
      return null;
    });
  }

  #file(projectId: string): string { return join(projectDir(this.#dir, projectId), ACCEPTANCE_FILE); }

  #draftConversation(projectId: string, conversationId: string | undefined): string {
    if (conversationId === undefined || !CONVERSATION_ID.test(conversationId) || !isPlanConversation(this.#db, projectId, conversationId)) throw new AcceptanceError('unknown_conversation');
    return conversationId;
  }

  #readDraft(projectId: string, conversationId: string): AcceptanceDoc | undefined {
    return this.#readAt(conversationDraftFile(this.#dir, projectId, conversationId));
  }

  #readFile(projectId: string): AcceptanceDoc | undefined {
    return this.#readAt(this.#file(projectId));
  }

  #readAt(file: string): AcceptanceDoc | undefined {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new AcceptanceError('not_file');
    return docOf(readFileSync(file, 'utf8'));
  }

  latest(projectId: string): AcceptanceVersionRow | undefined {
    return this.#db.prepare('SELECT * FROM acceptance_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as AcceptanceVersionRow | undefined;
  }

  #copy(projectId: string): { doc: AcceptanceDoc; write?: AcceptanceDoc; ahead?: number } | undefined {
    const row = this.latest(projectId);
    const file = this.#readFile(projectId);
    const doc = row && this.#truth(row);
    if (!row || !doc) return file && { doc: file };
    if (!file || file.version !== row.version) return { doc, write: doc, ...(file && file.version > row.version ? { ahead: file.version } : {}) };
    const { taintedRuns: _fileRuns, ...rest } = withStates(file, itemStatesOf(row.item_states));
    const copy: AcceptanceDoc = { ...rest, ...(doc.taintedRuns ? { taintedRuns: doc.taintedRuns } : {}) };
    return statesText(copy) === statesText(file) ? { doc: copy } : { doc: copy, write: copy };
  }

  read(projectId: string, conversationId?: string): AcceptanceDoc | undefined {
    if (conversationId !== undefined && !this.latest(projectId)) return CONVERSATION_ID.test(conversationId) ? this.#readDraft(projectId, conversationId) : undefined;
    return this.#copy(projectId)?.doc;
  }

  repair(projectId: string): boolean {
    const copy = this.#copy(projectId);
    if (!copy?.write) return false;
    if (copy.ahead !== undefined) this.#log(`[WARN] acceptance.json of product ${projectId} was at version ${copy.ahead}, ahead of the saved version ${copy.doc.version}. Restored the saved version`);
    this.#replace(this.#file(projectId), copy.write);
    return true;
  }

  repairAll(log: (line: string) => void = () => undefined): void {
    let names: string[];
    try { names = readdirSync(this.#dir); } catch { return; }
    for (const id of names.filter(name => PROJECT_ID.test(name))) {
      try {
        const dir = projectDir(this.#dir, id);
        for (const name of readdirSync(dir).filter(n => TEMP_NAME.test(n))) rmSync(join(dir, name), { force: true });
        if (this.repair(id)) log(`[INFO] Restored acceptance.json of product ${id} from the saved version`);
      } catch (error) {
        log(`[WARN] Could not check acceptance.json of product ${id}: ${(error as Error).message}`);
      }
    }
  }

  writeDraft(projectId: string, conversationId: string, doc: AcceptanceDoc): void {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    this.#draftConversation(projectId, conversationId);
    this.repair(projectId);
    const product = this.#readFile(projectId);
    const frozen = Math.max(product?.version ?? 0, this.latest(projectId)?.version ?? 0);
    if (frozen >= 1) throw new AcceptanceError('frozen', { version: frozen });
    const file = conversationDraftFile(this.#dir, projectId, conversationId);
    const current = this.#readAt(file);
    const taintedRuns = [...new Set([...(current?.taintedRuns ?? []), ...(doc.taintedRuns ?? [])])];
    mkdirSync(join(file, '..'), { recursive: true });
    this.#replace(file, { ...doc, version: 0, taintedRuns });
  }

  verifyFrozen(projectId: string): 'ok' | 'mismatch' | 'not_frozen' {
    const row = this.latest(projectId);
    if (!row) return 'not_frozen';
    let file: AcceptanceDoc | undefined;
    try { file = this.#readFile(projectId); } catch { return 'mismatch'; }
    return file && file.version === row.version && frozenHash(file) === row.hash ? 'ok' : 'mismatch';
  }

  freeze(projectId: string, doc: AcceptanceDoc, row: Pick<AcceptanceVersionRow, 'plan_hash' | 'source' | 'created_at'>, inside: () => string | null): AcceptanceVersionRow {
    return this.#freeze(projectId, withStates(doc, {}), {}, row, inside);
  }

  #freeze(projectId: string, doc: AcceptanceDoc, states: ItemStates, row: Pick<AcceptanceVersionRow, 'plan_hash' | 'source' | 'created_at'>, inside: () => string | null): AcceptanceVersionRow {
    const file = this.#file(projectId);
    const temp = this.#stage(file, doc);
    let saved: AcceptanceVersionRow;
    try {
      saved = transaction(this.#db, () => {
        const made: AcceptanceVersionRow = { project_id: projectId, version: doc.version, hash: frozenHash(doc), content: JSON.stringify(doc), ...row, build_task_id: inside(), item_states: JSON.stringify(states) };
        this.#db.prepare('INSERT INTO acceptance_versions (project_id, version, hash, content, plan_hash, source, build_task_id, created_at, item_states) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(made.project_id, made.version, made.hash, made.content, made.plan_hash, made.source, made.build_task_id, made.created_at, made.item_states);
        return made;
      });
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    try { this.#publish(temp, file); } catch (error) {
      rmSync(temp, { force: true });
      this.#log(`[WARN] Fixed version ${doc.version} of the acceptance list of product ${projectId}, but could not replace acceptance.json (${(error as Error).message}). It is restored from the saved version before the next write or at startup`);
    }
    return saved;
  }

  #stage(file: string, doc: AcceptanceDoc): string {
    const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try { this.#write(temp, `${JSON.stringify(doc, null, 2)}\n`); } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    return temp;
  }

  #publish(temp: string, file: string): void {
    for (let attempt = 0; ; attempt++) {
      try { this.#rename(temp, file); return; } catch (error) {
        if (attempt >= 4 || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
      }
    }
  }

  #replace(file: string, doc: AcceptanceDoc): void {
    const temp = this.#stage(file, doc);
    try { this.#publish(temp, file); } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
