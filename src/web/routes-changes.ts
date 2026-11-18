import { realpathSync } from 'node:fs';
import type { App } from '../app.ts';
import { branchEntries, gitEntries, present, recordEntries, type ChangeBase, type ChangeEntry } from '../changes/diff.ts';
import { changesDir } from '../changes/record.ts';
import { redoBatch, undoEntries } from '../changes/restore.ts';
import { SNAPSHOT_EVENT } from '../projects/snapshot-before.ts';
import { folderMissing, ProjectError, type ProjectRow } from '../projects/store.ts';
import { BEAT_BRANCH } from '../projects/worktree.ts';
import { gitFolder } from '../projects/work-folder.ts';
import { buildPolicy } from '../tools/policy.ts';
import { problem, readJson, requireObject, sendJson, type Router } from './http.ts';
import { projectProblem } from './routes-projects.ts';

const ID = /^[0-9a-f-]{36}$/u;
const BATCH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKTREE_ID = /^[0-9a-f]{8}$/u;
const BASES = ['build', 'commit', 'records'] as const;
type Base = typeof BASES[number];
const MAX_PATHS = 1000;
const WINDOWS = process.platform === 'win32';
const fold = (p: string): string => (WINDOWS ? p.toLowerCase() : p);

interface Scope { base: Base; task?: string | undefined; conversation?: string | undefined }

export function registerChangeRoutes(router: Router, app: App): void {
  const deny = (): string[] => buildPolicy(app.config(), app.paths).deny;
  const dir = (): string => changesDir(app.paths);

  const projectOf = (id: string): { project: ProjectRow; realRoot: string } => {
    const project = app.projects.get(id);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    if (folderMissing(project)) throw projectProblem(409, new ProjectError('folder_missing'));
    let realRoot: string;
    try { realRoot = realpathSync.native(project.root); } catch { throw projectProblem(409, new ProjectError('folder_missing')); }
    return { project, realRoot };
  };

  const busy = (projectId: string): boolean => {
    if (app.db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND status = 'running' AND proposed_by IS NOT 'scout-run' LIMIT 1").get(projectId)) return true;
    return app.engine.activeRuns().some(run => app.conversations.projectOf(run.conversationId) === projectId);
  };

  const lastBuild = (projectId: string): string | undefined => (app.db.prepare(
    'SELECT e.task_id AS id FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND e.kind = ? ORDER BY e.id DESC LIMIT 1',
  ).get(projectId, SNAPSHOT_EVENT) as { id: string } | undefined)?.id;

  const scopeOf = (project: ProjectRow, raw: { base?: unknown; task?: unknown; conversation?: unknown }): Scope => {
    const isGit = gitFolder(project.root);
    const base = raw.base === undefined || raw.base === null || raw.base === '' ? (isGit ? (lastBuild(project.id) ? 'build' : 'commit') : 'records') : raw.base;
    if (!(BASES as readonly unknown[]).includes(base)) throw projectProblem(400, new ProjectError('changes_bad_base'));
    if (base !== 'records' && !isGit) throw projectProblem(400, new ProjectError('changes_not_git'));
    const task = raw.task === undefined || raw.task === null || raw.task === '' ? undefined : raw.task;
    if (task !== undefined && (typeof task !== 'string' || !ID.test(task) || app.tasks.get(task)?.project_id !== project.id)) throw projectProblem(400, new ProjectError('changes_bad_task'));
    const conversation = raw.conversation === undefined || raw.conversation === null || raw.conversation === '' ? undefined : raw.conversation;
    if (conversation !== undefined && (typeof conversation !== 'string' || !ID.test(conversation) || app.conversations.projectOf(conversation) !== project.id)) throw projectProblem(400, new ProjectError('changes_bad_conversation'));
    return { base: base as Base, task, conversation };
  };

  const load = async (project: ProjectRow, realRoot: string, scope: Scope, only?: ReadonlySet<string>): Promise<{ base: ChangeBase; entries: ChangeEntry[]; more: number }> => {
    if (scope.base === 'records') return recordEntries(app.db, dir(), project.id, realRoot, scope, deny(), only);
    let base: { kind: 'build'; task: string } | { kind: 'commit' } = { kind: 'commit' };
    if (scope.base === 'build') {
      const task = scope.task ?? lastBuild(project.id);
      if (!task) throw projectProblem(404, new ProjectError('changes_no_base'));
      base = { kind: 'build', task };
    }
    const made = await gitEntries(realRoot, app.paths.data, base, deny(), only);
    if (!made.ok) throw projectProblem(made.reason === 'no_base' ? 404 : 409, new ProjectError(made.reason === 'no_base' ? 'changes_no_base' : made.reason === 'git_unusable' ? 'changes_git_unusable' : 'changes_failed'));
    return made;
  };

  router.add('GET', '/api/projects/:id/changes', async ({ res, params, url }) => {
    const { project, realRoot } = projectOf(params[0]!);
    const scope = scopeOf(project, { base: url.searchParams.get('base'), task: url.searchParams.get('task'), conversation: url.searchParams.get('conversation') });
    const made = await load(project, realRoot, scope);
    sendJson(res, 200, { base: made.base, files: present(made.entries, { undo: true }), more: made.more });
  });

  router.add('POST', '/api/projects/:id/changes/undo', async ({ req, res, params }) => {
    const { project, realRoot } = projectOf(params[0]!);
    const body = requireObject(await readJson(req));
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    const paths = body.paths;
    const list = paths === 'all' ? 'all' as const : Array.isArray(paths) && paths.length > 0 && paths.length <= MAX_PATHS && paths.every(p => typeof p === 'string' && p.length > 0 && p.length <= 4096) ? paths as string[] : undefined;
    if (!list) throw projectProblem(400, new ProjectError('changes_bad_paths'));
    const scope = scopeOf(project, body);
    if (busy(project.id)) throw projectProblem(409, new ProjectError('changes_busy'));
    const made = await load(project, realRoot, scope, list === 'all' ? undefined : new Set(list));
    if (busy(project.id)) throw projectProblem(409, new ProjectError('changes_busy'));
    const done = undoEntries({ db: app.db, dir: dir(), projectId: project.id, realRoot, deny: deny(), now: app.now() }, made.entries, list);
    sendJson(res, 200, done);
  });

  router.add('POST', '/api/projects/:id/changes/redo', async ({ req, res, params }) => {
    const { project, realRoot } = projectOf(params[0]!);
    const body = requireObject(await readJson(req));
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    if (typeof body.redo !== 'string' || !BATCH.test(body.redo)) throw projectProblem(400, new ProjectError('changes_redo_missing'));
    if (busy(project.id)) throw projectProblem(409, new ProjectError('changes_busy'));
    const done = redoBatch({ db: app.db, dir: dir(), projectId: project.id, realRoot, deny: deny(), now: app.now() }, body.redo);
    if (!done.ok) throw projectProblem(done.reason === 'missing' ? 404 : 409, new ProjectError(done.reason === 'missing' ? 'changes_redo_missing' : 'changes_redo_done'));
    sendJson(res, 200, { redone: done.redone, refused: done.refused });
  });

  router.add('GET', '/api/worktrees/:id/changes', async ({ res, params }) => {
    const row = WORKTREE_ID.test(params[0]!) ? app.worktrees.get(params[0]!) : undefined;
    if (!row || !BEAT_BRANCH.test(row.branch)) throw projectProblem(404, new ProjectError('changes_worktree_missing'));
    const { realRoot } = projectOf(row.project_id);
    if (fold(realRoot) !== fold(row.repo)) throw projectProblem(409, new ProjectError('changes_worktree_moved'));
    const made = await branchEntries(realRoot, app.paths.data, row.branch, row.base, deny());
    if (!made.ok) throw projectProblem(made.reason === 'no_base' ? 404 : 409, new ProjectError(made.reason === 'no_base' ? 'changes_no_base' : made.reason === 'git_unusable' ? 'changes_git_unusable' : 'changes_failed'));
    sendJson(res, 200, { base: made.base, files: present(made.entries, { undo: false }), more: made.more });
  });
}
