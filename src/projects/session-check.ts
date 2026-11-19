import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KV } from '../db/kv.ts';
import { withGit } from '../mesh/folders.ts';
import { gitFolder } from './work-folder.ts';
import { folderMissing, type ProjectRow } from './store.ts';

// beat 8-3（Q-P8-12）: 製品の会話のカード "Session" は、その会話の実行が製品のファイルを変えたときだけ Awaiting check（Mark checked）に置く。
// 変えた = beat のファイルの道具の記録（file_changes。本体の行だけ）か、git の製品で、実行の時間のあいだに書き換わったファイル・できたコミットがある
export const SESSION_WINDOW_MS = 30 * 86_400_000;
const SESSIONS_MAX = 200;
const PATHS_MAX = 2000;
const SLACK_MS = 2000;

export interface SessionMark { changedAt: number | null; checkedAt: number | null; seen: number }
export interface SessionCheck { conversation_id: string; changed_at: number; checked_at: number | null }

const keyOf = (conversationId: string): string => `session-check:${conversationId}`;

function markOf(kv: KV, conversationId: string): SessionMark {
  try {
    const raw = JSON.parse(kv.get(keyOf(conversationId)) ?? '{}') as Partial<SessionMark>;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { changedAt: num(raw.changedAt), checkedAt: num(raw.checkedAt), seen: num(raw.seen) ?? 0 };
  } catch { return { changedAt: null, checkedAt: null, seen: 0 }; }
}

export function markSessionChecked(kv: KV, conversationId: string, now: number): void {
  kv.setJson(keyOf(conversationId), { ...markOf(kv, conversationId), checkedAt: now });
}

interface Window { conversation: string; start: number; end: number }

// git の製品: 書きかけ（status）のファイルの変えた時刻と、HEAD に近いコミットの時刻が、どの実行の時間に入るか
async function gitTouches(root: string, dataDir: string, windows: readonly Window[]): Promise<Set<string>> {
  const hit = new Set<string>();
  if (!windows.length) return hit;
  const since = Math.min(...windows.map(w => w.start));
  const times = await withGit(root, dataDir, async git => {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const log = await git(['log', '-n', '200', `--since=@${Math.floor(since / 1000) - 2}`, '--format=%ct', 'HEAD', '--']);
    const out: number[] = [];
    if (status) {
      const parts = status.toString('utf8').split('\0');
      let seen = 0;
      for (let i = 0; i < parts.length && seen < PATHS_MAX; i++) {
        const entry = parts[i]!;
        if (entry.length < 4) continue;
        if (entry[0] === 'R' || entry[0] === 'C') i++;
        seen++;
        try { const stat = lstatSync(join(root, entry.slice(3)), { throwIfNoEntry: false }); if (stat) out.push(stat.mtimeMs); } catch { /* 読めないものは見ない */ }
      }
    }
    if (log) for (const line of log.toString('utf8').split('\n')) if (/^\d+$/u.test(line)) out.push(Number(line) * 1000);
    return out;
  });
  for (const at of times ?? []) {
    for (const w of windows) if (at >= w.start - SLACK_MS && at <= w.end + SLACK_MS) hit.add(w.conversation);
  }
  return hit;
}

// 製品の会話ごとに、ファイルを変えた時刻（まだ確かめていない分）を返す。project が無ければ全部の製品
export async function sessionChecks(deps: { db: DatabaseSync; kv: KV; dataDir: string; projects: { get(id: string): ProjectRow | undefined }; now: number }, project?: string | null): Promise<SessionCheck[]> {
  if (project === null) return [];
  const runs = deps.db.prepare(`SELECT r.conversation_id AS conversation, c.project_id AS project, r.started_at AS start, COALESCE(r.ended_at, r.started_at + COALESCE(r.duration_ms, 0)) AS "end"
    FROM engine_runs r JOIN conversations c ON c.id = r.conversation_id
    WHERE r.kind = 'chat' AND r.ok IS NOT NULL AND c.project_id IS NOT NULL${project ? ' AND c.project_id = ?' : ''} AND r.started_at >= ?
    AND c.kind = 'chat' AND c.id IN (SELECT id FROM conversations WHERE project_id IS NOT NULL AND kind = 'chat' ORDER BY last_message_at DESC LIMIT ${SESSIONS_MAX})
    ORDER BY r.started_at`).all(...(project ? [project] : []), deps.now - SESSION_WINDOW_MS) as Array<{ conversation: string; project: string; start: number; end: number }>;
  const marks = new Map<string, SessionMark>();
  const dirty = new Set<string>();
  const byProject = new Map<string, Window[]>();
  for (const run of runs) {
    let mark = marks.get(run.conversation);
    if (!mark) { mark = markOf(deps.kv, run.conversation); marks.set(run.conversation, mark); }
    if (run.end <= mark.seen || run.start <= (mark.checkedAt ?? 0)) continue;
    const list = byProject.get(run.project) ?? [];
    list.push({ conversation: run.conversation, start: run.start, end: run.end });
    byProject.set(run.project, list);
  }
  const ids = [...marks.keys()];
  const recorded = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const rows = deps.db.prepare(`SELECT conversation_id AS id, MAX(created_at) AS at FROM file_changes WHERE place IS NULL AND action IN ('create', 'modify')
      AND conversation_id IN (${part.map(() => '?').join(',')}) GROUP BY conversation_id`).all(...part) as Array<{ id: string; at: number }>;
    for (const row of rows) recorded.set(row.id, row.at);
  }
  for (const [projectId, windows] of byProject) {
    const row = deps.projects.get(projectId);
    const touched = row && !folderMissing(row) && gitFolder(row.root) ? await gitTouches(row.root, deps.dataDir, windows) : new Set<string>();
    for (const w of windows) {
      const mark = marks.get(w.conversation)!;
      if (touched.has(w.conversation) && w.end > (mark.changedAt ?? 0)) { mark.changedAt = w.end; dirty.add(w.conversation); }
      if (w.end > mark.seen) { mark.seen = w.end; dirty.add(w.conversation); }
    }
  }
  const out: SessionCheck[] = [];
  for (const [id, mark] of marks) {
    const at = recorded.get(id);
    if (at !== undefined && at > (mark.changedAt ?? 0)) { mark.changedAt = at; dirty.add(id); }
    if (dirty.has(id)) deps.kv.setJson(keyOf(id), mark);
    if (mark.changedAt !== null && mark.changedAt > (mark.checkedAt ?? 0)) out.push({ conversation_id: id, changed_at: mark.changedAt, checked_at: mark.checkedAt });
  }
  return out;
}
