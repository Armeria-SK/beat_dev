import { parseRoute, routeHash, type Route } from './routes.ts';

const dirty = new Map<string, true>();

export function setUnsaved(key: string, on: boolean): void {
  if (on) dirty.set(key, true); else dirty.delete(key);
}

export function clearUnsaved(prefix: string): void {
  for (const key of [...dirty.keys()]) if (key.startsWith(prefix)) dirty.delete(key);
}

export const hasUnsavedEdits = (prefix = '', except?: string): boolean => [...dirty.keys()].some(key => key.startsWith(prefix) && key !== except);

export const SCREEN_EDITS = 'screen:';

export const SETTINGS_EDITS = 'settings:';

export function settingsHold(unsaved: boolean, fromView: string, fromHash: string, next: Route, from: number | null, now: number | null): { leave: HeldLeave; back: string } | null {
  const to = routeHash(next);
  if (!unsaved || fromView !== 'settings' || to === routeHash(parseRoute(fromHash))) return null;
  return { leave: { to, moved: leaveMove(from, now), at: from }, back: fromHash };
}

export function leaveAsks(unsaved: boolean, current: Route, next: Route): boolean {
  return unsaved && next.view !== 'settings' && routeHash(next) !== routeHash(current);
}

export function unloadGuard(event: { preventDefault: () => void; returnValue?: unknown }): void {
  if (!hasUnsavedEdits()) return;
  event.preventDefault();
  event.returnValue = '';
}

export function historyIndex(nav: { currentEntry?: { index: number } | null } | undefined = (globalThis as { navigation?: { currentEntry?: { index: number } | null } }).navigation): number | null {
  const index = nav?.currentEntry?.index;
  return typeof index === 'number' && index >= 0 ? index : null;
}

export const leaveMove = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : to - from);

export interface LeaveEnv { go: (by: number) => void; replace: (hash: string) => void; push: (hash: string) => void }

export function holdLeave(moved: number | null, heldHash: string, env: LeaveEnv): void {
  if (moved) env.go(-moved); else env.replace(heldHash);
}

export interface HeldLeave { to: string; moved: number | null; at: number | null }

export function followLeave(leave: HeldLeave, now: number | null, env: LeaveEnv): void {
  if (leave.moved !== null && leave.moved < 0 && now !== null && now === leave.at) env.go(leave.moved); else env.push(leave.to);
}

export const popIndex = (known: number | null, lastHash: string, nowHash: string, now: number | null): number | null => (nowHash === lastHash ? now : known);

export interface DiscardGate { attempt: (dirty: boolean, run: () => void) => boolean; confirm: () => void; keep: () => void }

export function discardGate(onAsk: (asking: boolean) => void): DiscardGate {
  let held: (() => void) | null = null;
  return {
    attempt: (dirty, run) => {
      if (!dirty) { run(); return true; }
      held = run;
      onAsk(true);
      return false;
    },
    confirm: () => { const run = held; held = null; onAsk(false); run?.(); },
    keep: () => { held = null; onAsk(false); },
  };
}
