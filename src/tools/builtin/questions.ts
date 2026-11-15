import { Type } from '@sinclair/typebox';
import { QUESTION_CATEGORIES, QuestionError, type QuestionCategory, type QuestionView } from '../../questions/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { questionText } from '../../shared/messages/questions.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolDef } from '../types.ts';

const RECENT_ANSWERS = 10;

interface QuestionAddInput { question: string; why: string; options: string[]; chosen?: number; blocking?: boolean; item?: string; category?: QuestionCategory }

export const questionAdd: ToolDef<QuestionAddInput> = {
  name: 'question_add',
  description: 'Record a question for the owner and keep working with the option you assume (chosen: the number of that option, from 0). The owner answers later; a different answer starts a follow-up task. If you can go ahead with an assumption, do not set blocking. Set blocking only when no assumption is safe: the task then waits for the answer. item: the acceptance item the question is about (such as A-3); a different answer reopens it. category: scope (what to build), ui, data, naming, tech, security, or other.',
  input: Type.Object({
    question: Type.String({ minLength: 1, maxLength: 1500 }),
    why: Type.String({ minLength: 1, maxLength: 1500 }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { minItems: 2, maxItems: 4 }),
    chosen: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    blocking: Type.Optional(Type.Boolean()),
    item: Type.Optional(Type.String({ pattern: '^A-[1-9][0-9]{0,3}$', maxLength: 6 })),
    category: Type.Optional(Type.Unsafe<QuestionCategory>(Type.String({ pattern: `^(${QUESTION_CATEGORIES.join('|')})$` }))),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const questions = ctx.services?.questions;
    if (!ctx.task || !questions) return { content: questionText(language, 'not_in_task'), isError: true };
    const tasks = ctx.services?.tasks;
    const tainted = ctx.taint.tainted || ctx.conversationTainted?.() === true || tasks?.textTainted(ctx.task.id) === true;
    const projectId = ctx.project?.id ?? tasks?.get(ctx.task.id)?.project_id ?? null;
    try {
      const row = questions.add({
        kind: 'ai', projectId, taskId: ctx.task.id, conversationId: ctx.conversationId, question: input.question, why: input.why,
        options: input.options, chosen: input.chosen, blocking: input.blocking, acceptanceItem: input.item, category: input.category, tainted,
      });
      if (row.blocking === 1) {
        ctx.task.control = { outcome: 'question', question: row.question };
        return { content: questionText(language, 'recorded_blocking', { id: row.id, end: toolText(language, 'task.end') }) };
      }
      const options = JSON.parse(row.options) as string[];
      return { content: questionText(language, 'recorded', { id: row.id, option: options[row.chosen!] ?? '' }) };
    } catch (error) {
      if (error instanceof QuestionError) return { content: errorText(error, language), isError: true };
      throw error;
    }
  },
};

export const questionList: ToolDef<Record<string, never>> = {
  name: 'question_list',
  description: "List this product's open questions and the latest answers from the owner.",
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  replayable: false,
  async execute(_input, ctx) {
    const language = languageOf(ctx.config);
    const questions = ctx.services?.questions;
    if (!ctx.task || !questions) return { content: questionText(language, 'not_in_task'), isError: true };
    const scope = ctx.project?.id !== undefined ? { projectId: ctx.project.id } : { taskId: ctx.task.id };
    const open = questions.list({ status: 'open', ...scope });
    const answered = questions.list({ status: 'answered', ...scope, limit: RECENT_ANSWERS });
    if (!open.length && !answered.length) return { content: questionText(language, 'list_none') };
    const assumed = (q: QuestionView): string => (q.chosen !== null ? q.options[q.chosen] : undefined) ?? questionText(language, 'assumed_none');
    const lines: string[] = [];
    if (open.length) lines.push(questionText(language, 'list_open'), ...open.map(q => questionText(language, 'list_open_line', { id: q.id, question: q.question, assumed: assumed(q) })));
    if (answered.length) lines.push(questionText(language, 'list_answered'), ...answered.map(q => questionText(language, 'list_answered_line', { id: q.id, question: q.question, assumed: assumed(q), answer: q.answer ?? '' })));
    const fetched = [...open, ...answered].some(q => questions.get(q.id)?.tainted === 1);
    return { content: lines.join('\n'), ...(fetched ? { fetched: true } : {}) };
  },
};
