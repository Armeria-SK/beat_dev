import type { Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { buildText, type BuildMessageKey } from '../shared/messages/build.ts';
import { taskText } from '../shared/messages/tasks.ts';
import { estimateTextTokens } from '../engine/tokens.ts';
import { redactSecrets } from '../shared/redaction.ts';
import { ACCEPTANCE_ITEMS_LABEL, OUTSIDE_PLAN_NOTE, PLAN_GIST_LABEL, type Task, type TaskStore } from '../tasks/store.ts';
import { USER_REQUEST_LIMIT, USER_REQUEST_TOKENS } from '../tools/auto-approve.ts';
import { docOf, frozenHash, type AcceptanceDoc, type AcceptanceItem, type AcceptanceStore, type AcceptanceVersionRow } from './acceptance.ts';
import { PlanError, planGist, type PlanStore } from './plan.ts';
import { languageTagOf, ProjectError, type ProjectStore } from './store.ts';

export const BUILD_ACTOR = 'build';
const RUN_ID = /^[0-9a-f-]{36}$/u;
const ITEM_ID = /^A-[1-9]\d{0,3}$/u;
const MAX_MARKED_RUNS = 20;

export const BUILD_BODY = (docLanguage: string | null, only?: readonly string[], language?: string | null): string => [
  'Build the product as planned. Read the plan with mesh_read("plan.md") and the acceptance items with mesh_read("acceptance.json").',
  ...(only ? [`This build covers only the new or changed acceptance items ${only.join(', ')}.`] : []),
  ...(docLanguage ? [`Owner-facing notes go in ${docLanguage}.`] : []),
  ...(language ? [`Use ${language} for the product (the owner picked it before building; see DECISIONS.md).`] : []),
].join(' ');

const ITEMS_SHARE = 0.5;

function itemLines(entries: readonly AcceptanceItem[], roomChars: number, roomTokens: number): string[] {
  const lines: string[] = [];
  let text = ACCEPTANCE_ITEMS_LABEL;
  for (const entry of entries) {
    const line = `- ${entry.id}: ${redactSecrets(entry.result).replace(/\s+/gu, ' ').trim()}`;
    const next = `${text}\n${line}`;
    if (next.length > roomChars || estimateTextTokens(next) > roomTokens) break;
    lines.push(line);
    text = next;
  }
  return lines;
}

export class BuildError extends LocalizedError<BuildMessageKey> {
  constructor(code: BuildMessageKey, params?: MessageParams) { super(buildText, code, params); }
}

export interface BuildDeps {
  projects: ProjectStore;
  plans: PlanStore;
  acceptance: AcceptanceStore;
  tasks: TaskStore;
  language: () => Language;
  // beat R (D12): 調べた一覧で持ち主が確定した言語（コードの一覧の値）
  pickedLanguage?: (projectId: string) => string | null;
  now?: () => number;
}

export function unbuilt(d: Pick<BuildDeps, 'acceptance' | 'tasks'>, projectId: string, doc: AcceptanceDoc): string[] {
  const since = new Map(d.acceptance.versions(projectId).map(row => [row.version, row.created_at]));
  const first = Math.min(...since.keys());
  const builds = d.tasks.builds(projectId);
  return doc.items
    .filter(entry => entry.removedIn === null && entry.state === 'open' && ITEM_ID.test(entry.id))
    .filter(entry => {
      const at = since.get(entry.changedIn ?? first) ?? 0;
      return !builds.some(build => build.created_at >= at && build.items.includes(entry.id));
    })
    .map(entry => entry.id);
}

export function startBuild(d: BuildDeps, projectId: string, wanted: { planHash: string; acceptanceHash: string | null; conversationId: string }): { task: Task; version: AcceptanceVersionRow } {
  const project = d.projects.get(projectId);
  if (!project) throw new ProjectError('unknown');
  if (project.archived_at !== null) throw new ProjectError('archived');
  if (!d.plans.owns(projectId, wanted.conversationId)) throw new PlanError('unknown_conversation');
  const plan = d.plans.view(projectId, wanted.conversationId);
  if (plan.content === null || plan.hash === null) throw new BuildError('no_plan');
  if (d.tasks.hasOpenBuild(projectId)) throw new BuildError('running');
  const fixed = d.acceptance.latest(projectId);
  const draft = d.acceptance.read(projectId, wanted.conversationId);
  const only = fixed && draft ? unbuilt(d, projectId, draft) : undefined;
  if (fixed && !only?.length) throw new BuildError('frozen', { version: fixed.version });
  if (plan.hash !== wanted.planHash || (draft ? frozenHash(draft) : null) !== wanted.acceptanceHash) throw new BuildError('changed');

  const language = languageTagOf(project.doc_language) ?? null;
  const doc: AcceptanceDoc = only ? draft! : { schema: 1, language: draft?.language ?? language, items: draft?.items ?? [], notDoing: draft?.notDoing ?? [], taintedRuns: draft?.taintedRuns ?? [], version: 1 };
  const meta = d.plans.meta(projectId, wanted.conversationId);
  const runs = new Set<string>();
  if (plan.tainted && meta?.runId) runs.add(meta.runId);
  for (const run of [...(doc.taintedRuns ?? []), ...(fixed ? docOf(fixed.content)?.taintedRuns ?? [] : [])]) runs.add(run);
  const untrusted = plan.updated_by === 'outside' || plan.tainted || runs.size > 0;
  const marked = [...runs].filter(run => RUN_ID.test(run)).slice(0, MAX_MARKED_RUNS);

  const title = `Build: ${project.name}`;
  const head = untrusted ? `${title}\n${OUTSIDE_PLAN_NOTE}` : title;
  const entries = doc.items.filter(entry => entry.removedIn === null && (!only || only.includes(entry.id)));
  const items = itemLines(entries, Math.floor((USER_REQUEST_LIMIT - head.length) * ITEMS_SHARE), Math.floor((USER_REQUEST_TOKENS - estimateTextTokens(head)) * ITEMS_SHARE));
  const lead = [head, ...(items.length ? [ACCEPTANCE_ITEMS_LABEL, ...items] : []), PLAN_GIST_LABEL, ''].join('\n');
  const gist = planGist(plan.content, Math.max(0, USER_REQUEST_LIMIT - lead.length), Math.max(0, USER_REQUEST_TOKENS - estimateTextTokens(lead)));

  let task: Task | undefined;
  const makeTask = () => {
    task = d.tasks.create({
      title, body: BUILD_BODY(language, only, d.pickedLanguage?.(projectId) ?? null), origin: 'user', actor: 'user', projectId, ownerRequest: true, ownerPlan: gist, ownerItems: items, ownerPlanOutside: untrusted,
      acceptanceItems: only ?? doc.items.filter(entry => entry.removedIn === null).map(entry => entry.id),
      createdInConversation: wanted.conversationId,
    });
    d.plans.markBuilt(projectId, wanted.conversationId, plan.hash!);
    if (untrusted) {
      d.tasks.markUntrusted(task.id, BUILD_ACTOR, taskText(d.language(), 'event.build_untrusted'));
      for (const run of marked) d.tasks.event(task.id, 'context', BUILD_ACTOR, null, run);
    }
    return task.id;
  };
  if (fixed) {
    d.acceptance.atomically(makeTask);
    return { task: d.tasks.get(task!.id)!, version: fixed };
  }
  const version = d.acceptance.freeze(projectId, doc, { plan_hash: plan.hash, source: 'build', created_at: (d.now ?? Date.now)() }, makeTask);
  return { task: d.tasks.get(task!.id)!, version };
}
