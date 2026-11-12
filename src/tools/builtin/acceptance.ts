import { Type, type Static } from '@sinclair/typebox';
import { ownerSpeech } from '../../db/conversations.ts';
import { AcceptanceError, buildDraft, prepareSpeech, type AcceptanceCheck, type ClaimedSource } from '../../projects/acceptance.ts';
import { CHECK_COMMAND_MAX } from '../../projects/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolDef } from '../types.ts';

const SOURCE = {
  source: Type.String({ pattern: '^(owner_words|owner_choice|ai_added)$' }),
  quote: Type.Optional(Type.String()), question: Type.Optional(Type.String()), answer: Type.Optional(Type.String()),
};

const INPUT = Type.Object({
  items: Type.Array(Type.Object({ result: Type.String({ minLength: 1 }), ...SOURCE, check: Type.String({ pattern: '^(command|look|read)$' }), command: Type.Optional(Type.String()) }, { additionalProperties: false })),
  notDoing: Type.Optional(Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), ...SOURCE }, { additionalProperties: false }))),
}, { additionalProperties: false });

type Sourced = { source: string; quote?: string | undefined; question?: string | undefined; answer?: string | undefined };

function claimOf(entry: Sourced): ClaimedSource {
  if (entry.source === 'owner_words') {
    if (!entry.quote?.trim()) throw new AcceptanceError('bad_source', { kind: entry.source, fields: 'quote' });
    return { kind: 'owner_words', quote: entry.quote };
  }
  if (entry.source === 'owner_choice') {
    if (!entry.question?.trim() || !entry.answer?.trim()) throw new AcceptanceError('bad_source', { kind: entry.source, fields: 'question, answer' });
    return { kind: 'owner_choice', question: entry.question, answer: entry.answer };
  }
  return { kind: 'ai_added' };
}

function checkOf(entry: { check: string; command?: string | undefined }): AcceptanceCheck {
  if (entry.check === 'look' || entry.check === 'read') return { kind: entry.check };
  if (!entry.command?.trim()) throw new AcceptanceError('bad_command', { max: CHECK_COMMAND_MAX });
  return { kind: 'command', command: entry.command };
}

export const acceptanceWrite: ToolDef<Static<typeof INPUT>> = {
  name: 'acceptance_write',
  description: "Replace this product's draft acceptance list (owner-facing documents language): one checkable result per item, not how to build it. source: owner_words with quote (the owner's exact words; never translate) or ai_added. check: a command that succeeds only when the item holds, whenever possible; else look or read (keep these few; split mixed items). notDoing: what the owner ruled out. Quotes are checked against the conversation.",
  input: INPUT,
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const services = ctx.services;
    if (!services?.acceptance || !ctx.project) return { content: toolText(language, 'acceptance.no_store'), isError: true };
    let tainted = ctx.taint.tainted;
    if (!tainted && ctx.conversationTainted) { try { tainted = ctx.conversationTainted(); } catch { tainted = true; } }
    try {
      const speech = prepareSpeech(ownerSpeech(services.db, ctx.project.id));
      const docLanguage = services.projects?.get(ctx.project.id)?.doc_language ?? null;
      const { doc, verified, changed } = buildDraft({ items: input.items.map(entry => ({ result: entry.result, source: claimOf(entry), check: checkOf(entry) })), notDoing: input.notDoing?.map(entry => ({ text: entry.text, source: claimOf(entry) })) }, speech, { language: docLanguage, taintedRuns: tainted ? [ctx.runId] : [] });
      services.acceptance.writeDraft(ctx.project.id, doc);
      services.emit({ type: 'acceptance.changed', projectId: ctx.project.id, version: 0, draft: true });
      const reasons = Object.entries(changed).map(([reason, n]) => `${reason}: ${n}`).join(', ');
      const changedTotal = Object.values(changed).reduce((sum, n) => sum + n, 0);
      return { content: toolText(language, 'acceptance.saved', { items: doc.items.length, notDoing: doc.notDoing.length, verified, changed: changedTotal, reasons: reasons ? ` (${reasons})` : '' }) };
    } catch (error) {
      return { content: toolText(language, 'failed', { detail: errorText(error, language) }), isError: true };
    }
  },
};
