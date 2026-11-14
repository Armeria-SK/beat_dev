import type { Project, Question, QuestionAnswer, QuestionAnswered, QuestionCounts } from '../api.ts';
import type { PlainKey } from '../i18n/index.ts';

type PillTone = 'running' | 'ok' | 'danger';

export const OTHER = -1;
export type Picked = number | null;

export const isRetry = (q: Pick<Question, 'kind'>): boolean => q.kind === 'stuck' || q.kind === 'check_failed';

export const newestFirst = (rows: readonly Question[]): Question[] => [...rows].sort((a, b) => b.created_at - a.created_at || b.id - a.id);

export function openedId(rows: readonly Question[], picked: number | null): number | null {
  if (picked !== null && rows.some(r => r.id === picked)) return picked;
  return rows[0]?.id ?? null;
}

export function choiceOrder(q: Pick<Question, 'options' | 'chosen'>): number[] {
  const all = q.options.map((_, i) => i);
  return q.chosen === null || q.chosen < 0 || q.chosen >= q.options.length ? all : [q.chosen, ...all.filter(i => i !== q.chosen)];
}

export const firstPick = (q: Pick<Question, 'chosen'>): Picked => q.chosen;

export type AnswerButton = 'keep' | 'fix' | 'answer';

export function buttonOf(q: Pick<Question, 'chosen' | 'blocking'>, pick: Picked): AnswerButton {
  if (pick !== null && pick === q.chosen) return 'keep';
  return q.blocking ? 'answer' : 'fix';
}

export const BUTTON_KEY = { keep: 'ui.q.keep', fix: 'ui.q.fix', answer: 'ui.q.answer' } as const satisfies Record<AnswerButton, PlainKey>;

export type ResultLine = { key: 'ui.q.result.keep' | 'ui.q.result.fix' | 'ui.q.result.resume' | 'ui.q.result.retry'; item: null } | { key: 'ui.q.result.fixItem'; item: string };

export function resultLine(q: Pick<Question, 'kind' | 'chosen' | 'blocking' | 'acceptance_item'>, pick: Picked): ResultLine {
  if (isRetry(q)) return { key: 'ui.q.result.retry', item: null };
  if (q.blocking) return { key: 'ui.q.result.resume', item: null };
  if (buttonOf(q, pick) === 'keep') return { key: 'ui.q.result.keep', item: null };
  return q.acceptance_item ? { key: 'ui.q.result.fixItem', item: q.acceptance_item } : { key: 'ui.q.result.fix', item: null };
}

export function answerOf(pick: Picked, text: string): QuestionAnswer | null {
  if (pick === OTHER) {
    const said = text.trim();
    return said ? { choice: null, text: said } : null;
  }
  return pick === null ? null : { choice: pick };
}

export function retryChoice(q: Pick<Question, 'options' | 'chosen'>): number | null {
  const i = q.options.findIndex((_, n) => n !== q.chosen);
  return i < 0 ? null : i;
}

export const leaveChoice = (q: Pick<Question, 'options' | 'chosen'>): number | null =>
  (q.chosen !== null && q.chosen >= 0 && q.chosen < q.options.length ? q.chosen : null);

export function headKey(q: Pick<Question, 'kind' | 'blocking'>): PlainKey {
  if (q.kind === 'stuck') return 'ui.q.head.stuck';
  if (q.kind === 'check_failed') return 'ui.q.head.checkFailed';
  return q.blocking ? 'ui.q.head.blocking' : 'ui.q.head';
}

export const assumedText = (q: Pick<Question, 'options' | 'chosen'>): string | null => (q.chosen === null ? null : q.options[q.chosen] ?? null);

export interface FixPill { key: PlainKey; tone: PillTone }

const FIX: Record<NonNullable<Question['fix']>, FixPill> = {
  queued: { key: 'ui.q.fix.queued', tone: 'running' }, running: { key: 'ui.q.fix.running', tone: 'running' }, done: { key: 'ui.q.fix.done', tone: 'ok' }, failed: { key: 'ui.q.fix.failed', tone: 'danger' },
};
const RETRY: Record<NonNullable<Question['fix']>, FixPill> = {
  queued: { key: 'ui.q.retry.queued', tone: 'running' }, running: { key: 'ui.q.retry.running', tone: 'running' }, done: { key: 'ui.q.retry.done', tone: 'ok' }, failed: { key: 'ui.q.retry.failed', tone: 'danger' },
};

export const fixPill = (q: Pick<Question, 'kind' | 'fix'>): FixPill | null => (q.fix ? (isRetry(q) ? RETRY : FIX)[q.fix] : null);

export function mergeAnswered(old: readonly Question[], page: readonly Question[]): Question[] {
  const byId = new Map(old.map(q => [q.id, q]));
  for (const q of page) byId.set(q.id, q);
  return [...byId.values()].sort((a, b) => (b.answered_at ?? 0) - (a.answered_at ?? 0) || b.id - a.id);
}

export const earlierCursor = (rows: readonly Question[]): number | null => (rows.length ? Math.min(...rows.map(q => q.id)) : null);

export const ANSWERED_PAGE = 50;

export interface History { answered: number; changed: number }

export function historyOf(counts: QuestionCounts | null, rows: readonly Question[], all: boolean, complete: boolean): History | null {
  if (!complete) return all && counts && counts.answered > 0 ? { answered: counts.answered, changed: counts.changed } : null;
  if (rows.length === 0) return null;
  return { answered: rows.length, changed: rows.filter(q => q.fix_task_id !== null).length };
}

export const openShown = (rows: readonly Question[], gone: ReadonlySet<number>): Question[] => newestFirst(rows.filter(q => !gone.has(q.id)));

export const questionsFor = (counts: QuestionCounts | null, projectId: string): number => counts?.byProject[projectId] ?? 0;

export function withQuestionCounts(projects: Project[], counts: QuestionCounts | null): Project[] {
  if (!counts) return projects;
  return projects.map(p => ({ ...p, waiting: { ...p.waiting, questions: questionsFor(counts, p.id) } }));
}

export const taskQuestions = (counts: QuestionCounts | null): Map<string, number> => new Map(Object.entries(counts?.byTask ?? {}));

export function answeredToast(result: Pick<QuestionAnswered, 'kind' | 'fixTaskId' | 'reopenedTaskId' | 'resumedTaskId'>): PlainKey {
  if (result.resumedTaskId) return 'ui.q.toast.resumed';
  if (result.reopenedTaskId) return 'ui.q.toast.reopened';
  if (result.fixTaskId) return 'ui.q.toast.fix';
  return result.kind === 'kept' ? 'ui.q.toast.kept' : 'ui.q.toast.saved';
}
