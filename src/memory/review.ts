import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LANGUAGE, type Language } from '../config/schema.ts';
import type { StoredMessage } from '../db/conversations.ts';
import { KV } from '../db/kv.ts';
import type { Task, TaskEvent } from '../tasks/store.ts';
import { estimateTextTokens, prefixLength } from '../engine/tokens.ts';
import { prefix, type Memory } from './store.ts';

export type ReviewTrigger = 'task' | 'idle' | 'heavy_run' | 'book_full' | 'manual';

export interface ReviewJob {
  id: number;
  trigger: ReviewTrigger;
  dedup_key: string;
  conversation_id: string | null;
  task_id: string | null;
  status: 'pending' | 'running' | 'done' | 'failed';
  run_id: string | null;
  review_conversation_id: string | null;
  note: string | null;
  created_at: number;
  finished_at: number | null;
}

export const TRIGGER_TEXT: Record<Language, Record<ReviewTrigger, string>> = {
  en: { task: 'A task finished', idle: 'The conversation went quiet', heavy_run: 'Long conversation not reviewed yet', book_full: 'Memory has grown large', manual: 'Manual' },
};

export const REVIEW_WINDOW_CHARS = 15_000;
export const REVIEW_WINDOW_RATIO = 0.4;
const WINDOW_PAGE = 200;

export interface WindowLimits { maxChars: number; maxTokens?: number | undefined }

export type WindowMessage = Pick<StoredMessage, 'id' | 'role' | 'text'> & { message: { role: string; note?: unknown; name?: string } };

export interface ReviewWindow { transcript: string; messages: WindowMessage[]; lastId: number | undefined; full: boolean }

export const reviewWindowLimits = (available: number | undefined): WindowLimits => ({
  maxChars: REVIEW_WINDOW_CHARS,
  ...(available !== undefined ? { maxTokens: Math.floor(available * REVIEW_WINDOW_RATIO) } : {}),
});

export const reviewUptoKey = (conversationId: string): string => `review:upto:${conversationId}`;

// 整理の振り返り（book_full）では、記憶を消さず・新しく覚えず、案を知らせる。この実行には渡さず、呼ばれても拒否する道具
export const TIDY_FORBIDDEN_TOOLS: readonly string[] = ['memory_forget', 'memory_save', 'skill_draft'];

// 整理の案の返事が「案なし」のとき（通知しない）
export const isNoProposal = (reply: string): boolean => /^(?:変更なし|No changes?)[。.!！]?$/iu.test(reply.trim());

export class ReviewJobs {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  constructor(db: DatabaseSync, now: () => number = Date.now) { this.#db = db; this.#now = now; }

  enqueue(trigger: ReviewTrigger, dedupKey: string, refs: { conversationId?: string | null | undefined; taskId?: string | null | undefined } = {}): ReviewJob | undefined {
    const result = this.#db.prepare('INSERT OR IGNORE INTO memory_jobs (trigger, dedup_key, conversation_id, task_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(trigger, dedupKey, refs.conversationId ?? null, refs.taskId ?? null, this.#now());
    return Number(result.changes) === 1 ? this.get(Number(result.lastInsertRowid)) : undefined;
  }

  get(id: number): ReviewJob | undefined {
    return this.#db.prepare('SELECT * FROM memory_jobs WHERE id = ?').get(id) as ReviewJob | undefined;
  }

  // 古い順に、まだ始まっていない振り返りを 1 本。同じ会話の振り返りがもう動いているものは飛ばす
  // （worker.maxParallel が 2 以上でも、同じ発言を 2 本が同時に振り返って記憶を二重に書かないため。飛ばした分は実行待ちのまま、先の分が終われば選ばれる）
  next(options: { skipPiled?: boolean } = {}): ReviewJob | undefined {
    return this.#db.prepare(`SELECT * FROM memory_jobs j WHERE j.status = 'pending'
      AND (j.conversation_id IS NULL OR NOT EXISTS (SELECT 1 FROM memory_jobs r WHERE r.status = 'running' AND r.conversation_id = j.conversation_id))
      ${options.skipPiled ? "AND j.trigger != 'heavy_run'" : ''}
      ORDER BY j.id LIMIT 1`).get() as ReviewJob | undefined;
  }

  enqueueIfPiled(conversationId: string, limits: WindowLimits): ReviewJob | undefined {
    const upto = Number(new KV(this.#db).get(reviewUptoKey(conversationId)) ?? 0);
    if (!conversationWindow(this.#db, conversationId, upto, limits).full) return undefined;
    return this.enqueue('heavy_run', `conv:${conversationId}:${upto}`, { conversationId });
  }

  pendingCount(): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'pending'").get() as { n: number }).n;
  }

  claim(id: number, runId: string, reviewConversationId: string): void {
    this.#db.prepare("UPDATE memory_jobs SET status = 'running', run_id = ?, review_conversation_id = ? WHERE id = ?").run(runId, reviewConversationId, id);
  }

  finish(id: number, status: 'done' | 'failed', note: string | null): void {
    this.#db.prepare('UPDATE memory_jobs SET status = ?, note = ?, finished_at = ? WHERE id = ?').run(status, note, this.#now(), id);
  }

  // この会話を材料に、いま動いている振り返り
  runningFor(conversationId: string): ReviewJob[] {
    return this.#db.prepare("SELECT * FROM memory_jobs WHERE conversation_id = ? AND status = 'running'").all(conversationId) as unknown as ReviewJob[];
  }

  // この会話を材料にする、まだ始まっていない振り返りを消す（会話を消すとき、止めた振り返りの終わりを待つあいだに、次の振り返りが始まらないように。待つあいだに積み直されても、呼ぶ側が毎回また消す）
  dropPendingFor(conversationId: string): number {
    return Number(this.#db.prepare("DELETE FROM memory_jobs WHERE conversation_id = ? AND status = 'pending'").run(conversationId).changes);
  }

  requeue(id: number): void {
    this.#db.prepare("UPDATE memory_jobs SET status = 'pending', run_id = NULL WHERE id = ?").run(id);
  }

  recoverRunning(): number {
    return Number(this.#db.prepare("UPDATE memory_jobs SET status = 'pending', run_id = NULL WHERE status = 'running'").run().changes);
  }

  list(limit = 50): ReviewJob[] {
    return this.#db.prepare('SELECT * FROM memory_jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as ReviewJob[];
  }

  enqueueIdleConversations(idleMs: number, since: number): number {
    const now = this.#now();
    const rows = this.#db.prepare(`SELECT c.id AS id, (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id) AS last
      FROM conversations c WHERE c.kind = 'chat' AND c.archived = 0 AND c.last_message_at < ? AND c.last_message_at >= ?`).all(now - idleMs, since) as Array<{ id: string; last: number | null }>;
    let added = 0;
    for (const row of rows) {
      if (!row.last) continue;
      if (this.enqueue('idle', `idle:${row.id}:${row.last}`, { conversationId: row.id })) added++;
    }
    return added;
  }
}

export type PolicyTag = 'memory' | 'skill' | 'format' | 'language' | 'guide';

export interface PolicyLine { tag: PolicyTag; memoryOnly?: true; text: string }

interface ReviewText {
  intro: (trigger: string) => string;
  skillIntro: (trigger: string) => string;
  policyHeading: string;
  policy: readonly PolicyLine[];
  skillAuto: string;
  tidyPolicy: readonly string[];
  forgottenHeading: string;
  pressureHeading: string;
  pressureSummary: (tokens: number, budget: number, count: number) => string;
  pressureListHeading: string;
  pressureMore: (count: number) => string;
  taskHeading: string;
  taskTitle: string;
  taskResult: string;
  taskNotes: string;
  taskEvents: string;
  taskConversation: (id: string) => string;
  transcriptHeading: string;
  truncated: string;
  user: string;
  note: string;
  tool: (name: string) => string;
  line: (label: string, body: string) => string;
}

const REVIEW_TEXT: Record<Language, ReviewText> = {
  en: {
    intro: trigger => `[Review] Trigger: ${trigger}. Read the record below and tidy up your memory (this is not a conversation with the user; your reply is only saved to the record).`,
    skillIntro: trigger => `[Review] Trigger: ${trigger}. Read the record below and look for procedures worth keeping as skills (this is not a conversation with the user; your reply is only saved to the record).`,
    policyHeading: '# Policy',
    policy: [
      { tag: 'guide', text: '- Keep only "lessons and facts that will help next time". Do not keep a log of events' },
      { tag: 'guide', memoryOnly: true, text: '- Your main job is to check the memories you already have against the record and keep them tidy: correct them, merge overlapping ones into one, and remove the ones that are wrong or no longer needed' },
      { tag: 'guide', memoryOnly: true, text: "- Add something new only when the record confirms it and it cannot be found in the product's files, the plan or a search of past conversations" },
      { tag: 'guide', memoryOnly: true, text: '- If memories contradict each other, check the record and correct the wrong one. If the record cannot settle it, start the memory with "Unverified:"' },
      { tag: 'guide', memoryOnly: true, text: '- If the user asked in the record for something to be remembered and it is not saved yet, save it (in plan mode it could not be saved, so it is picked up here)' },
      { tag: 'memory', text: '- To correct or merge, use memory_update. To remove, use memory_forget. To add, use memory_save' },
      { tag: 'skill', text: '- If you find a procedure that looks reusable, use skill_draft (it is not used until the user approves it). Prefer fixing an existing skill over creating a new one' },
      { tag: 'format', text: '- If there is nothing to do, use no tools and reply only "No changes" (exactly these English words, whatever language you write in otherwise)' },
      { tag: 'format', text: '- At the end, report what you did in one or two sentences' },
      { tag: 'language', text: "- Write memories, skill drafts and your final reply in the language the user writes in: the language of the [User] lines in the record below (if there are none, the language of the user's own words in the task's title and notes). Only the reply \"No changes\" stays in English" },
    ],
    skillAuto: "- If you find a procedure that looks reusable, use skill_draft (it is registered right away without the user's review unless the record read outside content or is about a task, in which case it waits for the user's approval; the user can undo it from the skill's History). Prefer fixing an existing skill over creating a new one",
    tidyPolicy: [
      '- The purpose this time is to propose how to tidy up memory. Do not learn anything new (memory_save is not available)',
      '- Of the memories listed below that do not fit in a conversation, you may merge only the clearly overlapping ones into one with memory_update. memory_forget is not available (the user decides what to delete)',
      '- Write the memories you think should be deleted or merged in your final reply, one per line, like "[n3] Delete: reason (short)" or "[u1] [u4] Merge: reason (short)". At most 10 lines',
      '- Prefer outdated memories, ones that overlap with others, and ones about temporary events. Do not list important facts about the user',
      '- If there is nothing to propose, use no tools and reply only "No changes" (exactly these English words, whatever language you write in otherwise)',
      '- Write merged memories and your final reply in the language the user writes in: the language the listed memories are written in. Only the reply "No changes" stays in English',
    ],
    forgottenHeading: '# Memories the user deleted (do not learn the same thing again)',
    pressureHeading: '# Memory usage',
    pressureSummary: (tokens, budget, count) => `Memory totals about ${tokens} tokens, over the guideline for what goes into a conversation (about ${budget} tokens). ${count} ${count === 1 ? 'memory does' : 'memories do'} not fit in a conversation. Propose merging overlapping memories and trimming old ones`,
    pressureListHeading: 'Memories that do not fit (oldest first):',
    pressureMore: count => `… (${count} more)`,
    taskHeading: '# Finished task',
    taskTitle: 'Title',
    taskResult: 'Result',
    taskNotes: 'Notes',
    taskEvents: 'History',
    taskConversation: id => `Conversation ID: ${id} (read the run with history_read)`,
    transcriptHeading: '# Record of the conversation',
    truncated: '… (truncated)',
    user: 'User',
    note: 'beat note (not from the user)',
    tool: name => `Tool ${name}`,
    line: (label, body) => `[${label}] ${body}`,
  },
};

export const reviewPolicyLines = (language: Language = DEFAULT_LANGUAGE): readonly PolicyLine[] => REVIEW_TEXT[language].policy;

const clip = (text: string, max: number, language: Language = DEFAULT_LANGUAGE) => (text.length > max ? `${text.slice(0, max)}${REVIEW_TEXT[language].truncated}` : text);

function transcriptLine(m: WindowMessage, language: Language): string | undefined {
  const text = REVIEW_TEXT[language];
  const note = m.message.role === 'user' && m.message.note !== undefined;
  const label = note ? text.note : m.role === 'user' ? text.user : m.role === 'assistant' ? 'beat' : text.tool(m.message.role === 'tool' ? m.message.name ?? '' : '');
  const body = m.role === 'tool' || note ? clip(m.text, 300, language) : clip(m.text, 3000, language);
  return body.trim() ? text.line(label, body) : undefined;
}

export function reviewWindow(messages: readonly (StoredMessage | WindowMessage)[], limits: WindowLimits, language: Language = DEFAULT_LANGUAGE): ReviewWindow {
  const lines: string[] = [];
  const taken: WindowMessage[] = [];
  let chars = 0;
  let tokens = 0;
  for (const m of messages) {
    const line = transcriptLine(m, language);
    if (line !== undefined) {
      const lineChars = line.length + (lines.length ? 1 : 0);
      const lineTokens = estimateTextTokens(line) + 1;
      if (chars + lineChars > limits.maxChars || (limits.maxTokens !== undefined && tokens + lineTokens > limits.maxTokens)) {
        if (lines.length === 0) {
          lines.push(line.slice(0, prefixLength(line, limits.maxChars, limits.maxTokens ?? Infinity)));
          taken.push(m);
        }
        break;
      }
      lines.push(line);
      chars += lineChars;
      tokens += lineTokens;
    }
    taken.push(m);
  }
  return { transcript: lines.join('\n'), messages: taken, lastId: taken.at(-1)?.id, full: taken.length < messages.length };
}

export function conversationWindow(db: DatabaseSync, conversationId: string, upto: number, limits: WindowLimits, language: Language = DEFAULT_LANGUAGE): ReviewWindow {
  const page = db.prepare("SELECT id, role, text, json_extract(parts, '$.role') AS message_role, json_extract(parts, '$.note') AS note, json_extract(parts, '$.name') AS name FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?");
  const loaded: WindowMessage[] = [];
  for (;;) {
    const rows = page.all(conversationId, loaded.at(-1)?.id ?? upto, WINDOW_PAGE) as unknown as Array<Pick<StoredMessage, 'id' | 'role' | 'text'> & { message_role: string; note: unknown; name: string | null }>;
    loaded.push(...rows.map(({ message_role, note, name, ...row }) => ({ ...row, message: { role: message_role, ...(note !== null ? { note } : {}), ...(name !== null ? { name } : {}) } })));
    const window = reviewWindow(loaded, limits, language);
    if (window.full || rows.length < WINDOW_PAGE) return window;
  }
}

// 記憶が会話に入りきらないときの、振り返りへの知らせ。入りきらない記憶を古い順に挙げる（挙げる量も、会話に入れる量と同じ予算まで。最初の 1 件は必ず挙げる）。
export function bookPressureText(input: { tokens: number; budget: number; outside: readonly Pick<Memory, 'id' | 'book' | 'content'>[] }, language: Language = DEFAULT_LANGUAGE): string {
  const text = REVIEW_TEXT[language];
  const lines: string[] = [];
  let used = 0;
  for (const m of input.outside) {
    const line = `- [${prefix(m.book)}${m.id}] ${clip(m.content, 600, language)}`;
    const cost = estimateTextTokens(line) + 1;
    if (lines.length > 0 && used + cost > input.budget) break;
    used += cost;
    lines.push(line);
  }
  const rest = input.outside.length - lines.length;
  return [
    text.pressureSummary(input.tokens, input.budget, input.outside.length),
    text.pressureListHeading,
    ...lines,
    ...(rest > 0 ? [text.pressureMore(rest)] : []),
  ].join('\n');
}

export function reviewPrompt(input: {
  trigger: ReviewTrigger;
  transcript?: string;
  task?: (Pick<Task, 'title' | 'status' | 'result_summary' | 'body'> & Partial<Pick<Task, 'conversation_id'>>) | undefined;
  taskEvents?: readonly Pick<TaskEvent, 'kind' | 'content'>[];
  forgotten: readonly string[];
  bookPressure?: string | undefined;
  language?: Language | undefined;
  skillsAutoRegister?: boolean | undefined;
  memory?: boolean | undefined;
}): string {
  const language = input.language ?? DEFAULT_LANGUAGE;
  const text = REVIEW_TEXT[language];
  const policy = text.policy
    .filter(line => input.memory || (line.tag !== 'memory' && !line.memoryOnly))
    .map(line => (input.skillsAutoRegister && line.tag === 'skill' ? text.skillAuto : line.text));
  const parts = [
    (input.memory ? text.intro : text.skillIntro)(TRIGGER_TEXT[language][input.trigger]),
    '',
    text.policyHeading,
    ...(input.trigger === 'book_full' ? text.tidyPolicy : policy),
  ];
  if (input.memory && input.forgotten.length) {
    parts.push('', text.forgottenHeading, ...input.forgotten.map(f => `- ${clip(f, 200, language)}`));
  }
  if (input.bookPressure) parts.push('', `${text.pressureHeading}\n${input.bookPressure}`);
  if (input.task) {
    parts.push('', text.taskHeading, `${text.taskTitle}: ${input.task.title}`, `${text.taskResult}: ${input.task.status}${input.task.result_summary ? ` — ${clip(input.task.result_summary, 2000, language)}` : ''}`);
    if (input.task.conversation_id) parts.push(text.taskConversation(input.task.conversation_id));
    if (input.task.body) parts.push(`${text.taskNotes}:\n${clip(input.task.body, 3000, language)}`);
    if (input.taskEvents?.length) parts.push(`${text.taskEvents}:`, ...input.taskEvents.slice(0, 15).filter(e => e.content).map(e => `- ${e.kind}: ${clip(e.content ?? '', 300, language)}`));
  }
  if (input.transcript) parts.push('', text.transcriptHeading, input.transcript);
  return parts.join('\n');
}
