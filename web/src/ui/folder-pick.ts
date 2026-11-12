import type { FolderEntry, FolderList, NewProject, ProjectNote } from '../api.ts';

export function folderName(path: string): string {
  const parts = path.trim().split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? '';
}

export function upTarget(listing: FolderList): string | null | undefined {
  if (listing.path === null) return undefined;
  return listing.parent;
}

export type EntryReason = { kind: 'link' } | { kind: 'code'; code: string } | null;

export function entryReason(entry: FolderEntry): EntryReason {
  if (entry.link) return { kind: 'link' };
  if (entry.selectable) return null;
  return { kind: 'code', code: entry.reason ?? '' };
}

export function nameFor(root: string, typed: string, touched: boolean): string {
  return touched ? typed : folderName(root);
}

export function newProjectInput(root: string, name: string, check: string): NewProject | null {
  const path = root.trim();
  if (!path) return null;
  const input: NewProject = { root: path };
  if (name.trim()) input.name = name.trim();
  if (check.trim()) input.checkCommand = check.trim();
  return input;
}

export const NOTE_KEYS = {
  nested_inside: 'ui.np.note.nested',
  contains_product: 'ui.np.note.contains',
  inside_config_root: 'ui.np.note.insideRoot',
  config_root_read_only: 'ui.np.note.readOnly',
  not_git: 'ui.np.note.notGit',
} as const satisfies Record<ProjectNote, string>;

export function noteKeys(notes: readonly string[]): Array<typeof NOTE_KEYS[ProjectNote]> {
  return notes.filter((n): n is ProjectNote => Object.hasOwn(NOTE_KEYS, n)).map(n => NOTE_KEYS[n]);
}
