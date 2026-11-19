import type { ChangedFile, ChangeRefusal, ChangesScope, RefusedChange } from '../api.ts';
import type { t } from '../i18n/index.ts';
import type { PlainKey } from '../i18n/types.ts';

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

const norm = (path: string): string => path.replace(/\\/gu, '/').replace(/^(\.\/)+/u, '').replace(/\/+$/u, '').toLowerCase();
const absolute = (path: string): boolean => /^(\/|[a-z]:\/)/u.test(path);

export function matchChange(files: readonly ChangedFile[], wanted: string, root: string | null): ChangedFile | undefined {
  let target = norm(wanted.trim());
  if (!target) return undefined;
  if (absolute(target)) {
    const base = root ? norm(root) : '';
    if (!base || !target.startsWith(`${base}/`)) return undefined;
    target = target.slice(base.length + 1);
  }
  return files.find(file => norm(file.path) === target);
}

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['file_write', 'file_edit', 'table_write']);

const SHOWN_REFUSALS = 3;
const WHY: Record<ChangeRefusal, PlainKey> = {
  not_changed: 'ui.changes.why.not_changed',
  hidden: 'ui.changes.why.hidden',
  unsafe_path: 'ui.changes.why.unsafe_path',
  link: 'ui.changes.why.link',
  not_kept: 'ui.changes.why.not_kept',
  too_large: 'ui.changes.why.too_large',
  cannot_keep: 'ui.changes.why.cannot_keep',
  same_file: 'ui.changes.why.same_file',
  changed: 'ui.changes.why.changed',
  failed: 'ui.changes.why.failed',
};

export function refusalText(tr: typeof t, refused: readonly RefusedChange[]): string {
  const shown = refused.slice(0, SHOWN_REFUSALS).map(r => `${r.path}: ${tr(WHY[r.reason])}`);
  const rest = refused.length - shown.length;
  return [...shown, ...(rest > 0 ? [tr('ui.changes.more', rest)] : [])].join(' · ');
}
