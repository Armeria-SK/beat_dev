import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db/database.ts';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { taskText, type TaskErrorCode } from '../shared/messages/tasks.ts';
import { describeCron, nextRunAt } from './schedule.ts';

export type TaskStatus = 'inbox' | 'ready' | 'running' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'cancelled';
export type TaskOrigin = 'user' | 'self' | 'curiosity' | 'schedule';

export interface Task {
  id: string;
  title: string;
  body: string;
  next_action: string | null;
  done_criteria: string | null;
  status: TaskStatus;
  origin: TaskOrigin;
  priority: number;
  cron: string | null;
  timezone: string | null;
  run_at: number | null;
  parent_id: string | null;
  conversation_id: string | null;
  waiting_kind: 'question' | 'approval' | null;
  waiting_text: string | null;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  result_summary: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  curiosity_id: number | null;
  cancelled_from: TaskStatus | null;
  created_in_conversation: string | null;
  // 1 = 手元のモデルを選んだ会話から作った（手元のモデルだけで動かす）
  local_only: number;
  // 属する製品。NULL は製品に属さないタスク
  project_id: string | null;
  // 提案したもの（あとの段が書く。いまは誰も書かない）
  proposed_by: string | null;
}

export type TaskView = Task & { cron_text: string | null };
export function taskView(task: Task, language: Language = DEFAULT_LANGUAGE): TaskView { return { ...task, cron_text: task.cron ? describeCron(task.cron, language) : null }; }

export interface TaskEvent { id: number; task_id: string; kind: string; actor: string; content: string | null; run_id: string | null; created_at: number }

export interface CreateTask {
  title: string;
  body?: string | undefined;
  nextAction?: string | undefined;
  doneCriteria?: string | undefined;
  origin: TaskOrigin;
  priority?: number | undefined;
  runAt?: number | undefined;
  cron?: string | undefined;
  timezone?: string | undefined;
  propose?: boolean | undefined;
  curiosityId?: number | undefined;
  createdInConversation?: string | undefined;
  localOnly?: boolean | undefined;
  projectId?: string | null | undefined;
  actor: string;
}

export class TaskError extends LocalizedError<TaskErrorCode> {
  constructor(code: TaskErrorCode, params?: MessageParams) { super(taskText, code, params); }
}

const ORIGIN_ORDER = "CASE origin WHEN 'user' THEN 0 WHEN 'schedule' THEN 1 WHEN 'self' THEN 2 ELSE 3 END";
const ACTIVE: TaskStatus[] = ['inbox', 'ready', 'running', 'waiting', 'scheduled'];
// 取り消しを元に戻せる状態（取り消す直前がこの中のどれかのときだけ、戻す先を覚える）
const RESTORABLE: readonly TaskStatus[] = ACTIVE;
const IS_TEMPLATE = 'cron IS NOT NULL AND parent_id IS NULL';
const FINISHED = "status IN ('done', 'failed', 'cancelled')";
const FINISHED_T = 'COALESCE(completed_at, updated_at)';

export const SCHEDULE_MAX_RANGE_MS = 8 * 86_400_000;
export const SCHEDULE_PLANNED_LIMIT = 200;
export const SCHEDULE_PLANNED_TOTAL = 2000;
export const SCHEDULE_RAN_LIMIT = 2000;
export const SCHEDULE_MIN_SLOT_MS = 60_000;

export type RepeatingTask = Task & { last_run: { id: string; status: TaskStatus; summary: string | null; at: number } | null };
export interface FinishedCursor { t: number; id: string }
// 製品での絞り込み: undefined = 全部、null = 製品に属さないものだけ、文字列 = その製品だけ
export type ProjectFilter = string | null | undefined;
const byProject = (project: ProjectFilter): { sql: string; args: string[] } =>
  project === undefined ? { sql: '', args: [] } : project === null ? { sql: ' AND project_id IS NULL', args: [] } : { sql: ' AND project_id = ?', args: [project] };

export interface ScheduleSlot { taskId: string; projectId: string | null; runTaskId: string | null; title: string; start: number; length: number; state: 'past' | 'live' | 'planned' }
export interface Schedule { from: number; to: number; slots: ScheduleSlot[]; templates: Array<{ taskId: string; projectId: string | null; title: string; cron_text: string; truncated: boolean }>; ranTruncated: boolean }

export const TASK_SOFT_REFERENCES = [
  { table: 'curiosity_items', column: 'task_id' },
  { table: 'memory_jobs', column: 'task_id' },
  { table: 'conversations', column: 'source_task_id' },
] as const;
export const TASK_KV_PREFIXES = ['task-split:', 'task-idle:'] as const;
export interface RemovedTask { id: string; title: string; events: number; keptRuns: number }

function firstLine(text: string | null): string | null {
  const line = text?.split('\n').find(l => l.trim())?.trim();
  return line ? line.slice(0, 200) : null;
}

export class TaskStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  onChange: ((task: Task) => void) | undefined;
  // 取り消しを戻すとき、タスクの書き換えと同じ transaction の中で呼ばれる（好奇心の状態を戻すため）
  onUncancelled: ((task: Task) => void) | undefined;
  onDeleted: ((removed: RemovedTask) => void) | undefined;

  readonly #language: () => Language;

  constructor(db: DatabaseSync, now: () => number = Date.now, language: () => Language = () => DEFAULT_LANGUAGE) { this.#db = db; this.#now = now; this.#language = language; }

  get(id: string): Task | undefined {
    return this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  }

  find(idOrPrefix: string): Task | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    if (idOrPrefix.length < 6) return undefined;
    const rows = this.#db.prepare('SELECT * FROM tasks WHERE id LIKE ? LIMIT 2').all(`${idOrPrefix}%`) as unknown as Task[];
    return rows.length === 1 ? rows[0] : undefined;
  }

  byConversation(conversationId: string): Task | undefined {
    return this.#db.prepare('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1').get(conversationId) as Task | undefined;
  }

  list(options: { statuses?: readonly TaskStatus[]; limit?: number; project?: ProjectFilter } = {}): Task[] {
    const statuses = options.statuses ?? ACTIVE;
    const placeholders = statuses.map(() => '?').join(',');
    const filter = byProject(options.project);
    return this.#db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders})${filter.sql} ORDER BY ${ORIGIN_ORDER}, priority, COALESCE(run_at, created_at) LIMIT ?`)
      .all(...statuses, ...filter.args, options.limit ?? 200) as unknown as Task[];
  }

  recentlyFinished(limit = 50, project?: ProjectFilter): Task[] {
    const filter = byProject(project);
    return this.#db.prepare(`SELECT * FROM tasks WHERE status IN ('done', 'failed', 'cancelled')${filter.sql} ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT ?`).all(...filter.args, limit) as unknown as Task[];
  }

  templates(project?: ProjectFilter): RepeatingTask[] {
    const filter = byProject(project);
    const rows = this.#db.prepare(`SELECT * FROM tasks WHERE ${IS_TEMPLATE}${filter.sql} ORDER BY created_at, rowid`).all(...filter.args) as unknown as Task[];
    const last = this.#db.prepare('SELECT id, status, result_summary, COALESCE(completed_at, updated_at) AS at FROM tasks WHERE parent_id = ? ORDER BY rowid DESC LIMIT 1');
    return rows.map(task => {
      const run = last.get(task.id) as { id: string; status: TaskStatus; result_summary: string | null; at: number } | undefined;
      return { ...task, last_run: run ? { id: run.id, status: run.status, summary: firstLine(run.result_summary), at: run.at } : null };
    });
  }

  finishedTotal(project?: ProjectFilter): number {
    const filter = byProject(project);
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${FINISHED} AND NOT (${IS_TEMPLATE})${filter.sql}`).get(...filter.args) as { n: number }).n;
  }

  finishedPage(options: { before?: FinishedCursor | undefined; limit: number; project?: ProjectFilter }): { tasks: Task[]; next: FinishedCursor | null } {
    const before = options.before;
    const filter = byProject(options.project);
    const rows = this.#db.prepare(`SELECT * FROM tasks WHERE ${FINISHED} AND NOT (${IS_TEMPLATE})${filter.sql}
      ${before ? `AND (${FINISHED_T} < ? OR (${FINISHED_T} = ? AND id < ?))` : ''}
      ORDER BY ${FINISHED_T} DESC, id DESC LIMIT ?`).all(...filter.args, ...(before ? [before.t, before.t, before.id] : []), options.limit + 1) as unknown as Task[];
    const tasks = rows.slice(0, options.limit);
    const tail = tasks.at(-1);
    return { tasks, next: rows.length > options.limit && tail ? { t: tail.completed_at ?? tail.updated_at, id: tail.id } : null };
  }

  schedule(from: number, to: number): Schedule {
    const now = this.#now();
    const slots: ScheduleSlot[] = [];
    const ran = this.#db.prepare(`SELECT COALESCE(t.parent_id, t.id) AS taskId, t.project_id AS projectId, t.id AS runTaskId, COALESCE(p.title, t.title) AS title, r.started_at AS start, r.ended_at AS ended
      FROM engine_runs r JOIN tasks t ON t.conversation_id = r.conversation_id LEFT JOIN tasks p ON p.id = t.parent_id
      WHERE r.kind = 'task' AND r.started_at < ? AND COALESCE(r.ended_at, ?) >= ?
      ORDER BY r.started_at DESC LIMIT ?`).all(to, now, from, SCHEDULE_RAN_LIMIT + 1) as Array<{ taskId: string; projectId: string | null; runTaskId: string; title: string; start: number; ended: number | null }>;
    for (const row of ran.slice(0, SCHEDULE_RAN_LIMIT)) {
      slots.push({ taskId: row.taskId, projectId: row.projectId, runTaskId: row.runTaskId, title: row.title, start: row.start, length: Math.max(0, (row.ended ?? now) - row.start), state: row.ended === null ? 'live' : 'past' });
    }
    const lastLength = this.#db.prepare(`SELECT r.ended_at - r.started_at AS length FROM engine_runs r JOIN tasks t ON t.conversation_id = r.conversation_id
      WHERE t.parent_id = ? AND r.kind = 'task' AND r.ended_at IS NOT NULL ORDER BY r.started_at DESC LIMIT 1`);
    const hasRunChild = this.#db.prepare('SELECT 1 FROM tasks WHERE parent_id = ? AND conversation_id IS NOT NULL LIMIT 1');
    const templates: Schedule['templates'] = [];
    const active = this.#db.prepare(`SELECT * FROM tasks WHERE ${IS_TEMPLATE} AND status = 'scheduled' ORDER BY created_at, rowid`).all() as unknown as Task[];
    const perTemplate = Math.min(SCHEDULE_PLANNED_LIMIT, Math.max(1, Math.floor(SCHEDULE_PLANNED_TOTAL / Math.max(1, active.length))));
    for (const template of active) {
      const last = hasRunChild.get(template.id) ? lastLength.get(template.id) as { length: number } | undefined : undefined;
      const length = Math.max(SCHEDULE_MIN_SLOT_MS, last?.length ?? 0);
      let truncated = false;
      let count = 0;
      let at = nextRunAt(template.cron!, template.timezone ?? 'UTC', Math.max(now, from - 1));
      while (at !== null && at < to) {
        if (count === perTemplate) { truncated = true; break; }
        slots.push({ taskId: template.id, projectId: template.project_id, runTaskId: null, title: template.title, start: at, length, state: 'planned' });
        count += 1;
        at = nextRunAt(template.cron!, template.timezone ?? 'UTC', at);
      }
      templates.push({ taskId: template.id, projectId: template.project_id, title: template.title, cron_text: describeCron(template.cron!, this.#language()), truncated });
    }
    const timed = this.#db.prepare(`SELECT id, project_id, title, run_at FROM tasks WHERE status = 'ready' AND cron IS NULL AND parent_id IS NULL AND run_at >= ? AND run_at < ? ORDER BY run_at LIMIT ?`)
      .all(from, to, SCHEDULE_PLANNED_LIMIT) as Array<{ id: string; project_id: string | null; title: string; run_at: number }>;
    for (const task of timed) slots.push({ taskId: task.id, projectId: task.project_id, runTaskId: task.id, title: task.title, start: task.run_at, length: SCHEDULE_MIN_SLOT_MS, state: 'planned' });
    slots.sort((a, b) => a.start - b.start);
    return { from, to, slots, templates, ranTruncated: ran.length > SCHEDULE_RAN_LIMIT };
  }

  events(taskId: string, limit = 200): TaskEvent[] {
    return this.#db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, limit) as unknown as TaskEvent[];
  }

  event(taskId: string, kind: string, actor: string, content?: string | null, runId?: string): void {
    this.#db.prepare('INSERT INTO task_events (task_id, kind, actor, content, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, kind, actor, content ?? null, runId ?? null, this.#now());
  }

  #changed(id: string): Task {
    const task = this.get(id)!;
    this.onChange?.(task);
    return task;
  }

  create(input: CreateTask): Task {
    const title = input.title.trim();
    if (!title) throw new TaskError('error.empty_title');
    const now = this.#now();
    const id = randomUUID();
    let status: TaskStatus = input.propose ? 'inbox' : 'ready';
    let runAt = input.runAt ?? null;
    if (input.cron) {
      const tz = input.timezone ?? 'UTC';
      runAt = nextRunAt(input.cron, tz, now);
      if (runAt === null) throw new TaskError('error.bad_cron', { cron: input.cron });
      status = 'scheduled';
    }
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, cron, timezone, run_at, curiosity_id, created_in_conversation, local_only, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, title, input.body ?? '', input.nextAction ?? null, input.doneCriteria ?? null, status, input.origin,
      Math.min(3, Math.max(1, input.priority ?? 2)), input.cron ?? null, input.cron ? input.timezone ?? 'UTC' : null, runAt, input.curiosityId ?? null, input.createdInConversation ?? null, input.localOnly ? 1 : 0, input.projectId ?? null, now, now,
    );
    this.event(id, 'created', input.actor, status === 'inbox' ? taskText(this.#language(), 'event.proposed') : status === 'scheduled' ? taskText(this.#language(), 'event.repeat', { cron: input.cron! }) : null);
    return this.#changed(id);
  }

  // 手元のモデルだけで動かすタスクにする（一度付けたら外さない。手元のモデルの会話の文がメモに入ったタスクを、外のモデルに読ませないため）
  markLocalOnly(id: string): void {
    this.#db.prepare('UPDATE tasks SET local_only = 1 WHERE id = ? AND local_only = 0').run(id);
  }

  update(id: string, patch: { title?: string; body?: string; appendNote?: string; nextAction?: string | null; doneCriteria?: string | null; priority?: number; runAt?: number | null }, actor: string, runId?: string): Task {
    return transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (patch.runAt !== undefined && task.cron !== null && task.parent_id === null) throw new TaskError('error.template_when');
      const body = patch.appendNote ? `${task.body}${task.body ? '\n' : ''}- ${patch.appendNote}` : patch.body ?? task.body;
      this.#db.prepare(`UPDATE tasks SET title = ?, body = ?, next_action = ?, done_criteria = ?, priority = ?, run_at = ?, updated_at = ? WHERE id = ?`).run(
        patch.title?.trim() || task.title, body.slice(-20_000),
        patch.nextAction === undefined ? task.next_action : patch.nextAction,
        patch.doneCriteria === undefined ? task.done_criteria : patch.doneCriteria,
        patch.priority === undefined ? task.priority : Math.min(3, Math.max(1, patch.priority)),
        patch.runAt === undefined ? task.run_at : patch.runAt, this.#now(), id,
      );
      if (patch.appendNote) this.event(id, 'note', actor, patch.appendNote, runId);
      else if (runId) this.event(id, 'edited', actor, null, runId);
      return this.#changed(id);
    });
  }

  claim(id: string, leaseMs: number, conversationId: string): boolean {
    const now = this.#now();
    const result = this.#db.prepare(`UPDATE tasks SET status = 'running', lease_until = ?, conversation_id = COALESCE(conversation_id, ?), updated_at = ? WHERE id = ? AND status = 'ready'`)
      .run(now + leaseMs, conversationId, now, id);
    if (Number(result.changes) !== 1) return false;
    this.#changed(id);
    return true;
  }

  setReady(id: string, options: { runAt?: number | null; countAttempt?: boolean; reason?: string; actor?: string } = {}): Task {
    this.#db.prepare(`UPDATE tasks SET status = 'ready', lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, run_at = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .run(options.runAt ?? null, options.countAttempt ? 1 : 0, this.#now(), id);
    if (options.reason) this.event(id, 'requeued', options.actor ?? 'system', options.reason);
    return this.#changed(id);
  }

  setWaiting(id: string, kind: 'question' | 'approval', text: string, runId?: string): Task {
    this.#db.prepare(`UPDATE tasks SET status = 'waiting', waiting_kind = ?, waiting_text = ?, lease_until = NULL, updated_at = ? WHERE id = ?`)
      .run(kind, text, this.#now(), id);
    this.event(id, kind === 'question' ? 'question' : 'approval', 'clive', text, runId);
    return this.#changed(id);
  }

  finish(id: string, status: 'done' | 'failed' | 'cancelled', summary: string | null, actor: string, runId?: string, reason?: string): Task {
    const now = this.#now();
    transaction(this.#db, () => {
      if (reason) this.event(id, 'reason', actor, reason);
      if (status === 'cancelled') {
        // 取り消す直前の状態を覚える（取り消しを戻す先）。質問の文は消さない。もう取り消してあるものを重ねて取り消しても、前の記録を残す
        const before = this.get(id);
        const from = before?.status === 'cancelled' ? before.cancelled_from : before && RESTORABLE.includes(before.status) ? before.status : null;
        this.#db.prepare(`UPDATE tasks SET status = 'cancelled', result_summary = ?, lease_until = NULL, cancelled_from = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
          .run(summary, from, now, now, id);
      } else {
        this.#db.prepare(`UPDATE tasks SET status = ?, result_summary = ?, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, cancelled_from = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
          .run(status, summary, now, now, id);
      }
      this.event(id, status, actor, summary, runId);
    });
    return this.#changed(id);
  }

  // 取り消しを、取り消す直前の状態へ戻す。状態が変わっていなければ（まだ取り消したまま）いつでも戻せる
  uncancel(id: string, actor: string): Task {
    transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (task.status !== 'cancelled') throw new TaskError('error.not_cancelled');
      const from = task.cancelled_from;
      if (!from) throw new TaskError('error.no_cancel_record');
      // 繰り返しの実行は、同じ予定の別の実行が動いているあいだは戻さない（重ねて動かさない。#spawnChild と同じ決まり）
      if (task.parent_id && this.hasOpenRun(task.parent_id)) throw new TaskError('error.sibling_open');
      const now = this.#now();
      let runAt = task.run_at;
      let status: TaskStatus = from;
      if (from === 'running') { status = 'ready'; runAt = null; }
      if (from === 'scheduled' && (runAt === null || runAt <= now)) {
        // 取り消していたあいだの回を、あとからまとめて動かさない
        runAt = nextRunAt(task.cron ?? '', task.timezone ?? 'UTC', now);
        if (runAt === null) throw new TaskError('error.bad_cron', { cron: task.cron ?? '' });
      }
      this.#db.prepare(`UPDATE tasks SET status = ?, run_at = ?, lease_until = NULL, cancelled_from = NULL, completed_at = NULL, result_summary = NULL, updated_at = ? WHERE id = ?`)
        .run(status, runAt, now, id);
      this.event(id, 'uncancelled', actor, taskText(this.#language(), 'event.uncancelled'));
      this.onUncancelled?.(this.get(id)!);
    });
    return this.#changed(id);
  }

  // 同じ予定から作られた実行で、まだ終わっていない（実行待ち・実行中・返事待ち）ものがあるか
  hasOpenRun(parentId: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND status IN ('ready', 'running', 'waiting')").get(parentId));
  }

  approve(id: string): Task {
    const task = this.get(id);
    if (!task || task.status !== 'inbox') throw new TaskError('error.not_proposal');
    this.event(id, 'approved', 'user');
    return this.setReady(id);
  }

  #neverRan(task: Task): boolean {
    return task.conversation_id === null && !this.#db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND run_id IS NOT NULL AND kind NOT IN ('context', 'edited') LIMIT 1").get(task.id);
  }

  unapprove(id: string): Task {
    transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (task.status === 'running' || task.status === 'waiting' || !this.#neverRan(task)) throw new TaskError('error.already_started');
      const newest = this.#db.prepare('SELECT kind FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(id) as { kind: string } | undefined;
      if (task.status !== 'ready' || newest?.kind !== 'approved') throw new TaskError('error.not_approved');
      this.#db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(this.#now(), id);
      this.event(id, 'unapproved', 'user');
    });
    return this.#changed(id);
  }

  setSchedule(id: string, cron: string, timezone: string, actor: string): Task {
    transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (task.cron === null || task.parent_id !== null) throw new TaskError('error.not_template');
      const now = this.#now();
      const next = nextRunAt(cron, timezone, now);
      if (next === null) throw new TaskError('error.bad_cron', { cron });
      this.#db.prepare('UPDATE tasks SET cron = ?, timezone = ?, run_at = ?, updated_at = ? WHERE id = ?').run(cron, timezone, task.status === 'scheduled' ? next : null, now, id);
      this.event(id, 'edited', actor, taskText(this.#language(), 'event.repeat', { cron }));
    });
    return this.#changed(id);
  }

  remove(id: string): RemovedTask {
    const removed = transaction(this.#db, () => {
      const task = this.get(id);
      if (!task) throw new TaskError('error.not_found', { id });
      if (task.cron !== null && task.parent_id === null) {
        if (task.conversation_id !== null) throw new TaskError('error.not_deletable');
        if (this.hasOpenRun(id)) throw new TaskError('error.run_open');
      } else if (!(task.status === 'ready' && task.parent_id === null && task.cron === null && task.run_at !== null && this.#neverRan(task))) {
        throw new TaskError('error.not_deletable');
      }
      for (const ref of TASK_SOFT_REFERENCES) {
        if (this.#db.prepare(`SELECT 1 FROM ${ref.table} WHERE ${ref.column} = ? LIMIT 1`).get(id)) throw new TaskError('error.still_referenced');
      }
      const keptRuns = Number(this.#db.prepare('UPDATE tasks SET parent_id = NULL WHERE parent_id = ?').run(id).changes);
      const events = Number(this.#db.prepare('DELETE FROM task_events WHERE task_id = ?').run(id).changes);
      for (const prefix of TASK_KV_PREFIXES) this.#db.prepare('DELETE FROM kv WHERE key = ?').run(`${prefix}${id}`);
      this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      return { id, title: task.title, events, keptRuns };
    });
    this.onDeleted?.(removed);
    return removed;
  }

  recoverExpiredLeases(options: { all?: boolean } = {}): number {
    const now = this.#now();
    const rows = (options.all
      ? this.#db.prepare("SELECT id FROM tasks WHERE status = 'running'").all()
      : this.#db.prepare("SELECT id FROM tasks WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)").all(now)) as Array<{ id: string }>;
    for (const { id } of rows) this.setReady(id, { reason: taskText(this.#language(), 'event.recovered') });
    return rows.length;
  }

  spawnDueSchedules(): Task[] {
    const now = this.#now();
    const due = this.#db.prepare("SELECT * FROM tasks WHERE status = 'scheduled' AND run_at IS NOT NULL AND run_at <= ?").all(now) as unknown as Task[];
    const spawned: Task[] = [];
    for (const template of due) {
      transaction(this.#db, () => {
        const next = nextRunAt(template.cron ?? '', template.timezone ?? 'UTC', now);
        this.#db.prepare('UPDATE tasks SET run_at = ?, updated_at = ? WHERE id = ?').run(next, now, template.id);
        const child = this.#spawnChild(template, 'schedule');
        if (child) spawned.push(child);
      });
    }
    return spawned;
  }

  spawnNow(templateId: string): Task | undefined {
    const template = this.get(templateId);
    if (!template || template.status !== 'scheduled') throw new TaskError('error.not_schedule');
    return transaction(this.#db, () => this.#spawnChild(template, 'user'));
  }

  #spawnChild(template: Task, actor: string): Task | undefined {
    const now = this.#now();
    // 前回分がまだ終わっていなければ、重ねて作らない
    if (this.hasOpenRun(template.id)) { this.event(template.id, 'skipped', 'system', taskText(this.#language(), 'event.skipped')); return undefined; }
    const id = randomUUID();
    this.#db.prepare(`INSERT INTO tasks (id, title, body, next_action, done_criteria, status, origin, priority, parent_id, local_only, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', 'schedule', ?, ?, ?, ?, ?, ?)`).run(id, template.title, template.body, template.next_action, template.done_criteria, template.priority, template.id, template.local_only, template.project_id, now, now);
    this.event(id, 'created', actor, taskText(this.#language(), 'event.created_from', { title: template.title }));
    return this.#changed(id);
  }

  reopen(id: string, actor: string, reason?: string): Task {
    const task = this.get(id);
    if (!task) throw new TaskError('error.not_found', { id });
    if (task.status === 'running') throw new TaskError('error.running');
    if (task.status === 'scheduled') throw new TaskError('error.schedule_cannot_run');
    const now = this.#now();
    // 繰り返しのひな形は、一回きりの実行待ちではなく予定に戻す（次の回を計算する）
    const isTemplate = task.cron !== null && task.parent_id === null;
    const nextRun = isTemplate ? nextRunAt(task.cron!, task.timezone ?? 'UTC', now) : null;
    if (isTemplate && nextRun === null) throw new TaskError('error.bad_cron', { cron: task.cron! });
    this.#db.prepare(`UPDATE tasks SET status = ?, attempts = 0, run_at = ?, lease_until = NULL, waiting_kind = NULL, waiting_text = NULL, cancelled_from = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`)
      .run(isTemplate ? 'scheduled' : 'ready', nextRun, now, id);
    this.event(id, 'reopened', actor, reason ?? null);
    return this.#changed(id);
  }

  // accept: 並べた順に見て、これを通った最初のもの（提供元が満杯のタスクを飛ばして次を見るため）
  pickNext(options: { allowSelf: boolean; accept?: (task: Task) => boolean }): Task | undefined {
    const now = this.#now();
    const origins = options.allowSelf ? "('user', 'schedule', 'self', 'curiosity')" : "('user', 'schedule')";
    const sql = `SELECT * FROM tasks WHERE status = 'ready' AND (run_at IS NULL OR run_at <= ?) AND attempts < max_attempts AND origin IN ${origins}
      ORDER BY ${ORIGIN_ORDER}, priority, COALESCE(run_at, created_at)`;
    if (!options.accept) return this.#db.prepare(`${sql} LIMIT 1`).get(now) as Task | undefined;
    return (this.#db.prepare(sql).all(now) as unknown as Task[]).find(options.accept);
  }

  nextWakeAt(options: { allowSelf: boolean }): number | undefined {
    const now = this.#now();
    const origins = options.allowSelf ? "('user', 'schedule', 'self', 'curiosity')" : "('user', 'schedule')";
    const row = this.#db.prepare(`SELECT MIN(run_at) AS t FROM tasks WHERE run_at > ? AND (status = 'scheduled' OR (status = 'ready' AND origin IN ${origins}))`).get(now) as { t: number | null };
    return row.t ?? undefined;
  }

  createdSince(origin: TaskOrigin, since: number): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE origin = ? AND created_at > ?').get(origin, since) as { n: number }).n;
  }

  waitingSince(olderThanMs: number): Task[] {
    return this.#db.prepare("SELECT * FROM tasks WHERE status = 'waiting' AND updated_at < ?").all(this.#now() - olderThanMs) as unknown as Task[];
  }
}
