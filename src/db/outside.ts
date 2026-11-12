import type { DatabaseSync } from 'node:sqlite';

// 会話が外の内容を読んだか（分からないときも読んだ扱い）。タスクに結び付く会話（タスクの実行の会話・タスクの振り返り）は、中身を多くの実行が書くので読んだ扱い
export function conversationSawOutside(db: DatabaseSync, conversationId: string | null | undefined, seen: Set<string> = new Set()): boolean {
  if (!conversationId) return true;
  if (seen.has(conversationId)) return false;
  seen.add(conversationId);
  const row = db.prepare('SELECT ever_tainted, source_conversation_id, source_task_id FROM conversations WHERE id = ?').get(conversationId) as { ever_tainted: number; source_conversation_id: string | null; source_task_id: string | null } | undefined;
  if (!row || row.ever_tainted !== 0) return true;
  if (db.prepare('SELECT 1 FROM engine_runs WHERE conversation_id = ? AND tainted = 1 LIMIT 1').get(conversationId) !== undefined) return true;
  if (row.source_task_id) return true;
  if (db.prepare('SELECT 1 FROM tasks WHERE conversation_id = ? LIMIT 1').get(conversationId) !== undefined) return true;
  return row.source_conversation_id !== null && conversationSawOutside(db, row.source_conversation_id, seen);
}
