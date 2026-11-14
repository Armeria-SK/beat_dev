import type { DatabaseSync } from 'node:sqlite';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { questionText, type QuestionMessageKey } from '../shared/messages/questions.ts';
import type { AcceptanceStore } from '../projects/acceptance.ts';
import type { ProjectStore } from '../projects/store.ts';
import type { TaskStore } from '../tasks/store.ts';

export type QuestionKind = 'ai' | 'stuck' | 'check_failed' | 'submit_refused';
export type QuestionStatus = 'open' | 'answered';
export type QuestionAnswerKind = 'kept' | 'changed';
export type QuestionFix = 'queued' | 'running' | 'done' | 'failed';

export class QuestionError extends LocalizedError<QuestionMessageKey> {
  constructor(code: QuestionMessageKey, params?: MessageParams) { super(questionText, code, params); }
}

export interface QuestionRow {
  id: number;
  project_id: string | null;
  task_id: string | null;
  conversation_id: string | null;
  kind: QuestionKind;
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
  reopenedItem: string | null;
}

export interface QuestionChange { id: number; projectId: string | null; status: QuestionStatus }

export interface QuestionStoreOptions {
  now?: (() => number) | undefined;
  onChange?: ((change: QuestionChange) => void) | undefined;
  tasks?: TaskStore | undefined;
  projects?: ProjectStore | undefined;
  acceptance?: AcceptanceStore | undefined;
}

export class QuestionStore {
  readonly db: DatabaseSync;
  readonly options: QuestionStoreOptions;

  constructor(db: DatabaseSync, options: QuestionStoreOptions = {}) { this.db = db; this.options = options; }

  add(_input: QuestionAdd): QuestionRow { throw new QuestionError('unavailable'); }

  get(_id: number): QuestionRow | undefined { return undefined; }

  view(_id: number): QuestionView | undefined { return undefined; }

  list(_filter: QuestionFilter): QuestionView[] { return []; }

  counts(): QuestionCounts { return { open: 0, byProject: {}, byTask: {}, answered: 0, changed: 0 }; }

  answer(_id: number, _answer: QuestionAnswer): QuestionAnswered | undefined { return undefined; }
}
