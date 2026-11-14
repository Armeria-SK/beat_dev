import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { KV } from '../db/kv.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { planText, type PlanMessageKey } from '../shared/messages/plans.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { estimateTextTokens, prefixLength } from '../engine/tokens.ts';
import { redactSecrets, sanitizeModelInputText } from '../shared/redaction.ts';
import { projectDir } from './store.ts';

export const PLAN_FILE = 'plan.md';
export const PLAN_MAX_CHARS = 64_000;
export const PLAN_BACKUPS = 20;
const BACKUP_NAME = /^plan-\d+-[0-9a-f]+(?:-(ai|owner|outside))?\.md$/u;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029]/gu;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const AUTHORS: ReadonlySet<string> = new Set(['ai', 'owner', 'outside']);

export type PlanAuthor = 'ai' | 'owner';

export interface PlanMeta { hash: string; updatedAt: number; by: PlanAuthor; tainted: boolean; conversationId: string | null; runId: string | null; reviewedAt?: number }

export interface PlanView { content: string | null; hash: string | null; updated_at: number | null; updated_by: PlanAuthor | 'outside' | null; tainted: boolean }

export interface PlanIo {
  writeFileSync?: (path: string, data: string) => void;
  renameSync?: (from: string, to: string) => void;
  archived?: (projectId: string) => boolean;
}

export class PlanError extends LocalizedError<PlanMessageKey> {
  constructor(code: PlanMessageKey, params?: MessageParams) { super(planText, code, params); }
}

export const planHash = (content: string): string => createHash('sha256').update(content).digest('hex');

export function cleanPlan(raw: string): string {
  const content = stripHidden(raw).replace(CONTROLS, '');
  if (content.length > PLAN_MAX_CHARS) throw new PlanError('too_long', { max: PLAN_MAX_CHARS });
  if (sanitizeModelInputText(content).redaction_count > 0) throw new PlanError('secret');
  return content;
}

const GIST_HEAD_SHARE = 0.7;
const GIST_HEADING = /^#{1,6} /u;
const GIST_HEADING_CHARS = 80;
const GIST_LATER = 'Later sections:';
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/u;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u;
const FENCE_MARK = /^ {0,3}(?:`{3,}|~{3,})/u;
const CONTAINER = /^[ \t]*(?:(?:[-+*>]|\d{1,9}[.)])[ \t]*)*/u;
const HTML_KINDS: readonly (readonly [RegExp, RegExp | null])[] = [
  [/^<!--/u, /-->/u],
  [/^<\?/u, /\?>/u],
  [/^<!\[CDATA\[/u, /\]\]>/u],
  [/^<![A-Za-z]/u, />/u],
  [/^<(?:script|pre|style|textarea)(?=[\s>]|$)/iu, /<\/(?:script|pre|style|textarea)>/iu],
  [/^<\/?[A-Za-z]/u, null],
];
const HTML_SPAN_OPEN = /<!--|<\?|<!\[CDATA\[|<![A-Za-z]/u;
const HTML_TAG = /<\/?[A-Za-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gu;
const LINK_DEFINITION = /(^|\n)[ \t]*(?:(?:[-+*>]|\d{1,9}[.)])[ \t]*)*\[(?:\\[\s\S]|[^[\]\\])*\]:[^\n]*(?:\n[^\n]*\S[^\n]*)*/gu;

function fenceAfter(open: string, line: string): string {
  if (open) {
    const close = FENCE_CLOSE.exec(line);
    return close && close[1]![0] === open[0] && close[1]!.length >= open.length ? '' : open;
  }
  const start = FENCE_OPEN.exec(line);
  return start && !(start[1]![0] === '`' && start[2]!.includes('`')) ? start[1]! : '';
}

function shownToOwner(content: string): string {
  const out: { text: string; code: boolean }[] = [];
  let fence = '';
  let hide: { end: RegExp | null; strict: boolean } | undefined;
  for (const line of content.split(/\r\n|\n|\r/u)) {
    if (fence) {
      out.push({ text: line, code: true });
      fence = fenceAfter(fence, line);
      continue;
    }
    const body = line.slice(CONTAINER.exec(line)![0].length);
    const kind = HTML_KINDS.findIndex(([start]) => start.test(body));
    if (hide) {
      if (hide.end === null) {
        if (line.trim() === '') {
          hide = undefined;
          out.push({ text: '', code: false });
        } else if (FENCE_MARK.test(line) || (kind >= 0 && kind < 5)) break;
        continue;
      }
      if (hide.strict && (FENCE_MARK.test(line) || kind >= 0)) break;
      if (hide.end.test(line)) hide = undefined;
      continue;
    }
    fence = fenceAfter('', line);
    if (fence) {
      out.push({ text: line, code: true });
      continue;
    }
    if (kind >= 0) {
      const [start, end] = HTML_KINDS[kind]!;
      if (end === null || !end.test(body.slice(start.exec(body)![0].length))) hide = { end, strict: body.length !== line.length };
      continue;
    }
    let rest = line;
    let kept = '';
    for (;;) {
      const open = HTML_SPAN_OPEN.exec(rest);
      if (!open) {
        kept += rest;
        break;
      }
      kept += rest.slice(0, open.index);
      const end = HTML_KINDS.find(([start]) => start.test(open[0]))![1]!;
      const tail = rest.slice(open.index + open[0].length);
      const close = end.exec(tail);
      if (!close) {
        hide = { end, strict: true };
        break;
      }
      rest = tail.slice(close.index + close[0].length);
    }
    out.push({ text: kept, code: false });
  }
  const parts: string[] = [];
  for (let at = 0; at < out.length;) {
    if (out[at]!.code) {
      parts.push(out[at++]!.text);
      continue;
    }
    let until = at;
    while (until < out.length && !out[until]!.code) until++;
    parts.push(out.slice(at, until).map(entry => entry.text).join('\n').replace(LINK_DEFINITION, '$1').replace(HTML_TAG, ''));
    at = until;
  }
  return parts.join('\n');
}

export function planGist(content: string, roomChars: number, roomTokens: number): string {
  const text = redactSecrets(shownToOwner(content)).split('\n').map(line => line.trimEnd()).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  const fits = (value: string): boolean => value.length <= roomChars && estimateTextTokens(value) <= roomTokens;
  if (fits(text)) return text;
  const lineCut = (chars: number, tokens: number): number => {
    const length = prefixLength(text, chars, tokens);
    const at = text.lastIndexOf('\n', length);
    return at > 0 ? at : length;
  };
  const headEnd = lineCut(Math.floor(roomChars * GIST_HEAD_SHARE), Math.floor(roomTokens * GIST_HEAD_SHARE));
  const headings: string[] = [];
  let fence = '';
  let at = 0;
  for (const line of text.split('\n')) {
    const code = fence !== '';
    fence = fenceAfter(fence, line);
    if (at >= headEnd && !code && !fence && GIST_HEADING.test(line)) headings.push([...line].slice(0, GIST_HEADING_CHARS).join(''));
    at += line.length + 1;
  }
  if (headings.length === 0) return text.slice(0, lineCut(roomChars, roomTokens)).trimEnd();
  const head = text.slice(0, headEnd).trimEnd();
  let gist = [head, GIST_LATER].filter(Boolean).join('\n');
  if (!fits(`${gist}\n${headings[0]}`)) return fits(head) ? head : '';
  for (const heading of headings) {
    const next = `${gist}\n${heading}`;
    if (!fits(next)) break;
    gist = next;
  }
  return gist;
}

export class PlanStore {
  readonly #kv: KV;
  readonly #dirs: { projects: string; backups: string };
  readonly #now: () => number;
  readonly #write: (path: string, data: string) => void;
  readonly #rename: (from: string, to: string) => void;
  readonly #archived: (projectId: string) => boolean;

  constructor(kv: KV, dirs: { projects: string; backups: string }, now: () => number = Date.now, io: PlanIo = {}) {
    this.#kv = kv;
    this.#dirs = dirs;
    this.#now = now;
    this.#write = io.writeFileSync ?? ((path, data) => writeFileSync(path, data));
    this.#rename = io.renameSync ?? renameSync;
    this.#archived = io.archived ?? (() => false);
  }

  #file(projectId: string): string { return join(projectDir(this.#dirs.projects, projectId), PLAN_FILE); }

  #stat(file: string): Stats | undefined {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new PlanError('not_file');
    return stat;
  }

  read(projectId: string): string | undefined {
    const file = this.#file(projectId);
    return this.#stat(file) ? readFileSync(file, 'utf8') : undefined;
  }

  has(projectId: string): boolean {
    try { return lstatSync(this.#file(projectId), { throwIfNoEntry: false }) !== undefined; } catch { return false; }
  }

  meta(projectId: string): PlanMeta | undefined { return this.#kv.getJson<PlanMeta>(`plan:${projectId}`); }

  view(projectId: string): PlanView {
    const file = this.#file(projectId);
    const stat = this.#stat(file);
    if (!stat) return { content: null, hash: null, updated_at: null, updated_by: null, tainted: false };
    const content = readFileSync(file, 'utf8');
    const hash = planHash(content);
    const meta = this.meta(projectId);
    if (meta?.hash === hash) return { content, hash, updated_at: meta.updatedAt, updated_by: meta.by, tainted: meta.tainted === true };
    return { content, hash, updated_at: Math.floor(stat.mtimeMs), updated_by: 'outside', tainted: meta?.tainted === true };
  }

  write(projectId: string, raw: string, by: Omit<PlanMeta, 'hash' | 'updatedAt'>, baseHash?: string | null): PlanView & { content: string; hash: string; changed: boolean } {
    if (this.#archived(projectId)) throw new PlanError('archived');
    const content = cleanPlan(raw);
    const file = this.#file(projectId);
    mkdirSync(join(file, '..'), { recursive: true });
    const previous = this.read(projectId);
    if (baseHash !== undefined && (previous === undefined ? null : planHash(previous)) !== baseHash) throw new PlanError('changed');
    const hash = planHash(content);
    const known = this.meta(projectId);
    const author = previous !== undefined && known?.hash === planHash(previous) ? known : undefined;
    if (previous === content && author) {
      if (!by.tainted || author.tainted) return { content, hash, updated_at: author.updatedAt, updated_by: author.by, tainted: author.tainted, changed: false };
      this.#kv.setJson(`plan:${projectId}`, { ...author, tainted: true, conversationId: by.conversationId, runId: by.runId });
      return { content, hash, updated_at: author.updatedAt, updated_by: author.by, tainted: true, changed: true };
    }
    if (previous === content && by.by === 'ai') return { ...this.view(projectId), content, hash, changed: false };
    const now = this.#now();
    if (previous !== undefined && previous !== content && !(by.by === 'ai' && author?.by === 'ai' && author.runId !== null && author.runId === by.runId)) {
      this.#backup(projectId, previous, author?.by ?? 'outside', now);
    }
    if (previous !== content) this.#replace(file, content);
    const meta: PlanMeta = by.by === 'owner' && !by.tainted && known?.tainted === true
      ? { hash, updatedAt: now, by: by.by, tainted: true, conversationId: known.conversationId, runId: known.runId }
      : { hash, updatedAt: now, ...by };
    this.#kv.setJson(`plan:${projectId}`, meta);
    return { content, hash, updated_at: now, updated_by: by.by, tainted: meta.tainted, changed: true };
  }

  review(projectId: string, baseHash: string): PlanView & { content: string; hash: string } {
    if (this.#archived(projectId)) throw new PlanError('archived');
    const content = this.read(projectId);
    if (content === undefined || planHash(content) !== baseHash) throw new PlanError('changed');
    const known = this.meta(projectId);
    const now = this.#now();
    const meta: PlanMeta = known?.hash === baseHash
      ? { ...known, tainted: false, reviewedAt: now }
      : { hash: baseHash, updatedAt: now, by: 'owner', tainted: false, conversationId: null, runId: null, reviewedAt: now };
    this.#kv.setJson(`plan:${projectId}`, meta);
    return { content, hash: baseHash, updated_at: meta.updatedAt, updated_by: meta.by, tainted: false };
  }

  #replace(file: string, content: string): void {
    const temp = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      this.#write(temp, content);
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

  #backup(projectId: string, content: string, author: PlanAuthor | 'outside', now: number): void {
    const dir = join(this.#dirs.backups, 'mesh', projectId);
    mkdirSync(dir, { recursive: true });
    const label = AUTHORS.has(author) ? author : 'ai';
    writeFileSync(join(dir, `plan-${String(now).padStart(15, '0')}-${randomBytes(3).toString('hex')}-${label}.md`), content);
    const kept = readdirSync(dir).filter(name => BACKUP_NAME.test(name)).sort();
    const human = kept.findLast(name => /-(?:owner|outside)\.md$/u.test(name));
    for (const name of kept.slice(0, Math.max(0, kept.length - PLAN_BACKUPS))) if (name !== human) rmSync(join(dir, name), { force: true });
  }
}
