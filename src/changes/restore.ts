import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isInside, isSecretPath } from '../tools/hooks/scope.ts';
import { readCurrent, safeRel, type ChangeEntry } from './diff.ts';
import { insertChange, keepContent, KEEP_MAX_BYTES, readKept, sha256, type FileChangeRow } from './record.ts';

export type Refusal = 'not_changed' | 'hidden' | 'unsafe_path' | 'link' | 'not_kept' | 'cannot_keep' | 'changed' | 'failed';
export type WriteResult = { ok: true } | { ok: false; reason: Refusal };

const WINDOWS = process.platform === 'win32';
const fold = (p: string): string => (WINDOWS ? resolve(p).toLowerCase() : resolve(p));

const lstatOf = (path: string): Stats | undefined | null => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return null; }
};

// 実体がその場所そのもの（途中にリンク・ジャンクションが無い）か
const plainDirAt = (path: string): boolean => {
  const st = lstatOf(path);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  try { return fold(realpathSync.native(path)) === fold(path); } catch { return false; }
};

function renameOver(tmp: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, target); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

// 書き戻しの 1 つの関数。製品のフォルダからの相対パスだけを受け、途中を 1 段ずつ lstat で確かめ（リンク・ジャンクションは断る）、
// 一時ファイル → 名前の付け替えで書き、書いたあとにもう一度実体を確かめる。content が null なら、ファイル 1 つを消す（フォルダは空のときだけ）
export function writeBack(realRoot: string, rel: string, content: Buffer | null, deny: readonly string[]): WriteResult {
  if (!safeRel(rel)) return { ok: false, reason: 'unsafe_path' };
  if (isSecretPath(rel)) return { ok: false, reason: 'hidden' };
  const parts = rel.split('/');
  const target = join(realRoot, ...parts);
  if (deny.some(dir => isInside(dir, target))) return { ok: false, reason: 'hidden' };
  if (!plainDirAt(realRoot)) return { ok: false, reason: 'link' };
  let dir = realRoot;
  for (const part of parts.slice(0, -1)) {
    const next = join(dir, part);
    if (lstatOf(next) === undefined) {
      if (content === null) return { ok: true };
      try { mkdirSync(next); } catch { return { ok: false, reason: 'failed' }; }
    }
    if (!plainDirAt(next)) return { ok: false, reason: 'link' };
    dir = next;
  }
  const st = lstatOf(target);
  if (st === null || (st && (st.isSymbolicLink() || !st.isFile()))) return { ok: false, reason: 'link' };
  try {
    if (content === null) {
      if (!st) return { ok: true };
      unlinkSync(target);
      for (let up = dirname(target); fold(up) !== fold(realRoot) && isInside(realRoot, up); up = dirname(up)) {
        if (!plainDirAt(up)) break;
        try { rmdirSync(up); } catch { break; }
      }
      return { ok: true };
    }
    const tmp = join(dir, `.beat-undo-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmp, content, { flag: 'wx' });
    try { renameOver(tmp, target); } catch (error) {
      try { unlinkSync(tmp); } catch { }
      throw error;
    }
  } catch { return { ok: false, reason: 'failed' }; }
  const after = lstatOf(target);
  if (!after || after.isSymbolicLink() || !after.isFile() || !plainDirAt(dir)) return { ok: false, reason: 'failed' };
  return { ok: true };
}

export interface UndoDeps { db: DatabaseSync; dir: string; projectId: string; realRoot: string; deny: readonly string[]; now: number }
export interface UndoResult { undone: string[]; refused: Array<{ path: string; reason: Refusal }>; redo: string | null }

const hashOrNull = (content: Buffer | null): string | null => (content === null ? null : sha256(content));

// Undo: 元の中身（entry.before）を書き戻す。書く前に今の中身を Redo の控えに取り、取れないファイルは断る
export function undoEntries(deps: UndoDeps, entries: readonly ChangeEntry[], paths: readonly string[] | 'all'): UndoResult {
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  const chosen: Array<{ path: string; entry: ChangeEntry | undefined }> = paths === 'all'
    ? entries.filter(entry => !entry.hidden).map(entry => ({ path: entry.path, entry }))
    : [...new Set(paths)].map(path => ({ path, entry: byPath.get(path) }));
  const batch = randomUUID();
  const out: UndoResult = { undone: [], refused: [], redo: null };
  for (const { path, entry } of chosen) {
    if (!entry) { out.refused.push({ path, reason: 'not_changed' }); continue; }
    if (entry.hidden) { out.refused.push({ path: entry.path, reason: 'hidden' }); continue; }
    if (entry.before === 'unknown') { out.refused.push({ path: entry.path, reason: 'not_kept' }); continue; }
    const current = readCurrent(deps.realRoot, entry.path);
    if (current === 'unknown') { out.refused.push({ path: entry.path, reason: 'link' }); continue; }
    let kept: string | null = null;
    if (current !== null) {
      if (current.length > KEEP_MAX_BYTES) { out.refused.push({ path: entry.path, reason: 'cannot_keep' }); continue; }
      try { kept = keepContent(deps.dir, deps.projectId, current); } catch { out.refused.push({ path: entry.path, reason: 'cannot_keep' }); continue; }
    }
    const wrote = writeBack(deps.realRoot, entry.path, entry.before, deps.deny);
    if (!wrote.ok) { out.refused.push({ path: entry.path, reason: wrote.reason }); continue; }
    insertChange(deps.db, {
      project_id: deps.projectId, place: null, run_id: null, conversation_id: null, task_id: null, batch, path: entry.path, action: 'undo',
      before_hash: kept, after_hash: hashOrNull(entry.before), size: current?.length ?? 0, kept: 1, created_at: deps.now,
    });
    out.undone.push(entry.path);
  }
  if (out.undone.length) out.redo = batch;
  return out;
}

export type RedoResult = { ok: true; redone: string[]; refused: Array<{ path: string; reason: Refusal }> } | { ok: false; reason: 'missing' | 'done' };

// Redo: Undo の直前に取った控えを、同じ書き戻しの関数で書く。Undo のあとに中身が変わったファイルは書かない
export function redoBatch(deps: UndoDeps, batch: string): RedoResult {
  const rows = deps.db.prepare("SELECT * FROM file_changes WHERE project_id = ? AND batch = ? AND place IS NULL ORDER BY id").all(deps.projectId, batch) as unknown as FileChangeRow[];
  const undos = rows.filter(row => row.action === 'undo');
  if (!undos.length) return { ok: false, reason: 'missing' };
  if (rows.some(row => row.action === 'redo')) return { ok: false, reason: 'done' };
  const out = { ok: true as const, redone: [] as string[], refused: [] as Array<{ path: string; reason: Refusal }> };
  for (const row of undos) {
    const current = readCurrent(deps.realRoot, row.path);
    if (current === 'unknown') { out.refused.push({ path: row.path, reason: 'link' }); continue; }
    if (hashOrNull(current) !== row.after_hash) { out.refused.push({ path: row.path, reason: 'changed' }); continue; }
    let content: Buffer | null = null;
    if (row.before_hash !== null) {
      content = readKept(deps.dir, deps.projectId, row.before_hash);
      if (content === null) { out.refused.push({ path: row.path, reason: 'not_kept' }); continue; }
    }
    const wrote = writeBack(deps.realRoot, row.path, content, deps.deny);
    if (!wrote.ok) { out.refused.push({ path: row.path, reason: wrote.reason }); continue; }
    insertChange(deps.db, {
      project_id: deps.projectId, place: null, run_id: null, conversation_id: null, task_id: null, batch, path: row.path, action: 'redo',
      before_hash: row.after_hash, after_hash: row.before_hash, size: current?.length ?? 0, kept: 0, created_at: deps.now,
    });
    out.redone.push(row.path);
  }
  return out;
}
