import { Type } from '@sinclair/typebox';
import { addAiDecision } from '../../mesh/decisions.ts';
import { dateIn } from '../../mesh/files.ts';
import { MeshWriteError, type Writer } from '../../mesh/map.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { meshWriteText } from '../../shared/messages/mesh-write.ts';
import { toolText } from '../../shared/messages/tools.ts';
import type { ToolContext, ToolDef, ToolOutput } from '../types.ts';

const fail = (error: unknown, ctx: ToolContext): ToolOutput => ({ content: toolText(languageOf(ctx.config), 'failed', { detail: errorText(error, languageOf(ctx.config)) }), isError: true });

function writer(ctx: ToolContext): Writer {
  let external = ctx.taint.tainted;
  if (!external && ctx.conversationTainted) { try { external = ctx.conversationTainted(); } catch { external = true; } }
  return { by: 'task', external };
}

function place(ctx: ToolContext): { mesh: NonNullable<NonNullable<ToolContext['services']>['mesh']>; id: string; root: string } | ToolOutput {
  const mesh = ctx.services?.mesh;
  if (!mesh || !ctx.project) return { content: toolText(languageOf(ctx.config), 'mesh.unavailable'), isError: true };
  if (!ctx.project.root) return { content: meshWriteText(languageOf(ctx.config), 'no_folder'), isError: true };
  return { mesh, id: ctx.project.id, root: ctx.project.root };
}

export const meshMapSet: ToolDef<{ path: string; what: string; entry?: string }> = {
  name: 'mesh_map_set',
  description: 'Describe one folder of this product in MAP.md (one English line, up to 160 characters with the path and the entry; replaces the line of that folder). path: a folder beat lists, such as those under "not in MAP yet" in the Mesh. entry: its main file, if it has one. Never write instructions or requests.',
  input: Type.Object({ path: Type.String({ minLength: 1, maxLength: 200 }), what: Type.String({ minLength: 1, maxLength: 640 }), entry: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  projectOnly: true,
  async execute(input, ctx) {
    const at = place(ctx);
    if ('content' in at) return at;
    const by = writer(ctx);
    try {
      const path = await at.mesh.setMapRow(at.id, at.root, input, by);
      return { content: meshWriteText(languageOf(ctx.config), by.external ? 'map_saved_external' : 'map_saved', { path }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const meshGlossarySet: ToolDef<{ term: string; points_to: string }> = {
  name: 'mesh_glossary_set',
  description: 'Record in GLOSSARY.md what a name the owner uses points to (the same name replaces its line; up to 30 names). term: the owner\'s words exactly as written. points_to: a path in the product folder, or a mesh file such as plan.md.',
  input: Type.Object({ term: Type.String({ minLength: 1, maxLength: 200 }), points_to: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  projectOnly: true,
  async execute(input, ctx) {
    const at = place(ctx);
    if ('content' in at) return at;
    const by = writer(ctx);
    try {
      const term = at.mesh.setGlossary(at.id, at.root, input, by);
      return { content: meshWriteText(languageOf(ctx.config), by.external ? 'glossary_saved_external' : 'glossary_saved', { term }) };
    } catch (error) { return fail(error, ctx); }
  },
};

export const meshDecisionAdd: ToolDef<{ decision: string }> = {
  name: 'mesh_decision_add',
  description: 'Add one line to DECISIONS.md for a decision you made while working on this product that later work should keep, with its reason (one short English line, such as "Use SQLite for storage because the app must work offline"). beat marks the line as yours; the owner\'s decisions are written by beat when the owner answers a question, so never present yours as the owner\'s. Never write instructions or requests.',
  input: Type.Object({ decision: Type.String({ minLength: 1, maxLength: 400 }) }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  projectOnly: true,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.project) return { content: toolText(language, 'mesh.unavailable'), isError: true };
    const project = ctx.services?.projects?.get(ctx.project.id);
    if (!project || project.archived_at !== null) return { content: meshWriteText(language, 'decision_closed'), isError: true };
    const by = writer(ctx);
    if (!by.external && ctx.task) by.external = ctx.services?.tasks?.textTainted(ctx.task.id) === true;
    try {
      const { hidden } = addAiDecision(ctx.paths.projects, ctx.project.id, { date: dateIn(Date.now(), ctx.config.timezone), text: input.decision, writer: by });
      const saved = meshWriteText(language, by.external ? 'decision_saved_external' : 'decision_saved');
      return { content: hidden ? `${saved}. ${meshWriteText(language, 'decision_hidden')}` : saved };
    } catch (error) {
      if (error instanceof MeshWriteError) return { content: errorText(error, language), isError: true };
      return fail(error, ctx);
    }
  },
};
