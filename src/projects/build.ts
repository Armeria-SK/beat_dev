import type { Language } from '../config/schema.ts';
import { LocalizedError, type MessageParams } from '../shared/messages/define.ts';
import { buildText, type BuildMessageKey } from '../shared/messages/build.ts';
import { taskText } from '../shared/messages/tasks.ts';
import type { Task, TaskStore } from '../tasks/store.ts';
import { docOf, frozenHash, type AcceptanceDoc, type AcceptanceStore, type AcceptanceVersionRow } from './acceptance.ts';
import type { PlanStore } from './plan.ts';
import { languageTagOf, ProjectError, type ProjectStore } from './store.ts';

export const BUILD_ACTOR = 'build';
const RUN_ID = /^[0-9a-f-]{36}$/u;
const ITEM_ID = /^A-[1-9]\d{0,3}$/u;
const MAX_MARKED_RUNS = 20;

export const BUILD_BODY = (docLanguage: string | null, only?: readonly string[]): string => [
  'Build the product as planned. Read the plan with mesh_read("plan.md") and the acceptance items with mesh_read("acceptance.json").',
  ...(only ? [`This build covers only the new or changed acceptance items ${only.join(', ')}.`] : []),
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

export function startBuild(d: BuildDeps, projectId: string, wanted: { planHash: string; acceptanceHash: string | null }): { task: Task; version: AcceptanceVersionRow } {
  const project = d.projects.get(projectId);
  if (!project) throw new ProjectError('unknown');
  if (project.archived_at !== null) throw new ProjectError('archived');
  const plan = d.plans.view(projectId);
  if (plan.content === null || plan.hash === null) throw new BuildError('no_plan');
  if (d.tasks.hasOpenBuild(projectId)) throw new BuildError('running');
  const fixed = d.acceptance.latest(projectId);
  const draft = d.acceptance.read(projectId);
  const only = fixed && draft ? unbuilt(d, projectId, draft) : undefined;
  if (fixed && !only?.length) throw new BuildError('frozen', { version: fixed.version });
  if (plan.hash !== wanted.planHash || (draft ? frozenHash(draft) : null) !== wanted.acceptanceHash) throw new BuildError('changed');

  const language = languageTagOf(project.doc_language) ?? null;
  const doc: AcceptanceDoc = only ? draft! : { schema: 1, language: draft?.language ?? language, items: draft?.items ?? [], notDoing: draft?.notDoing ?? [], taintedRuns: draft?.taintedRuns ?? [], version: 1 };
  const meta = d.plans.meta(projectId);
  const runs = new Set<string>();
  if (plan.tainted && meta?.runId) runs.add(meta.runId);
  for (const run of [...(doc.taintedRuns ?? []), ...(fixed ? docOf(fixed.content)?.taintedRuns ?? [] : [])]) runs.add(run);
  const untrusted = plan.updated_by === 'outside' || plan.tainted || runs.size > 0;
  const marked = [...runs].filter(run => RUN_ID.test(run)).slice(0, MAX_MARKED_RUNS);

  let task: Task | undefined;
  const makeTask = () => {
    task = d.tasks.create({
      title: `Build: ${project.name}`, body: BUILD_BODY(language, only), origin: 'user', actor: 'user', projectId,
      acceptanceItems: only ?? doc.items.filter(entry => entry.removedIn === null).map(entry => entry.id),
      createdInConversation: plan.updated_by === 'ai' ? meta?.conversationId ?? undefined : undefined,
    });
    if (untrusted) {
      for (const run of marked) d.tasks.event(task.id, 'context', BUILD_ACTOR, null, run);
      d.tasks.markUntrusted(task.id, BUILD_ACTOR, taskText(d.language(), 'event.build_untrusted'));
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
