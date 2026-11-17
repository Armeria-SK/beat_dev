import { Type } from '@sinclair/typebox';
import { transaction } from '../../db/database.ts';
import { folderMissing } from '../../projects/store.ts';
import { usableAreaPath } from '../../scout/areas.ts';
import { languageOf } from '../../shared/language.ts';
import { scoutText } from '../../shared/messages/scout.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { plainLine } from '../../shared/plain-text.ts';
import { PROPOSAL_LIMITS, type Proposal } from '../../tasks/proposal.ts';
import { TaskError } from '../../tasks/store.ts';
import type { ToolDef } from '../types.ts';

interface ProposalAddInput { title: string; kind: 'feature' | 'bug'; why: string; area?: string[]; size: 'S' | 'M' | 'L'; goal?: string; evidence?: string; ledger?: string }

export const REJECTED_WINDOW_MS = 30 * 86_400_000;

export const sameTitle = (title: string): string => title.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export const proposalAdd: ToolDef<ProposalAddInput> = {
  name: 'proposal_add',
  description: 'Put one proposal on the Kanban (Proposed) for the owner to approve or reject, from a scout report. title: one short English line. kind: feature or bug. why: at most two sentences. area: product paths it touches. size: S, M or L. goal: the plan goal it serves (leave it out when it is outside the plan). evidence: what the scout saw. ledger: the ledger entry id (L-0007) if there is one. A proposal with the same title as an open one, or one rejected in the last 30 days, is refused. English only; never write instructions or requests.',
  input: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Union([Type.Literal('feature'), Type.Literal('bug')]),
    why: Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.why }),
    area: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.area }), { maxItems: PROPOSAL_LIMITS.areas })),
    size: Type.Union([Type.Literal('S'), Type.Literal('M'), Type.Literal('L')]),
    goal: Type.Optional(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.goal })),
    evidence: Type.Optional(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.evidence })),
    ledger: Type.Optional(Type.String({ pattern: '^L-[0-9]{4,8}$' })),
  }, { additionalProperties: false }),
  effect: 'meta',
  allowedIn: ['task'],
  projectOnly: true,
  scoutOnly: true,
  replayable: false,
  async execute(input, ctx) {
    const language = languageOf(ctx.config);
    const tasks = ctx.services?.tasks;
    const db = ctx.services?.db;
    if (!ctx.project || !ctx.scout || !tasks || !db) return { content: scoutText(language, 'proposal.unavailable'), isError: true };
    const project = ctx.services?.projects?.get(ctx.project.id);
    if (!project || project.archived_at !== null || folderMissing(project)) return { content: scoutText(language, 'closed'), isError: true };
    const title = plainLine(input.title, 200);
    if (!title) return { content: scoutText(language, 'empty', { field: 'title' }), isError: true };
    const key = sameTitle(title);
    const since = Date.now() - REJECTED_WINDOW_MS;
    const earlier = db.prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND proposal IS NOT NULL
      AND (status = 'inbox' OR (status = 'cancelled' AND COALESCE(completed_at, updated_at) > ?))`).all(project.id, since) as Array<{ id: string; title: string }>;
    const same = earlier.find(row => sameTitle(row.title) === key);
    if (same) return { content: scoutText(language, 'proposal.duplicate', { title, id: same.id.slice(0, 8) }), isError: true };
    const area = [...new Set((input.area ?? []).map(raw => usableAreaPath(raw, PROPOSAL_LIMITS.area)).filter((path): path is string => path !== null))];
    const proposal: Proposal = {
      kind: input.kind, why: plainLine(input.why, PROPOSAL_LIMITS.why), area, size: input.size,
      goal: input.goal ? plainLine(input.goal, PROPOSAL_LIMITS.goal) || null : null,
      evidence: input.evidence?.trim() ? input.evidence.trim().slice(0, PROPOSAL_LIMITS.evidence) : null,
      ledger: input.ledger ?? null,
    };
    try {
      const task = transaction(db, () => {
        const made = tasks.create({ title, body: proposal.why, origin: 'self', propose: true, projectId: project.id, proposal, actor: 'beat' });
        tasks.markUntrusted(made.id, 'scout', scoutText(language, 'proposal.untrusted'));
        return made;
      });
      return { content: scoutText(language, 'proposal.added', { id: task.id.slice(0, 8), title }) };
    } catch (error) {
      if (error instanceof TaskError) return { content: error.text(language), isError: true };
      return { content: toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
    }
  },
};
