export type Lang = 'en' | 'ja';
export const EXPLAIN_CHOICES = ['auto', 'en', 'ja'] as const;
export type ExplainChoice = typeof EXPLAIN_CHOICES[number];
export const LANG_NAME: Record<Lang, string> = { en: 'English', ja: '日本語' };

export const DEFAULT_TIMEZONE = 'Asia/Tokyo';
export const EXPLAIN_STORAGE_KEY = 'beat.explainLanguage';

export function isValidTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

export const isExplainChoice = (value: unknown): value is ExplainChoice => typeof value === 'string' && (EXPLAIN_CHOICES as readonly string[]).includes(value);

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function readSavedChoice(): ExplainChoice {
  try { const saved = storage()?.getItem(EXPLAIN_STORAGE_KEY); return isExplainChoice(saved) ? saved : 'auto'; } catch { return 'auto'; }
}

let timezone = DEFAULT_TIMEZONE;
let explainChoice: ExplainChoice = readSavedChoice();
let version = 0;
const listeners = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function setTimezone(zone: string): void {
  const next = isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE;
  if (next === timezone) return;
  timezone = next;
  changed();
}

export function resolveAuto(languages: readonly string[]): Lang {
  for (const tag of languages) {
    if (/^ja(?:-|$)/iu.test(tag)) return 'ja';
    if (/^en(?:-|$)/iu.test(tag)) return 'en';
  }
  return 'en';
}

function browserLanguages(): readonly string[] {
  try { return globalThis.navigator?.languages ?? []; } catch { return []; }
}

export function setExplainLanguage(choice: ExplainChoice): void {
  if (!isExplainChoice(choice) || choice === explainChoice) return;
  explainChoice = choice;
  try { storage()?.setItem(EXPLAIN_STORAGE_KEY, choice); } catch { }
  changed();
}

export const getExplainChoice = (): ExplainChoice => explainChoice;
export const autoLanguage = (): Lang => resolveAuto(browserLanguages());
export const getExplainLanguage = (): Lang => (explainChoice === 'auto' ? autoLanguage() : explainChoice);

// 日付・数（Intl）の書き方は英語のまま。説明の文の言語は getExplainLanguage。
export const getLanguage = (): Lang => 'en';
export const getTimezone = (): string => timezone;
export const getVersion = (): number => version;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
