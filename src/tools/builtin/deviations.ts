import { Type } from '@sinclair/typebox';
import type { AcceptanceDoc } from '../../projects/acceptance.ts';
import { addDeviation, DEVIATION_TEXT_MAX, DeviationError } from '../../projects/deviations.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { deviationText } from '../../shared/messages/deviations.ts';
import type { ToolContext, ToolDef } from '../types.ts';

interface DeviationAddInput { item?: string; what: string; why: string }

function tainted(ctx: ToolContext, taskId: string): boolean {
  if (ctx.taint.tainted) return true;
  try { if (ctx.conversationTainted?.() === true) return true; } catch { return true; }
  return ctx.services?.tasks?.textTainted(taskId) === true;
}

function acceptanceOf(ctx: ToolContext, projectId: string): AcceptanceDoc | undefined | 'unreadable' {
  const store = ctx.services?.acceptance;
  if (!store) return 'unreadable';
  try { return store.read(projectId); } catch { return 'unreadable'; }
}

export const deviationAdd: ToolDef<DeviationAddInput> = {
  name: 'deviation_add',
  description: "Record where your work differs from the plan or the acceptance list, and why; the owner sees it next to the plan. item: the acceptance item it is about (such as A-3), if any. Write in the product's owner-facing language.",
  input: Type.Object({
    item: Type.Optional(Type.String({ maxLength: 20 })),
    what: Type.String({ minLength: 1, maxLength: DEVIATION_TEXT_MAX }),
    why: Type.String({ minLength: 1, maxLength: DEVIATION_TEXT_MAX }),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  projectOnly: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.task || !ctx.project) return { content: deviationText(language, 'not_in_task'), isError: true };
    const projectId = ctx.project.id;
    const external = tainted(ctx, ctx.task.id);
    try {
      const { row, hidden } = addDeviation(ctx.paths.projects, projectId, input, {
        taskId: ctx.task.id, external, now: Date.now(), timezone: ctx.config.timezone,
        language: ctx.services?.projects?.get(projectId)?.doc_language ?? null, acceptance: acceptanceOf(ctx, projectId),
      });
      const saved = deviationText(language, external ? 'saved_external' : 'saved', { item: row.item ?? deviationText(language, 'no_item') });
      return { content: hidden ? `${saved}. ${deviationText(language, 'saved_hidden')}` : saved };
    } catch (error) {
      if (error instanceof DeviationError) return { content: errorText(error, language), isError: true };
      throw error;
    }
  },
};
