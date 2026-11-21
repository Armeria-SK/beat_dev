import { Type } from '@sinclair/typebox';
import { languageOf } from '../../shared/language.ts';
import { pendingText } from '../../shared/messages/pending.ts';
import type { ToolDef } from '../types.ts';

export const pendingWithdraw: ToolDef<{ id: number }> = {
  name: 'pending_withdraw',
  description: 'Withdraw a call of yours that waits in Pending for the owner (id is the number after #), when you no longer need it. Only calls parked by this task, or by this conversation, can be withdrawn. A withdrawn call never runs.',
  input: Type.Object({ id: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const pending = ctx.services?.pending;
    if (!pending) return { content: pendingText(language, 'withdraw_unavailable'), isError: true };
    const row = pending.row(input.id);
    const own = row !== undefined && (ctx.task ? row.task_id === ctx.task.id : row.task_id === null && row.conversation_id === ctx.conversationId);
    if (!row || !own) return { content: pendingText(language, 'withdraw_not_own', { id: input.id }), isError: true };
    if (!pending.withdraw(row.id, pendingText('en', 'withdrawn_by_beat'))) return { content: pendingText(language, 'not_waiting', { id: row.id, status: pending.row(row.id)?.status ?? row.status }), isError: true };
    return { content: pendingText(language, 'withdraw_done', { id: row.id }) };
  },
};
