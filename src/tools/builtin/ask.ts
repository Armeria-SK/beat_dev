import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { questionText } from '../../shared/messages/questions.ts';
import type { ToolContext, ToolDef } from '../types.ts';

export interface AskOption { label: string; description?: string }
export interface AskQuestion { question: string; header: string; options: AskOption[]; multiSelect?: boolean }
export interface AskOwnerInput { questions: AskQuestion[] }

const OTHER_LABELS = new Set(['other', 'others', 'something else']);
const key = (text: string): string => text.trim().toLowerCase();
const otherLabel = (label: string): boolean => OTHER_LABELS.has(key(label).replace(/[.:]+$/u, '').trim());

const asked = new WeakSet<ToolContext>();

export const askOwner: ToolDef<AskOwnerInput> = {
  name: 'ask_owner',
  description: 'Ask the owner multiple-choice questions, shown as a card they click. Ask only when their choice changes what you do. header: a short chip (about 12 characters). Put the recommended option first and end its label with " (Recommended)". The card adds "Something else" with a text field, so add no "Other" option. Call it once, as the last call of your reply, and write nothing after it: the answers arrive as the owner\'s next message.',
  input: Type.Object({
    questions: Type.Array(Type.Object({
      question: Type.String({ minLength: 1, maxLength: 500 }),
      header: Type.String({ minLength: 1, maxLength: 20 }),
      options: Type.Array(Type.Object({
        label: Type.String({ minLength: 1, maxLength: 80 }),
        description: Type.Optional(Type.String({ maxLength: 300 })),
      }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
      multiSelect: Type.Optional(Type.Boolean({ default: false })),
    }, { additionalProperties: false }), { minItems: 1, maxItems: 4 }),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (ctx.kind !== 'chat') return { content: questionText(language, 'ask_not_in_chat'), isError: true };
    if (asked.has(ctx)) return { content: questionText(language, 'ask_once'), isError: true };
    const seen = new Set<string>();
    for (const q of input.questions) {
      if (seen.has(key(q.question))) return { content: questionText(language, 'ask_duplicate_question', { question: q.question }), isError: true };
      seen.add(key(q.question));
      const labels = new Set<string>();
      for (const option of q.options) {
        if (otherLabel(option.label)) return { content: questionText(language, 'ask_other_label', { label: option.label }), isError: true };
        if (labels.has(key(option.label))) return { content: questionText(language, 'ask_duplicate_label', { header: q.header, label: option.label }), isError: true };
        labels.add(key(option.label));
      }
    }
    asked.add(ctx);
    return { content: questionText(language, 'ask_shown', { count: input.questions.length }) };
  },
};
