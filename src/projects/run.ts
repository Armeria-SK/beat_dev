import { folderMissing, type ProjectStore } from './store.ts';

export interface RunProject { id: string; root?: string }

export function runProject(projects: ProjectStore | undefined, projectId: string | null): RunProject | undefined {
  if (!projectId) return undefined;
  const row = projects?.get(projectId);
  return row && !folderMissing(row) ? { id: row.id, root: row.root } : { id: projectId };
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
