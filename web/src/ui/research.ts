import type { ResearchItem, ResearchLanguageName, ResearchLimitsView, ResearchOwn, ResearchPick, ResearchRecord, ResearchStatus } from '../api.ts';
import { RESEARCH_LANGUAGES, RESEARCH_LIMIT_RANGE } from '../../../src/shared/research-languages.ts';
import { pruned, type Config } from '../settings/model.ts';
import { apiDetail } from './plan.ts';

export type FeatureDecision = 'picked' | 'later' | 'not_needed';
export type SimilarPick = { id: number; decision: 'use' | 'base' } | 'build' | null;

export interface ResearchPicks {
  features: Readonly<Record<number, FeatureDecision>>;
  reasons: Readonly<Record<number, string>>;
  similar: SimilarPick;
  memo: string;
  setup: boolean;
  choices: Readonly<Record<number, number>>;
}

type PillTone = 'running' | 'waiting' | 'ok' | 'warn' | 'danger';

const FINISHED: readonly ResearchStatus[] = ['done', 'failed', 'cancelled'];

export const canConfirm = (record: ResearchRecord): boolean => FINISHED.includes(record.status);

export const canStart = (record: ResearchRecord | null): boolean => record === null || record.status !== 'running';

export const itemsOf = (record: ResearchRecord, kind: ResearchItem['kind']): ResearchItem[] => record.items.filter(item => item.kind === kind);

// Only the code's measures may choose for the owner. A model's recommendation is shown with a tag and is never pre-selected (R3.11 L4 (c)).
export function presetChoice(item: ResearchItem): number | null {
  if (item.kind !== 'choice' || item.by !== 'code' || item.recommended === null) return null;
  return item.recommended >= 0 && item.recommended < (item.options?.length ?? 0) ? item.recommended : null;
}

export function initialPicks(record: ResearchRecord): ResearchPicks {
  const features: Record<number, FeatureDecision> = {};
  const choices: Record<number, number> = {};
  for (const item of record.items) {
    if (item.kind === 'feature') features[item.id] = item.defaultChecked ? 'picked' : 'later';
    const preset = presetChoice(item);
    if (preset !== null) choices[item.id] = preset;
  }
  return { features, reasons: {}, similar: null, memo: '', setup: false, choices };
}

export const baseOf = (picks: ResearchPicks): number | null => (picks.similar !== null && picks.similar !== 'build' && picks.similar.decision === 'base' ? picks.similar.id : null);

export function featureGroups(record: ResearchRecord, picks: ResearchPicks): { missing: ResearchItem[]; onBase: ResearchItem[] } {
  const base = baseOf(picks);
  const features = itemsOf(record, 'feature');
  if (base === null) return { missing: features, onBase: [] };
  return { missing: features.filter(item => !item.products.includes(base)), onBase: features.filter(item => item.products.includes(base)) };
}

export const pickedCount = (record: ResearchRecord, picks: ResearchPicks): number =>
  featureGroups(record, picks).missing.filter(item => picks.features[item.id] === 'picked').length;

export const answeredChoices = (record: ResearchRecord, picks: ResearchPicks): number =>
  itemsOf(record, 'choice').filter(item => picks.choices[item.id] !== undefined).length;

// What the confirm call sends. An unanswered choice sends nothing, so nothing is written for it.
export function confirmPicks(record: ResearchRecord, picks: ResearchPicks): ResearchPick[] {
  const out: ResearchPick[] = [];
  const similar = itemsOf(record, 'similar');
  if (picks.similar === 'build') {
    if (similar[0]) out.push({ id: similar[0].id, decision: 'build' });
  } else if (picks.similar !== null) {
    const memo = picks.memo.trim();
    out.push({ id: picks.similar.id, decision: picks.similar.decision, ...(picks.similar.decision === 'use' && memo ? { reason: memo } : {}), ...(picks.similar.decision === 'use' && picks.setup ? { setup: true } : {}) });
  }
  for (const item of featureGroups(record, picks).missing) {
    const decision = picks.features[item.id] ?? 'later';
    const reason = (picks.reasons[item.id] ?? '').trim();
    out.push({ id: item.id, decision, ...(decision === 'not_needed' && reason ? { reason } : {}) });
  }
  for (const item of itemsOf(record, 'choice')) {
    const index = picks.choices[item.id];
    if (index !== undefined) out.push({ id: item.id, decision: index });
  }
  return out;
}

export type ConfirmFailure = { kind: 'busy' } | { kind: 'changed' } | { kind: 'failed'; detail: string | null };

export function confirmFailure(error: unknown): ConfirmFailure {
  const code = (error as { body?: { code?: unknown } } | null)?.body?.code;
  if (code === 'research.conversation_running') return { kind: 'busy' };
  if (code === 'research.changed') return { kind: 'changed' };
  return { kind: 'failed', detail: apiDetail(error) };
}

const STATUS = {
  running: ['ui.rs.status.running', 'running'],
  done: ['ui.rs.status.done', 'waiting'],
  failed: ['ui.rs.status.failed', 'danger'],
  cancelled: ['ui.rs.status.cancelled', undefined],
  skipped: ['ui.rs.status.skipped', undefined],
  confirmed: ['ui.rs.status.confirmed', 'ok'],
} as const satisfies Record<ResearchStatus, readonly [string, PillTone | undefined]>;

export function statusPill(record: ResearchRecord): { label: (typeof STATUS)[ResearchStatus][0] | 'ui.rs.status.partial'; tone: PillTone | undefined } {
  if (record.status === 'done' && record.partial) return { label: 'ui.rs.status.partial', tone: 'warn' };
  const [label, tone] = STATUS[record.status];
  return { label, tone };
}

const REASON = { owner_said: 'ui.rs.tag.ownerSaid', standard: 'ui.rs.tag.standard' } as const;

export const defaultTag = (item: ResearchItem): (typeof REASON)[keyof typeof REASON] | null =>
  (item.defaultChecked && item.defaultReason && Object.hasOwn(REASON, item.defaultReason) ? REASON[item.defaultReason] : null);

export const choiceTag = (item: ResearchItem, index: number): 'ui.rs.tag.measures' | 'ui.rs.tag.ai' | null =>
  (item.recommended !== index ? null : item.by === 'code' ? 'ui.rs.tag.measures' : 'ui.rs.tag.ai');

// The owner's confirmed choices, read back from the record (after confirm nothing can change)
export function confirmedLines(record: ResearchRecord): Array<{ kind: 'use' | 'base' | 'build' | 'feature' | 'choice'; name: string; option?: string }> {
  const out: Array<{ kind: 'use' | 'base' | 'build' | 'feature' | 'choice'; name: string; option?: string }> = [];
  for (const item of record.items) {
    if (item.kind === 'similar' && (item.decision === 'use' || item.decision === 'base' || item.decision === 'build')) out.push(item.decision === 'build' ? { kind: 'build', name: '' } : { kind: item.decision, name: item.name });
    else if (item.kind === 'feature' && item.decision === 'picked') out.push({ kind: 'feature', name: item.name });
    else if (item.kind === 'choice' && item.decision !== null && item.options) {
      const option = item.options[Number(item.decision)];
      if (option !== undefined) out.push({ kind: 'choice', name: item.name, option });
    }
  }
  return out.filter((line, i) => line.kind !== 'build' || out.findIndex(l => l.kind === 'build') === i);
}

// Settings: the research block of the config (global) and the product's own override (R-4)
export const RESEARCH_LANGUAGE_LIST: readonly ResearchLanguageName[] = RESEARCH_LANGUAGES;
export const LIMIT_KEYS = ['candidates', 'searches', 'fetches', 'minutes'] as const satisfies ReadonlyArray<keyof ResearchLimitsView>;
export const LIMIT_RANGE: Readonly<Record<keyof ResearchLimitsView, { min: number; max: number; default: number }>> = RESEARCH_LIMIT_RANGE;

export const researchModel = (config: Config): string => (Array.isArray(config.routing?.research) ? (config.routing.research as string[])[0] ?? '' : '');

export function setResearchModel(config: Config, id: string): Config {
  const routing: Record<string, unknown> = { ...(config.routing ?? {}) };
  if (id) routing.research = [id]; else delete routing.research;
  return { ...config, routing };
}

export function setResearch(config: Config, patch: Record<string, unknown>): Config {
  const merged: Record<string, unknown> = { ...(config.research ?? {}), ...patch };
  if (patch.limits !== undefined) {
    const limits = pruned({ ...(config.research?.limits ?? {}), ...(patch.limits as Record<string, unknown>) });
    if (Object.keys(limits).length) merged.limits = limits; else delete merged.limits;
  }
  return { ...config, research: pruned(merged) };
}

// Toggling a language into one list takes it out of the other, so a language is never both preferred and avoided
export function toggleLanguage(lists: { prefer: readonly ResearchLanguageName[]; avoid: readonly ResearchLanguageName[] }, which: 'prefer' | 'avoid', language: ResearchLanguageName): { prefer: ResearchLanguageName[]; avoid: ResearchLanguageName[] } {
  const other = which === 'prefer' ? 'avoid' : 'prefer';
  const list = lists[which].includes(language) ? lists[which].filter(l => l !== language) : [...lists[which], language];
  const rest = lists[other].filter(l => l !== language);
  return which === 'prefer' ? { prefer: list, avoid: rest } : { prefer: rest, avoid: list };
}

export function ownSettings(own: ResearchOwn): ResearchOwn | null {
  const limits = own.limits ? pruned({ ...own.limits }) : undefined;
  const out = pruned({ ...own, limits: limits && Object.keys(limits).length ? limits : undefined }) as ResearchOwn;
  return Object.keys(out).length ? out : null;
}
