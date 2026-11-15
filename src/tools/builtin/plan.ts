import { Type } from '@sinclair/typebox';
import { languageTagOf } from '../../projects/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput =>
  ({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true });

export const planWrite: ToolDef<{ content: string; language?: string }> = {
  name: 'plan_write',
  description: 'Write the plan of this conversation for this product (Markdown; it replaces the whole plan; other conversations keep their own plans). Write it in the owner-facing documents language (if none is set, the language the owner writes in). When you quote the owner, copy their words exactly; never translate or paraphrase them. The owner reads and edits the plan in the Plan pane. Pass its language tag (ja, en, zh...) the first time.',
  input: Type.Object({ content: Type.String({ minLength: 1 }), language: Type.Optional(Type.String()) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const services = ctx.services;
    if (!services?.plans || !ctx.project) return { content: toolText(languageOf(ctx.config), 'plan.no_store'), isError: true };
    let tainted = ctx.taint.tainted;
    if (!tainted && ctx.conversationTainted) { try { tainted = ctx.conversationTainted(); } catch { tainted = true; } }
    try {
      const saved = services.plans.write(ctx.project.id, ctx.conversationId, input.content, { by: 'ai', tainted, conversationId: ctx.conversationId, runId: ctx.runId });
      if (saved.changed) services.emit({ type: 'plan.changed', projectId: ctx.project.id, conversationId: ctx.conversationId, hash: saved.hash, by: 'ai' });
      const tag = languageTagOf(input.language);
      if (tag && !tainted && services.projects?.detectDocLanguage(ctx.project.id, tag)) services.emit({ type: 'project.changed', projectId: ctx.project.id, change: 'updated' });
      const saidLanguage = input.language !== undefined && !tag ? [toolText(languageOf(ctx.config), 'language.ignored', { tag: input.language })] : [];
      return { content: [toolText(languageOf(ctx.config), 'plan.saved', { chars: saved.content.length }), ...saidLanguage].join('\n') };
    } catch (error) { return fail(error, ctx); }
  },
};
