import type { App } from '../app.ts';
import { APP_ROOT } from '../paths.ts';
import { checkCommandOf, defaultProjectName, folderMissing, languageTagOf, PROJECT_ID, ProjectError, projectName, type ProjectRow } from '../projects/store.ts';
import { ownerSpeech } from '../db/conversations.ts';
import { AcceptanceError, coverageOf, frozenHash } from '../projects/acceptance.ts';
import { BuildError, startBuild } from '../projects/build.ts';
import { PlanError, type PlanView } from '../projects/plan.ts';
import { languageOf } from '../shared/language.ts';
import { readRemotes } from '../projects/remotes.ts';
import { checkWorkFolder, gitFolder, listFolders, type WorkFolderContext } from '../projects/work-folder.ts';
import { taskView, type ProjectFilter } from '../tasks/store.ts';
import { approvalShownIn } from '../tools/approvals.ts';
import { domainProblem, problem, readJson, requireObject, requireString, sendJson, type HttpProblem, type Router } from './http.ts';

const MAX_PATH_CHARS = 4096;

export function projectProblem(status: number, error: ProjectError): HttpProblem {
  return domainProblem(status, 'project', error);
}

export function projectFilterOf(url: URL): ProjectFilter {
  const raw = url.searchParams.get('project');
  if (raw === null) return undefined;
  if (raw === 'none') return null;
  if (!PROJECT_ID.test(raw)) throw problem(400, 'invalid_id', 'invalid_id');
  return raw;
}

export function usableProjectId(app: App, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const project = typeof raw === 'string' ? app.projects.get(raw) : undefined;
  if (!project) throw projectProblem(400, new ProjectError('unknown'));
  if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
  return project.id;
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && !value.trim())) return null;
  return requireString(body, key, { max })!;
}

function remotesOf(raw: string): Array<{ name: string; url: string; push_url: string | null }> {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((r): r is { name: string; url: string; pushUrl?: unknown } => Boolean(r) && typeof r.name === 'string' && typeof r.url === 'string')
      .map(r => ({ name: r.name, url: r.url, push_url: typeof r.pushUrl === 'string' ? r.pushUrl : null }));
  } catch { return []; }
}

export function projectWire(app: App, row: ProjectRow) {
  const counts = app.projects.counts(row.id);
  const inProject = (conversationId: string) => app.conversations.projectOf(conversationId) === row.id;
  return {
    id: row.id, name: row.name, root: row.root, check_command: row.check_command, scout_mode: row.scout_mode, remotes: remotesOf(row.remotes),
    archived_at: row.archived_at, created_at: row.created_at, updated_at: row.updated_at,
    is_git: gitFolder(row.root), folder_missing: folderMissing(row),
    waiting: { proposals: counts.proposals, questions: counts.questions, pending: app.approvals.pending().filter(a => inProject(approvalShownIn(a))).length },
    running: app.engine.activeRuns().filter(r => inProject(r.conversationId)).length,
    last_activity_at: counts.lastActivityAt,
    has_plan: app.plans.has(row.id),
    doc_language: row.doc_language, doc_language_pinned: row.doc_language_pinned === 1,
  };
}

export function registerProjectRoutes(router: Router, app: App): void {
  const folderContext = (): WorkFolderContext => ({
    paths: app.paths, appRoot: APP_ROOT, config: app.config(), active: app.projects.list(), exempt: app.projectFolderExempt,
  });
  const guarded = <T>(work: () => T): T => {
    try { return work(); } catch (error) {
      if (error instanceof ProjectError) throw projectProblem(error.code === 'root_in_use' ? 409 : 400, error);
      throw error;
    }
  };

  router.add('GET', '/api/projects', ({ res, url }) => {
    const archived = ['1', 'true'].includes(url.searchParams.get('archived') ?? '');
    sendJson(res, 200, { projects: app.projects.list({ archived }).map(row => projectWire(app, row)) });
  });

  router.add('POST', '/api/projects', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const root = requireString(body, 'root', { max: MAX_PATH_CHARS })!;
    const rawName = optionalText(body, 'name', 400);
    const rawCheck = optionalText(body, 'checkCommand', 4000);
    const checked = checkWorkFolder(root, folderContext());
    if (!checked.ok) throw projectProblem(checked.reason === 'root_in_use' ? 409 : 400, new ProjectError(checked.reason));
    const project = guarded(() => app.projects.create({
      name: projectName(rawName ?? defaultProjectName(checked.root)), root: checked.root, rootKey: checked.rootKey, checkCommand: checkCommandOf(rawCheck ?? null),
      remotes: checked.isGit ? readRemotes(checked.root) : [],
    }));
    app.bus.publish({ type: 'project.changed', projectId: project.id, change: 'created' });
    sendJson(res, 201, { project: projectWire(app, project), notes: checked.notes });
  });

  router.add('PATCH', '/api/projects/:id', async ({ req, res, params }) => {
    const current = app.projects.get(params[0]!);
    if (!current) throw problem(404, 'not_found', 'project_missing');
    const body = requireObject(await readJson(req));
    if (body.root !== undefined) throw projectProblem(400, new ProjectError('root_fixed'));
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw problem(400, 'invalid_field', 'bad_bool', { field: 'archived', params: { field: 'archived' } });
    if (body.refreshRemotes !== undefined && body.refreshRemotes !== true) throw projectProblem(400, new ProjectError('bad_refresh'));
    const rawName = requireString(body, 'name', { optional: true, max: 400 });
    const rawCheck = optionalText(body, 'checkCommand', 4000);
    const docLanguage = body.docLanguage === null ? null : languageTagOf(body.docLanguage);
    if (body.docLanguage !== undefined && docLanguage === undefined) throw problem(400, 'invalid_field', 'bad_language', { field: 'docLanguage', params: { field: 'docLanguage' } });
    const changed = guarded(() => app.projects.update(current.id, {
      ...(rawName !== undefined ? { name: projectName(rawName) } : {}),
      ...(rawCheck !== undefined ? { checkCommand: checkCommandOf(rawCheck) } : {}),
      ...(typeof body.archived === 'boolean' ? { archived: body.archived } : {}),
      ...(body.refreshRemotes === true && !folderMissing(current) ? { remotes: readRemotes(current.root) } : {}),
    }));
    const updated = docLanguage === undefined ? changed : app.projects.setDocLanguage(current.id, docLanguage);
    const change = updated.archived_at !== null && current.archived_at === null ? 'archived' : updated.archived_at === null && current.archived_at !== null ? 'restored' : 'updated';
    app.bus.publish({ type: 'project.changed', projectId: current.id, change });
    sendJson(res, 200, { project: projectWire(app, updated) });
  });

  const planWire = (projectId: string, view: PlanView = app.plans.view(projectId)) => ({
    ...view,
    writing: app.engine.activeRuns().some(r => r.kind === 'chat' && app.conversations.projectOf(r.conversationId) === projectId && r.mode === 'plan'),
  });
  const planned = <T>(work: () => T): T => {
    try { return work(); } catch (error) {
      if (error instanceof PlanError) throw domainProblem(error.code === 'changed' ? 409 : 400, 'plan', error);
      throw error;
    }
  };

  router.add('GET', '/api/projects/:id/plan', ({ res, params }) => {
    const project = app.projects.get(params[0]!);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    sendJson(res, 200, { plan: planned(() => planWire(project.id)) });
  });

  router.add('PUT', '/api/projects/:id/plan', async ({ req, res, params }) => {
    const project = app.projects.get(params[0]!);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    const body = requireObject(await readJson(req, 1024 * 1024));
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    const content = requireString(body, 'content')!;
    const baseHash = body.baseHash;
    if (baseHash !== null && typeof baseHash !== 'string') throw problem(400, 'invalid_field', 'required', { field: 'baseHash', params: { field: 'baseHash' } });
    const saved = planned(() => app.plans.write(project.id, content, { by: 'owner', tainted: false, conversationId: null, runId: null }, baseHash));
    if (saved.changed) app.bus.publish({ type: 'plan.changed', projectId: project.id, hash: saved.hash, by: 'owner' });
    const { changed: _changed, ...view } = saved;
    sendJson(res, 200, { plan: planWire(project.id, view) });
  });

  const accepted = <T>(work: () => T): T => {
    try { return work(); } catch (error) {
      if (error instanceof AcceptanceError) throw domainProblem(400, 'acceptance', error);
      throw error;
    }
  };

  router.add('GET', '/api/projects/:id/acceptance', ({ res, params, url }) => {
    const project = app.projects.get(params[0]!);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    const rawBefore = url.searchParams.get('unreferencedBefore');
    if (rawBefore !== null && !/^\d{1,16}$/u.test(rawBefore)) throw problem(400, 'invalid_field', 'bad_time', { field: 'unreferencedBefore', params: { field: 'unreferencedBefore' } });
    const doc = accepted(() => app.acceptance.read(project.id));
    const frozen = app.acceptance.latest(project.id);
    sendJson(res, 200, {
      acceptance: {
        version: doc?.version ?? 0, language: doc?.language ?? null, items: doc?.items ?? [], not_doing: doc?.notDoing ?? [], draft: (doc?.version ?? 0) === 0,
        hash: doc ? frozenHash(doc) : null, tainted: (doc?.taintedRuns?.length ?? 0) > 0,
        frozen: frozen ? { version: frozen.version, hash: frozen.hash, plan_hash: frozen.plan_hash, created_at: frozen.created_at, source: frozen.source, build_task_id: frozen.build_task_id } : null,
      },
      coverage: coverageOf(doc, ownerSpeech(app.db, project.id), rawBefore === null ? undefined : Number(rawBefore)),
    });
  });

  router.add('POST', '/api/projects/:id/build', async ({ req, res, params }) => {
    const project = app.projects.get(params[0]!);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    const body = requireObject(await readJson(req));
    const planHash = requireString(body, 'planHash', { max: 128 })!;
    const acceptanceHash = body.acceptanceHash === null ? null : requireString(body, 'acceptanceHash', { max: 128 })!;
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    if (folderMissing(project)) throw projectProblem(409, new ProjectError('folder_missing'));
    let built;
    try {
      built = accepted(() => planned(() => startBuild({ projects: app.projects, plans: app.plans, acceptance: app.acceptance, tasks: app.tasks, language: () => languageOf(app.config()) }, project.id, { planHash, acceptanceHash })));
    } catch (error) {
      if (error instanceof BuildError) throw domainProblem(error.code === 'no_plan' ? 400 : 409, 'build', error);
      if (error instanceof ProjectError) throw projectProblem(400, error);
      throw error;
    }
    app.bus.publish({ type: 'acceptance.changed', projectId: project.id, version: built.version.version, draft: false });
    sendJson(res, 201, { task: taskView(built.task, languageOf(app.config())), version: built.version.version });
  });

  router.add('POST', '/api/folders/list', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const path = optionalText(body, 'path', MAX_PATH_CHARS);
    const listing = listFolders(path ?? undefined, folderContext());
    if ('reason' in listing) throw projectProblem(400, new ProjectError(listing.reason));
    sendJson(res, 200, listing);
  });
}
