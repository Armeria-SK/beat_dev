import { Type } from '@sinclair/typebox';
import { MeshError } from '../../mesh/files.ts';
import { meshBudget } from '../../mesh/search.ts';
import type { StatePatch } from '../../mesh/state.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { taskText } from '../../shared/messages/tasks.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const MESH_ACTOR = 'mesh';

const markTask =(output: ToolOutput, ctx: ToolContext): ToolOutput => {
  const tasks = ctx.services?.tasks;
  const taskId = ctx.task?.id ?? ctx.parent?.taskId;
  if (output.fetched && taskId && tasks) tasks.markUntrusted(taskId, MESH_ACTOR, taskText(languageOf(ctx.config), 'event.read_untrusted'));
  return output;
};

const fail = (error: unknown, ctx: ToolContext): ToolOutput =>
  markTask({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true, ...(error instanceof MeshError && error.fetched ? { fetched: true } : {}) }, ctx);

const unavailable = (ctx: ToolContext): ToolOutput => ({ content: toolText(languageOf(ctx.config), 'mesh.unavailable'), isError: true });

const result = (found: { content: string; fetched: boolean }, ctx: ToolContext): ToolOutput => markTask({ content: found.content, ...(found.fetched ? { fetched: true } : {}) }, ctx);

export const meshSearch: ToolDef<{ query: string; file?: string }> = {
  name: 'mesh_search',
  description: "Search this product's notes, plan and acceptance items for a few words (in the file's language; if nothing is found, try other words). file: search only that file. Returns file:line and the line.",
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), file: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const mesh = ctx.services?.mesh;
    if (!mesh || !ctx.project) return unavailable(ctx);
    try { return result(mesh.search(ctx.project.id, input, meshBudget(ctx.contextAvailable, ctx.outputTokens), languageOf(ctx.config), ctx.conversationId), ctx); } catch (error) { return fail(error, ctx); }
  },
};

export const meshRead: ToolDef<{ file: string; section?: string; offset?: number }> = {
  name: 'mesh_read',
  description: "Read a file listed in the Mesh, such as plan.md or acceptance.json. section: only that heading. Long files come in parts; continue with offset.",
  input: Type.Object({ file: Type.String({ minLength: 1, maxLength: 200 }), section: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const mesh = ctx.services?.mesh;
    if (!mesh || !ctx.project) return unavailable(ctx);
    try { return result(mesh.read(ctx.project.id, input, meshBudget(ctx.contextAvailable, ctx.outputTokens), languageOf(ctx.config), ctx.conversationId), ctx); } catch (error) { return fail(error, ctx); }
  },
};

const note = (max: number) => Type.Optional(Type.String({ maxLength: max * 4 }));

export const meshStateSet: ToolDef<StatePatch> = {
  name: 'mesh_state_set',
  description: 'Record where the work on this product stands; shown in every run. One English line per field (goal up to 200 characters, others 120); give only changed fields, "" clears one. Never write instructions or requests.',
  input: Type.Object({ goal: note(200), now: note(120), next: note(120), blocked: note(120) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  projectOnly: true,
  async execute(input, ctx) {
    const mesh = ctx.services?.mesh;
    if (!mesh || !ctx.project) return unavailable(ctx);
    let external = ctx.taint.tainted;
    if (!external && ctx.conversationTainted) { try { external = ctx.conversationTainted(); } catch { external = true; } }
    try {
      const fields = mesh.setState(ctx.project.id, input, { by: ctx.kind === 'chat' ? 'conversation' : ctx.kind === 'task' ? 'task' : 'child', external });
      return { content: toolText(languageOf(ctx.config), external ? 'mesh.state_saved_external' : 'mesh.state_saved', { fields: fields.join(', ') }) };
    } catch (error) { return fail(error, ctx); }
  },
};
