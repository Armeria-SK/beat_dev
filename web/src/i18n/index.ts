import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { getVersion, subscribe } from './state.ts';
import type { ArgsOf, Dict, DictKey } from './types.ts';

export { formatDateTime, formatDateTimeSmart, formatList, formatNumber, formatRelative, formatZonedInput, parseZonedInput, pluralEn, startOfDay, timezoneLabel, type DateStyle } from './format.ts';
export { formatElapsed } from './elapsed.ts';
export { applyServerSettings, loadServerSettings, type LoadSettingsOptions, type ServerSettingsView } from './load-settings.ts';
export { DEFAULT_TIMEZONE, getLanguage, getTimezone, setTimezone, type Lang } from './state.ts';
export type { DictKey, PlainKey } from './types.ts';

const dictionary: Dict = en;

export function t<K extends DictKey>(key: K, ...args: ArgsOf<K>): string {
  const entry = dictionary[key] as string | ((...a: unknown[]) => string);
  return typeof entry === 'function' ? entry(...args) : entry;
}

export function useT(): typeof t {
  useSyncExternalStore(subscribe, getVersion);
  return t;
}
