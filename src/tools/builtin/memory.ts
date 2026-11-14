import { Type } from '@sinclair/typebox';
import { conversationSawOutside } from '../../db/outside.ts';
import { readHistory, searchHistory } from '../../memory/history.ts';
import { BOOK_LABELS, MemoryError, prefix, type Book } from '../../memory/store.ts';
import { errorText } from '../../shared/messages/define.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

export const MEMORY_TOOL_NAMES: readonly string[] = ['memory_save', 'memory_update', 'memory_forget', 'memory_search'];

const BookArg = Type.Union([Type.Literal('user'), Type.Literal('notes')], { description: 'user: facts and preferences about the user / notes: beat\'s own notes and lessons' });
const IdArg = Type.Union([Type.Integer({ minimum: 1 }), Type.String({ pattern: '^[unUN]?[0-9]+$' })], { description: 'The memory ID (for [u7], "u7" or 7)' });

function services(ctx: ToolContext) {
  if (!ctx.services) throw new MemoryError('memory.unavailable');
  return ctx.services;
}
const parseId = (id: number | string) => (typeof id === 'number' ? id : Number(String(id).replace(/^[unUN]/u, '')));
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof MemoryError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};

function latestUserMessage(ctx: ToolContext): number | undefined {
  const row = services(ctx).db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(ctx.conversationId) as { id: number } | undefined;
  return row?.id;
}

export const memorySave: ToolDef<{ book: Book; content: string }> = {
  name: 'memory_save',
  description: [
    'Save, right away, something that should be remembered in later conversations too (like ChatGPT\'s memory).',
    'user: the user\'s name, preferences, situation and decisions. notes: your own lessons and tips on how to do things.',
    'Keep each entry short, one fact. Do not write things that only matter in the moment or that are already known.',
  ].join(' '),
  input: Type.Object({ book: BookArg, content: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  escalateOnTaint: true,
  summarize: (input, language) => ({ title: toolText(language, 'summary.memory_save', { label: BOOK_LABELS[language][input.book] }), body: input.content }),
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const messageId = latestUserMessage(ctx);
      const { memory, eventId } = s.memory.save({ book: input.book, content: input.content, actor: ctx.kind === 'review' ? 'review' : 'beat', conversationId: ctx.conversationId, ...(messageId === undefined ? {} : { messageId }), runId: ctx.runId });
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'create', content: memory.content, eventId });
      const language = languageOf(ctx.config);
      return { content: toolText(language, 'memory.saved', { id: `${prefix(memory.book)}${memory.id}`, label: BOOK_LABELS[language][memory.book], used: s.memory.used(memory.book) }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memoryUpdate: ToolDef<{ id: number | string; content: string }> = {
  name: 'memory_update',
  description: 'Rewrite a memory (when it is out of date or wrong, or to merge similar memories).',
  input: Type.Object({ id: IdArg, content: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  escalateOnTaint: true,
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const { memory, eventId } = s.memory.update(parseId(input.id), input.content, ctx.kind === 'review' ? 'review' : 'beat', ctx.runId);
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'update', content: memory.content, eventId });
      return { content: toolText(languageOf(ctx.config), 'memory.updated', { id: `${prefix(memory.book)}${memory.id}` }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memoryForget: ToolDef<{ id: number | string; reason: string }> = {
  name: 'memory_forget',
  description: 'Delete a memory that is no longer needed or was wrong. Also use this when the user asks you to forget something.',
  input: Type.Object({ id: IdArg, reason: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task', 'review'],
  escalateOnTaint: true,
  async execute(input, ctx) {
    try {
      const s = services(ctx);
      const { memory, eventId } = s.memory.forget(parseId(input.id), ctx.kind === 'review' ? 'review' : 'beat', input.reason, ctx.runId);
      s.emit({ type: 'memory.changed', runId: ctx.runId, conversationId: ctx.conversationId, memoryId: memory.id, book: memory.book, action: 'forget', content: memory.content, eventId });
      return { content: toolText(languageOf(ctx.config), 'memory.forgotten', { id: `${prefix(memory.book)}${memory.id}` }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const memorySearch: ToolDef<{ query: string; limit?: number }> = {
  name: 'memory_search',
  description: 'Search memories (when something is not in the memories given at the start of the conversation, or when you want to check an ID).',
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const hits = services(ctx).memory.search(input.query, input.limit ?? 20);
      if (!hits.length) return { content: toolText(languageOf(ctx.config), 'memory.no_hit', { query: input.query }) };
      return { content: hits.map(m => `- [${prefix(m.book)}${m.id}] ${m.content}`).join('\n') };
    } catch (error) { return fail(error, ctx); }
  },
};

const fmtDate = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export const historySearch: ToolDef<{ query: string; days?: number; limit?: number }> = {
  name: 'history_search',
  description: 'Search past conversations. When asked about "that thing we talked about before" or "when was it", search first instead of answering from a guess. days narrows it to the last N days.',
  input: Type.Object({
    query: Type.String({ minLength: 1, maxLength: 200 }),
    days: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const hits = searchHistory(services(ctx).db, input.query, { days: input.days, limit: input.limit ?? 12, excludeConversationId: ctx.conversationId });
      const language = languageOf(ctx.config);
      if (!hits.length) return { content: toolText(language, 'history.no_hit', { query: input.query, days: input.days ? toolText(language, 'history.days', { days: input.days }) : '' }) };
      const db = services(ctx).db;
      return {
        content: hits.map(h => toolText(language, 'history.line', { date: fmtDate(h.createdAt), title: h.title ?? toolText(language, 'history.untitled'), cid: h.conversationId, mid: h.messageId, role: h.role, snippet: h.snippet })).join('\n'),
        ...([...new Set(hits.map(h => h.conversationId))].some(id => conversationSawOutside(db, id)) ? { fetched: true } : {}),
      };
    } catch (error) { return fail(error, ctx); }
  },
};

export const historyRead: ToolDef<{ conversation_id: string; around_message_id?: number; limit?: number }> = {
  name: 'history_read',
  description: 'Read part of a past conversation. Use it to read around a message_id found with history_search.',
  input: Type.Object({
    conversation_id: Type.String({ minLength: 1, maxLength: 100 }),
    around_message_id: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const rows = readHistory(services(ctx).db, input.conversation_id, { aroundMessageId: input.around_message_id, limit: input.limit ?? 20 });
      if (!rows.length) return { content: toolText(languageOf(ctx.config), 'history.not_found'), isError: true };
      return {
        content: rows.map(r => `[${r.id}] ${fmtDate(r.createdAt)} ${r.role}: ${r.text.slice(0, 1500)}`).join('\n\n'),
        ...(conversationSawOutside(services(ctx).db, input.conversation_id) ? { fetched: true } : {}),
      };
    } catch (error) { return fail(error, ctx); }
  },
};
