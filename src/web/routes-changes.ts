import { realpathSync } from 'node:fs';
import type { App } from '../app.ts';
import { branchEntries, gitEntries, present, recordEntries, type ChangeBase, type ChangeEntry } from '../changes/diff.ts';
import { changesDir, sha256 } from '../changes/record.ts';
import { listRunChanges } from '../changes/runtime.ts';
import { redoBatch, undoEntries } from '../changes/restore.ts';
import { SNAPSHOT_EVENT } from '../projects/snapshot-before.ts';
import { folderMissing, ProjectError, type ProjectRow } from '../projects/store.ts';
import { BEAT_BRANCH } from '../projects/worktree.ts';
import { gitFolder } from '../projects/work-folder.ts';
import { isInside } from '../tools/hooks/scope.ts';
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
const HASH = /^[0-9a-f]{64}$/u;

const realOf = (path: string): string => { try { return realpathSync.native(path); } catch { return path; } };
const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

function hashTable(raw: unknown): Map<string, string | null> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length > MAX_PATHS || !entries.every(([path, hash]) => path.length > 0 && path.length <= 4096 && (hash === null || (typeof hash === 'string' && HASH.test(hash))))) return undefined;
  return new Map(entries as Array<[string, string | null]>);
}

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

  // Undo・Redo を断る間: その製品の running のタスク（scout-run の行は製品のフォルダに書かないので除く）、フォルダが重なる（入れ子・親）別の製品の実行、
  // tools.roots の書ける場所がその製品のフォルダに重なるときは、どの会話の実行でも
  const busy = (projectId: string, realRoot: string): boolean => {
    if (app.db.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND status = 'running' AND proposed_by IS NOT 'scout-run' LIMIT 1").get(projectId)) return true;
    const touches = (id: string | null): boolean => {
      if (id === null || id === projectId) return false;
      const other = app.projects.get(id);
      return other !== undefined && overlaps(realRoot, realOf(other.root));
    };
    const others = app.db.prepare("SELECT DISTINCT project_id FROM tasks WHERE status = 'running' AND proposed_by IS NOT 'scout-run' AND project_id IS NOT NULL AND project_id != ?").all(projectId) as Array<{ project_id: string }>;
    if (others.some(row => touches(row.project_id))) return true;
    const runs = app.engine.activeRuns();
    if (runs.some(run => { const id = app.conversations.projectOf(run.conversationId); return id === projectId || touches(id); })) return true;
    return runs.length > 0 && buildPolicy(app.config(), app.paths).roots.some(root => root.mode === 'write' && overlaps(realRoot, realOf(root.path)));
  };

  const lastBuild = (projectId: string): string | undefined => (app.db.prepare(
    'SELECT e.task_id AS id FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND e.kind = ? ORDER BY e.id DESC LIMIT 1',
  ).get(projectId, SNAPSHOT_EVENT) as { id: string } | undefined)?.id;

  const redoOf = (projectId: string): { id: string; created_at: number; paths: string[] } | null => {
    const last = app.db.prepare(
      "SELECT batch, MAX(created_at) AS created_at FROM file_changes WHERE project_id = ? AND place IS NULL AND action = 'undo' AND batch IS NOT NULL GROUP BY batch ORDER BY MAX(id) DESC LIMIT 1",
    ).get(projectId) as { batch: string; created_at: number } | undefined;
    if (!last || app.db.prepare("SELECT 1 FROM file_changes WHERE project_id = ? AND batch = ? AND action = 'redo' LIMIT 1").get(projectId, last.batch)) return null;
    const rows = app.db.prepare("SELECT path FROM file_changes WHERE project_id = ? AND batch = ? AND action = 'undo' ORDER BY id").all(projectId, last.batch) as Array<{ path: string }>;
    return { id: last.batch, created_at: last.created_at, paths: rows.map(row => row.path) };
  };

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
    const files = present(made.entries, { undo: true }).map((file, i) => {
      const after = made.entries[i]!.after;
      return file.undo && (after === null || Buffer.isBuffer(after)) ? { ...file, hash: after === null ? null : sha256(after) } : file;
    });
    // 外の実行役が返事のあいだに変えたファイル（beat が git の前後から割り出したもの。元に戻す・やり直すの対象ではなく、file_changes の記録でもない）
    sendJson(res, 200, { base: made.base, files, more: made.more, redo: redoOf(project.id), runtime: { runs: listRunChanges(app.kv, project.id, scope.conversation) } });
  });

  router.add('POST', '/api/projects/:id/changes/undo', async ({ req, res, params }) => {
    const { project, realRoot } = projectOf(params[0]!);
    const body = requireObject(await readJson(req));
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    const paths = body.paths;
    const list = paths === 'all' ? 'all' as const : Array.isArray(paths) && paths.length > 0 && paths.length <= MAX_PATHS && paths.every(p => typeof p === 'string' && p.length > 0 && p.length <= 4096) ? paths as string[] : undefined;
    const expected = body.hashes === undefined ? undefined : hashTable(body.hashes);
    if (!list || (body.hashes !== undefined && !expected)) throw projectProblem(400, new ProjectError('changes_bad_paths'));
    const scope = scopeOf(project, body);
    if (busy(project.id, realRoot)) throw projectProblem(409, new ProjectError('changes_busy'));
    const made = await load(project, realRoot, scope, list === 'all' ? undefined : new Set(list));
    if (busy(project.id, realRoot)) throw projectProblem(409, new ProjectError('changes_busy'));
    const done = undoEntries({ db: app.db, dir: dir(), projectId: project.id, realRoot, deny: deny(), now: app.now() }, made.entries, list, expected);
    sendJson(res, 200, { ...done, more: list === 'all' ? made.more : 0 });
  });

  router.add('POST', '/api/projects/:id/changes/redo', async ({ req, res, params }) => {
    const { project, realRoot } = projectOf(params[0]!);
    const body = requireObject(await readJson(req));
    if (project.archived_at !== null) throw projectProblem(400, new ProjectError('archived'));
    if (typeof body.redo !== 'string' || !BATCH.test(body.redo)) throw projectProblem(400, new ProjectError('changes_redo_missing'));
    if (busy(project.id, realRoot)) throw projectProblem(409, new ProjectError('changes_busy'));
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
