import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useT } from '../i18n/index.ts';
import { useMedia } from './hooks.ts';
import { PendingList, type PendingListProps } from './panes/PendingPane.tsx';
import { PlanPane } from './panes/PlanPane.tsx';
import {
  closePane, fitLayout, keepHidden, KEY_STEP, openable, openView, PANE_MIN, paneDef, paneRange, panesWidth, parseLayout, resizePane, selectView, showSplit, singlePane, STORE_KEY, tabOrder, togglePanes, visiblePanes,
  type PaneLayout, type PaneView,
} from './panes.ts';
import { Button, CountBadge } from './parts.tsx';
import './styles/panes.css';

const NARROW = '(max-width: 760px)';
const SIDEBAR = 248;

export interface PanesToggle { open: boolean; onToggle: () => void; onOpenPlan?: ((reveal: boolean) => void) | undefined }

export function PanesButton({ open, onToggle }: PanesToggle) {
  const t = useT();
  return <Button variant="ghost" small className="ui-panes__toggle" aria-pressed={open} onClick={onToggle}>{t('ui.panes.open')}</Button>;
}

function readStored(): string | null {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

function writeStored(layout: PaneLayout): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(layout)); } catch { return; }
}

function useRoom(): number {
  const [room, setRoom] = useState(() => innerWidth - SIDEBAR);
  useEffect(() => {
    const onResize = () => setRoom(innerWidth - SIDEBAR);
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  return room;
}

export interface PanesState {
  views: PaneView[];
  shown: PaneLayout;
  narrow: boolean;
  single: boolean;
  room: number;
  width: number;
  toggle: () => void;
  close: (index: number) => void;
  select: (index: number, view: PaneView) => void;
  split: (index: number) => void;
  begin: () => void;
  drag: (index: number, dx: number) => void;
  nudge: (index: number, dx: number) => void;
  reveal: boolean;
  openPlan: (reveal: boolean) => void;
  openPane: (view: PaneView) => void;
  revealed: () => void;
}

export function usePanes(productId: string | null): PanesState {
  const narrow = useMedia(NARROW);
  const room = useRoom();
  const [layout, setLayout] = useState<PaneLayout>(() => parseLayout(readStored()));
  const [singleView, setSingleView] = useState<PaneView | null>(null);
  const [reveal, setReveal] = useState(false);
  const views = useMemo(() => openable({ productId }), [productId]);
  const single = singlePane(narrow, room);
  const visible = visiblePanes(layout, views);
  const shown: PaneLayout = single
    ? (singleView && views.includes(singleView) ? [{ view: singleView, width: 0 }] : [])
    : fitLayout(visible, room);
  const base = useRef<PaneLayout>(shown);

  const update = (next: PaneLayout) => {
    const hidden = layout.filter(p => !views.includes(p.view));
    const merged = [...next, ...hidden];
    setLayout(merged);
    writeStored(merged);
  };
  const keep = (next: PaneLayout, from: PaneLayout = shown) => update(keepHidden(next, visible, from));

  return {
    views, shown, narrow, single, room, width: panesWidth(shown),
    toggle: () => { if (single) setSingleView(v => (v ? null : views[0] ?? null)); else update(togglePanes(shown, views)); },
    close: index => { if (single) setSingleView(null); else keep(closePane(shown, index)); },
    select: (index, view) => { if (single) setSingleView(view); else keep(selectView(shown, index, view)); },
    split: index => {
      const next = views.find(v => v !== shown[index]?.view) ?? views[0];
      if (next) keep([...shown.slice(0, index + 1), { view: next, width: PANE_MIN }, ...shown.slice(index + 1)]);
    },
    begin: () => { base.current = shown; },
    drag: (index, dx) => keep(resizePane(base.current, index, dx, room), base.current),
    nudge: (index, dx) => keep(resizePane(shown, index, dx, room)),
    reveal,
    openPlan: wanted => {
      if (!views.includes('plan')) return;
      if (single) setSingleView('plan'); else keep(openView(shown, views, 'plan'));
      setReveal(wanted);
    },
    revealed: () => setReveal(false),
    openPane: view => {
      if (!views.includes(view)) return;
      if (single) setSingleView(view); else keep(openView(shown, views, view));
    },
  };
}

const paneId = (index: number) => `ui-pane-${index}`;

function focusToggle(): void {
  const toggles = [...document.querySelectorAll<HTMLElement>('.ui-panes__toggle')];
  toggles.find(el => el.getClientRects().length > 0)?.focus();
}

function Handle({ index, width, panes }: { index: number; width: number; panes: PanesState }) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);
  const end = () => setDragging(false);
  const range = paneRange(panes.shown, index, panes.room);
  return (
    <div role="separator" aria-orientation="vertical" aria-label={t('ui.pane.resize')} aria-controls={paneId(index)} aria-valuenow={width} aria-valuemin={range.min} aria-valuemax={range.max} tabIndex={0}
      className={`ui-panes__handle${dragging ? ' is-dragging' : ''}`}
      onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); start.current = e.clientX; panes.begin(); setDragging(true); }}
      onPointerMove={e => { if (dragging) panes.drag(index, e.clientX - start.current); }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={e => {
        const step = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0;
        if (step) { e.preventDefault(); panes.nudge(index, step); }
      }} />
  );
}

export type PanePending = Omit<PendingListProps, 'projectId' | 'onOpenPlan'> & { count: number };

export function Panes({ panes, productId, scope, revision, taskRevision, isGit, inert, pending }: { panes: PanesState; productId: string; scope: string; revision: string; taskRevision: string; isGit: boolean; inert: boolean; pending: PanePending }) {
  const t = useT();
  const body = (view: PaneView, index: number): ReactNode => {
    switch (view) {
      case 'pending': {
        const { count: _count, ...list } = pending;
        return <PendingList key={productId} projectId={productId} {...list} onOpenPlan={() => panes.select(index, 'plan')} />;
      }
      case 'plan': return <PlanPane key={`${productId}:${scope}`} productId={productId} revision={revision} taskRevision={taskRevision} isGit={isGit} reveal={panes.reveal} onRevealed={panes.revealed} />;
    }
  };
  const tabs = tabOrder(panes.views, panes.narrow);
  const splittable = !panes.single && showSplit(panes.views, panes.shown, panes.room);
  const close = (index: number) => {
    const last = panes.shown.length === 1;
    flushSync(() => panes.close(index));
    if (last) focusToggle();
  };
  return (
    <div className="bt-app__panes ui-panes" role="region" aria-label={t('ui.panes.label')} inert={inert}>
      {panes.shown.map((pane, i) => (
        <Fragment key={i}>
          {!panes.single && <Handle index={i} width={pane.width} panes={panes} />}
          <section id={paneId(i)} className="bt-pane ui-panes__pane" style={panes.single ? undefined : { flexBasis: pane.width }}>
            <div className="bt-tabs" role="tablist">
              {tabs.map(view => (
                <button key={view} type="button" className="bt-tab" role="tab" aria-selected={pane.view === view} onClick={() => panes.select(i, view)}>{t(paneDef(view).label)}{view === 'pending' && <> <CountBadge n={pending.count} label={t('ui.count.waiting', pending.count)} /></>}</button>
              ))}
              <span className="bt-tabs__end">
                {splittable && <Button variant="ghost" small icon="columns" aria-label={t('ui.pane.split')} title={t('ui.pane.split')} onClick={() => panes.split(i)} />}
                <Button variant="ghost" small icon="x" aria-label={t('ui.pane.close')} title={t('ui.pane.close')} onClick={() => close(i)} />
              </span>
            </div>
            <div className="bt-pane__body" role="tabpanel" aria-label={t(paneDef(pane.view).label)}>{body(pane.view, i)}</div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
