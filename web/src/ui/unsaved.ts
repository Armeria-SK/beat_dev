import { routeHash, type Route } from './routes.ts';

const dirty = new Map<string, true>();

export function setUnsaved(key: string, on: boolean): void {
  if (on) dirty.set(key, true); else dirty.delete(key);
}

export function clearUnsaved(prefix: string): void {
  for (const key of [...dirty.keys()]) if (key.startsWith(prefix)) dirty.delete(key);
}

export const hasUnsavedEdits = (prefix = '', except?: string): boolean => [...dirty.keys()].some(key => key.startsWith(prefix) && key !== except);

export const SCREEN_EDITS = 'screen:';

export function leaveAsks(unsaved: boolean, current: Route, next: Route): boolean {
  return unsaved && next.view !== 'settings' && routeHash(next) !== routeHash(current);
}

export function unloadGuard(event: { preventDefault: () => void; returnValue?: unknown }): void {
  if (!hasUnsavedEdits()) return;
  event.preventDefault();
  event.returnValue = '';
}
