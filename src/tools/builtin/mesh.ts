import { Type } from '@sinclair/typebox';
import { meshBudget } from '../../mesh/search.ts';
import type { StatePatch } from '../../mesh/state.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput =>
  ({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true });

const unavailable = (ctx: ToolContext): ToolOutput => ({ content: toolText(languageOf(ctx.config), 'mesh.unavailable'), isError: true });

const result = (found: { content: string; fetched: boolean }): ToolOutput => ({ content: found.content, ...(found.fetched ? { fetched: true } : {}) });

export const meshSearch: ToolDef<{ query: string; file?: string }> = {
  name: 'mesh_search',
  description: "Search this product's mesh folder (plan.md, acceptance items, STATE.md and notes) line by line. query: a few words separated by spaces; lines with more of them come first. Use the words of the file's language: English for STATE and notes, the owner-facing documents language for the plan and acceptance items; if nothing is found, try the other language or other words. file: search only that file. Returns file:line, the section heading and the line.",
  input: Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }), file: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const mesh = ctx.services?.mesh;
    if (!mesh || !ctx.project) return unavailable(ctx);
    try { return result(mesh.search(ctx.project.id, input, meshBudget(ctx.contextAvailable, ctx.outputTokens), languageOf(ctx.config))); } catch (error) { return fail(error, ctx); }
  },
};

export const meshRead: ToolDef<{ file: string; section?: string; offset?: number }> = {
  name: 'mesh_read',
  description: "Read a file of this product's mesh folder, such as plan.md, acceptance.json or STATE.md (paths are relative to the mesh folder). section: read only the part under that heading. A long file comes in parts; read the rest with offset.",
  input: Type.Object({ file: Type.String({ minLength: 1, maxLength: 200 }), section: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  effect: 'read',
  allowedIn: ['chat', 'task', 'agent'],
  planOk: true,
  projectOnly: true,
  async execute(input, ctx) {
    const mesh = ctx.services?.mesh;
    if (!mesh || !ctx.project) return unavailable(ctx);
    try { return result(mesh.read(ctx.project.id, input, meshBudget(ctx.contextAvailable, ctx.outputTokens), languageOf(ctx.config))); } catch (error) { return fail(error, ctx); }
  },
};

const note = (max: number) => Type.Optional(Type.String({ maxLength: max * 4 }));

export const meshStateSet: ToolDef<StatePatch> = {
  name: 'mesh_state_set',
  description: 'Record where the work on this product stands in STATE.md; now and next appear at the top of every run of this product. Fields: goal (up to 200 characters), now, next, blocked (up to 120 each). Write them in English, one line each; give only the fields that changed, and an empty string clears one. Write only what you are doing and what comes next; never write instructions or requests.',
  input: Type.Object({ goal: note(200), now: note(120), next: note(120), blocked: note(120) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['chat', 'task'],
  planOk: true,
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
