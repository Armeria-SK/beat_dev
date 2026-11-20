import { Value } from '@sinclair/typebox/value';
import { ResearchConfig, type AppConfig } from '../config/schema.ts';
import { RESEARCH_LIMIT_RANGE, type ResearchLimits, type ResearchSettings } from '../shared/research-languages.ts';

export const ONE_BY_ONE_BELOW = 32_000;

const DEFAULT_LIMITS = Object.fromEntries(Object.entries(RESEARCH_LIMIT_RANGE).map(([k, r]) => [k, r.default])) as unknown as ResearchLimits;

export function parseProjectResearch(raw: string | null | undefined): ResearchConfig | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return Value.Check(ResearchConfig, value) ? value : undefined;
  } catch { return undefined; }
}

export function researchSettings(config: AppConfig, project?: ResearchConfig): ResearchSettings {
  const global = config.research ?? {};
  const own = project ?? {};
  return {
    when: own.when ?? global.when ?? 'new',
    mode: own.mode ?? global.mode ?? 'auto',
    limits: { ...DEFAULT_LIMITS, ...global.limits, ...own.limits },
    askLanguage: own.askLanguage ?? global.askLanguage ?? true,
    preferLanguages: [...(own.preferLanguages ?? global.preferLanguages ?? [])],
    avoidLanguages: [...(own.avoidLanguages ?? global.avoidLanguages ?? [])],
  };
}
