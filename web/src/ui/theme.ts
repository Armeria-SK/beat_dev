import { getExplainLanguage, subscribe } from '../i18n/state.ts';

export const THEMES = ['light', 'dusk', 'sand', 'mist', 'moss', 'ember'] as const;
export type Theme = typeof THEMES[number];
export const DEFAULT_THEME: Theme = 'light';

export const THEME_KEY = 'beat.theme';
export const REDUCED_MOTION_KEY = 'beat.reducedMotion';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const isTheme = (value: unknown): value is Theme => typeof value === 'string' && (THEMES as readonly string[]).includes(value);

function read(storage: ThemeStorage | undefined, key: string): string | null {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function write(storage: ThemeStorage | undefined, key: string, value: string): void {
  try { storage?.setItem(key, value); } catch { }
}

export function readTheme(storage: ThemeStorage | undefined): Theme {
  const saved = read(storage, THEME_KEY);
  return isTheme(saved) ? saved : DEFAULT_THEME;
}

export function saveTheme(storage: ThemeStorage | undefined, theme: Theme): void {
  write(storage, THEME_KEY, theme);
}

export function readReducedMotion(storage: ThemeStorage | undefined): boolean {
  return read(storage, REDUCED_MOTION_KEY) === '1';
}

export function saveReducedMotion(storage: ThemeStorage | undefined, on: boolean): void {
  write(storage, REDUCED_MOTION_KEY, on ? '1' : '0');
}

export function applyTheme(root: { dataset: DOMStringMap }, theme: Theme): void {
  root.dataset.theme = theme;
}

export function followExplainLanguage(root: { lang: string }): () => void {
  const sync = () => { root.lang = getExplainLanguage(); };
  sync();
  return subscribe(sync);
}

export function browserStorage(): ThemeStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}
