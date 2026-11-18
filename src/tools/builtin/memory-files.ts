import { Type } from '@sinclair/typebox';
import { MEMORY_CONTENT_MAX, MEMORY_TITLE_MAX, MemoryFileError, type MemoryWriter } from '../../memory/files.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

export const MEMORY_FILE_DESCRIPTIONS = {
  memory_save: [
    'Save a note in this product\'s memory, so that you, in a later run, can rely on it without looking it up again.',
    'Save when the user asks you to remember something, or when it will clearly help the next piece of work on this product. You may save without asking.',
    'Do not save what the product\'s files, the plan, the acceptance list or a search of past conversations already tell, or how something went only this time.',
    'One topic per note. If you checked it, say in a few words how you checked it. If you did not check it, start the content with "Unverified:".',
  ].join(' '),
  memory_update: [
    'Rewrite a note in this product\'s memory when it is out of date or wrong, or to merge notes on the same topic into one. You may do this without asking.',
    'Keep only what a later run needs and cannot find in the product\'s files, the plan, the acceptance list or past conversations. Say how you checked it, or start the content with "Unverified:".',
  ].join(' '),
  memory_forget: 'Delete a note from this product\'s memory when it is wrong or no longer needed, or when the user asks you to forget it. You may do this without asking.',
} as const;

export const MEMORY_FILE_TOOL_NAMES: readonly string[] = ['memory_save', 'memory_update', 'memory_forget'];

const NameArg = Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,47}$', description: 'The note name, as in memory/<name>.md' });
const TitleArg = Type.String({ minLength: 1, maxLength: MEMORY_TITLE_MAX, description: 'A one-line title in English' });
const ContentArg = Type.String({ minLength: 1, maxLength: MEMORY_CONTENT_MAX, description: 'The note in English (quote the owner\'s words as they are)' });
const WhyArg = Type.String({ minLength: 1, maxLength: 80, description: 'A short title for this change, shown to the owner in the note\'s history' });

export function memoryProjectOf(ctx: ToolContext): string | undefined {
  return ctx.project?.id ?? (ctx.kind === 'review' ? ctx.memoryProject : undefined);
}

// 印の条件は質問票と同じ: この実行が外を読んだ・この会話が外を読んだことがある・タスクの文が外を読んだ実行から書かれた
export function memoryWriter(ctx: ToolContext): MemoryWriter {
  const tasks = ctx.services?.tasks;
  const tainted = ctx.taint.tainted || ctx.conversationTainted?.() === true || (ctx.task !== undefined && tasks?.textTainted(ctx.task.id) === true);
  return { actor: ctx.kind === 'review' ? 'review' : 'beat', tainted, runId: ctx.runId, conversationId: ctx.conversationId };
}

function run(ctx: ToolContext, work: (projectId: string, store: NonNullable<NonNullable<ToolContext['services']>['memoryFiles']>) => { name: string; eventId: number; action: 'create' | 'update' | 'forget'; key: 'memfile.saved' | 'memfile.updated' | 'memfile.forgotten' }): ToolOutput {
  const language = languageOf(ctx.config);
  try {
    const projectId = memoryProjectOf(ctx);
    const store = ctx.services?.memoryFiles;
    if (!projectId || !store) throw new MemoryFileError('memfile.no_product');
    const done = work(projectId, store);
    ctx.services?.emit({ type: 'memoryFile.changed', runId: ctx.runId, conversationId: ctx.conversationId, projectId, name: done.name, action: done.action, eventId: done.eventId });
    return { content: toolText(language, done.key, { name: done.name }) };
  } catch (error) {
    return { content: error instanceof MemoryFileError ? error.text(language) : toolText(language, 'failed', { detail: errorText(error, language) }), isError: true };
  }
}

const common = { effect: 'meta', allowedIn: ['chat', 'task', 'review'], projectOnly: true, productReview: true } as const;

export const memoryFileSave: ToolDef<{ title: string; content: string; why: string }> = {
  name: 'memory_save',
  description: MEMORY_FILE_DESCRIPTIONS.memory_save,
  input: Type.Object({ title: TitleArg, content: ContentArg, why: WhyArg }, { additionalProperties: false }),
  ...common,
  async execute(input, ctx) {
    return run(ctx, (projectId, store) => ({ ...store.save(projectId, { title: input.title, content: input.content, summary: input.why }, memoryWriter(ctx)), action: 'create', key: 'memfile.saved' }));
  },
};

export const memoryFileUpdate: ToolDef<{ name: string; title?: string; content: string; why: string }> = {
  name: 'memory_update',
  description: MEMORY_FILE_DESCRIPTIONS.memory_update,
  input: Type.Object({ name: NameArg, title: Type.Optional(TitleArg), content: ContentArg, why: WhyArg }, { additionalProperties: false }),
  ...common,
  async execute(input, ctx) {
    return run(ctx, (projectId, store) => ({ ...store.update(projectId, input.name, { title: input.title, content: input.content, summary: input.why }, memoryWriter(ctx)), action: 'update', key: 'memfile.updated' }));
  },
};

export const memoryFileForget: ToolDef<{ name: string; reason: string }> = {
  name: 'memory_forget',
  description: MEMORY_FILE_DESCRIPTIONS.memory_forget,
  input: Type.Object({ name: NameArg, reason: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }),
  ...common,
  async execute(input, ctx) {
    return run(ctx, (projectId, store) => ({ ...store.forget(projectId, input.name, input.reason, memoryWriter(ctx)), action: 'forget', key: 'memfile.forgotten' }));
  },
};

export const memoryFileTools: ToolDef[] = [memoryFileSave, memoryFileUpdate, memoryFileForget];
