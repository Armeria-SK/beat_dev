export const RESEARCH_LANGUAGES = ['TypeScript / JavaScript', 'Python', 'Go', 'Rust', 'C#', 'Java / Kotlin', 'C / C++', 'Swift', 'Dart', 'PHP', 'Ruby'] as const;
export type ResearchLanguage = (typeof RESEARCH_LANGUAGES)[number];

export const RESEARCH_WHEN = ['new', 'button', 'off'] as const;
export const RESEARCH_MODES = ['auto', 'one_by_one', 'batch'] as const;
export type ResearchWhen = (typeof RESEARCH_WHEN)[number];
export type ResearchModeSetting = (typeof RESEARCH_MODES)[number];

export interface ResearchLimits { candidates: number; searches: number; fetches: number; minutes: number }
export const RESEARCH_LIMIT_RANGE: Record<keyof ResearchLimits, { min: number; max: number; default: number }> = {
  candidates: { min: 1, max: 8, default: 8 },
  searches: { min: 1, max: 60, default: 15 },
  fetches: { min: 1, max: 30, default: 30 },
  minutes: { min: 1, max: 120, default: 20 },
};

export interface ResearchSettings {
  when: ResearchWhen;
  mode: ResearchModeSetting;
  limits: ResearchLimits;
  askLanguage: boolean;
  preferLanguages: ResearchLanguage[];
  avoidLanguages: ResearchLanguage[];
}
