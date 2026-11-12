import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { projectText, type ProjectMessageKey } from '../shared/messages/projects.ts';
import { stripHidden } from '../shared/plain-text.ts';
import { isInside, realish } from '../tools/hooks/scope.ts';
import type { Remote } from './remotes.ts';
import { folderGone } from './work-folder.ts';

export const PROJECT_ID = /^[A-Za-z0-9_-]{6,64}$/u;
export const PROJECT_NAME_MAX = 100;
export const CHECK_COMMAND_MAX = 1000;
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}​-‍⁠﻿]/u;

export type ScoutMode = 'off' | 'research' | 'fix';

export interface ProjectRow {
  id: string;
  name: string;
  root: string;
  root_key: string;
  check_command: string | null;
  scout_mode: ScoutMode;
  remotes: string;
  doc_language: string | null;
  doc_language_pinned: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export class ProjectError extends LocalizedError<ProjectMessageKey> {
  constructor(code: ProjectMessageKey, params?: MessageParams) { super(projectText, code, params); }
}

export function projectName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > PROJECT_NAME_MAX || UNSAFE_TEXT.test(name)) throw new ProjectError('bad_name');
  return name;
}

export function checkCommandOf(raw: string | null): string | null {
  const command = raw?.trim() ?? '';
  if (command.length > CHECK_COMMAND_MAX || UNSAFE_TEXT.test(command) || stripHidden(command) !== command) throw new ProjectError('bad_check_command');
  return command || null;
}

export const languageTagOf = (raw: unknown): string | undefined => typeof raw === 'string' && LANGUAGE_TAG.test(raw) ? raw : undefined;

export function projectDir(projectsDir: string, id: string): string {
  if (!PROJECT_ID.test(id)) throw new ProjectError('unknown');
  const dir = join(projectsDir, id);
  if (!isInside(realish(projectsDir), realish(dir))) throw new ProjectError('unknown');
  return dir;
}

export const folderMissing = (project: Pick<ProjectRow, 'root' | 'root_key'>): boolean => folderGone(project.root, project.root_key);

export function defaultProjectName(root: string): string {
  const cleaned = (basename(root) || root).replace(new RegExp(UNSAFE_TEXT.source, 'gu'), '').trim().slice(0, PROJECT_NAME_MAX).trim();
  return cleaned || 'Project';
}

const isRootConflict = (error: unknown): boolean => error instanceof Error && /UNIQUE constraint failed: projects\.root_key/u.test(error.message);

export class ProjectStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #dir: string;

  constructor(db: DatabaseSync, projectsDir: string, now: () => number = Date.now) { this.#db = db; this.#dir = projectsDir; this.#now = now; }

  get(id: string): ProjectRow | undefined {
    if (!PROJECT_ID.test(id)) return undefined;
    return this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  list(options: { archived?: boolean } = {}): ProjectRow[] {
    return this.#db.prepare(`SELECT * FROM projects WHERE archived_at IS ${options.archived ? 'NOT NULL' : 'NULL'} ORDER BY created_at, rowid`).all() as unknown as ProjectRow[];
  }

  create(input: { name: string; root: string; rootKey: string; checkCommand: string | null; remotes?: readonly Remote[] }): ProjectRow {
    const id = randomUUID();
    const now = this.#now();
    try {
      transaction(this.#db, () => {
        this.#db.prepare('INSERT INTO projects (id, name, root, root_key, check_command, remotes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, input.name, input.root, input.rootKey, input.checkCommand, JSON.stringify(input.remotes ?? []), now, now);
        mkdirSync(projectDir(this.#dir, id), { recursive: true });
      });
    } catch (error) {
      if (isRootConflict(error)) throw new ProjectError('root_in_use');
      throw error;
    }
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string | undefined; checkCommand?: string | null | undefined; archived?: boolean | undefined; remotes?: readonly Remote[] | undefined }): ProjectRow {
    const current = this.get(id);
    if (!current) throw new ProjectError('unknown');
    const restoring = patch.archived === false && current.archived_at !== null;
    if (restoring && this.#db.prepare('SELECT 1 FROM projects WHERE root_key = ? AND archived_at IS NULL AND id != ?').get(current.root_key, id)) throw new ProjectError('root_in_use');
    const now = this.#now();
    const archivedAt = patch.archived === undefined ? current.archived_at : patch.archived ? current.archived_at ?? now : null;
    try {
      this.#db.prepare('UPDATE projects SET name = ?, check_command = ?, archived_at = ?, remotes = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? current.name, patch.checkCommand === undefined ? current.check_command : patch.checkCommand, archivedAt, patch.remotes ? JSON.stringify(patch.remotes) : current.remotes, now, id);
    } catch (error) {
      if (isRootConflict(error)) throw new ProjectError('root_in_use');
      throw error;
    }
    return this.get(id)!;
  }

  detectDocLanguage(id: string, tag: string): boolean {
    this.#db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(`doc-language:${id}`, JSON.stringify(tag), this.#now());
    return Number(this.#db.prepare('UPDATE projects SET doc_language = ?1 WHERE id = ?2 AND doc_language IS NOT ?1 AND doc_language_pinned = 0').run(tag, id).changes) === 1;
  }

  #detected(id: string): string | null {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(`doc-language:${id}`) as { value: string } | undefined;
    try { return languageTagOf(row ? JSON.parse(row.value) : undefined) ?? null; } catch { return null; }
  }

  setDocLanguage(id: string, tag: string | null): ProjectRow {
    if (!this.get(id)) throw new ProjectError('unknown');
    this.#db.prepare('UPDATE projects SET doc_language = ?, doc_language_pinned = ?, updated_at = ? WHERE id = ?').run(tag ?? this.#detected(id), tag === null ? 0 : 1, this.#now(), id);
    return this.get(id)!;
  }

  counts(id: string): { proposals: number; questions: number; lastActivityAt: number | null } {
    const tasks = this.#db.prepare(`SELECT COALESCE(SUM(status = 'inbox'), 0) AS proposals, COALESCE(SUM(status = 'waiting' AND waiting_kind = 'question'), 0) AS questions, MAX(updated_at) AS last
      FROM tasks WHERE project_id = ?`).get(id) as { proposals: number; questions: number; last: number | null };
    const chats = this.#db.prepare('SELECT MAX(last_message_at) AS last FROM conversations WHERE project_id = ?').get(id) as { last: number | null };
    const last = Math.max(tasks.last ?? 0, chats.last ?? 0);
    return { proposals: tasks.proposals, questions: tasks.questions, lastActivityAt: last > 0 ? last : null };
  }
}
