import { Type, type Static } from '@sinclair/typebox';
import { ownerSpeech } from '../../db/conversations.ts';
import {
  AcceptanceError, buildDraft, checkedSource, prepareSpeech, SCAN_BUDGET, type AcceptanceCheck, type ChangeOp, type ChangeOpKind, type ClaimedSource, type Speech,
} from '../../projects/acceptance.ts';
import { CHECK_COMMAND_MAX, languageTagOf } from '../../projects/store.ts';
import { confirmedPicks } from '../../research/store.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolDef } from '../types.ts';

const SOURCE = {
  source: Type.String({ pattern: '^(owner_words|owner_choice|ai_added)$' }),
  quote: Type.Optional(Type.String()), question: Type.Optional(Type.String()), answer: Type.Optional(Type.String()),
};

const COMMAND = Type.Optional(Type.String({ description: "Runs in beat's shell (PowerShell on Windows, bash on Linux) from the product folder. Never cmd.exe syntax (type x | findstr); on Windows prefer Test-Path / Select-String." }));

const INPUT = Type.Object({
  items: Type.Array(Type.Object({ result: Type.String({ minLength: 1 }), ...SOURCE, check: Type.String({ pattern: '^(command|look|read)$' }), command: COMMAND }, { additionalProperties: false })),
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

const CHANGE_INPUT = Type.Object({
  changes: Type.Array(Type.Object({
    op: Type.String(), id: Type.Optional(Type.String()), result: Type.Optional(Type.String()), quote: Type.Optional(Type.String()), check: Type.Optional(Type.String()), command: COMMAND,
  })),
  language: Type.Optional(Type.String()),
});

type ChangeEntry = Static<typeof CHANGE_INPUT>['changes'][number];

function changeOf(entry: ChangeEntry, speech: Speech): ChangeOp {
  if (entry.check !== undefined && !['command', 'look', 'read'].includes(entry.check)) throw new AcceptanceError('bad_change', { detail: 'check must be command, look or read' });
  const source = checkedSource(speech, entry.quote?.trim() ? { kind: 'owner_words', quote: entry.quote } : { kind: 'ai_added' });
  const item = entry.result !== undefined && entry.check !== undefined ? { result: entry.result, check: checkOf({ check: entry.check, command: entry.command }) } : undefined;
  return { op: entry.op as ChangeOpKind, ...(entry.id !== undefined ? { id: entry.id } : {}), ...(item ? { item } : {}), source };
}

export const acceptanceChange: ToolDef<Static<typeof CHANGE_INPUT>> = {
  name: 'acceptance_change',
  description: "Propose changes to the locked acceptance list; nothing changes until the owner approves. Write in the owner-facing documents language and pass its tag as language. op: add, change (id) or remove (id). result: one checkable result, not how to build it. quote: the owner's words copied verbatim (never translate or paraphrase); omit when you add it. check: command (with command) that succeeds only when the item holds, whenever possible; else look or read.",
  input: CHANGE_INPUT,
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  projectOnly: true,
  acceptanceState: 'frozen',
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const services = ctx.services;
    if (!services?.acceptance || !ctx.project) return { content: toolText(language, 'acceptance.no_store'), isError: true };
    let tainted = ctx.taint.tainted;
    if (!tainted && ctx.conversationTainted) { try { tainted = ctx.conversationTainted(); } catch { tainted = true; } }
    try {
      const speech = prepareSpeech(ownerSpeech(services.db, ctx.project.id), SCAN_BUDGET, confirmedPicks(services.db, ctx.project.id));
      const ops = input.changes.map(entry => changeOf(entry, speech));
      const row = services.acceptance.propose(ctx.project.id, ops, { language: tainted ? null : languageTagOf(input.language) ?? null, conversationId: ctx.conversationId, tainted });
      services.emit({ type: 'acceptance.changed', projectId: ctx.project.id, version: row.base_version, draft: false });
      const changed: Record<string, number> = {};
      for (const { source } of ops) if (source.kind === 'ai_added' && source.reason) changed[source.reason] = (changed[source.reason] ?? 0) + 1;
      return { content: toolText(language, 'acceptance.proposed', {
        changes: ops.length, version: row.base_version, verified: ops.filter(op => op.source.kind === 'owner_words' || op.source.kind === 'owner_choice').length,
        aiAdded: ops.filter(op => op.source.kind === 'ai_added').length, unconfirmed: unconfirmedText(changed),
      }) };
    } catch (error) {
      return { content: toolText(language, 'failed', { detail: errorText(error, language) }), isError: true };
    }
  },
};

function unconfirmedText(changed: Partial<Record<string, number>>): string {
  const total = Object.values(changed).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  if (total === 0) return '';
  return ` (${total} of them because the quote or answer was not found: ${Object.entries(changed).map(([reason, n]) => `${reason}: ${n}`).join(', ')})`;
}

export const acceptanceWrite: ToolDef<Static<typeof INPUT>> = {
  name: 'acceptance_write',
  description: "Replace this conversation's draft acceptance list (owner-facing documents language): one checkable result per item, not how to build it. source: owner_words with quote (the owner's exact words; never translate) or ai_added. check: a command that succeeds only when the item holds, whenever possible; else look or read (keep these few; split mixed items). notDoing: what the owner ruled out. Quotes are checked against the conversation.",
  input: INPUT,
  effect: 'meta',
  allowedIn: ['chat'],
  planOk: true,
  projectOnly: true,
  acceptanceState: 'draft',
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const services = ctx.services;
    if (!services?.acceptance || !ctx.project) return { content: toolText(language, 'acceptance.no_store'), isError: true };
    let tainted = ctx.taint.tainted;
    if (!tainted && ctx.conversationTainted) { try { tainted = ctx.conversationTainted(); } catch { tainted = true; } }
    try {
      const speech = prepareSpeech(ownerSpeech(services.db, ctx.project.id), SCAN_BUDGET, confirmedPicks(services.db, ctx.project.id));
      const docLanguage = services.projects?.get(ctx.project.id)?.doc_language ?? null;
      const { doc, verified, changed } = buildDraft({ items: input.items.map(entry => ({ result: entry.result, source: claimOf(entry), check: checkOf(entry) })), notDoing: input.notDoing?.map(entry => ({ text: entry.text, source: claimOf(entry) })) }, speech, { language: docLanguage, taintedRuns: tainted ? [ctx.runId] : [] });
      services.acceptance.writeDraft(ctx.project.id, ctx.conversationId, doc);
      services.emit({ type: 'acceptance.changed', projectId: ctx.project.id, version: 0, draft: true });
      const aiAdded = [...doc.items, ...doc.notDoing].filter(entry => entry.source.kind === 'ai_added').length;
      return { content: toolText(language, 'acceptance.saved', { items: doc.items.length, notDoing: doc.notDoing.length, verified, aiAdded, unconfirmed: unconfirmedText(changed) }) };
    } catch (error) {
      return { content: toolText(language, 'failed', { detail: errorText(error, language) }), isError: true };
    }
  },
};
