import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { getExplainLanguage, getVersion, subscribe } from './state.ts';
import type { ArgsOf, Dict, DictKey } from './types.ts';

export { formatDateTime, formatDateTimeSmart, formatList, formatNumber, formatRelative, formatZonedInput, parseZonedInput, pluralEn, startOfDay, timezoneLabel, type DateStyle } from './format.ts';
export { formatElapsed } from './elapsed.ts';
export { applyServerSettings, loadServerSettings, type LoadSettingsOptions, type ServerSettingsView } from './load-settings.ts';
export { autoLanguage, DEFAULT_TIMEZONE, EXPLAIN_CHOICES, getExplainChoice, getExplainLanguage, getLanguage, getTimezone, isExplainChoice, LANG_NAME, resolveAuto, setExplainLanguage, setTimezone, type ExplainChoice, type Lang } from './state.ts';
export type { DictKey, PlainKey } from './types.ts';

const dictionary: Dict = en;
const explained: Partial<Record<DictKey, unknown>> = ja;

export function t<K extends DictKey>(key: K, ...args: ArgsOf<K>): string {
  const entry = ((getExplainLanguage() === 'ja' ? explained[key] : undefined) ?? dictionary[key]) as string | ((...a: unknown[]) => string);
  return typeof entry === 'function' ? entry(...args) : entry;
}

export function useT(): typeof t {
  useSyncExternalStore(subscribe, getVersion);
  return t;
}
