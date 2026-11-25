import type { AppConfig } from '../config/schema.ts';
import { RESEARCH_LIMIT_RANGE, type ResearchLimits, type ResearchSettings } from '../shared/research-languages.ts';

export const ONE_BY_ONE_BELOW = 32_000;

const DEFAULT_LIMITS = Object.fromEntries(Object.entries(RESEARCH_LIMIT_RANGE).map(([k, r]) => [k, r.default])) as unknown as ResearchLimits;

export function researchSettings(config: AppConfig): ResearchSettings {
  const global = config.research ?? {};
  return {
    when: global.when ?? 'new',
    mode: global.mode ?? 'auto',
    limits: { ...DEFAULT_LIMITS, ...global.limits },
    askLanguage: global.askLanguage ?? true,
    preferLanguages: [...(global.preferLanguages ?? [])],
    avoidLanguages: [...(global.avoidLanguages ?? [])],
  };
}
