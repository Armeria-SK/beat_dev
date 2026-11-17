import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ScoutMode, type ScoutState } from '../api.ts';
import { latestOnly } from './latest.ts';
import { noProductApi } from './products.ts';

export const SCOUT_POLL_MS = 30_000;

export type ScoutLoad = { kind: 'loading' } | { kind: 'absent' } | { kind: 'ready'; state: ScoutState };

const STATES: readonly string[] = ['off', 'idle', 'thinking', 'asleep', 'resting'];

export const isScoutState = (value: unknown): value is ScoutState => {
  const v = value as Partial<ScoutState> | null;
  return typeof v === 'object' && v !== null && STATES.includes(v.state as string) && typeof v.examined === 'number'
    && (v.area === null || typeof v.area === 'string') && (v.lastChangeAt === null || typeof v.lastChangeAt === 'number') && (v.note === null || typeof v.note === 'string');
};

export const canThinkNow = (state: ScoutState, mode: ScoutMode): boolean => mode !== 'off' && state.state !== 'off' && state.state !== 'thinking';

export const SCOUT_MODE_CHOICES: ReadonlyArray<{ mode: ScoutMode; enabled: boolean }> = [
  { mode: 'off', enabled: true },
  { mode: 'research', enabled: true },
  { mode: 'fix', enabled: false },
];

export function useScout(productId: string, revision = 0): { load: ScoutLoad; refresh: () => Promise<void>; thinkNow: () => Promise<void> } {
  const [load, setLoad] = useState<ScoutLoad>({ kind: 'loading' });
  const loads = useRef(latestOnly());
  const refresh = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const state = await api.scout(productId);
      if (loads.current.isCurrent(ticket)) setLoad(isScoutState(state) ? { kind: 'ready', state } : { kind: 'absent' });
    } catch (error) {
      if (loads.current.isCurrent(ticket) && noProductApi(error)) setLoad({ kind: 'absent' });
    }
  }, [productId]);
  useEffect(() => { setLoad({ kind: 'loading' }); }, [productId]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  const absent = load.kind === 'absent';
  useEffect(() => {
    if (absent) return undefined;
    const timer = setInterval(() => void refresh(), SCOUT_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, absent]);
  const thinkNow = useCallback(async () => {
    await api.scoutRun(productId);
    await refresh();
  }, [productId, refresh]);
  return { load, refresh, thinkNow };
}
