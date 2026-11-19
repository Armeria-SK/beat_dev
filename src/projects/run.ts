import { folderMissing, type ProjectStore } from './store.ts';

export interface RunWorktree { id: string; path: string; branch: string; base: string; ceiling: string }
export interface RunProject { id: string; root?: string; productRoot?: string; worktree?: RunWorktree }

// root: その実行が書く場所（作業コピーがあればそれ、無ければ本体）。productRoot: 作業コピーで動くときだけの本体
export function runProject(projects: ProjectStore | undefined, projectId: string | null, worktree?: RunWorktree): RunProject | undefined {
  if (!projectId) return undefined;
  const row = projects?.get(projectId);
  if (!row || folderMissing(row)) return { id: projectId };
  return worktree ? { id: row.id, root: worktree.path, productRoot: row.root, worktree } : { id: row.id, root: row.root };
}

export function rootsLister(projects: { list: (options?: { archived?: boolean }) => ReadonlyArray<{ root: string }> } | undefined): () => string[] {
  const seen = new Set<string>();
  return () => {
    try {
      for (const row of [...(projects?.list() ?? []), ...(projects?.list({ archived: true }) ?? [])]) seen.add(row.root);
    } catch { return [...seen]; }
    return [...seen];
  };
}

export function projectFolderGone(projects: ProjectStore, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  const row = projects.get(projectId);
  return !row || folderMissing(row);
}
