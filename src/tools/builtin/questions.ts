import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { questionText } from '../../shared/messages/questions.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const unavailable = (ctx: ToolContext): ToolOutput => ({ content: questionText(languageOf(ctx.config), 'unavailable'), isError: true });

export const questionAdd: ToolDef = {
  name: 'question_add',
  description: 'Record a question for the owner with the answer you assume, and keep working.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  async execute(_input, ctx) { return unavailable(ctx); },
};

export const questionList: ToolDef = {
  name: 'question_list',
  description: 'List the open questions of this product and the latest answers.',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'read',
  allowedIn: [],
  async execute(_input, ctx) { return unavailable(ctx); },
};
