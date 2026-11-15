import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE } from '../config/schema.ts';
import { transaction } from '../db/database.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { questionText, type QuestionMessageKey } from '../shared/messages/questions.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { plainBlock, plainLine, stripHidden } from '../shared/plain-text.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { AcceptanceError, ITEM_ID, type AcceptanceStore } from '../projects/acceptance.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { Task, TaskStore } from '../tasks/store.ts';

export type QuestionKind = 'ai' | 'stuck' | 'check_failed' | 'submit_refused';
export type QuestionStatus = 'open' | 'answered';
export type QuestionAnswerKind = 'kept' | 'changed';
export type QuestionFix = 'queued' | 'running' | 'done' | 'failed';
export const QUESTION_CATEGORIES = ['scope', 'ui', 'data', 'naming', 'tech', 'security', 'other'] as const;
export type QuestionCategory = typeof QUESTION_CATEGORIES[number];

export class QuestionError extends LocalizedError<QuestionMessageKey> {
  constructor(code: QuestionMessageKey, params?: MessageParams) { super(questionText, code, params); }
}

export interface QuestionRow {
  id: number;
  project_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  kind: QuestionKind;
  category: QuestionCategory;
  question: string;
  why: string | null;
  options: string;
  chosen: number | null;
  blocking: number;
  acceptance_item: string | null;
  status: QuestionStatus;
  answer: string | null;
  answer_kind: QuestionAnswerKind | null;
  fix_task_id: string | null;
  tainted: number;
  created_at: number;
  answered_at: number | null;
}

export interface QuestionView {
  id: number;
  project_id: string | null;
  task_id: string | null;
  kind: QuestionKind;
  category: QuestionCategory;
  question: string;
  why: string | null;
  options: string[];
  chosen: number | null;
  blocking: boolean;
  acceptance_item: string | null;
  status: QuestionStatus;
  answer: string | null;
  answer_kind: QuestionAnswerKind | null;
  fix_task_id: string | null;
  created_at: number;
  answered_at: number | null;
  product: string | null;
  task: string | null;
  fix: QuestionFix | null;
}

export interface QuestionCounts {
  open: number;
  byProject: Record<string, number>;
  byTask: Record<string, number>;
  answered: number;
  changed: number;
}

export interface QuestionAdd {
  kind?: QuestionKind | undefined;
  category?: QuestionCategory | undefined;
  projectId?: string | null | undefined;
  taskId?: string | null | undefined;
  conversationId?: string | null | undefined;
  question: string;
  why?: string | null | undefined;
  options: readonly string[];
  chosen?: number | null | undefined;
  blocking?: boolean | undefined;
  acceptanceItem?: string | null | undefined;
  tainted?: boolean | undefined;
}

export interface SubmitRefused {
  taskId: string;
  projectId: string | null;
  conversationId: string | null;
  tool: string;
  url: string | undefined;
  tainted: boolean;
}

export interface QuestionFilter {
  status: QuestionStatus;
  projectId?: string | undefined;
  taskId?: string | undefined;
  before?: number | undefined;
  limit?: number | undefined;
}

export interface QuestionAnswer {
  choice: number | null;
  text?: string | undefined;
}

export interface QuestionAnswered {
  question: QuestionView;
  kind: QuestionAnswerKind;
  fixTaskId: string | null;
  reopenedTaskId: string | null;
  resumedTaskId: string | null;
  repeated: boolean;
  reopenedItem: string | null;
  warning: string | null;
}

export interface QuestionChange { id: number; projectId: string | null; status: QuestionStatus }

export interface QuestionStoreOptions {
  now?: (() => number) | undefined;
  onChange?: ((change: QuestionChange) => void) | undefined;
  tasks?: TaskStore | undefined;
  projects?: ProjectStore | undefined;
  acceptance?: AcceptanceStore | undefined;
}

const QUESTIONS_PER_TASK = 10;
const TEXT_MAX = 1500;
const OPTION_MAX = 300;
const ANSWER_MAX = 4000;
const TITLE_MAX = 200;
const ANSWERED_LIMIT = 50;
const ANSWERED_MAX = 200;
const OPEN_MAX = 1000;
const REOPEN_KINDS: readonly QuestionKind[] = ['stuck', 'check_failed'];
const FINISHED: readonly string[] = ['done', 'failed', 'cancelled'];

const cleanBlock = (text: string, max: number): string => plainBlock(redactSecrets(stripHidden(text)), max).trim();
const cleanLine = (text: string, max: number): string => plainLine(redactSecrets(stripHidden(text)), max);

function pageOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? null : `${parsed.origin}${parsed.pathname}`;
  } catch { return null; }
}

function optionsOf(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
}

function fixOf(status: string | null): QuestionFix | null {
  if (status === null) return null;
  if (status === 'done') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'running' || status === 'waiting') return 'running';
  return 'queued';
}

type JoinedRow = QuestionRow & { product: string | null; task: string | null; fix_status: string | null };

const SELECT = `SELECT q.*, p.name AS product, t.title AS task, f.status AS fix_status FROM questions q
  LEFT JOIN projects p ON p.id = q.project_id LEFT JOIN tasks t ON t.id = q.task_id LEFT JOIN tasks f ON f.id = q.fix_task_id`;

function viewOf(row: JoinedRow): QuestionView {
  return {
    id: row.id, project_id: row.project_id, task_id: row.task_id, kind: row.kind, category: row.category, question: row.question, why: row.why, options: optionsOf(row.options),
    chosen: row.chosen, blocking: row.blocking === 1, acceptance_item: row.acceptance_item, status: row.status, answer: row.answer, answer_kind: row.answer_kind,
    fix_task_id: row.fix_task_id, created_at: row.created_at, answered_at: row.answered_at, product: row.product, task: row.task, fix: fixOf(row.fix_status),
  };
}

export class QuestionStore {
  readonly db: DatabaseSync;
  readonly options: QuestionStoreOptions;

  constructor(db: DatabaseSync, options: QuestionStoreOptions = {}) { this.db = db; this.options = options; }

  #now(): number { return this.options.now?.() ?? Date.now(); }

  add(input: QuestionAdd): QuestionRow {
    const row = this.#insert(input, false);
    this.options.onChange?.({ id: row.id, projectId: row.project_id, status: 'open' });
    return row;
  }

  #insert(input: QuestionAdd, copy: boolean): QuestionRow {
    const kind = input.kind ?? 'ai';
    const category = input.category ?? 'other';
    if (!(QUESTION_CATEGORIES as readonly string[]).includes(category)) throw new QuestionError('bad_category', { categories: QUESTION_CATEGORIES.join(', ') });
    const question = cleanBlock(input.question, TEXT_MAX);
    if (!question) throw new QuestionError('empty');
    const why = input.why ? cleanBlock(input.why, TEXT_MAX) || null : null;
    if (input.options.length < 2 || input.options.length > 4) throw new QuestionError('options_count');
    const options = input.options.map(option => cleanLine(option, OPTION_MAX));
    if (options.some(option => !option)) throw new QuestionError('option_empty');
    const blocking = input.blocking === true;
    const chosen = input.chosen ?? null;
    if (chosen === null && !blocking) throw new QuestionError('chosen_required');
    if (chosen !== null && (!Number.isInteger(chosen) || chosen < 0 || chosen >= options.length)) throw new QuestionError('chosen_range', { max: options.length - 1 });
    const taskId = input.taskId ?? null;
    const item = input.acceptanceItem ?? null;
    if (item !== null && (!ITEM_ID.test(item) || !input.projectId || !this.options.acceptance?.hasLiveItem(input.projectId, item))) throw new QuestionError('no_item', { item: plainLine(item, 20) });
    const id = transaction(this.db, () => {
      if (taskId && kind === 'ai' && !copy) {
        const same = this.db.prepare("SELECT id FROM questions WHERE task_id = ? AND status = 'open' AND question = ? LIMIT 1").get(taskId, question) as { id: number } | undefined;
        if (same) throw new QuestionError('duplicate', { id: same.id });
        const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND kind = 'ai'").get(taskId) as { n: number };
        if (n >= QUESTIONS_PER_TASK) throw new QuestionError('too_many', { max: QUESTIONS_PER_TASK });
      }
      return Number(this.db.prepare(`INSERT INTO questions (project_id, task_id, conversation_id, kind, category, question, why, options, chosen, blocking, acceptance_item, tainted, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.projectId ?? null, taskId, input.conversationId ?? null, kind, category, question, why, JSON.stringify(options), chosen, blocking ? 1 : 0, item, input.tainted ? 1 : 0, this.#now(),
      ).lastInsertRowid);
    });
    return this.get(id)!;
  }

  addSubmitRefused(input: SubmitRefused): { row: QuestionRow; added: boolean } {
    const language = DEFAULT_LANGUAGE;
    const page = pageOf(input.url);
    const question = page ? questionText(language, 'submit_question', { url: page }) : questionText(language, 'submit_question_unknown', { tool: input.tool });
    const same = this.db.prepare("SELECT id FROM questions WHERE task_id = ? AND kind = 'submit_refused' AND question = ? ORDER BY id LIMIT 1").get(input.taskId, cleanBlock(question, TEXT_MAX)) as { id: number } | undefined;
    const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND kind = 'submit_refused'").get(input.taskId) as { n: number };
    const kept = same ?? (n >= QUESTIONS_PER_TASK ? this.db.prepare("SELECT id FROM questions WHERE task_id = ? AND kind = 'submit_refused' ORDER BY id DESC LIMIT 1").get(input.taskId) as { id: number } : undefined);
    if (kept) {
      if (input.tainted) this.db.prepare('UPDATE questions SET tainted = 1 WHERE id = ?').run(kept.id);
      return { row: this.get(kept.id)!, added: false };
    }
    const row = this.add({
      kind: 'submit_refused', projectId: input.projectId, taskId: input.taskId, conversationId: input.conversationId, question,
      why: questionText(language, 'submit_why', { tool: input.tool }), options: [questionText(language, 'submit_send'), questionText(language, 'submit_keep')], chosen: 1, tainted: input.tainted,
    });
    return { row, added: true };
  }

  copyLegacyWaits(log: (line: string) => void = () => undefined): number {
    const tasks = this.options.tasks;
    if (!tasks) return 0;
    const language = DEFAULT_LANGUAGE;
    const waiting = this.db.prepare(`SELECT id FROM tasks WHERE waiting_kind = 'question' AND (status = 'waiting' OR (status = 'cancelled' AND cancelled_from = 'waiting')) ORDER BY created_at, id`).all() as Array<{ id: string }>;
    let copied = 0;
    for (const { id } of waiting) {
      try {
        const added = transaction(this.db, () => {
          const task = tasks.get(id);
          if (!task) return false;
          const question = cleanBlock(task.waiting_text ?? '', TEXT_MAX) || questionText(language, 'legacy_none');
          const latest = this.#waitedOn(task.id);
          const held = latest === undefined ? undefined : this.get(latest);
          if (held && held.status === 'open' && held.question === question) return false;
          this.#insert({
            kind: 'ai', projectId: task.project_id, taskId: task.id, conversationId: task.conversation_id, question, why: questionText(language, 'legacy_why'),
            options: [questionText(language, 'legacy_go'), questionText(language, 'legacy_stop')], chosen: null, blocking: true, tainted: true,
          }, true);
          return true;
        });
        if (added) copied += 1;
      } catch (error) {
        log(`[WARN] Could not copy the wait of task ${id} into Questions: ${(error as Error).message}`);
      }
    }
    return copied;
  }

  #legacyStop(row: QuestionRow, options: readonly string[], choice: number | null): boolean {
    const language = DEFAULT_LANGUAGE;
    return row.kind === 'ai' && row.why === questionText(language, 'legacy_why') && options.length === 2
      && options[0] === questionText(language, 'legacy_go') && options[1] === questionText(language, 'legacy_stop') && choice === 1;
  }

  #waitedOn(taskId: string): number | undefined {
    const row = this.db.prepare('SELECT MAX(id) AS id FROM questions WHERE task_id = ? AND blocking = 1').get(taskId) as { id: number | null } | undefined;
    return row?.id ?? undefined;
  }

  waitingQuestion(taskId: string): QuestionRow | undefined {
    const id = this.#waitedOn(taskId);
    const row = id === undefined ? undefined : this.get(id);
    return row?.status === 'open' ? row : undefined;
  }

  resumeAnswered(task: Task): boolean {
    const tasks = this.options.tasks;
    if (!tasks || task.status !== 'waiting' || task.waiting_kind !== 'question') return false;
    const id = this.#waitedOn(task.id);
    if (id === undefined || this.get(id)?.status !== 'answered') return false;
    tasks.setReady(task.id, { actor: 'user' });
    return true;
  }

  get(id: number): QuestionRow | undefined {
    return this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
  }

  view(id: number): QuestionView | undefined {
    const row = this.db.prepare(`${SELECT} WHERE q.id = ?`).get(id) as JoinedRow | undefined;
    return row ? viewOf(row) : undefined;
  }

  list(filter: QuestionFilter): QuestionView[] {
    const where = ['q.status = ?'];
    const args: Array<string | number> = [filter.status];
    if (filter.projectId !== undefined) { where.push('q.project_id = ?'); args.push(filter.projectId); }
    if (filter.taskId !== undefined) { where.push('q.task_id = ?'); args.push(filter.taskId); }
    if (filter.before !== undefined) { where.push('q.id < ?'); args.push(filter.before); }
    const limit = filter.status === 'open' ? Math.min(filter.limit ?? OPEN_MAX, OPEN_MAX) : Math.min(Math.max(filter.limit ?? ANSWERED_LIMIT, 1), ANSWERED_MAX);
    const rows = this.db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY q.id DESC LIMIT ?`).all(...args, limit) as unknown as JoinedRow[];
    return rows.map(viewOf);
  }

  counts(): QuestionCounts {
    const group = (column: 'project_id' | 'task_id'): Record<string, number> => Object.fromEntries(
      (this.db.prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM questions WHERE status = 'open' AND ${column} IS NOT NULL GROUP BY ${column}`).all() as Array<{ k: string; n: number }>).map(r => [r.k, r.n]),
    );
    const totals = this.db.prepare(`SELECT COALESCE(SUM(status = 'open'), 0) AS open, COALESCE(SUM(status = 'answered'), 0) AS answered, COALESCE(SUM(answer_kind = 'changed'), 0) AS changed FROM questions`).get() as { open: number; answered: number; changed: number };
    return { open: totals.open, byProject: group('project_id'), byTask: group('task_id'), answered: totals.answered, changed: totals.changed };
  }

  answer(id: number, answer: QuestionAnswer): QuestionAnswered | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    if (row.status === 'answered') return this.#answered(row);
    const options = optionsOf(row.options);
    const raw = answer.text?.trim() ?? '';
    let text: string | null = null;
    if (raw) {
      if (answer.choice !== null) throw new QuestionError('invalid_answer');
      text = cleanBlock(raw, ANSWER_MAX);
      if (!text) throw new QuestionError('invalid_answer');
    } else if (answer.choice === null) {
      throw new QuestionError('invalid_answer');
    } else if (!Number.isInteger(answer.choice) || answer.choice < 0 || answer.choice >= options.length) {
      throw new QuestionError('invalid_choice', { choice: answer.choice });
    }
    const answerText = text ?? options[answer.choice!]!;
    const kind: QuestionAnswerKind = text === null && answer.choice === row.chosen ? 'kept' : 'changed';
    const tasks = this.options.tasks;
    if (!tasks) throw new Error('QuestionStore needs the task store to take answers');
    const acceptance = this.options.acceptance;
    const result = transaction(this.db, () => {
      const blockedTask = row.blocking === 1 && row.task_id ? tasks.get(row.task_id) : undefined;
      if (blockedTask?.status === 'running') throw new QuestionError('task_running', { id });
      const done = this.db.prepare("UPDATE questions SET status = 'answered', answer = ?, answer_kind = ?, answered_at = ? WHERE id = ? AND status = 'open'").run(answerText, kind, this.#now(), id);
      if (Number(done.changes) !== 1) return undefined;
      let reopenedItem: string | null = null;
      let warning: string | null = null;
      if (kind === 'changed' && row.acceptance_item && row.project_id && acceptance) {
        try {
          const taint = text === null && row.tainted === 1 ? `question:${id}` : null;
          if (acceptance.reopenForAnswer(row.project_id, row.acceptance_item, { questionId: id, answer: answerText, picked: text === null ? 'option' : 'text', taint })) reopenedItem = row.acceptance_item;
        } catch (error) {
          if (!(error instanceof AcceptanceError)) throw error;
          warning = `Question ${id} was answered, but acceptance item ${row.acceptance_item} of product ${row.project_id} was not reopened: ${error.message}`;
        }
      }
      let fixTaskId: string | null = null;
      let reopenedTaskId: string | null = null;
      let resumedTaskId: string | null = null;
      const waitedOn = blockedTask !== undefined && this.#waitedOn(blockedTask.id) === row.id;
      const heldByCancel = waitedOn && blockedTask.status === 'cancelled' && blockedTask.cancelled_from === 'waiting' && blockedTask.waiting_kind === 'question';
      if (text === null && this.#legacyStop(row, options, answer.choice)) {
        if (blockedTask && (!FINISHED.includes(blockedTask.status) || heldByCancel)) {
          tasks.event(blockedTask.id, 'answer', 'user', taskText(DEFAULT_LANGUAGE, 'event.answer', { question: row.question, text: answerText }));
          if (blockedTask.status === 'waiting' && waitedOn) tasks.finish(blockedTask.id, 'cancelled', questionText(DEFAULT_LANGUAGE, 'legacy_stopped'), 'user');
        }
      } else if (row.kind === 'submit_refused') {
        if (kind === 'changed' && row.task_id && tasks.get(row.task_id)) tasks.event(row.task_id, 'answer', 'user', questionText(DEFAULT_LANGUAGE, 'submit_yourself', { question: row.question, answer: answerText }));
      } else if (blockedTask && (!FINISHED.includes(blockedTask.status) || heldByCancel)) {
        tasks.event(blockedTask.id, 'answer', 'user', taskText(DEFAULT_LANGUAGE, 'event.answer', { question: row.question, text: answerText }));
        if (blockedTask.status === 'waiting' && blockedTask.waiting_kind === 'question' && waitedOn) {
          tasks.setReady(blockedTask.id, { actor: 'user' });
          resumedTaskId = blockedTask.id;
        }
      } else if (kind === 'changed' && REOPEN_KINDS.includes(row.kind)) {
        if (row.task_id) {
          tasks.reopen(row.task_id, 'user', questionText(DEFAULT_LANGUAGE, 'reopen_reason', { id, answer: answerText }));
          reopenedTaskId = row.task_id;
        }
      } else if (kind === 'changed') {
        fixTaskId = this.#fixTask(tasks, row, options, answerText, text !== null, reopenedItem);
      }
      const follow = fixTaskId ?? reopenedTaskId;
      if (follow) this.db.prepare('UPDATE questions SET fix_task_id = ? WHERE id = ?').run(follow, id);
      return { fixTaskId, reopenedTaskId, resumedTaskId, reopenedItem, warning };
    });
    const latest = this.get(id)!;
    if (!result) return this.#answered(latest);
    this.options.onChange?.({ id, projectId: latest.project_id, status: 'answered' });
    return { question: this.view(id)!, kind, ...result, repeated: false };
  }

  #answered(row: QuestionRow): QuestionAnswered {
    const reopened = REOPEN_KINDS.includes(row.kind);
    return {
      question: this.view(row.id)!, kind: row.answer_kind ?? 'kept',
      fixTaskId: reopened ? null : row.fix_task_id, reopenedTaskId: reopened ? row.fix_task_id : null, resumedTaskId: null, reopenedItem: null, warning: null, repeated: true,
    };
  }

  #fixTask(tasks: TaskStore, row: QuestionRow, options: readonly string[], answerText: string, ownerWrote: boolean, item: string | null): string {
    const language = DEFAULT_LANGUAGE;
    const assumed = row.chosen !== null ? options[row.chosen] ?? questionText(language, 'assumed_none') : questionText(language, 'assumed_none');
    const title = plainLine(questionText(language, 'fix_title', { id: row.id, question: row.question }), TITLE_MAX);
    const body = [questionText(language, 'fix_body', { question: row.question, assumed, answer: answerText }), item ? questionText(language, 'fix_item', { item }) : ''].filter(Boolean).join('\n');
    const ownerText = ownerWrote || row.tainted === 0 ? answerText : null;
    const task = tasks.create({ title, body, origin: 'user', actor: 'user', projectId: row.project_id, ownerRequest: ownerText !== null });
    if (ownerText !== null) tasks.ownerEdited(task.id, { title: ownerText, body: '' });
    if (row.tainted === 1) tasks.markUntrusted(task.id, 'question', questionText(language, ownerText === null ? 'untrusted_note' : 'untrusted_note_owner'));
    return task.id;
  }
}
