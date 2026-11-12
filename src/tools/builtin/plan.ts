import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput =>
  ({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true });

export const planWrite: ToolDef<{ content: string }> = {
  name: 'plan_write',
  description: 'Write the plan of this product (Markdown; it replaces the whole plan). Write it in the owner-facing documents language (if none is set, the language the owner writes in). When you quote the owner, copy their words exactly; never translate or paraphrase them. The owner reads and edits the plan in the Plan pane.',
  input: Type.Object({ content: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const services = ctx.services;
    if (!services?.plans || !ctx.project) return { content: toolText(languageOf(ctx.config), 'plan.no_store'), isError: true };
    try {
      const saved = services.plans.write(ctx.project.id, input.content, { by: 'ai', tainted: ctx.taint.tainted, conversationId: ctx.conversationId, runId: ctx.runId });
      services.emit({ type: 'plan.changed', projectId: ctx.project.id, hash: saved.hash, by: 'ai' });
      return { content: toolText(languageOf(ctx.config), 'plan.saved', { chars: saved.content.length }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const planRead: ToolDef<Record<string, never>> = {
  name: 'plan_read',
  description: 'Read the plan of this product (plan.md, written by the owner and the planning conversation).',
  input: Type.Object({}, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  projectOnly: true,
  async execute(_input, ctx) {
    const plans = ctx.services?.plans;
    if (!plans || !ctx.project) return { content: toolText(languageOf(ctx.config), 'plan.no_store'), isError: true };
    try {
      return { content: plans.read(ctx.project.id) ?? toolText(languageOf(ctx.config), 'plan.none') };
    } catch (error) { return fail(error, ctx); }
  },
};
