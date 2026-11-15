import { Type } from '@sinclair/typebox';
import { addAiDecision } from '../../mesh/decisions.ts';
import { dateIn, MeshWriteError, type Writer } from '../../mesh/files.ts';
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
      const { hidden, lineMoved } = addAiDecision(ctx.paths.projects, ctx.project.id, { date: dateIn(Date.now(), ctx.config.timezone), text: input.decision, writer: by });
      const saved = lineMoved
        ? `${meshWriteText(language, 'decision_saved_old')}${by.external ? `. ${meshWriteText(language, 'decision_external_note')}` : ''}`
        : meshWriteText(language, by.external ? 'decision_saved_external' : 'decision_saved');
      return { content: hidden ? `${saved}. ${meshWriteText(language, 'decision_hidden')}` : saved };
    } catch (error) {
      if (error instanceof MeshWriteError) return { content: errorText(error, language), isError: true };
      return fail(error, ctx);
    }
  },
};
