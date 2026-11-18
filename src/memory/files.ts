import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { replaceFile } from '../mesh/files.ts';
import { projectDir, type ProjectStore } from '../projects/store.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { storeText, type StoreMessageKey } from '../shared/messages/stores.ts';
import { sanitizeModelInputText } from '../shared/redaction.ts';
import { isInside } from '../tools/hooks/scope.ts';

export const MEMORY_DIR = 'memory';
export const MEMORY_TITLE_MAX = 80;
export const MEMORY_CONTENT_MAX = 4000;
export const MEMORY_FILES_MAX = 200;
export const MEMORY_CREATES_PER_RUN = 5;
const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export type MemoryActor = 'beat' | 'review' | 'owner';
export type MemoryAction = 'create' | 'update' | 'forget' | 'restore' | 'outside' | 'reviewed';
export interface MemoryWriter { actor: MemoryActor; tainted: boolean; runId?: string | null | undefined; conversationId?: string | null | undefined }
export interface MemoryNote { name: string; title: string; mtime: number; hash: string; tainted: boolean; updatedBy: MemoryActor | null }
export interface MemoryFileEvent {
  id: number; project_id: string; name: string; action: MemoryAction; before: string | null; after: string | null; actor: MemoryActor;
  summary: string | null; tainted: number; run_id: string | null; conversation_id: string | null; created_at: number;
}

export class MemoryFileError extends LocalizedError<StoreMessageKey> {
  constructor(code: StoreMessageKey, params?: MessageParams) { super(storeText, code, params); }
}

export const memoryHash = (text: string): string => createHash('sha256').update(text).digest('hex');

// list() と同じ決まり: 拡張子は小文字の .md だけ。フォルダの名前は、大文字小文字を区別しない Windows でだけ区別しない
export function memoryNameOf(rel: string): string | undefined {
  const match = /^([^/]+)\/([^/]+)\.md$/u.exec(rel.replaceAll('\\', '/'));
  if (!match || (process.platform === 'win32' ? match[1]!.toLowerCase() : match[1]) !== MEMORY_DIR) return undefined;
  return NAME.test(match[2]!) ? match[2] : undefined;
}

export function titleOf(text: string, fallback: string): string {
  const first = text.split(/\r?\n/u, 1)[0] ?? '';
  return /^#\s+\S/u.test(first) ? first.replace(/^#\s+/u, '').trim() : fallback;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40).replace(/-+$/u, '');
}

function plainFile(file: string): { mtime: number } | undefined {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.nlink !== 1) throw new MemoryFileError('memfile.unusable');
  return { mtime: Math.floor(stat.mtimeMs) };
}

export interface ProductMemoryDeps { db: DatabaseSync; projectsDir: string; projects?: Pick<ProjectStore, 'get'> | undefined; now?: (() => number) | undefined }

export class ProductMemory {
  readonly #d: ProductMemoryDeps;

  constructor(deps: ProductMemoryDeps) { this.#d = deps; }

  #now(): number { return this.#d.now?.() ?? Date.now(); }

  #dir(projectId: string, create: boolean): string {
    const dir = join(projectDir(this.#d.projectsDir, projectId), MEMORY_DIR);
    let stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat && create) { mkdirSync(dir, { recursive: true }); stat = lstatSync(dir); }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new MemoryFileError('memfile.unusable');
    if (stat && !isInside(realpathSync.native(this.#d.projectsDir), realpathSync.native(dir))) throw new MemoryFileError('memfile.unusable');
    return dir;
  }

  // 大文字小文字を区別しない Windows では、memory/Ideas.md も ideas の名前で開けてしまう。記憶の形ではないファイル（持ち主のもの）は開かない
  #file(projectId: string, name: string, create = false): string {
    if (!NAME.test(name)) throw new MemoryFileError('memfile.bad_name', { name: name.slice(0, 60) });
    const dir = this.#dir(projectId, create);
    const entry = `${name}.md`;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { entries = []; }
    if (!entries.includes(entry) && entries.some(e => e.toLowerCase() === entry)) throw new MemoryFileError('memfile.bad_name', { name });
    return join(dir, entry);
  }

  #writable(projectId: string): void {
    const project = this.#d.projects?.get(projectId);
    if (this.#d.projects && !project) throw new MemoryFileError('memfile.no_product');
    if (project && project.archived_at !== null) throw new MemoryFileError('memfile.archived');
  }

  #latest(projectId: string, name: string): MemoryFileEvent | undefined {
    return this.#d.db.prepare('SELECT * FROM memory_file_events WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT 1').get(projectId, name) as MemoryFileEvent | undefined;
  }

  #insert(projectId: string, name: string, action: MemoryAction, before: string | null, after: string | null, writer: MemoryWriter, tainted: boolean, summary: string | null): number {
    const row = this.#d.db.prepare(`INSERT INTO memory_file_events (project_id, name, action, before, after, actor, summary, tainted, run_id, conversation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(projectId, name, action, before, after, writer.actor, summary, tainted ? 1 : 0, writer.runId ?? null, writer.conversationId ?? null, this.#now()) as { id: number };
    return row.id;
  }

  #readText(file: string): string | undefined {
    return plainFile(file) ? readFileSync(file, 'utf8') : undefined;
  }

  // 持ち主がフォルダを直接直したとき: 最後の版と違えば outside の行を 1 つ足す（印は今の値のまま）
  #reconcile(projectId: string, name: string, text: string | undefined): MemoryFileEvent | undefined {
    const last = this.#latest(projectId, name);
    if (!last || (last.after ?? undefined) === text) return last;
    const id = this.#insert(projectId, name, 'outside', last.after, text ?? null, { actor: 'owner', tainted: false }, last.tainted === 1, null);
    return { ...last, id, action: 'outside', before: last.after, after: text ?? null, actor: 'owner', summary: null };
  }

  list(projectId: string): MemoryNote[] {
    return this.notesWithText(projectId).map(({ text: _text, ...note }) => note);
  }

  // 一覧と本文を 1 回ずつ読む（振り返りの依頼文が、本文ごとに一覧を読み直さないように）
  notesWithText(projectId: string): Array<MemoryNote & { text: string }> {
    let dir: string;
    try { dir = this.#dir(projectId, false); } catch { return []; }
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const state = new Map((this.#d.db.prepare(`SELECT name, tainted, actor FROM memory_file_events WHERE id IN (SELECT MAX(id) FROM memory_file_events WHERE project_id = ? GROUP BY name)`).all(projectId) as Array<{ name: string; tainted: number; actor: MemoryActor }>).map(r => [r.name, r]));
    const notes: Array<MemoryNote & { text: string }> = [];
    for (const entry of names) {
      const name = entry.endsWith('.md') ? entry.slice(0, -3) : '';
      if (!NAME.test(name)) continue;
      let stat;
      try { stat = plainFile(join(dir, entry)); } catch { continue; }
      if (!stat) continue;
      let text: string;
      try { text = readFileSync(join(dir, entry), 'utf8'); } catch { continue; }
      const row = state.get(name);
      notes.push({ name, title: titleOf(text, name), mtime: stat.mtime, hash: memoryHash(text), tainted: row?.tainted === 1, updatedBy: row?.actor ?? null, text });
    }
    return notes.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  }

  read(projectId: string, name: string): { note: MemoryNote; text: string } {
    const text = this.#readText(this.#file(projectId, name));
    const note = text === undefined ? undefined : this.list(projectId).find(n => n.name === name);
    if (text === undefined || !note) throw new MemoryFileError('memfile.bad_name', { name });
    return { note, text };
  }

  tainted(projectId: string, name: string): boolean { return this.#latest(projectId, name)?.tainted === 1; }

  lastEventId(projectId: string): number {
    return (this.#d.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM memory_file_events WHERE project_id = ?').get(projectId) as { id: number }).id;
  }

  history(projectId: string, name: string, limit = 100): MemoryFileEvent[] {
    return this.#d.db.prepare('SELECT * FROM memory_file_events WHERE project_id = ? AND name = ? ORDER BY id DESC LIMIT ?').all(projectId, name, limit) as unknown as MemoryFileEvent[];
  }

  // 持ち主が消した記憶（消したときに印が無かったものだけ。振り返りが同じことを覚え直さないため）
  forgottenByOwner(projectId: string, limit = 20): { forgotten: string[]; hidden: number } {
    const rows = this.#d.db.prepare("SELECT before, tainted FROM memory_file_events WHERE project_id = ? AND action = 'forget' AND actor = 'owner' AND before IS NOT NULL ORDER BY id DESC LIMIT ?").all(projectId, limit) as Array<{ before: string; tainted: number }>;
    return { forgotten: rows.filter(r => r.tainted === 0).map(r => r.before), hidden: rows.filter(r => r.tainted === 1).length };
  }

  #check(title: string, content: string, summary: string | null): string {
    const cleanTitle = title.trim();
    if (!cleanTitle || CONTROLS.test(cleanTitle) || Array.from(cleanTitle).length > MEMORY_TITLE_MAX) throw new MemoryFileError('memfile.bad_title', { max: MEMORY_TITLE_MAX });
    const body = content.trim();
    if (!body) throw new MemoryFileError('memfile.empty');
    const length = Array.from(body).length;
    if (length > MEMORY_CONTENT_MAX) throw new MemoryFileError('memfile.too_long', { length, max: MEMORY_CONTENT_MAX });
    if (sanitizeModelInputText([cleanTitle, body, summary ?? ''].join('\n')).redaction_count > 0) throw new MemoryFileError('memfile.secret');
    return `# ${cleanTitle}\n\n${body}\n`;
  }

  #taken(projectId: string, name: string, dir: string): boolean {
    return lstatSync(join(dir, `${name}.md`), { throwIfNoEntry: false }) !== undefined || this.#latest(projectId, name) !== undefined;
  }

  // 外を読んだ実行が作る名前は題から作らない（note-<数字>）。題から作れないとき（英数字が無い）も同じ
  #newName(projectId: string, title: string, tainted: boolean, dir: string): string {
    const base = tainted ? '' : slug(title);
    if (base) {
      if (!this.#taken(projectId, base, dir)) return base;
      for (let n = 2; ; n++) if (!this.#taken(projectId, `${base}-${n}`, dir)) return `${base}-${n}`;
    }
    for (let n = 1; ; n++) if (!this.#taken(projectId, `note-${n}`, dir)) return `note-${n}`;
  }

  #summary(text: string | null | undefined): string | null {
    const line = (text ?? '').replace(/\s+/gu, ' ').trim();
    return line ? Array.from(line).slice(0, 80).join('') : null;
  }

  #baseOk(text: string | undefined, baseHash: string | null | undefined): void {
    if (baseHash === undefined) return;
    if ((text === undefined ? null : memoryHash(text)) !== baseHash) throw new MemoryFileError('memfile.changed');
  }

  save(projectId: string, input: { title: string; content: string; summary?: string | null | undefined }, writer: MemoryWriter): { name: string; eventId: number } {
    this.#writable(projectId);
    const summary = this.#summary(input.summary);
    const text = this.#check(input.title, input.content, summary);
    const saved = transaction(this.#d.db, () => {
      if (this.list(projectId).length >= MEMORY_FILES_MAX) throw new MemoryFileError('memfile.too_many', { max: MEMORY_FILES_MAX });
      if (writer.runId && writer.actor !== 'owner') {
        const made = (this.#d.db.prepare("SELECT COUNT(*) AS n FROM memory_file_events WHERE run_id = ? AND action = 'create'").get(writer.runId) as { n: number }).n;
        if (made >= MEMORY_CREATES_PER_RUN) throw new MemoryFileError('memfile.run_limit', { max: MEMORY_CREATES_PER_RUN });
      }
      const dir = this.#dir(projectId, true);
      const name = this.#newName(projectId, input.title.trim(), writer.tainted, dir);
      const eventId = this.#insert(projectId, name, 'create', null, text, writer, writer.tainted, summary);
      return { name, eventId, file: join(dir, `${name}.md`) };
    });
    this.#write(saved.eventId, () => replaceFile(saved.file, text));
    return { name: saved.name, eventId: saved.eventId };
  }

  // 履歴の行を先に確定してからファイルを書く。間で落ちても、ファイルより履歴が先に進むだけで、次に読むとき outside の行が今の印のまま足される（印は消えない）。
  // 書けなかったときは、いま足した行を消して投げ直す
  #write(eventId: number, apply: () => void): void {
    try { apply(); } catch (error) {
      this.#d.db.prepare('DELETE FROM memory_file_events WHERE id = ?').run(eventId);
      throw error;
    }
  }

  update(projectId: string, name: string, input: { title?: string | undefined; content: string; summary?: string | null | undefined }, writer: MemoryWriter, baseHash?: string | null): { name: string; eventId: number } {
    this.#writable(projectId);
    const file = this.#file(projectId, name);
    const current = this.#readText(file);
    if (current === undefined) throw new MemoryFileError('memfile.bad_name', { name });
    this.#baseOk(current, baseHash);
    const summary = this.#summary(input.summary);
    const text = this.#check(input.title ?? titleOf(current, name), input.content, summary);
    if (text === current) throw new MemoryFileError('memfile.unchanged');
    const eventId = transaction(this.#d.db, () => {
      const last = this.#reconcile(projectId, name, current);
      return this.#insert(projectId, name, 'update', current, text, writer, writer.tainted || last?.tainted === 1, summary);
    });
    this.#write(eventId, () => replaceFile(file, text));
    return { name, eventId };
  }

  forget(projectId: string, name: string, reason: string | null, writer: MemoryWriter, baseHash?: string | null): { name: string; eventId: number } {
    this.#writable(projectId);
    const file = this.#file(projectId, name);
    const current = this.#readText(file);
    if (current === undefined) throw new MemoryFileError('memfile.bad_name', { name });
    this.#baseOk(current, baseHash);
    const eventId = transaction(this.#d.db, () => {
      const last = this.#reconcile(projectId, name, current);
      return this.#insert(projectId, name, 'forget', current, null, writer, writer.tainted || last?.tainted === 1, this.#summary(reason));
    });
    this.#write(eventId, () => rmSync(file));
    return { name, eventId };
  }

  restore(projectId: string, name: string, eventId: number, baseHash: string | null): { name: string; eventId: number } {
    this.#writable(projectId);
    const file = this.#file(projectId, name, true);
    const current = this.#readText(file);
    this.#baseOk(current, baseHash);
    const version = this.#d.db.prepare('SELECT * FROM memory_file_events WHERE id = ? AND project_id = ? AND name = ?').get(eventId, projectId, name) as MemoryFileEvent | undefined;
    const text = version?.after ?? version?.before;
    if (!version || text === null || text === undefined) throw new MemoryFileError('memfile.no_version');
    if (text === current) throw new MemoryFileError('memfile.unchanged');
    const id = transaction(this.#d.db, () => {
      const last = this.#reconcile(projectId, name, current);
      return this.#insert(projectId, name, 'restore', current ?? null, text, { actor: 'owner', tainted: false }, last?.tainted === 1 || version.tainted === 1, null);
    });
    this.#write(id, () => replaceFile(file, text));
    return { name, eventId: id };
  }

  // 「読んだので印を外す」: 持ち主の口だけが呼ぶ（AI の道具には無い）
  review(projectId: string, name: string, baseHash: string): { name: string; eventId: number } {
    this.#writable(projectId);
    const current = this.#readText(this.#file(projectId, name));
    if (current === undefined) throw new MemoryFileError('memfile.bad_name', { name });
    this.#baseOk(current, baseHash);
    return transaction(this.#d.db, () => {
      this.#reconcile(projectId, name, current);
      return { name, eventId: this.#insert(projectId, name, 'reviewed', current, current, { actor: 'owner', tainted: false }, false, null) };
    });
  }
}
