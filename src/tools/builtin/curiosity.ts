import { Type } from '@sinclair/typebox';
import { CuriosityError, type CuriosityItem, type CuriosityStore } from '../../curiosity/store.ts';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): CuriosityStore {
  const curiosity = ctx.services?.curiosity;
  if (!curiosity) throw new CuriosityError('curiosity.unavailable');
  return curiosity;
}
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof CuriosityError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};
const line = (i: CuriosityItem, language: Language) => toolText(language, 'curiosity.line', {
  id: i.id, status: toolText(language, `curiosity.status.${i.status}`), topic: i.topic,
  why: i.why ? toolText(language, 'curiosity.why', { why: i.why }) : '', result: i.result ? toolText(language, 'curiosity.result', { result: i.result.slice(0, 200) }) : '',
});

export const curiosityAdd: ToolDef<{ topic: string; why?: string }> = {
  name: 'curiosity_add',
  description: 'Write something you are curious about but will not look into now on the curiosity list (if autonomous actions are on, you look into it yourself later). Keep topic short and specific; why is why you became curious.',
  input: Type.Object({
    topic: Type.String({ minLength: 1, maxLength: 200 }),
    why: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const item = store(ctx).add({ topic: input.topic, why: input.why, source: 'clive' });
      return { content: toolText(languageOf(ctx.config), 'curiosity.added', { line: line(item, languageOf(ctx.config)) }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const curiosityList: ToolDef<{ include_closed?: boolean }> = {
  name: 'curiosity_list',
  description: 'View the curiosity list (items you are curious about or looking into). With include_closed=true, also the ones you finished looking into or dropped.',
  input: Type.Object({ include_closed: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const items = store(ctx).list({ includeClosed: Boolean(input.include_closed), limit: 50 });
      const language = languageOf(ctx.config);
      return { content: items.length ? items.map(i => line(i, language)).join('\n') : toolText(language, 'curiosity.empty') };
    } catch (error) { return fail(error, ctx); }
  },
};

export const curiosityUpdate: ToolDef<{ id: number; status?: 'open' | 'done' | 'dropped'; result?: string }> = {
  name: 'curiosity_update',
  description: 'Update an item on the curiosity list. Write what you found out in result and set status=done; if you lost interest, status=dropped.',
  input: Type.Object({
    id: Type.Integer({ minimum: 1 }),
    status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('done'), Type.Literal('dropped')])),
    result: Type.Optional(Type.String({ maxLength: 4000 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      const item = store(ctx).update(input.id, { ...(input.status ? { status: input.status } : {}), ...(input.result !== undefined ? { result: input.result } : {}) });
      return { content: toolText(languageOf(ctx.config), 'curiosity.updated', { line: line(item, languageOf(ctx.config)) }) };
    } catch (error) { return fail(error, ctx); }
  },
};
