import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SpeechRow } from '../db/conversations.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { acceptanceText, type AcceptanceMessageKey } from '../shared/messages/acceptance.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { stripAttachments } from '../uploads/store.ts';
import { CHECK_COMMAND_MAX, checkCommandOf, PROJECT_ID, projectDir } from './store.ts';

export const ACCEPTANCE_FILE = 'acceptance.json';
export const ACCEPTANCE_MAX_ITEMS = 60;
export const ACCEPTANCE_RESULT_MAX = 300;
export const ACCEPTANCE_QUOTE_MAX = 1000;
export const MIN_QUOTE_WEIGHT = 12;

export type AcceptanceState = 'open' | 'met' | 'unverified';
export type UncheckedReason = 'not_found' | 'too_short' | 'not_next_reply';
export type AcceptanceCheck = { kind: 'command'; command: string } | { kind: 'look' } | { kind: 'read' };
export type ClaimedSource =
  | { kind: 'owner_words'; quote: string }
  | { kind: 'owner_choice'; question: string; answer: string }
  | { kind: 'ai_added' };
export type AcceptanceSource =
  | { kind: 'owner_words'; quote: string; messageId: number; conversationId: string; context?: string }
  | { kind: 'owner_choice'; question: string; questionMessageId: number; answer: string; answerMessageId: number; conversationId: string }
  | { kind: 'ai_added'; claimed?: 'owner_words' | 'owner_choice'; reason?: UncheckedReason; quote?: string; question?: string; answer?: string }
  | { kind: 'owner_edit' };

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
}

export interface DraftInput {
  items: Array<{ result: string; source: ClaimedSource; check: AcceptanceCheck }>;
  notDoing?: Array<{ text: string; source: ClaimedSource }> | undefined;
}

export class AcceptanceError extends LocalizedError<AcceptanceMessageKey> {
  constructor(code: AcceptanceMessageKey, params?: MessageParams) { super(acceptanceText, code, params); }
}

const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu;
const SHORT_ANSWER = /^(?:[A-H]|[1-9]|yes|no|Yes|No|YES|NO|はい|いいえ)$/u;
const OPTION_LETTER = /^[A-H]$/u;
const OPTION_DIGIT = /^[1-9]$/u;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TEMP_NAME = /^acceptance\.json\.tmp-[0-9a-f]+$/u;

export const normalizeQuote = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');

export function quoteWeight(text: string): number {
  let weight = 0;
  for (const char of normalizeQuote(text)) weight += WIDE.test(char) ? 2 : 1;
  return weight;
}

interface Line { text: string; norm: string; plain: boolean; mark: boolean; number: number | null; style: string | null }
interface OwnerView { text: string; norm: string; at: number[]; starts: number[]; ends: number[] }

interface Spoken {
  id: number; conversationId: string; owner: boolean; generated: boolean; raw: string; norm: string;
  next?: Spoken | undefined; peers?: Spoken[] | undefined; laterAt?: number | undefined;
  lines?: Line[] | undefined; view?: OwnerView | undefined;
}

export interface Speech { owner: Spoken[]; assistant: Spoken[]; laterOwner: (from: Spoken) => Spoken[] }

export function prepareSpeech(rows: readonly SpeechRow[]): Speech {
  const all: Spoken[] = rows.map(row => {
    const owner = row.role === 'user';
    const raw = owner ? stripAttachments(row.text) : row.text;
    return { id: row.id, conversationId: row.conversation_id, owner, generated: row.generated === 1, raw, norm: normalizeQuote(raw) };
  });
  const byConversation = new Map<string, Spoken[]>();
  for (const spoken of all) {
    const list = byConversation.get(spoken.conversationId) ?? [];
    list.push(spoken);
    byConversation.set(spoken.conversationId, list);
  }
  for (const list of byConversation.values()) {
    list.sort((a, b) => a.id - b.id);
    const peers = list.filter(s => s.owner && !s.generated);
    let next: Spoken | undefined;
    let laterAt = peers.length;
    for (let i = list.length - 1; i >= 0; i--) {
      const spoken = list[i]!;
      if (!spoken.owner) {
        spoken.next = next;
        spoken.peers = peers;
        spoken.laterAt = laterAt;
      } else {
        next = spoken;
        if (!spoken.generated) laterAt--;
      }
    }
  }
  const newestFirst = (list: Spoken[]) => list.sort((a, b) => b.id - a.id);
  return {
    owner: newestFirst(all.filter(s => s.owner && !s.generated)),
    assistant: newestFirst(all.filter(s => !s.owner)),
    laterOwner: from => from.peers?.slice(from.laterAt) ?? [],
  };
}

const MAX_ASKED = 20;
const CONTEXT_MAX = 500;
const ELLIPSIS = '…';
const ANSWER_END = '(?=[ \\t]*$|[).:,;!?\\u3001\\u3002]|[ \\t]*[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]|[ \\t]+[(\\-\\u2013])';
const NUMBER_MARK = '(?:Q[ \\t]*)?(\\d{1,2})(?:[.):](?!\\d)[ \\t]*|(?=[A-H](?![A-Za-z])))';
const NUMBERED = new RegExp(`(?:^|[\\s,;\\u3001(])${NUMBER_MARK}(?=\\S)`, 'mu');
const QUESTION_NUMBER = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?(Q[ \t]*)?(\d{1,2})([.):])(?!\d)/u;
const HTML_START = /^[ \t]{0,3}<[A-Za-z!?/]/u;
const TAG = /<[^<>\n]*>/u;
const REF_DEF = /^[ \t]{0,3}\[[^\n]*\]:/u;
const STOPS = '.!?\\u3002\\uFF01\\uFF1F';
const SENTENCE = new RegExp(`[^${STOPS}\\n]+[${STOPS}]*|[${STOPS}]+`, 'gu');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

interface TokenPatterns { head: RegExp; numbered: RegExp; offered: RegExp }
const TOKEN_PATTERNS = new Map<string, TokenPatterns>();

function patternsOf(token: string): TokenPatterns {
  let patterns = TOKEN_PATTERNS.get(token);
  if (!patterns) {
    const t = escapeRegExp(token);
    patterns = {
      head: new RegExp(`^[ \\t]*${t}${ANSWER_END}`, 'mu'),
      numbered: new RegExp(`(?:^|[\\s,;\\u3001(])${NUMBER_MARK}${t}${ANSWER_END}`, 'gmu'),
      offered: new RegExp(`\\(${t}\\)|(?<![A-Za-z0-9])${t}[).:]`, 'u'),
    };
    TOKEN_PATTERNS.set(token, patterns);
  }
  return patterns;
}

function linesOf(message: Spoken): Line[] {
  let html = false;
  let comment = false;
  let afterDefinition = false;
  return message.raw.normalize('NFKC').split('\n').map(text => {
    if (text.trim() === '') html = false;
    if (HTML_START.test(text)) html = true;
    const definition = REF_DEF.test(text);
    const opens = text.includes('<!--');
    const plain = !html && !comment && !opens && !text.includes('-->') && !TAG.test(text) && !text.includes('](') && !definition && !afterDefinition;
    if (opens && !text.slice(text.indexOf('<!--')).includes('-->')) comment = true;
    else if (comment && text.includes('-->')) comment = false;
    afterDefinition = definition;
    const numbered = QUESTION_NUMBER.exec(text);
    return { text, norm: normalizeQuote(text), plain, mark: text.includes('?'), number: numbered ? Number(numbered[2]) : null, style: numbered ? `${numbered[1] ? 'Q' : ''}${numbered[3]}` : null };
  });
}

interface Asked { number: number | null; block: string; questionMark: boolean; multi: boolean }

function askedIn(message: Spoken, question: string, claimedMark: boolean): Asked | undefined {
  const lines = message.lines ??= linesOf(message);
  let span: [number, number] | undefined;
  for (let i = 0; i < lines.length;) {
    if (!lines[i]!.plain) { i++; continue; }
    const offsets: number[] = [];
    let joined = '';
    let j = i;
    for (; j < lines.length && lines[j]!.plain; j++) { offsets.push(joined.length); joined += lines[j]!.norm; }
    const at = joined.lastIndexOf(question);
    if (at >= 0) {
      const lineAt = (pos: number) => { let k = offsets.length - 1; while (offsets[k]! > pos) k--; return i + k; };
      span = [lineAt(at), lineAt(at + question.length - 1)];
    }
    i = j;
  }
  if (!span) return undefined;
  const [start, end] = span;
  for (let k = start; k <= end; k++) {
    if (k > start && lines[k]!.number !== null) return undefined;
    if (k < end && lines[k]!.mark) return undefined;
  }
  const head = lines[start]!;
  const spanMark = lines[end]!.mark;
  if (!spanMark && head.number === null) return undefined;
  const asks = (line: Line) => line.mark || (line.number !== null && line.style !== ')') || (head.style !== null && line.style === head.style);
  let count = 0;
  for (const line of lines) if (asks(line)) count++;
  let stop = end + 1;
  while (stop < lines.length && !asks(lines[stop]!)) stop++;
  const block = lines.slice(start, stop).filter(line => line.plain).map(line => line.text).join('\n');
  return { number: head.number, block, questionMark: claimedMark && spanMark, multi: count > 1 };
}

function placed(raw: string, token: string, asked: Asked): boolean {
  const text = raw.normalize('NFKC').trim();
  const patterns = patternsOf(token);
  if (NUMBERED.test(text)) {
    if (asked.number === null) return false;
    for (const match of text.matchAll(patterns.numbered)) if (Number(match[1]) === asked.number) return true;
    return false;
  }
  if (asked.multi) return false;
  return text === token || patterns.head.test(text);
}

function answered(reply: Spoken, answer: string, asked: Asked): boolean {
  if (quoteWeight(answer) >= MIN_QUOTE_WEIGHT) return !asked.multi && reply.norm.includes(normalizeQuote(answer));
  const token = answer.normalize('NFKC').trim();
  const option = OPTION_LETTER.test(token) || OPTION_DIGIT.test(token);
  const offered = patternsOf(token).offered.test(asked.block);
  if (option ? !offered : !(asked.questionMark || offered)) return false;
  return placed(reply.raw, token, asked);
}

function foldChar(text: string, i: number): [string, number] {
  const code = text.codePointAt(i)!;
  if (code < 128) {
    if (code === 32 || (code >= 9 && code <= 13)) return ['', 1];
    return [code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[i]!, 1];
  }
  const char = String.fromCodePoint(code);
  return [normalizeQuote(char), char.length];
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

function contextOf(message: Spoken, quote: string): string | undefined {
  const view = message.view ??= ownerViewOf(message);
  const folded = fold(quote);
  const index = folded ? view.norm.indexOf(folded) : -1;
  if (index < 0 || view.starts.length === 0) return undefined;
  const { text } = view;
  const from = view.at[index]!;
  const lastAt = view.at[index + folded.length - 1]!;
  const to = lastAt + (isHigh(text.charCodeAt(lastAt)) ? 2 : 1);
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
  if (claimed.kind === 'owner_words') {
    const unchecked = (reason: UncheckedReason): AcceptanceSource => ({ kind: 'ai_added', claimed: 'owner_words', reason, quote: claimed.quote });
    if (quoteWeight(claimed.quote) < MIN_QUOTE_WEIGHT) return unchecked('too_short');
    const quote = normalizeQuote(claimed.quote);
    const found = speech.owner.find(s => s.norm.includes(quote));
    if (!found) return unchecked('not_found');
    const context = contextOf(found, quote);
    return { kind: 'owner_words', quote: claimed.quote, messageId: found.id, conversationId: found.conversationId, ...(context === undefined ? {} : { context }) };
  }
  const unchecked = (reason: UncheckedReason): AcceptanceSource => ({ kind: 'ai_added', claimed: 'owner_choice', reason, question: claimed.question, answer: claimed.answer });
  if (quoteWeight(claimed.question) < MIN_QUOTE_WEIGHT) return unchecked('too_short');
  const answer = claimed.answer.normalize('NFKC').trim();
  if (quoteWeight(claimed.answer) < MIN_QUOTE_WEIGHT && !SHORT_ANSWER.test(answer)) return unchecked('too_short');
  const question = normalizeQuote(claimed.question);
  const questionMark = claimed.question.normalize('NFKC').includes('?');
  const asked: Array<[Spoken, Asked]> = [];
  for (const s of speech.assistant) {
    if (!s.norm.includes(question)) continue;
    const found = askedIn(s, question, questionMark);
    if (found) asked.push([s, found]);
    if (asked.length >= MAX_ASKED) break;
  }
  for (const [q, found] of asked) {
    const reply = q.next;
    if (reply && !reply.generated && answered(reply, answer, found)) {
      return { kind: 'owner_choice', question: claimed.question, questionMessageId: q.id, answer: claimed.answer, answerMessageId: reply.id, conversationId: q.conversationId };
    }
  }
  if (asked.some(([q, found]) => speech.laterOwner(q).some(reply => answered(reply, answer, found)))) return unchecked('not_next_reply');
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

function docOf(raw: string): AcceptanceDoc | undefined {
  try {
    const doc = JSON.parse(raw) as AcceptanceDoc;
    if (doc?.schema !== 1 || !Number.isInteger(doc.version) || doc.version < 0 || !Array.isArray(doc.items) || !Array.isArray(doc.notDoing)) return undefined;
    return doc;
  } catch { return undefined; }
}

function overlay(base: AcceptanceDoc, file: AcceptanceDoc | undefined): AcceptanceDoc {
  const live = new Map((file?.items ?? []).map(entry => [entry.id, entry]));
  return {
    ...base,
    items: base.items.map(entry => {
      const current = live.get(entry.id);
      return current ? { ...entry, state: current.state, evidence: current.evidence } : entry;
    }),
  };
}

export interface AcceptanceIo {
  writeFileSync?: (path: string, data: string) => void;
  renameSync?: (from: string, to: string) => void;
  archived?: (projectId: string) => boolean;
}

export class AcceptanceStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #write: (path: string, data: string) => void;
  readonly #rename: (from: string, to: string) => void;
  readonly #archived: (projectId: string) => boolean;

  constructor(db: DatabaseSync, projectsDir: string, io: AcceptanceIo = {}) {
    this.#db = db;
    this.#dir = projectsDir;
    this.#write = io.writeFileSync ?? ((path, data) => writeFileSync(path, data));
    this.#rename = io.renameSync ?? renameSync;
    this.#archived = io.archived ?? (() => false);
  }

  #file(projectId: string): string { return join(projectDir(this.#dir, projectId), ACCEPTANCE_FILE); }

  #readFile(projectId: string): AcceptanceDoc | undefined {
    const file = this.#file(projectId);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new AcceptanceError('not_file');
    return docOf(readFileSync(file, 'utf8'));
  }

  latest(projectId: string): AcceptanceVersionRow | undefined {
    return this.#db.prepare('SELECT * FROM acceptance_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId) as AcceptanceVersionRow | undefined;
  }

  #behind(projectId: string): { file: AcceptanceDoc | undefined; doc: AcceptanceDoc } | undefined {
    const row = this.latest(projectId);
    const file = this.#readFile(projectId);
    if (!row || (file && file.version >= row.version)) return undefined;
    const stored = docOf(row.content);
    return stored ? { file, doc: overlay(stored, file) } : undefined;
  }

  read(projectId: string): AcceptanceDoc | undefined {
    return this.#behind(projectId)?.doc ?? this.#readFile(projectId);
  }

  repair(projectId: string): boolean {
    const behind = this.#behind(projectId);
    if (!behind) return false;
    this.#replace(this.#file(projectId), behind.doc);
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

  writeDraft(projectId: string, doc: AcceptanceDoc): void {
    if (this.#archived(projectId)) throw new AcceptanceError('archived');
    this.repair(projectId);
    const current = this.#readFile(projectId);
    const frozen = Math.max(current?.version ?? 0, this.latest(projectId)?.version ?? 0);
    if (frozen >= 1) throw new AcceptanceError('frozen', { version: frozen });
    const taintedRuns = [...new Set([...(current?.taintedRuns ?? []), ...(doc.taintedRuns ?? [])])];
    this.#replace(this.#file(projectId), { ...doc, version: 0, taintedRuns });
  }

  verifyFrozen(projectId: string): 'ok' | 'mismatch' | 'not_frozen' {
    const row = this.latest(projectId);
    if (!row) return 'not_frozen';
    let file: AcceptanceDoc | undefined;
    try { file = this.#readFile(projectId); } catch { return 'mismatch'; }
    return file && file.version === row.version && frozenHash(file) === row.hash ? 'ok' : 'mismatch';
  }

  #replace(file: string, doc: AcceptanceDoc): void {
    const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      this.#write(temp, `${JSON.stringify(doc, null, 2)}\n`);
      for (let attempt = 0; ; attempt++) {
        try { this.#rename(temp, file); return; } catch (error) {
          if (attempt >= 4 || !BUSY.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        }
      }
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }
}
