import { useEffect, useRef } from 'react';
import { useT } from '../i18n/index.ts';
import { Button } from './parts.tsx';

export function RowConfirm({ warn, note, action, busy, onConfirm, onKeep }: {
  warn: string; note?: string | undefined; action: string; busy: boolean; onConfirm: () => void; onKeep: () => void;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef(onKeep);
  keep.current = onKeep;
  useEffect(() => {
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) keep.current(); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  return (
    <div ref={box} className="ui-confirm" role="group" aria-label={warn}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onKeep(); } }}>
      <span className="bt-label bt-del">{warn}</span>
      {note && <span className="bt-meta ui-confirm__note">{note}</span>}
      <span className="ui-confirm__buttons">
        <Button variant="danger" small disabled={busy} onClick={onConfirm}>{action}</Button>
        <Button variant="ghost" small autoFocus onClick={onKeep}>{t('ui.lib.keep')}</Button>
      </span>
    </div>
  );
}
