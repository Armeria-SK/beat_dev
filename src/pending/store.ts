import type { DatabaseSync } from 'node:sqlite';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { pendingText, type PendingMessageKey } from '../shared/messages/pending.ts';
import { redactSecrets } from '../shared/redaction.ts';
import type { PreviewFile } from '../tools/approvals.ts';
import type { RunKind, ToolDef } from '../tools/types.ts';
import { fileFacts, takeSnapshot, type PathFact, type Snapshot } from './snapshot.ts';

export type PendingKind = 'send' | 'delete' | 'hook' | 'policy' | 'owner' | 'judge' | 'judge_failed';
export type PendingStatus = 'waiting' | 'running' | 'ran' | 'failed' | 'rejected' | 'stale' | 'cancelled';

export class PendingError extends LocalizedError<PendingMessageKey> {
  constructor(code: PendingMessageKey, params?: MessageParams) { super(pendingText, code, params); }
}

export interface ParkInput {
  tool: string;
  input: unknown;
  cwd: string;
  kind: PendingKind;
  reason: string;
  checks?: string[] | undefined;
  bind?: string | undefined;
  preview?: PreviewFile[] | undefined;
  targets?: string[] | undefined;
  files?: string[] | undefined;
  runId: string;
  runKind: RunKind;
  conversationId: string;
  taskId?: string | null | undefined;
  projectId?: string | null | undefined;
  tainted?: boolean | undefined;
}

export interface PendingState { snapshot?: Snapshot; preview?: PreviewFile[] }

export interface PendingRow {
  id: number; tool: string; input: string; shown: string; masked: number; cwd: string | null; kind: PendingKind; reason: string; checks: string;
  bind: string | null; state: string | null; files: string | null; run_id: string; run_kind: string; conversation_id: string; task_id: string | null;
  project_id: string | null; tainted: number; status: PendingStatus; reject_reason: string | null; exit_code: number | null; output_preview: string | null;
  full_ref: string | null; created_at: number; decided_at: number | null; ran_at: number | null;
}

export interface PendingView {
  id: number; tool: string; shown: string; masked: number; cwd: string | null; kind: PendingKind; reason: string; checks: string[];
  preview: PreviewFile[]; files: PathFact[]; run_kind: string; conversation_id: string; task_id: string | null; task_title: string | null;
  project_id: string | null; project_name: string | null; tainted: boolean; status: PendingStatus; reject_reason: string | null;
  exit_code: number | null; output_preview: string | null; created_at: number; decided_at: number | null; ran_at: number | null;
}

export interface PendingChange { id: number; status: PendingStatus; projectId: string | null; conversationId: string; taskId: string | null }

export interface PendingFilter {
  status: 'waiting' | 'decided';
  project?: string | undefined;
  task?: string | undefined;
  conversation?: string | undefined;
  before?: number | undefined;
  since?: number | undefined;
  limit?: number | undefined;
}

export interface PendingCounts {
  waiting: number;
  byProject: Record<string, number>;
  acceptanceChanges: Record<string, number>;
  judgedToday: { allowed: number; parked: number };
}

export interface FinishInput { status: 'ran' | 'failed' | 'stale' | 'cancelled'; exitCode?: number | undefined; output?: string | undefined; fullRef?: string | undefined }

const OUTPUT_TAIL = 2000;
const REASON_MAX = 500;
const LIST_MAX = 200;
const MARK = '[REDACTED]';
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const marks = (text: string): number => text.split(MARK).length - 1;

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};

export function outputTail(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > OUTPUT_TAIL ? redacted.slice(-OUTPUT_TAIL) : redacted;
}

export function cleanReason(text: string | undefined): string | null {
  if (text === undefined) return null;
  const cleaned = text.replace(CONTROL, '').trim().slice(0, REASON_MAX);
  return cleaned || null;
}

export interface PendingStoreOptions {
  tools: { get(name: string): ToolDef | undefined };
  dataDir: string;
  now?: (() => number) | undefined;
  onChange?: ((change: PendingChange) => void) | undefined;
}

export class PendingStore {
  readonly #db: DatabaseSync;
  readonly #o: PendingStoreOptions;

  constructor(db: DatabaseSync, options: PendingStoreOptions) { this.#db = db; this.#o = options; }

  onChange: ((change: PendingChange) => void) | undefined;

  #now(): number { return this.#o.now?.() ?? Date.now(); }

  #changed(row: PendingRow): void {
    const change: PendingChange = { id: row.id, status: row.status, projectId: row.project_id, conversationId: row.conversation_id, taskId: row.task_id };
    for (const listener of [this.#o.onChange, this.onChange]) { try { listener?.(change); } catch { } }
  }

  park(input: ParkInput): PendingView {
    const tool = this.#o.tools.get(input.tool);
    if (!tool) throw new PendingError('unknown_tool', { tool: input.tool });
    if (tool.replayable === false) throw new PendingError('not_replayable', { tool: input.tool });
    const raw = tool.summarize?.(input.input as never, 'en').body ?? JSON.stringify(input.input, null, 2);
    const shown = redactSecrets(raw);
    const masked = Math.max(0, marks(shown) - marks(raw));
    const state: PendingState = {
      ...(input.kind === 'delete' ? { snapshot: takeSnapshot(input.cwd, input.targets ?? [], this.#o.dataDir) } : {}),
      ...(input.preview?.length ? { preview: input.preview.map(p => ({ ...p, text: redactSecrets(p.text) })) } : {}),
    };
    const result = this.#db.prepare(`INSERT INTO pending_actions (tool, input, shown, masked, cwd, kind, reason, checks, bind, state, files, run_id, run_kind, conversation_id, task_id, project_id, tainted, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(
      input.tool, JSON.stringify(input.input), shown, masked, input.cwd, input.kind, redactSecrets(input.reason), JSON.stringify((input.checks ?? []).map(c => redactSecrets(c))),
      input.bind ?? null, Object.keys(state).length ? JSON.stringify(state) : null, input.files?.length ? JSON.stringify(input.files) : null,
      input.runId, input.runKind, input.conversationId, input.taskId ?? null, input.projectId ?? null, input.tainted ? 1 : 0, this.#now(),
    );
    const row = this.row(Number(result.lastInsertRowid))!;
    this.#changed(row);
    return this.#view(row);
  }

  row(id: number): PendingRow | undefined {
    return this.#db.prepare('SELECT * FROM pending_actions WHERE id = ?').get(id) as PendingRow | undefined;
  }

  view(id: number): PendingView | undefined {
    const row = this.row(id);
    return row ? this.#view(row) : undefined;
  }

  #view(row: PendingRow): PendingView {
    const state = parseJson<PendingState>(row.state, {});
    const task = row.task_id ? this.#db.prepare('SELECT title FROM tasks WHERE id = ?').get(row.task_id) as { title: string } | undefined : undefined;
    const project = row.project_id ? this.#db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string } | undefined : undefined;
    return {
      id: row.id, tool: row.tool, shown: row.shown, masked: row.masked, cwd: row.cwd, kind: row.kind, reason: row.reason, checks: parseJson<string[]>(row.checks, []),
      preview: state.preview ?? [], files: fileFacts(parseJson<string[]>(row.files, [])), run_kind: row.run_kind, conversation_id: row.conversation_id,
      task_id: row.task_id, task_title: task?.title ?? null, project_id: row.project_id, project_name: project?.name ?? null, tainted: row.tainted === 1,
      status: row.status, reject_reason: row.reject_reason, exit_code: row.exit_code, output_preview: row.output_preview,
      created_at: row.created_at, decided_at: row.decided_at, ran_at: row.ran_at,
    };
  }

  list(filter: PendingFilter): PendingView[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.status === 'waiting') where.push("status IN ('waiting', 'running')");
    else {
      where.push("status NOT IN ('waiting', 'running')");
      if (filter.before !== undefined) { where.push('id < ?'); args.push(filter.before); }
      else if (filter.since !== undefined) { where.push('decided_at >= ?'); args.push(filter.since); }
    }
    if (filter.project !== undefined) { where.push('project_id = ?'); args.push(filter.project); }
    if (filter.task !== undefined) { where.push('task_id = ?'); args.push(filter.task); }
    if (filter.conversation !== undefined) { where.push('conversation_id = ?'); args.push(filter.conversation); }
    const limit = Math.min(Math.max(1, filter.limit ?? LIST_MAX), LIST_MAX);
    const rows = this.#db.prepare(`SELECT * FROM pending_actions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(...args) as unknown as PendingRow[];
    return rows.map(row => this.#view(row));
  }

  counts(since: number): PendingCounts {
    const waiting = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'waiting'").get() as { n: number }).n);
    const byProject: Record<string, number> = {};
    for (const r of this.#db.prepare("SELECT project_id AS id, COUNT(*) AS n FROM pending_actions WHERE status = 'waiting' AND project_id IS NOT NULL GROUP BY project_id").all() as Array<{ id: string; n: number }>) byProject[r.id] = Number(r.n);
    const acceptanceChanges: Record<string, number> = {};
    for (const r of this.#db.prepare("SELECT project_id AS id, COUNT(*) AS n FROM acceptance_changes WHERE status = 'pending' GROUP BY project_id").all() as Array<{ id: string; n: number }>) acceptanceChanges[r.id] = Number(r.n);
    const allowed = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'auto-mode' AND decision = 'allow' AND created_at >= ?").get(since) as { n: number }).n);
    const parked = Number((this.#db.prepare("SELECT COUNT(*) AS n FROM pending_actions WHERE kind IN ('judge', 'judge_failed') AND created_at >= ?").get(since) as { n: number }).n);
    return { waiting, byProject, acceptanceChanges, judgedToday: { allowed, parked } };
  }

  #require(id: number): PendingRow {
    const row = this.row(id);
    if (!row) throw new PendingError('not_found', { id });
    return row;
  }

  claim(id: number): PendingRow {
    const before = this.#require(id);
    const now = this.#now();
    const taken = this.#db.prepare("UPDATE pending_actions SET status = 'running', decided_at = ? WHERE id = ? AND status = 'waiting'").run(now, id);
    if (Number(taken.changes) !== 1) throw new PendingError('not_waiting', { id, status: this.row(id)?.status ?? before.status });
    const row = this.row(id)!;
    this.#changed(row);
    return row;
  }

  finish(id: number, result: FinishInput): PendingView | undefined {
    const now = this.#now();
    const changed = this.#db.prepare(`UPDATE pending_actions SET status = ?, exit_code = ?, output_preview = ?, full_ref = ?, ran_at = ?, decided_at = COALESCE(decided_at, ?)
      WHERE id = ? AND status = 'running'`).run(
      result.status, result.exitCode ?? null, result.output === undefined ? null : outputTail(result.output), result.fullRef ?? null, result.status === 'ran' || result.status === 'failed' ? now : null, now, id,
    );
    if (Number(changed.changes) !== 1) return this.view(id);
    const row = this.row(id)!;
    this.#changed(row);
    return this.#view(row);
  }

  reject(id: number, reason?: string): PendingView {
    const before = this.#require(id);
    const changed = this.#db.prepare("UPDATE pending_actions SET status = 'rejected', reject_reason = ?, decided_at = ? WHERE id = ? AND status = 'waiting'").run(cleanReason(reason), this.#now(), id);
    if (Number(changed.changes) !== 1) throw new PendingError('not_waiting', { id, status: this.row(id)?.status ?? before.status });
    const row = this.row(id)!;
    this.#changed(row);
    return this.#view(row);
  }

  cancelConversations(ids: readonly string[]): number {
    let count = 0;
    for (const id of ids) {
      const rows = this.#db.prepare("SELECT * FROM pending_actions WHERE conversation_id = ? AND status = 'waiting'").all(id) as unknown as PendingRow[];
      for (const row of rows) {
        const changed = this.#db.prepare("UPDATE pending_actions SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'waiting'").run(this.#now(), row.id);
        if (Number(changed.changes) === 1) { count += 1; this.#changed(this.row(row.id)!); }
      }
    }
    return count;
  }

  closeInterrupted(): number {
    const result = this.#db.prepare("UPDATE pending_actions SET status = 'failed', output_preview = ?, ran_at = ? WHERE status = 'running'").run(pendingText('en', 'interrupted'), this.#now());
    return Number(result.changes);
  }
}
