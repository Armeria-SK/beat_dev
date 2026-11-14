import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { plainLine, plainBlock } from '../../shared/plain-text.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof Error ? toolText(language, 'failed', { detail: error.message }) : toolText(language, 'failed', { detail: String(error) }), isError: true };
};

export const notifyOwner: ToolDef<{ title: string; body?: string }> = {
  name: 'notify_owner',
  description: 'Show one notification on the owner\'s screen (it also appears as a browser notification). Use it only at an important milestone of a task or when the owner\'s decision is needed. A link to the current conversation or task is added automatically (you cannot pass a URL). The same title and body only once per 24 hours.',
  input: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 100 }),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      const notify = ctx.services?.notify;
      if (!notify) {
        const language = languageOf(ctx.config);
        return { content: toolText(language, 'notify_owner.unavailable'), isError: true };
      }
      const language = languageOf(ctx.config);
      const title = plainLine(input.title, 100);
      const body = input.body ? plainBlock(input.body, 1000) : '';
      if (!title) {
        return { content: toolText(language, 'failed', { detail: 'title' }), isError: true };
      }
      const link = ctx.kind === 'task' && ctx.task ? `#/tasks/${ctx.task.id}` : `#/c/${encodeURIComponent(ctx.conversationId)}`;
      const notifTitle = toolText(language, ctx.taint.tainted ? 'notify_owner.title_tainted' : 'notify_owner.title', { title });
      const dedupKey = `owner:${createHash('sha256').update(`${ctx.conversationId}\n${title}\n${body}`).digest('hex').slice(0, 32)}`;
      const result = notify({ kind: 'info', title: notifTitle, link, dedupKey, ...(body ? { body } : {}) });
      if (result === undefined) {
        return { content: toolText(language, 'notify_owner.duplicate') };
      }
      return { content: toolText(language, 'notify_owner.sent', { title }) };
    } catch (error) { return fail(error, ctx); }
  },
};
