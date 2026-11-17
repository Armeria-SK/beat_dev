import { useState } from 'react';
import type { ScoutMode, ScoutState } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatRelative, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { Button, Pill } from '../parts.tsx';
import { productOf } from '../products.ts';
import { canThinkNow, useScout } from '../scout.ts';
import { Kanban, type KanbanProps } from '../screens/Kanban.tsx';
import { reportOpError } from '../task-ops.ts';

export type KanbanPaneProps = Omit<KanbanProps, 'productId' | 'emptyProposed'> & { productId: string };

const PILL = { thinking: 'ui.scout.thinking', asleep: 'ui.scout.asleep', idle: 'ui.scout.idle', resting: 'ui.scout.resting', off: 'ui.scout.off' } as const;

export function ScoutEmpty({ state, mode, archived = false, now, onThinkNow }: { state: ScoutState; mode: ScoutMode; archived?: boolean; now: number; onThinkNow: () => Promise<void> }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const meta = state.state === 'thinking' ? [t('ui.scout.examined', state.examined), state.area && t('ui.scout.reading', state.area)]
    : state.state === 'asleep' ? [state.lastChangeAt !== null && t('ui.scout.lastChange', formatRelative(state.lastChangeAt, now)), t('ui.scout.wakes')]
    : state.state === 'off' ? [t(mode === 'off' ? 'ui.scout.offMeta' : archived ? 'ui.scout.offMetaArchived' : 'ui.scout.offMetaModel')]
    : [];
  const shown = meta.filter((line): line is string => Boolean(line));
  const title = state.state === 'off' ? t('ui.scout.offTitle') : state.state === 'asleep' ? t('ui.scout.nothingNew') : t('ui.scout.nothingYet');
  const think = async () => {
    if (busy) return;
    setBusy(true);
    try { await onThinkNow(); toast({ icon: 'refresh', title: t('ui.scout.started') }); } catch (error) { reportOpError(error); } finally { setBusy(false); }
  };
  return (
    <div className="bt-empty bt-rise ui-scout" data-scout={state.state}>
      <Pill tone={state.state === 'thinking' ? 'running' : undefined}>{t(PILL[state.state])}</Pill>
      <h2 className="bt-empty__title">{title}</h2>
      {shown.length > 0 && <p className="bt-meta ui-scout__meta">{shown.join(' · ')}</p>}
      {state.note && <p className="bt-meta ui-scout__meta" data-scout-note>{state.note}</p>}
      {canThinkNow(state, mode) && <Button small disabled={busy} onClick={() => void think()}>{t('ui.scout.thinkNow')}</Button>}
    </div>
  );
}

export function KanbanPane(props: KanbanPaneProps) {
  const { load, thinkNow } = useScout(props.productId, props.revision);
  const now = useNow(30_000);
  const product = productOf(props.projects, props.productId);
  const mode = product?.scout_mode ?? 'off';
  const empty = load.kind === 'ready' ? <ScoutEmpty state={load.state} mode={mode} archived={(product?.archived_at ?? null) !== null} now={now} onThinkNow={thinkNow} /> : undefined;
  return <Kanban {...props} emptyProposed={empty} />;
}
