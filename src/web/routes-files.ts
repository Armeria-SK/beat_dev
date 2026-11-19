import { lstatSync, realpathSync } from 'node:fs';
import type { App } from '../app.ts';
import { listFolder, readFileView, type FilesRefusal, type FileTree, type TreeRoot } from '../projects/files-view.ts';
import { folderMissing, ProjectError, projectDir } from '../projects/store.ts';
import { gitFolder } from '../projects/work-folder.ts';
import { resolveConfigPath } from '../tools/hooks/scope.ts';
import { buildPolicy } from '../tools/policy.ts';
import { problem, sendJson, type HttpProblem, type Router } from './http.ts';
import { projectProblem } from './routes-projects.ts';

const TREES: readonly FileTree[] = ['product', 'knowledge'];

const REFUSAL: Record<FilesRefusal, () => HttpProblem> = {
  bad_path: () => problem(400, 'bad_path', 'files_bad_path'),
  refused: () => problem(403, 'refused', 'files_refused'),
  missing: () => problem(404, 'not_found', 'files_missing'),
  not_dir: () => problem(400, 'not_dir', 'files_not_dir'),
  not_file: () => problem(400, 'not_file', 'files_not_file'),
  unchecked: () => problem(403, 'unchecked', 'files_unchecked'),
};

// beat 8-5a: Files の欄の口（読むだけ）。product は製品のフォルダ、knowledge は data/projects/<id>/（mesh）。
// どちらも根の中だけを 1 段ずつ見る（files-view.ts）。product では beat が道具から隠す場所（DB・設定・控え・.env・道具の出力・
// ブラウザのプロフィール・data/projects など）と tools.deny を出さない
export function registerFilesRoutes(router: Router, app: App): void {
  const treeOf = (id: string, url: URL): TreeRoot => {
    const project = app.projects.get(id);
    if (!project) throw problem(404, 'not_found', 'project_missing');
    const raw = url.searchParams.get('tree') ?? 'product';
    if (!(TREES as readonly string[]).includes(raw)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'tree', params: { field: 'tree', values: TREES.join(' / ') } });
    const deny = buildPolicy(app.config(), app.paths).deny;
    if (raw === 'product') {
      if (folderMissing(project)) throw projectProblem(409, new ProjectError('folder_missing'));
      return { root: realpathSync.native(project.root), deny, git: gitFolder(project.root) ? { dataDir: app.paths.data } : null };
    }
    let dir: string;
    try { dir = projectDir(app.paths.projects, project.id); } catch { throw REFUSAL.refused(); }
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) throw REFUSAL.missing();
    if (st.isSymbolicLink() || !st.isDirectory()) throw REFUSAL.refused();
    const projects = resolveConfigPath(app.paths.projects, app.paths.data);
    return { root: realpathSync.native(dir), deny: deny.filter(d => d !== projects), git: null };
  };
  const answer = <T extends object>(out: T | FilesRefusal): T => {
    if (typeof out === 'string') throw REFUSAL[out]();
    return out;
  };

  router.add('GET', '/api/projects/:id/files', async ({ res, params, url }) => {
    const view = treeOf(params[0]!, url);
    sendJson(res, 200, answer(await listFolder(view, url.searchParams.get('dir') ?? '')));
  });

  router.add('GET', '/api/projects/:id/file', async ({ res, params, url }) => {
    const view = treeOf(params[0]!, url);
    sendJson(res, 200, answer(await readFileView(view, url.searchParams.get('path') ?? '')));
  });
}
