import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppPaths } from '../paths.ts';
import { PROJECT_ID } from '../projects/store.ts';
import type { ToolContext } from '../tools/types.ts';
import { pruneChangesSoon } from './retention.ts';

export const KEEP_MAX_BYTES = 5 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;

export type ChangeAction = 'create' | 'modify' | 'undo' | 'redo';

export interface FileChangeRow {
  id: number;
  project_id: string;
  place: string | null;
  run_id: string | null;
  conversation_id: string | null;
  task_id: string | null;
  batch: string | null;
  path: string;
  action: ChangeAction;
  before_hash: string | null;
  after_hash: string | null;
  size: number;
  kept: number;
  created_at: number;
}

export const changesDir = (paths: Pick<AppPaths, 'backups'>): string => join(paths.backups, 'changes');

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};

const plainDir = (path: string): boolean => {
  const st = lstatOf(path);
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink());
};

function keepFolder(dir: string, projectId: string): string {
  if (!PROJECT_ID.test(projectId)) throw new Error('bad product id');
  const folder = join(dir, projectId);
  mkdirSync(folder, { recursive: true });
  if (!plainDir(dir) || !plainDir(folder)) throw new Error('the backup folder is not a plain folder');
  return folder;
}

export function keepContent(dir: string, projectId: string, bytes: Uint8Array): string {
  if (bytes.length > KEEP_MAX_BYTES) throw new Error('too large to keep');
  const hash = sha256(bytes);
  const folder = keepFolder(dir, projectId);
  const file = join(folder, hash);
  const st = lstatOf(file);
  if (st && st.isFile() && !st.isSymbolicLink() && st.size === bytes.length) return hash;
  if (st !== undefined) throw new Error('the backup file is not a plain file');
  const tmp = join(folder, `.${hash}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, bytes, { flag: 'wx' });
  try { renameSync(tmp, file); } catch (error) {
    try { unlinkSync(tmp); } catch { }
    throw error;
  }
  return hash;
}

export function readKept(dir: string, projectId: string, hash: string): Buffer | null {
  if (!HASH.test(hash) || !PROJECT_ID.test(projectId)) return null;
  const file = join(dir, projectId, hash);
  const st = lstatOf(file);
  if (!st || !st.isFile() || st.isSymbolicLink() || st.size > KEEP_MAX_BYTES) return null;
  try {
    const bytes = readFileSync(file);
    return sha256(bytes) === hash ? bytes : null;
  } catch { return null; }
}

export function productRel(root: string, abs: string): string | null {
  try {
    const real = realpathSync.native(root);
    const full = join(realpathSync.native(dirname(abs)), basename(abs));
    const rel = relative(real, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]/u);
    return parts.some(part => part.toLowerCase() === '.git') ? null : parts.join('/');
  } catch { return null; }
}

export function insertChange(db: DatabaseSync, row: Omit<FileChangeRow, 'id'>): number {
  const made = db.prepare(`INSERT INTO file_changes (project_id, place, run_id, conversation_id, task_id, batch, path, action, before_hash, after_hash, size, kept, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.project_id, row.place, row.run_id, row.conversation_id, row.task_id, row.batch, row.path, row.action, row.before_hash, row.after_hash, row.size, row.kept, row.created_at);
  return Number(made.lastInsertRowid);
}

export function recordToolWrite(ctx: ToolContext, abs: string, next: string | Uint8Array): void {
  const db = ctx.services?.db;
  const project = ctx.project;
  if (!db || !project?.root) return;
  try {
    const rel = productRel(project.root, abs);
    if (rel === null) return;
    const st = lstatOf(abs);
    if (st === null || (st && (st.isSymbolicLink() || !st.isFile()))) return;
    const dir = changesDir(ctx.paths);
    let before: string | null = null;
    let kept = 1;
    let size = 0;
    if (st) {
      size = st.size;
      if (st.size > KEEP_MAX_BYTES) kept = 0;
      else {
        try { before = keepContent(dir, project.id, readFileSync(abs)); } catch { kept = 0; }
      }
    }
    const now = Date.now();
    insertChange(db, {
      project_id: project.id, place: null, run_id: ctx.runId, conversation_id: ctx.conversationId, task_id: ctx.task?.id ?? ctx.parent?.taskId ?? null, batch: null,
      path: rel, action: st ? 'modify' : 'create', before_hash: before, after_hash: sha256(next), size, kept, created_at: now,
    });
    pruneChangesSoon(db, dir, now);
  } catch (error) {
    ctx.log(`[WARN] Could not keep a copy of ${abs} before writing it: ${(error as Error).message}`);
  }
}
