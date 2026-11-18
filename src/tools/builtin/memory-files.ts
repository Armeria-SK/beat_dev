import { Type } from '@sinclair/typebox';
import { MEMORY_CONTENT_MAX, MEMORY_FILES_MAX, MEMORY_TITLE_MAX, MemoryFileError, type MemoryWriter } from '../../memory/files.ts';
import { storeText } from '../../shared/messages/stores.ts';
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
const EvidenceArg = Type.Optional(Type.String({ maxLength: 500, description: 'Only in a review: words copied exactly from the record that show why' }));

export function memoryProjectOf(ctx: ToolContext): string | undefined {
  return ctx.project?.id ?? (ctx.kind === 'review' ? ctx.memoryProject : undefined);
}

// 印の条件は質問票と同じ: この実行が外を読んだ・この会話が外を読んだことがある・タスクの文が外を読んだ実行から書かれた
export function memoryWriter(ctx: ToolContext): MemoryWriter {
  const tasks = ctx.services?.tasks;
  const tainted = ctx.taint.tainted || ctx.conversationTainted?.() === true || (ctx.task !== undefined && tasks?.textTainted(ctx.task.id) === true);
  return { actor: ctx.kind === 'review' ? 'review' : 'beat', tainted, runId: ctx.runId, conversationId: ctx.conversationId };
}

export const EVIDENCE_MIN_CHARS = 12;
// 持ち主の発言 1 つ丸ごとを証拠にするときの下限（「はい」「ok」だけでどの記憶も直せないように）
export const EVIDENCE_WHOLE_MIN_CHARS = 5;
const QUOTES = /^["'“”‘’「」『』`\s]+|["'“”‘’「」『』`\s]+$/gu;
const plain = (text: string): string => text.normalize('NFKC').replaceAll('⏎', ' ').replace(/\s+/gu, ' ').toLowerCase().trim();

const quoteOf = (evidence: string): string => plain(plain(evidence.replace(QUOTES, '')).replace(/^\[user\]\s*/u, '').replace(QUOTES, ''));

// 振り返りの実行が記憶を直す・消すときの見張り（beat mem-fix）。振り返りの記録に触れていない記憶を、記録に無いという理由だけで書き換えさせない。
// 通すのは: この振り返りの実行が作った・もう直した記憶、または evidence（記録からそのまま写した言葉。頭の [User] は外して照らす）が記録にあるとき。
// 持ち主が確かめた記憶（最後の版が持ち主のもの・履歴が無い・外で直された）は、持ち主の発言（添付と beat の文を除く）にあるときだけ。持ち主の発言 1 つ丸ごとなら 5 文字から。記憶が読めなければ断る
function reviewGuard(ctx: ToolContext, projectId: string, store: NonNullable<NonNullable<ToolContext['services']>['memoryFiles']>, name: string, evidence: string | undefined): void {
  if (ctx.kind !== 'review') return;
  const history = store.history(projectId, name);
  if (history.some(event => event.run_id === ctx.runId)) return;
  const current = store.read(projectId, name).text;
  const last = history[0];
  const ownerHeld = !last || last.actor === 'owner' || last.after !== current;
  const quote = quoteOf(evidence ?? '');
  if (!quote) throw new MemoryFileError(ownerHeld ? 'memfile.review_owner_words' : 'memfile.review_no_evidence', { name });
  const owner = (ctx.reviewEvidence?.owner ?? []).map(plain);
  const length = Array.from(quote).length;
  if (length >= EVIDENCE_WHOLE_MIN_CHARS && owner.includes(quote)) return;
  if (length < EVIDENCE_MIN_CHARS) throw new MemoryFileError('memfile.review_short', { name, min: EVIDENCE_MIN_CHARS, whole: EVIDENCE_WHOLE_MIN_CHARS });
  if (owner.some(m => m.includes(quote))) return;
  if (ownerHeld) throw new MemoryFileError('memfile.review_owner_words', { name });
  if (ctx.reviewEvidence && plain(ctx.reviewEvidence.record).includes(quote)) return;
  throw new MemoryFileError('memfile.review_not_found', { name });
}

// 振り返りが上限で保存できなかったとき: 振り返りは場所を空けられない（記録に触れていない記憶は消せない）ので、そう言って返し、持ち主にも知らせる
function reviewFull(ctx: ToolContext, language: ReturnType<typeof languageOf>): string {
  const projectId = memoryProjectOf(ctx);
  ctx.services?.notify?.({ kind: 'info', title: storeText(language, 'memfile.full_title'), body: storeText(language, 'memfile.full_body', { max: MEMORY_FILES_MAX }), link: '#/memory', dedupKey: `memory-full:${projectId ?? ''}` });
  return storeText(language, 'memfile.review_full', { max: MEMORY_FILES_MAX });
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
    if (error instanceof MemoryFileError && error.code === 'memfile.too_many' && ctx.kind === 'review') return { content: reviewFull(ctx, language), isError: true };
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

export const memoryFileUpdate: ToolDef<{ name: string; title?: string; content: string; why: string; evidence?: string }> = {
  name: 'memory_update',
  description: MEMORY_FILE_DESCRIPTIONS.memory_update,
  input: Type.Object({ name: NameArg, title: Type.Optional(TitleArg), content: ContentArg, why: WhyArg, evidence: EvidenceArg }, { additionalProperties: false }),
  ...common,
  async execute(input, ctx) {
    return run(ctx, (projectId, store) => {
      reviewGuard(ctx, projectId, store, input.name, input.evidence);
      return { ...store.update(projectId, input.name, { title: input.title, content: input.content, summary: input.why }, memoryWriter(ctx)), action: 'update', key: 'memfile.updated' };
    });
  },
};

export const memoryFileForget: ToolDef<{ name: string; reason: string; evidence?: string }> = {
  name: 'memory_forget',
  description: MEMORY_FILE_DESCRIPTIONS.memory_forget,
  input: Type.Object({ name: NameArg, reason: Type.String({ minLength: 1, maxLength: 300 }), evidence: EvidenceArg }, { additionalProperties: false }),
  ...common,
  async execute(input, ctx) {
    return run(ctx, (projectId, store) => {
      reviewGuard(ctx, projectId, store, input.name, input.evidence);
      return { ...store.forget(projectId, input.name, input.reason, memoryWriter(ctx)), action: 'forget', key: 'memfile.forgotten' };
    });
  },
};

export const memoryFileTools: ToolDef[] = [memoryFileSave, memoryFileUpdate, memoryFileForget];
