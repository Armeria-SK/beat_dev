import { lstatSync, readdirSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const KEEP_DAYS = 30;
export const KEEP_TOTAL_BYTES = 500 * 1024 * 1024;
const PRUNE_EVERY_MS = 10 * 60_000;
const TMP_AGE_MS = 60 * 60_000;
const HASH = /^[0-9a-f]{64}$/u;

export interface PruneLimits { maxAgeMs: number; maxBytes: number }

export const DEFAULT_LIMITS: PruneLimits = { maxAgeMs: KEEP_DAYS * 86_400_000, maxBytes: KEEP_TOTAL_BYTES };

const lstatOf = (path: string): Stats | undefined => {
  try { return lstatSync(path, { throwIfNoEntry: false }); } catch { return undefined; }
};

const plainDir = (st: Stats | undefined): boolean => Boolean(st && st.isDirectory() && !st.isSymbolicLink());

const listOf = (dir: string): string[] => {
  try { return readdirSync(dir); } catch { return []; }
};

const drop = (path: string): boolean => {
  try { unlinkSync(path); return true; } catch { return false; }
};

export function pruneChanges(db: DatabaseSync, dir: string, now: number, limits: PruneLimits = DEFAULT_LIMITS): { rows: number; files: number } {
  const rows = Number(db.prepare('DELETE FROM file_changes WHERE created_at < ?').run(now - limits.maxAgeMs).changes);
  const used = new Set((db.prepare('SELECT DISTINCT project_id, before_hash FROM file_changes WHERE kept = 1 AND before_hash IS NOT NULL').all() as Array<{ project_id: string; before_hash: string }>)
    .map(r => `${r.project_id}/${r.before_hash}`));
  const sizes = new Map<string, number>();
  let files = 0;
  let total = 0;
  if (!plainDir(lstatOf(dir))) return { rows, files };
  for (const project of listOf(dir)) {
    const folder = join(dir, project);
    if (!plainDir(lstatOf(folder))) continue;
    for (const name of listOf(folder)) {
      const file = join(folder, name);
      const st = lstatOf(file);
      if (!st || !st.isFile() || st.isSymbolicLink()) continue;
      if (!HASH.test(name)) {
        if (name.endsWith('.tmp') && st.mtimeMs < now - TMP_AGE_MS && drop(file)) files++;
        continue;
      }
      const key = `${project}/${name}`;
      if (!used.has(key)) { if (drop(file)) files++; continue; }
      sizes.set(key, st.size);
      total += st.size;
    }
  }
  let removed = rows;
  const oldest = db.prepare('SELECT id, project_id, before_hash FROM file_changes WHERE kept = 1 AND before_hash IS NOT NULL ORDER BY created_at, id LIMIT 1');
  const stillUsed = db.prepare('SELECT 1 FROM file_changes WHERE project_id = ? AND before_hash = ? AND kept = 1 LIMIT 1');
  while (total > limits.maxBytes) {
    const row = oldest.get() as { id: number; project_id: string; before_hash: string } | undefined;
    if (!row) break;
    db.prepare('DELETE FROM file_changes WHERE id = ?').run(row.id);
    removed++;
    const key = `${row.project_id}/${row.before_hash}`;
    if (stillUsed.get(row.project_id, row.before_hash) || !sizes.has(key)) continue;
    if (drop(join(dir, row.project_id, row.before_hash))) files++;
    total -= sizes.get(key)!;
    sizes.delete(key);
  }
  return { rows: removed, files };
}

let lastPrune = 0;

export function pruneChangesSoon(db: DatabaseSync, dir: string, now: number): void {
  if (now - lastPrune < PRUNE_EVERY_MS) return;
  lastPrune = now;
  pruneChanges(db, dir, now);
}
