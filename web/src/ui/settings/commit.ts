import { accessKey, accessWidening, keyEntryAccess, type Access } from '../../settings/access.ts';
import { applyEdits, deepEqual, diffConfig } from '../../settings/merge.ts';
import type { Config } from '../../settings/model.ts';

export type Control = 'switch' | 'seg' | 'select' | 'tile' | 'button' | 'text' | 'path' | 'command' | 'list' | 'url' | 'number' | 'secret';

export const COMMIT_ON: Record<Control, 'press' | 'blur'> = {
  switch: 'press', seg: 'press', select: 'press', tile: 'press', button: 'press',
  text: 'blur', path: 'blur', command: 'blur', list: 'blur', url: 'blur', number: 'blur', secret: 'blur',
};

export interface FieldDraft { saved: string; text: string }

export type FieldEvent =
  | { type: 'input'; text: string }
  | { type: 'blur' }
  | { type: 'key'; key: string; composing: boolean }
  | { type: 'saved'; value: string };

export function fieldStep(draft: FieldDraft, event: FieldEvent, accept: (value: string) => boolean = () => true): { draft: FieldDraft; commit: string | null } {
  switch (event.type) {
    case 'input': return { draft: { ...draft, text: event.text }, commit: null };
    case 'saved': return { draft: { saved: event.value, text: event.value }, commit: null };
    case 'key':
      if (event.key === 'Escape') return { draft: { ...draft, text: draft.saved }, commit: null };
      if (event.key !== 'Enter' || event.composing) return { draft, commit: null };
      return finish(draft, accept);
    case 'blur': return finish(draft, accept);
  }
}

function finish(draft: FieldDraft, accept: (value: string) => boolean): { draft: FieldDraft; commit: string | null } {
  const value = draft.text.trim();
  if (value === draft.saved.trim()) return { draft: { ...draft, text: value }, commit: null };
  return accept(value) ? { draft: { ...draft, text: value }, commit: value } : { draft: { ...draft, text: draft.saved }, commit: null };
}

export const listAccepts = (items: readonly string[], value: string, allowDuplicates = false): boolean => allowDuplicates || !items.includes(value);

export const listWithout = (items: readonly string[], index: number): string[] => items.filter((_, i) => i !== index);

export type NumberRead = { kind: 'value'; value: number | undefined } | { kind: 'bad' };

export function readNumber(text: string, rule: { min?: number; max?: number; optional?: boolean; integer?: boolean }): NumberRead {
  const trimmed = text.trim();
  if (trimmed === '') return rule.optional ? { kind: 'value', value: undefined } : { kind: 'bad' };
  const n = Number(trimmed);
  if (!Number.isFinite(n) || (rule.integer !== false && !Number.isInteger(n))) return { kind: 'bad' };
  if ((rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max)) return { kind: 'bad' };
  return { kind: 'value', value: n };
}

export type SavePlan =
  | { kind: 'same' }
  | { kind: 'confirm'; items: Access[]; key: string }
  | { kind: 'save'; config: Config };

export function planSave(latest: Config, edit: (config: Config) => Config, confirmedKey: string | null): SavePlan {
  const next = edit(structuredClone(latest));
  if (deepEqual(next, latest)) return { kind: 'same' };
  const items = accessWidening(latest, next);
  if (items.length > 0 && accessKey(items) !== confirmedKey) return { kind: 'confirm', items, key: accessKey(items) };
  return { kind: 'save', config: next };
}

export function planKey(provider: Record<string, any> | undefined, confirmedKey: string | null): { kind: 'confirm'; items: Access[]; key: string } | { kind: 'send' } | { kind: 'none' } {
  if (!provider) return { kind: 'none' };
  const items = keyEntryAccess(provider);
  if (items.length > 0 && accessKey(items) !== confirmedKey) return { kind: 'confirm', items, key: accessKey(items) };
  return { kind: 'send' };
}

export function planKeyFor(latest: Config, id: string, confirmedKey: string | null): ReturnType<typeof planKey> {
  const providers = Array.isArray(latest.providers) ? latest.providers as Array<Record<string, any>> : [];
  return planKey(providers.find(p => p.id === id), confirmedKey);
}

export function mergeRawConfig(loaded: Config, edited: Config, latest: Config): { config: Config; conflicts: string[] } {
  const merged = applyEdits(latest, diffConfig(loaded, edited));
  const conflicts = merged.conflicts.map(c => c.path);
  return { config: conflicts.length > 0 ? latest : merged.config, conflicts };
}

export function parseRawConfig(text: string): Config | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Config : null;
  } catch { return null; }
}
