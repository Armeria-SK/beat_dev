import { Type } from '@sinclair/typebox';
import { transaction } from '../../db/database.ts';
import { folderMissing } from '../../projects/store.ts';
import { headOf, usableAreaPath } from '../../scout/areas.ts';
import { languageOf } from '../../shared/language.ts';
import { scoutText } from '../../shared/messages/scout.ts';
import { toolText } from '../../shared/messages/tools.ts';
import { plainLine } from '../../shared/plain-text.ts';
import { researchSeed } from '../../research/store.ts';
import { DEEPENED_EVENT, deepenNote, PROPOSAL_LIMITS, type Proposal } from '../../tasks/proposal.ts';
import { TaskError } from '../../tasks/store.ts';
import type { ToolDef } from '../types.ts';

interface ProposalAddInput { title: string; kind: 'feature' | 'bug'; why: string; area?: string[]; size: 'S' | 'M' | 'L'; goal?: string; evidence?: string; ledger?: string; deepen?: string; fixable?: boolean; research_item?: number }

export const REJECTED_WINDOW_MS = 30 * 86_400_000;
export const PROPOSAL_OPEN_MAX = 10;

export const sameTitle = (title: string): string => title.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

export const goalText = (raw: string): string | null => plainLine(raw.replace(/^\s*(?:#{1,6}|[-*+])(?:\s+|$)/u, ''), PROPOSAL_LIMITS.goal) || null;

// beat 8-6b: Research and pre-fix の製品でだけ、説明に fixable を足す
const DESCRIPTION = 'Put one proposal on the Kanban (Proposed) for the owner to approve or reject, from a scout report. title: one short line in the language the owner reads (the system prompt names it; English when it names none). kind: feature or bug. why: at most two sentences, in the same language as title. area: product paths it touches. size: S, M or L. goal: the plan heading it serves, exactly as listed under Plan goals (leave it out only when no heading fits). evidence: what the scout saw. ledger: the ledger entry id (L-0007) if there is one. A proposal with the same title as an open one, or one rejected in the last 30 days, is refused. deepen: the id of an open proposal to update with what a closer check found (same fields; the title stays), once per proposal per commit. research_item: the id of a deferred feature from the research list, when the proposal is that feature (one proposal per feature). Every other field in English; never write instructions or requests.';
const FIXABLE = ' fixable: set true only for a bug of size S or M that a short unattended run could fix inside a private copy of the product and prove with the product check command; beat may then try the fix before the owner decides. Leave it out otherwise.';

export const proposalAdd: ToolDef<ProposalAddInput> = {
  name: 'proposal_add',
  description: DESCRIPTION,
  describe: (_config, scope) => (scope?.fixProduct ? DESCRIPTION + FIXABLE : DESCRIPTION),
  input: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Union([Type.Literal('feature'), Type.Literal('bug')]),
    why: Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.why }),
    area: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.area }), { maxItems: PROPOSAL_LIMITS.areas })),
    size: Type.Union([Type.Literal('S'), Type.Literal('M'), Type.Literal('L')]),
    goal: Type.Optional(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.goal })),
    evidence: Type.Optional(Type.String({ minLength: 1, maxLength: PROPOSAL_LIMITS.evidence })),
    ledger: Type.Optional(Type.String({ pattern: '^L-[0-9]{4,8}$' })),
    deepen: Type.Optional(Type.String({ pattern: '^[0-9a-fA-F]{8}[0-9a-fA-F-]{0,28}$' })),
    fixable: Type.Optional(Type.Boolean()),
    research_item: Type.Optional(Type.Integer({ minimum: 1 })),
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
    const area = [...new Set((input.area ?? []).map(raw => usableAreaPath(raw, PROPOSAL_LIMITS.area)).filter((path): path is string => path !== null))];
    const proposal: Proposal = {
      kind: input.kind, why: plainLine(input.why, PROPOSAL_LIMITS.why), area, size: input.size,
      goal: input.goal ? goalText(input.goal) : null,
      evidence: input.evidence?.trim() ? input.evidence.trim().slice(0, PROPOSAL_LIMITS.evidence) : null,
      ledger: input.ledger ?? null,
      ...(input.fixable === true ? { fixable: true as const } : {}),
      ...(input.research_item !== undefined && input.deepen === undefined ? { researchItem: input.research_item } : {}),
    };
    if (input.deepen !== undefined) {
      const prefix = input.deepen.toLowerCase();
      const rows = db.prepare(`SELECT id, title, json_extract(proposal, '$.researchItem') AS research_item FROM tasks WHERE project_id = ? AND proposal IS NOT NULL AND status = 'inbox' AND substr(id, 1, ?) = ?`).all(project.id, prefix.length, prefix) as Array<{ id: string; title: string; research_item: number | null }>;
      if (rows.length !== 1) return { content: scoutText(language, 'proposal.deepen_unknown', { id: input.deepen }), isError: true };
      const row = rows[0]!;
      if (typeof row.research_item === 'number') proposal.researchItem = row.research_item;
      const note = deepenNote(await headOf(project.root, ctx.paths.data).catch(() => null));
      if (db.prepare('SELECT 1 FROM task_events WHERE task_id = ? AND kind = ? AND content = ?').get(row.id, DEEPENED_EVENT, note)) {
        return { content: scoutText(language, 'proposal.deepen_done', { id: row.id.slice(0, 8) }), isError: true };
      }
      try {
        transaction(db, () => {
          tasks.deepenProposal(row.id, proposal, note, ctx.runId);
          tasks.markUntrusted(row.id, 'scout', scoutText(language, 'proposal.untrusted'));
        });
        return { content: scoutText(language, 'proposal.deepened', { id: row.id.slice(0, 8), title: plainLine(row.title, 200) }) };
      } catch (error) {
        if (error instanceof TaskError) return { content: error.text(language), isError: true };
        return { content: toolText(language, 'failed', { detail: (error as Error).message }), isError: true };
      }
    }
    const key = sameTitle(title);
    const since = Date.now() - REJECTED_WINDOW_MS;
    const earlier = db.prepare(`SELECT id, title FROM tasks WHERE project_id = ? AND proposal IS NOT NULL
      AND (status = 'inbox' OR (status = 'cancelled' AND COALESCE(completed_at, updated_at) > ?))`).all(project.id, since) as Array<{ id: string; title: string }>;
    const same = earlier.find(row => sameTitle(row.title) === key);
    if (same) return { content: scoutText(language, 'proposal.duplicate', { title, id: same.id.slice(0, 8) }), isError: true };
    const open = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND proposal IS NOT NULL AND status = 'inbox'").get(project.id) as { n: number }).n;
    if (open >= PROPOSAL_OPEN_MAX) return { content: scoutText(language, 'proposal.too_many', { max: PROPOSAL_OPEN_MAX }), isError: true };
    try {
      const task = transaction(db, () => {
        if (proposal.researchItem !== undefined) {
          const seed = researchSeed(db, project.id, proposal.researchItem);
          if (seed !== 'free') throw new TaskError('error.bad_proposal', { reason: seed === 'unknown' ? scoutText(language, 'proposal.research_item_unknown', { id: proposal.researchItem }) : scoutText(language, 'proposal.research_item_taken', { id: proposal.researchItem, task: seed.slice(0, 8) }) });
        }
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
