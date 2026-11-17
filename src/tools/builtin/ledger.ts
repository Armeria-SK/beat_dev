import { Type } from '@sinclair/typebox';
import { folderMissing } from '../../projects/store.ts';
import { cleanAreaPath, headOf, type Area } from '../../scout/areas.ts';
import { LIMITS, oneLine, recordEntry, ScoutError } from '../../scout/ledger.ts';
import { languageOf } from '../../shared/language.ts';
import { errorText } from '../../shared/messages/define.ts';
import { scoutText } from '../../shared/messages/scout.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { plainLine } from '../../shared/plain-text.ts';
import { redactSecrets } from '../../shared/redaction.ts';
import type { ToolDef } from '../types.ts';

interface LedgerRecordInput { id?: string; title: string; area?: string[]; checked: string; result: string }

const line = (max: number) => Type.String({ minLength: 1, maxLength: max * 4 });

export function areaOf(paths: readonly string[] | undefined): { area: Area; dropped: string[] } {
  if (paths === undefined) return { area: 'whole', dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const raw of paths) {
    const shown = plainLine(raw, LIMITS.path);
    const clean = shown === raw.trim() && redactSecrets(shown) === shown && !shown.includes(',') ? cleanAreaPath(shown) : null;
    if (clean === null) dropped.push(shown || '-');
    else if (!kept.includes(clean)) kept.push(clean);
  }
  return { area: kept, dropped };
}

export const ledgerRecord: ToolDef<LedgerRecordInput> = {
  name: 'ledger_record',
  description: 'Add one entry to the scout ledger (scout/ledger.md) for an area a scout checked, from its report; give id (L-0007) to rewrite that entry instead. title: what was checked, one short English line. area: the paths checked, relative to the product folder (files or folders); leave it out only when the whole product was checked. checked: what was verified. result: "no problem", "proposal <id>" or "fix <branch>". beat adds the time, the commit and the model. English only; never write instructions or requests.',
  input: Type.Object({
    id: Type.Optional(Type.String({ pattern: '^L-[0-9]{4,8}$' })),
    title: line(LIMITS.title),
    area: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.path * 2 }), { maxItems: LIMITS.paths })),
    checked: line(LIMITS.checked),
    result: line(LIMITS.result),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: [],
  projectOnly: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    if (!ctx.project) return { content: scoutText(language, 'unavailable'), isError: true };
    const project = ctx.services?.projects?.get(ctx.project.id);
    if (!project || project.archived_at !== null || folderMissing(project)) return { content: scoutText(language, 'closed'), isError: true };
    const texts = { title: plainLine(input.title, Infinity), checked: plainLine(input.checked, Infinity), result: plainLine(input.result, Infinity) };
    const cleaned = { title: oneLine(input.title, LIMITS.title), checked: oneLine(input.checked, LIMITS.checked), result: oneLine(input.result, LIMITS.result) };
    for (const field of ['title', 'checked', 'result'] as const) if (!cleaned[field]) return { content: scoutText(language, 'empty', { field }), isError: true };
    const hidden = Object.values(texts).some(text => redactSecrets(text) !== text);
    const { area, dropped } = areaOf(input.area);
    try {
      const commit = await headOf(project.root, ctx.paths.data);
      const by = oneLine(ctx.model?.id ?? '', LIMITS.by) || 'unknown';
      const { id, created } = recordEntry(ctx.paths.projects, project.id, { id: input.id, ...cleaned, area }, { when: new Date().toISOString(), commit, by });
      const parts = [scoutText(language, created ? 'recorded' : 'rewritten', { id, commit: commit ? commit.slice(0, 12) : 'none' })];
      if (dropped.length) parts.push(scoutText(language, 'paths_dropped', { count: dropped.length, paths: dropped.slice(0, 5).join(', ') }));
      if (area !== 'whole' && !area.length) parts.push(scoutText(language, 'no_area_kept'));
      if (hidden) parts.push(scoutText(language, 'hidden'));
      return { content: parts.join('. ') };
    } catch (error) {
      if (error instanceof ScoutError) return { content: errorText(error, language), isError: true };
      return { content: toolText(language, 'failed', { detail: errorText(error, language) }), isError: true };
    }
  },
};
