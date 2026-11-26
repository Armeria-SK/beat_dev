import { useSyncExternalStore } from 'react';

// 提供元のモデルが 1 つも無いか（サーバーの /api/worker の noProvider）。無いと動かないもの（Build・定期の仕事・考える役・調べもの・裏の作業）が、画面のあちこちで同じ理由を出す
let none = false;
const listeners = new Set<() => void>();

export function setNoProvider(value: boolean): void {
  if (value === none) return;
  none = value;
  for (const listener of listeners) listener();
}

export const noProviderNow = (): boolean => none;

export const subscribeNoProvider = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const useNoProvider = (): boolean => useSyncExternalStore(subscribeNoProvider, () => none, () => false);
