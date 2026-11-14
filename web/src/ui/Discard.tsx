import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { RowConfirm } from './RowConfirm.tsx';
import { discardGate, setUnsaved, type DiscardGate } from './unsaved.ts';

export function useUnsaved(key: string, dirty: boolean): void {
  useEffect(() => { setUnsaved(key, dirty); return () => setUnsaved(key, false); }, [key, dirty]);
}

export interface DiscardAsk { asking: boolean; attempt: (run: () => void) => void; confirm: () => void; keep: (refocus: boolean) => void }

export function useDiscardAsk(isDirty: () => boolean): DiscardAsk {
  const [asking, setAsking] = useState(false);
  const gate = useRef<DiscardGate | null>(null);
  gate.current ??= discardGate(setAsking);
  const opener = useRef<Element | null>(null);
  const dirty = useRef(isDirty);
  dirty.current = isDirty;
  return {
    asking,
    attempt: run => { opener.current = document.activeElement; gate.current!.attempt(dirty.current(), run); },
    confirm: () => gate.current!.confirm(),
    keep: refocus => {
      gate.current!.keep();
      const el = opener.current;
      if (refocus && el instanceof HTMLElement) requestAnimationFrame(() => { if (el.isConnected) el.focus(); });
    },
  };
}

export function DiscardConfirm({ ask }: { ask: DiscardAsk }) {
  const t = useT();
  if (!ask.asking) return null;
  return <RowConfirm warn={t('ui.set.leave.title')} action={t('ui.set.leave.discard')} busy={false} onConfirm={ask.confirm} onKeep={ask.keep} />;
}
