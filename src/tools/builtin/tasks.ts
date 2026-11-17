import { Type } from '@sinclair/typebox';
import type { Language } from '../../config/schema.ts';
import { languageOf } from '../../shared/language.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { pendingText } from '../../shared/messages/pending.ts';
import { CHECK_FAIL_LIMIT, CHECK_TEXT, checkSignal, productCheck, runProductCheck } from '../../projects/check-run.ts';
import { liveList, ownedItems, runGate, type GateItemInput } from '../../projects/gate.ts';
import { gateText } from '../../shared/messages/gate.ts';
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

export const taskCreate: ToolDef<{ title: string; body?: string; next_action?: string; done_criteria?: string; priority?: number; when?: string; repeat?: string; requested_by_user?: boolean; items?: string[] }> = {
  name: 'task_create',
  description: [
    'Write a to-do (a task) in the notebook. You work on it yourself later.',
    'For something the user asked for, requested_by_user=true. when is the start date and time (ISO 8601, with a time zone); repeat is the repetition (cron: "minute hour day month weekday", e.g. "0 9 * * MON-FRI").',
    'Do not make a task for something that finishes quickly; do it right away.',
    'items hands acceptance items this task covers (e.g. ["A-2"]) to the new task.',
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
    items: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 20 }), { maxItems: 60 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  escalateOnTaint: true,
  allowedIn: ['chat', 'task'],
  async execute(input, ctx) {
    try {
      if (input.repeat && !validateCron(input.repeat)) throw new TaskError('error.bad_repeat', { repeat: input.repeat });
      const parent = ctx.task !== undefined && !store(ctx).beatDecided(ctx.task.id) ? ctx.task.id : undefined;
      const items = input.items === undefined ? undefined : [...new Set(input.items)];
      if (items?.length) {
        const language = languageOf(ctx.config);
        const owner = parent ? store(ctx).get(parent) : undefined;
        const list = ctx.services?.db ? liveList(ctx.services.db, owner?.project_id ?? null) : undefined;
        if (!owner || !list || !ctx.project || owner.project_id !== ctx.project.id) return { content: gateText(language, 'items_child_only'), isError: true };
        if (input.repeat) return { content: gateText(language, 'items_repeat'), isError: true };
        const unknown = items.filter(id => !list.items.some(entry => entry.id === id));
        if (unknown.length) return { content: gateText(language, 'items_unknown', { ids: unknown.map(id => id.slice(0, 20)).join(', ') }), isError: true };
        const mine = ownedItems(owner);
        const foreign = items.filter(id => !mine.includes(id));
        if (foreign.length) return { content: gateText(language, 'items_not_owned', { ids: foreign.join(', ') }), isError: true };
      }
      const inTask = ctx.task !== undefined;
      const self = parent === undefined && (inTask || !input.requested_by_user);
      const task = store(ctx).create({
        title: input.title, body: input.body, nextAction: input.next_action, doneCriteria: input.done_criteria, priority: input.priority,
        runAt: parseWhen(input.when), cron: input.repeat, timezone: ctx.config.timezone,
        origin: self ? 'self' : 'user', propose: self && (!inTask || input.repeat !== undefined || ctx.config.worker.selfTasksNeedApproval), spawnedBy: parent,
        ...(items?.length ? { acceptanceItems: items } : {}),
        actor: 'beat', createdInConversation: ctx.conversationId, projectId: ctx.project?.id,
      });
      ctx.touchedTasks?.add(task.id);
      const language = languageOf(ctx.config);
      store(ctx).event(task.id, 'context', 'beat', toolText(language, 'task.context', { cid: ctx.conversationId }), ctx.runId);
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
      const shown = [...active, ...(input.include_finished ? s.recentlyFinished(10) : [])];
      const lines = shown.map(t => line(t, ctx.config.timezone, language));
      const fetched = shown.some(t => s.textTainted(t.id));
      return { content: lines.length ? lines.join('\n') : toolText(language, 'task.none'), ...(fetched ? { fetched: true } : {}) };
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
      if (input.status === 'done') {
        const text = CHECK_TEXT[languageOf(ctx.config)];
        const children = s.openChildren(task.id);
        const refused = ctx.task?.id === task.id ? text.selfDone : ownedItems(task).length > 0 ? gateText(languageOf(ctx.config), 'update_done', { id: task.id }) : children > 0 ? text.doneChildren(children)
          : task.spawned_by === null && productCheck(ctx.services?.projects, task.project_id) !== undefined ? text.doneCheck : undefined;
        if (refused) return { content: refused, isError: true };
      }
      let updated = s.update(task.id, {
        ...(input.note ? { appendNote: input.note } : {}), ...(input.next_action ? { nextAction: input.next_action } : {}),
        ...(input.priority ? { priority: input.priority } : {}), ...(input.when ? { runAt: parseWhen(input.when) ?? null } : {}),
      }, 'beat', ctx.runId);
      if (input.status) updated = s.finish(task.id, input.status, input.note ?? null, 'beat', ctx.runId);
      ctx.touchedTasks?.add(task.id);
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
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task) return { content: toolText(language, 'task.not_running'), isError: true };
    ctx.task.control = { outcome: 'checkpoint', note: toolText(language, 'task.checkpoint_note', { tried: input.tried, result: input.result }), nextAction: input.next_action, resumeAfterMinutes: input.resume_after_minutes };
    return { content: toolText(language, 'task.checkpoint_saved', { minutes: input.resume_after_minutes, end: toolText(language, 'task.end') }) };
  },
};

export const taskComplete: ToolDef<{ summary: string; notify?: boolean; items?: GateItemInput[] }> = {
  name: 'task_complete',
  description: 'Finish the task you are working on now. Write the result in summary. If there is nothing to tell the user, notify=false (finish quietly). While tasks you made from this task are unfinished (including ones set to start later with when), this only pauses the task until they finish. If the product has a check command, beat runs it first; when it fails, fix the cause and call this again. For acceptance items this task covers, beat runs the item commands; for the other items pass items: the tag (E-3) of a successful tool call as evidence, or not_done with the reason.',
  input: Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 4000 }),
    notify: Type.Optional(Type.Boolean()),
    items: Type.Optional(Type.Array(Type.Object({
      id: Type.String({ minLength: 1, maxLength: 20 }),
      evidence: Type.Optional(Type.String({ maxLength: 20 })),
      not_done: Type.Optional(Type.String({ maxLength: 1000 })),
    }, { additionalProperties: false }), { maxItems: 60 })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task) return { content: toolText(language, 'task.not_running'), isError: true };
    const end = toolText(language, 'task.end');
    const text = CHECK_TEXT[language];
    if (ctx.task.control.outcome !== 'none') return { content: text.already };
    const taskId = ctx.task.id;
    const tasks = ctx.services?.tasks;
    const children = tasks?.openChildren(taskId) ?? 0;
    if (children > 0) {
      ctx.task.control = { outcome: 'yield', reason: text.yieldReason(children) };
      return { content: `${text.childrenLeft(children)} ${end}` };
    }
    const own = tasks?.get(taskId);
    const check = tasks && own && own.spawned_by === null ? productCheck(ctx.services?.projects, own.project_id) : undefined;
    if (check === 'invalid') return { content: text.invalid, isError: true };
    const gate = own ? await runGate(ctx, own, input.items, language) : { kind: 'skip' as const };
    if (gate.kind === 'refuse') return { content: gate.text, isError: true };
    if (gate.kind === 'failed') {
      ctx.task.control = { outcome: 'failed', reason: gate.reason };
      return { content: `${gate.text}\n${end}`, isError: true };
    }
    let passed = '';
    if (tasks && check) {
      const stop = checkSignal(ctx.stopSignal ?? ctx.signal, () => tasks.get(taskId)?.status === 'running');
      let run;
      try { run = await runProductCheck(check, { config: ctx.config, dataDir: ctx.paths.data, signal: stop.signal }); } finally { stop.dispose(); }
      if (!run.ok && run.reason === 'aborted') return { content: text.stopped, isError: true };
      if (!run.ok) {
        const attempt = tasks.checkFailures(taskId).count + 1;
        tasks.event(taskId, 'check_failed', 'beat', text.event(run, attempt), ctx.runId);
        if (attempt < CHECK_FAIL_LIMIT) return { content: text.failed(check.command, run, attempt), isError: true };
        ctx.task.control = { outcome: 'failed', reason: text.reason(run) };
        return { content: `${text.gaveUp(check.command, run)}\n${end}`, isError: true };
      }
      tasks.event(taskId, 'check_passed', 'beat', null, ctx.runId);
      passed = text.passed(check.command);
    }
    const waiting = ctx.services?.db ? (ctx.services.db.prepare("SELECT id FROM pending_actions WHERE task_id = ? AND status = 'waiting' ORDER BY id").all(ctx.task.id) as Array<{ id: number }>) : [];
    const suffix = waiting.length ? pendingText(language, 'task_waiting', { ids: waiting.map(row => `#${row.id}`).join(', ') }) : '';
    ctx.task.control = { outcome: 'complete', summary: suffix ? `${input.summary}\n\n${suffix}` : input.summary, notify: input.notify ?? true };
    const done = toolText(language, 'task.completed', { end });
    const items = gate.kind === 'pass' ? gate.text : '';
    const state = own?.project_id ? gateText(language, 'state_line') : '';
    return { content: [items, passed, state, done, suffix].filter(Boolean).join('\n') };
  },
};
