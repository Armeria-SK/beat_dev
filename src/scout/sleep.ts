import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { KV } from '../db/kv.ts';
import { headOf, treeMark } from './areas.ts';

export type SleepReason = 'done' | 'deepened' | 'stuck';

export interface Marks { head: string | null; plan: string; kanban: string; tree: string }

export interface ScoutSleep extends Marks { reason: SleepReason; at: number }

export const SCOUT_FLAT_RUNS = 3;

const sleepKey = (projectId: string): string => `scout:sleep:${projectId}`;

const digest = (parts: readonly string[]): string => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);

export function readSleep(kv: KV, projectId: string): ScoutSleep | undefined {
  const raw = kv.getJson<Partial<ScoutSleep>>(sleepKey(projectId));
  if (!raw || typeof raw !== 'object' || !['done', 'deepened', 'stuck'].includes(raw.reason as string)) return undefined;
  return {
    reason: raw.reason as SleepReason, at: typeof raw.at === 'number' ? raw.at : 0,
    head: typeof raw.head === 'string' ? raw.head : null, plan: typeof raw.plan === 'string' ? raw.plan : '', kanban: typeof raw.kanban === 'string' ? raw.kanban : '', tree: typeof raw.tree === 'string' ? raw.tree : '',
  };
}

export function saveSleep(kv: KV, projectId: string, sleep: ScoutSleep): void { kv.setJson(sleepKey(projectId), sleep); }

export function clearSleep(kv: KV, projectId: string): void { kv.delete(sleepKey(projectId)); }

// カンバンの印: 考える実行の行（proposed_by = 'scout-run'）と、まだ持ち主が触っていない提案（inbox の proposal）を除いた行の状態。
// 考える実行が足した提案・深めた経過では変わらず、持ち主の承認・却下・タスクの動きで変わる
export function kanbanMark(db: DatabaseSync, projectId: string): string {
  const rows = db.prepare(`SELECT id, status, COALESCE(check_state, '') AS c FROM tasks WHERE project_id = ? AND proposed_by IS NOT 'scout-run'
    AND NOT (proposal IS NOT NULL AND status = 'inbox') ORDER BY id`).all(projectId) as Array<{ id: string; status: string; c: string }>;
  return digest(rows.map(row => `${row.id}:${row.status}:${row.c}`));
}

// 計画書の印: その製品の計画書（会話ごと）の控えのハッシュ。考える実行は計画書を書けない（plan_write は許す一覧の外）
export function planMark(kv: KV, projectId: string): string {
  const prefix = `plan:${projectId}:`;
  const rows = kv.db.prepare('SELECT key, value FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key').all(prefix.length, prefix) as Array<{ key: string; value: string }>;
  return digest(rows.map(row => {
    try { return `${row.key}:${String((JSON.parse(row.value) as { hash?: unknown }).hash ?? '')}`; } catch { return `${row.key}:`; }
  }));
}

// 安い印（HEAD・計画書・カンバン）。作業フォルダの印 `tree` はファイルを読むので、見回りごとに 1 回までにする（worker が間引く）
export async function quickMarks(db: DatabaseSync, kv: KV, projectId: string, root: string, dataDir: string): Promise<Omit<Marks, 'tree'>> {
  const plan = planMark(kv, projectId);
  const kanban = kanbanMark(db, projectId);
  return { head: await headOf(root, dataDir).catch(() => null), plan, kanban };
}

export async function currentMarks(db: DatabaseSync, kv: KV, projectId: string, root: string, dataDir: string): Promise<Marks> {
  return { ...(await quickMarks(db, kv, projectId, root, dataDir)), tree: await treeMark(root, dataDir).catch(() => '') };
}

export const sameQuickMarks = (a: Omit<Marks, 'tree'>, b: Omit<Marks, 'tree'>): boolean => a.head === b.head && a.plan === b.plan && a.kanban === b.kanban;
