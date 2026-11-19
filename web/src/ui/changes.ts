import type { ChangedFile, ChangesScope } from '../api.ts';

export type ChangesPick = 'build' | 'commit' | 'records' | 'conversation';

export interface DiffLine { kind: 'add' | 'del' | 'same' | 'gap'; text: string }

export function diffLines(hunks: readonly (readonly string[])[]): DiffLine[] {
  const out: DiffLine[] = [];
  hunks.forEach((hunk, i) => {
    if (i > 0) out.push({ kind: 'gap', text: '…' });
    for (const line of hunk.slice(1)) {
      const sign = line[0];
      const rest = line.slice(1);
      if (sign === '+') out.push({ kind: 'add', text: `+ ${rest}` });
      else if (sign === '-') out.push({ kind: 'del', text: `− ${rest}` });
      else out.push({ kind: 'same', text: `  ${rest}` });
    }
  });
  return out;
}

export const changeTotals = (files: readonly ChangedFile[]): { files: number; added: number; removed: number } =>
  files.reduce((sum, f) => ({ files: sum.files + 1, added: sum.added + f.added, removed: sum.removed + f.removed }), { files: 0, added: 0, removed: 0 });

export function changePicks({ isGit, hasBuild, conversation }: { isGit: boolean; hasBuild: boolean; conversation: string | undefined }): ChangesPick[] {
  const picks: ChangesPick[] = isGit ? [...(hasBuild ? ['build' as const] : []), 'commit'] : ['records'];
  return conversation ? [...picks, 'conversation'] : picks;
}

export function scopeOf(pick: ChangesPick | null, conversation: string | undefined): ChangesScope {
  if (pick === null) return {};
  if (pick === 'conversation') return conversation ? { base: 'records', conversation } : { base: 'records' };
  return { base: pick };
}

const norm = (path: string): string => path.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();

export function matchChange(files: readonly ChangedFile[], wanted: string): ChangedFile | undefined {
  const target = norm(wanted.trim());
  if (!target) return undefined;
  let best: ChangedFile | undefined;
  for (const file of files) {
    const own = norm(file.path);
    if (own === target) return file;
    if (target.endsWith(`/${own}`) && (!best || own.length > best.path.length)) best = file;
  }
  return best;
}
