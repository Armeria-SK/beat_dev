import { resolve } from 'node:path';
import { pendingText } from '../shared/messages/pending.ts';
import { preparePending, sentChanges, type ReplayDeps } from './replay.ts';
import { compareSnapshot, takeSnapshot } from './snapshot.ts';
import { realCwd, type PendingRow } from './store.ts';

// 承認しても「古くなった」で動かない行かを、動かさずに確かめる（bind・作業フォルダ・送るファイル・消す物の写し）。持ち主の実行前フックは走らせない
export async function staleReason(row: PendingRow, deps: ReplayDeps): Promise<string | undefined> {
  const prepared = await preparePending(row, deps);
  if ('early' in prepared) return prepared.early.status === 'stale' ? prepared.early.output : undefined;
  const { state, recheck, cwd } = prepared.ready;
  const again = await recheck();
  if (again?.decision === 'deny') return undefined;
  if (again?.cwd !== undefined && resolve(again.cwd) !== resolve(cwd)) return pendingText('en', 'changed_cwd', { path: again.cwd });
  if (state.cwdReal !== undefined && realCwd(cwd) !== state.cwdReal) return pendingText('en', 'changed_cwd', { path: cwd });
  if ((again?.bind ?? null) !== row.bind) return pendingText('en', 'changed_bind');
  const moved = sentChanges(state, again);
  if (moved.length) return pendingText('en', 'changed_files', { changes: moved.join('\n') });
  if (row.kind === 'delete') {
    const before = state.snapshot ?? { git: null, paths: [] };
    const changes = compareSnapshot(before, await takeSnapshot(cwd, before.paths.map(p => p.path), deps.paths.data));
    if (changes.length) return pendingText('en', 'changed_state', { changes: changes.map(c => pendingText('en', 'change_line', { ...c })).join('\n') });
  }
  return undefined;
}

// このタスクの待ちの行のうち、古くなったものを stale で閉じる。閉じた行の番号と理由を返す
export async function sweepStale(taskId: string, deps: ReplayDeps): Promise<Array<{ id: number; reason: string }>> {
  const rows = deps.db.prepare("SELECT * FROM pending_actions WHERE task_id = ? AND status = 'waiting' AND kind != 'runtime' ORDER BY id").all(taskId) as unknown as PendingRow[];
  const closed: Array<{ id: number; reason: string }> = [];
  for (const row of rows) {
    let reason: string | undefined;
    try { reason = await staleReason(row, deps); } catch (error) { deps.log?.(`[WARN] Could not check whether pending item #${row.id} is stale: ${(error as Error).message}`); }
    if (reason !== undefined && deps.store.closeStale(row.id, reason)) closed.push({ id: row.id, reason });
  }
  return closed;
}
