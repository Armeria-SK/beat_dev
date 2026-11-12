import type { Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { buildText, type BuildMessageKey } from '../shared/messages/build.ts';
import { taskText } from '../shared/messages/tasks.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import { frozenHash, type AcceptanceDoc, type AcceptanceStore, type AcceptanceVersionRow } from './acceptance.ts';
import type { PlanStore } from './plan.ts';
import { languageTagOf, ProjectError, type ProjectStore } from './store.ts';

export const BUILD_ACTOR = 'build';
const RUN_ID = /^[0-9a-f-]{36}$/u;
const MAX_MARKED_RUNS = 20;

export const BUILD_BODY = (docLanguage: string | null): string => [
  'Build the product as planned. Read the plan with mesh_read("plan.md") and the acceptance items with mesh_read("acceptance.json").',
  ...(docLanguage ? [`Owner-facing notes go in ${docLanguage}.`] : []),
].join(' ');

export class BuildError extends LocalizedError<BuildMessageKey> {
  constructor(code: BuildMessageKey, params?: MessageParams) { super(buildText, code, params); }
}

export interface BuildDeps {
  projects: ProjectStore;
  plans: PlanStore;
  acceptance: AcceptanceStore;
  tasks: TaskStore;
  language: () => Language;
  now?: () => number;
}

export function startBuild(d: BuildDeps, projectId: string, wanted: { planHash: string; acceptanceHash: string | null }): { task: Task; version: AcceptanceVersionRow } {
  const project = d.projects.get(projectId);
  if (!project) throw new ProjectError('unknown');
  if (project.archived_at !== null) throw new ProjectError('archived');
  const plan = d.plans.view(projectId);
  if (plan.content === null || plan.hash === null) throw new BuildError('no_plan');
  if (d.tasks.hasOpenBuild(projectId)) throw new BuildError('running');
  const fixed = d.acceptance.latest(projectId);
  if (fixed) throw new BuildError('frozen', { version: fixed.version });
  const draft = d.acceptance.read(projectId);
  if (plan.hash !== wanted.planHash || (draft ? frozenHash(draft) : null) !== wanted.acceptanceHash) throw new BuildError('changed');

  const language = languageTagOf(project.doc_language) ?? null;
  const doc: AcceptanceDoc = { schema: 1, language: draft?.language ?? language, items: draft?.items ?? [], notDoing: draft?.notDoing ?? [], taintedRuns: draft?.taintedRuns ?? [], version: 1 };
  const meta = d.plans.meta(projectId);
  const runs = new Set<string>();
  if (plan.tainted && meta?.runId) runs.add(meta.runId);
  for (const run of doc.taintedRuns ?? []) runs.add(run);
  const untrusted = plan.updated_by === 'outside' || plan.tainted || runs.size > 0;
  const marked = [...runs].filter(run => RUN_ID.test(run)).slice(0, MAX_MARKED_RUNS);

  let task: Task | undefined;
  const version = d.acceptance.freeze(projectId, doc, { plan_hash: plan.hash, source: 'build', created_at: (d.now ?? Date.now)() }, () => {
    task = d.tasks.create({
      title: `Build: ${project.name}`, body: BUILD_BODY(language), origin: 'user', actor: 'user', projectId,
      acceptanceItems: doc.items.filter(entry => entry.removedIn === null).map(entry => entry.id),
      createdInConversation: plan.updated_by === 'ai' ? meta?.conversationId ?? undefined : undefined,
    });
    if (untrusted) {
      for (const run of marked) d.tasks.event(task.id, 'context', BUILD_ACTOR, null, run);
      d.tasks.markUntrusted(task.id, BUILD_ACTOR, taskText(d.language(), 'event.build_untrusted'));
    }
    return task.id;
  });
  return { task: d.tasks.get(task!.id)!, version };
}
