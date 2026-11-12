import { Type } from '@sinclair/typebox';
import { prefixLength } from '../../engine/tokens.ts';
import { languageTagOf } from '../../projects/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const READ_CHARS = 15_000;
const READ_TOKEN_MARGIN = 100;

const fail = (error: unknown, ctx: ToolContext): ToolOutput =>
  ({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true });

export const planWrite: ToolDef<{ content: string; language?: string }> = {
  name: 'plan_write',
  description: 'Write the plan of this product (Markdown; it replaces the whole plan). Write it in the owner-facing documents language (if none is set, the language the owner writes in). When you quote the owner, copy their words exactly; never translate or paraphrase them. The owner reads and edits the plan in the Plan pane. Pass its language tag (ja, en, zh...) the first time.',
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
      const saved = services.plans.write(ctx.project.id, input.content, { by: 'ai', tainted, conversationId: ctx.conversationId, runId: ctx.runId });
      if (saved.changed) services.emit({ type: 'plan.changed', projectId: ctx.project.id, hash: saved.hash, by: 'ai' });
      const tag = languageTagOf(input.language);
      if (tag && !tainted && services.projects?.detectDocLanguage(ctx.project.id, tag)) services.emit({ type: 'project.changed', projectId: ctx.project.id, change: 'updated' });
      const saidLanguage = input.language !== undefined && !tag ? [toolText(languageOf(ctx.config), 'language.ignored', { tag: input.language })] : [];
      return { content: [toolText(languageOf(ctx.config), 'plan.saved', { chars: saved.content.length }), ...saidLanguage].join('\n') };
    } catch (error) { return fail(error, ctx); }
  },
};

export const planRead: ToolDef<{ offset?: number }> = {
  name: 'plan_read',
  description: 'Read the plan of this product (plan.md, written by the owner and the planning conversation). A long plan comes in parts; read the rest with offset.',
  input: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  projectOnly: true,
  async execute(input, ctx) {
    const plans = ctx.services?.plans;
    const language = languageOf(ctx.config);
    if (!plans || !ctx.project) return { content: toolText(language, 'plan.no_store'), isError: true };
    try {
      const view = plans.view(ctx.project.id);
      if (view.content === null) return { content: toolText(language, 'plan.none') };
      const fetched = view.tainted || view.updated_by === 'outside';
      const total = view.content.length;
      const offset = input.offset ?? 0;
      if (offset >= total && offset > 0) return { content: toolText(language, 'plan.past_end', { total: String(total) }), ...(fetched ? { fetched } : {}) };
      const rest = view.content.slice(offset);
      const shown = Math.max(1, prefixLength(rest, READ_CHARS, (ctx.outputTokens ?? Infinity) - READ_TOKEN_MARGIN));
      const part = rest.slice(0, shown);
      const content = shown >= rest.length ? part : `${part}\n\n${toolText(language, 'plan.continues', { offset: String(offset + shown), total: String(total) })}`;
      return { content, ...(fetched ? { fetched } : {}) };
    } catch (error) { return fail(error, ctx); }
  },
};
