export type Lang = 'en';

export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

export function isValidTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

let timezone = DEFAULT_TIMEZONE;
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

// 画面は英語だけ。呼ぶ所（文の表・Intl の書式）は P1 で言語の引数ごと消す。
export const getLanguage = (): Lang => 'en';
export const getTimezone = (): string => timezone;
export const getVersion = (): number => version;
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
