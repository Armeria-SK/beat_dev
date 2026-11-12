import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { describeCron, validateCron } from '../../tasks/schedule.ts';
import { TaskError, type Task, type TaskStore } from '../../tasks/store.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

function store(ctx: ToolContext): TaskStore {
  const tasks = ctx.services?.tasks;
  if (!tasks) throw new TaskError('error.unavailable');
  return tasks;
}
const fail = (error: unknown, ctx: ToolContext): ToolOutput => {
  const language = languageOf(ctx.config);
  return { content: error instanceof TaskError ? error.text(language) : toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
};
const STATUSES = ['inbox', 'ready', 'running', 'waiting', 'scheduled', 'done', 'failed', 'cancelled'] as const;
const short = (id: string) => id.slice(0, 8);
const when = (ms: number, timezone: string, _language: Language) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: timezone }).format(ms);

function line(task: Task, timezone: string, language: Language): string {
  const at = task.cron ? toolText(language, 'task.when_cron', { cron: describeCron(task.cron, language) }) : task.run_at ? toolText(language, 'task.since', { time: when(task.run_at, timezone, language) }) : '';
  const status = (STATUSES as readonly string[]).includes(task.status) ? toolText(language, `task.status.${task.status as (typeof STATUSES)[number]}`) : task.status;
  return toolText(language, 'task.line', { id: short(task.id), status, when: at, title: task.title, next: task.next_action ? toolText(language, 'task.next', { next: task.next_action }) : '' });
}

function parseWhen(when: string | undefined): number | undefined {
  if (!when) return undefined;
  const ms = Date.parse(when);
  if (!Number.isFinite(ms)) throw new TaskError('error.bad_when', { when });
  return ms;
}

export const taskCreate: ToolDef<{ title: string; body?: string; next_action?: string; done_criteria?: string; priority?: number; when?: string; repeat?: string; requested_by_user?: boolean }> = {
  name: 'task_create',
  description: [
    'Write a to-do (a task) in the notebook. You work on it yourself later.',
    'For something the user asked for, requested_by_user=true. when is the start date and time (ISO 8601, with a time zone); repeat is the repetition (cron: "minute hour day month weekday", e.g. "0 9 * * MON-FRI").',
    'Do not make a task for something that finishes quickly; do it right away.',
  ].join(' '),
  input: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.Optional(Type.String({ maxLength: 4000 })),
    next_action: Type.Optional(Type.String({ maxLength: 500 })),
    done_criteria: Type.Optional(Type.String({ maxLength: 500 })),
    priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: '1 is the highest' })),
    when: Type.Optional(Type.String({ maxLength: 40 })),
    repeat: Type.Optional(Type.String({ maxLength: 60 })),
    requested_by_user: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  effect: 'meta',
  escalateOnTaint: true,
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      if (input.repeat && !validateCron(input.repeat)) throw new TaskError('error.bad_repeat', { repeat: input.repeat });
      const self = !input.requested_by_user;
      const task = store(ctx).create({
        title: input.title, body: input.body, nextAction: input.next_action, doneCriteria: input.done_criteria, priority: input.priority,
        runAt: parseWhen(input.when), cron: input.repeat, timezone: ctx.config.timezone,
        origin: self ? 'self' : 'user', propose: self && ctx.config.worker.selfTasksNeedApproval, actor: 'clive', createdInConversation: ctx.conversationId, localOnly: ctx.localOnly === true, projectId: ctx.project?.id,
      });
      ctx.touchedTasks?.add(task.id);
      const language = languageOf(ctx.config);
      store(ctx).event(task.id, 'context', 'clive', toolText(language, 'task.context', { cid: ctx.conversationId }), ctx.runId);
      const note = task.status === 'inbox' ? toolText(language, 'task.note_proposal')
        : self && !ctx.config.worker.autonomy ? toolText(language, 'task.note_autonomy_off') : '';
      return { content: toolText(language, 'task.created', { line: line(task, ctx.config.timezone, language), note }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const taskList: ToolDef<{ include_finished?: boolean }> = {
  name: 'task_list',
  description: 'View the list of tasks (in progress, scheduled, waiting for a reply, proposed). With include_finished=true, also the recently finished ones.',
  input: Type.Object({ include_finished: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'review'],
  async execute(input, ctx) {
    try {
      const s = store(ctx);
      const active = s.list();
      const language = languageOf(ctx.config);
      const lines = active.map(t => line(t, ctx.config.timezone, language));
      if (input.include_finished) lines.push(...s.recentlyFinished(10).map(t => line(t, ctx.config.timezone, language)));
      return { content: lines.length ? lines.join('\n') : toolText(language, 'task.none') };
    } catch (error) { return fail(error, ctx); }
  },
};

export const taskUpdate: ToolDef<{ id: string; note?: string; next_action?: string; priority?: number; when?: string; status?: 'done' | 'cancelled' }> = {
  name: 'task_update',
  description: 'Add a note to a task, change its next step, priority or start date and time, or mark it done or cancelled (id is the [xxxxxxxx] in the list).',
  input: Type.Object({
    id: Type.String({ minLength: 6, maxLength: 64 }),
    note: Type.Optional(Type.String({ maxLength: 2000 })),
    next_action: Type.Optional(Type.String({ maxLength: 500 })),
    priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    when: Type.Optional(Type.String({ maxLength: 40 })),
    status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('cancelled')])),
  }, { additionalProperties: false }),
  effect: 'meta',
  escalateOnTaint: true,
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      const s = store(ctx);
      const task = s.find(input.id);
      if (!task) throw new TaskError('error.tool_not_found', { id: input.id });
      if (ctx.project && task.project_id !== ctx.project.id) throw new TaskError('error.other_project', { id: input.id });
      let updated = s.update(task.id, {
        ...(input.note ? { appendNote: input.note } : {}), ...(input.next_action ? { nextAction: input.next_action } : {}),
        ...(input.priority ? { priority: input.priority } : {}), ...(input.when ? { runAt: parseWhen(input.when) ?? null } : {}),
      }, 'clive', ctx.runId);
      if (input.status) updated = s.finish(task.id, input.status, input.note ?? null, 'clive', ctx.runId);
      ctx.touchedTasks?.add(task.id);
      if (ctx.localOnly === true) s.markLocalOnly(task.id);
      return { content: toolText(languageOf(ctx.config), 'task.updated', { line: line(updated, ctx.config.timezone, languageOf(ctx.config)) }) };
    } catch (error) { return fail(error, ctx); }
  },
};


export const taskCheckpoint: ToolDef<{ tried: string; result: string; next_action: string; resume_after_minutes: number }> = {
  name: 'task_checkpoint',
  description: 'Record the progress of the task you are working on now and pause. Write what you tried, the result, the next step and after how many minutes to resume. Even when there is no progress, write what is missing and pause.',
  input: Type.Object({
    tried: Type.String({ minLength: 1, maxLength: 1500 }),
    result: Type.String({ minLength: 1, maxLength: 1500 }),
    next_action: Type.String({ minLength: 1, maxLength: 500 }),
    resume_after_minutes: Type.Integer({ minimum: 1, maximum: 10080 }),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task) return { content: toolText(language, 'task.not_running'), isError: true };
    ctx.task.control = { outcome: 'checkpoint', note: toolText(language, 'task.checkpoint_note', { tried: input.tried, result: input.result }), nextAction: input.next_action, resumeAfterMinutes: input.resume_after_minutes };
    return { content: toolText(language, 'task.checkpoint_saved', { minutes: input.resume_after_minutes, end: toolText(language, 'task.end') }) };
  },
};

export const taskComplete: ToolDef<{ summary: string; notify?: boolean }> = {
  name: 'task_complete',
  description: 'Finish the task you are working on now. Write the result in summary. If there is nothing to tell the user, notify=false (finish quietly).',
  input: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4000 }), notify: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task) return { content: toolText(language, 'task.not_running'), isError: true };
    ctx.task.control = { outcome: 'complete', summary: input.summary, notify: input.notify ?? true };
    return { content: toolText(language, 'task.completed', { end: toolText(language, 'task.end') }) };
  },
};

export const askUser: ToolDef<{ question: string }> = {
  name: 'ask_user',
  description: 'Ask the user about the task you are working on now (the task stops until the answer comes). Ask only about things where going ahead on a guess would cause trouble.',
  input: Type.Object({ question: Type.String({ minLength: 1, maxLength: 1500 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task) return { content: toolText(language, 'task.not_running_chat'), isError: true };
    ctx.task.control = { outcome: 'question', question: input.question };
    return { content: toolText(language, 'task.asked', { end: toolText(language, 'task.end') }) };
  },
};
