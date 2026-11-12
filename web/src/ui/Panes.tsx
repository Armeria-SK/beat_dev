import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import { useMedia } from './hooks.ts';
import { PlanPane } from './panes/PlanPane.tsx';
import {
  closePane, fitLayout, KEY_STEP, openable, PANE_MIN, paneDef, panesWidth, parseLayout, resizePane, selectView, showSplit, STORE_KEY, tabOrder, togglePanes, visiblePanes,
  type PaneLayout, type PaneView,
} from './panes.ts';
import { Button } from './parts.tsx';
import './styles/panes.css';

const NARROW = '(max-width: 760px)';
const SIDEBAR = 248;

export interface PanesToggle { open: boolean; onToggle: () => void }

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
  room: number;
  width: number;
  toggle: () => void;
  close: (index: number) => void;
  select: (index: number, view: PaneView) => void;
  split: (index: number) => void;
  begin: () => void;
  drag: (index: number, dx: number) => void;
  nudge: (index: number, dx: number) => void;
}

export function usePanes(productId: string | null): PanesState {
  const narrow = useMedia(NARROW);
  const room = useRoom();
  const [layout, setLayout] = useState<PaneLayout>(() => parseLayout(readStored()));
  const [narrowView, setNarrowView] = useState<PaneView | null>(null);
  const views = useMemo(() => openable({ productId }), [productId]);
  const shown: PaneLayout = narrow
    ? (narrowView && views.includes(narrowView) ? [{ view: narrowView, width: 0 }] : [])
    : fitLayout(visiblePanes(layout, views), room);
  const base = useRef<PaneLayout>(shown);

  const update = (next: PaneLayout) => {
    const hidden = layout.filter(p => !views.includes(p.view));
    const merged = [...next, ...hidden];
    setLayout(merged);
    writeStored(merged);
  };

  return {
    views, shown, narrow, room, width: panesWidth(shown),
    toggle: () => { if (narrow) setNarrowView(v => (v ? null : views[0] ?? null)); else update(togglePanes(shown, views)); },
    close: index => { if (narrow) setNarrowView(null); else update(closePane(shown, index)); },
    select: (index, view) => { if (narrow) setNarrowView(view); else update(selectView(shown, index, view)); },
    split: index => {
      const next = views.find(v => v !== shown[index]?.view) ?? views[0];
      if (next) update([...shown.slice(0, index + 1), { view: next, width: PANE_MIN }, ...shown.slice(index + 1)]);
    },
    begin: () => { base.current = shown; },
    drag: (index, dx) => update(resizePane(base.current, index, dx, room)),
    nudge: (index, dx) => update(resizePane(shown, index, dx, room)),
  };
}

function Handle({ index, width, panes }: { index: number; width: number; panes: PanesState }) {
  const t = useT();
  const [dragging, setDragging] = useState(false);
  const start = useRef(0);
  const end = () => setDragging(false);
  return (
    <div role="separator" aria-orientation="vertical" aria-label={t('ui.pane.resize')} aria-valuenow={width} aria-valuemin={PANE_MIN} tabIndex={0}
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

export function Panes({ panes, productId, scope, revision, inert }: { panes: PanesState; productId: string; scope: string; revision: string; inert: boolean }) {
  const t = useT();
  const body = (view: PaneView): ReactNode => {
    switch (view) {
      case 'plan': return <PlanPane key={`${productId}:${scope}`} productId={productId} revision={revision} />;
    }
  };
  const tabs = tabOrder(panes.views, panes.narrow);
  const splittable = !panes.narrow && showSplit(panes.views, panes.shown, panes.room);
  return (
    <div className="bt-app__panes ui-panes" role="region" aria-label={t('ui.panes.label')} inert={inert}>
      {panes.shown.map((pane, i) => (
        <Fragment key={i}>
          {!panes.narrow && <Handle index={i} width={pane.width} panes={panes} />}
          <section className="bt-pane ui-panes__pane" style={panes.narrow ? undefined : { flexBasis: pane.width }}>
            <div className="bt-tabs" role="tablist">
              {tabs.map(view => (
                <button key={view} type="button" className="bt-tab" role="tab" aria-selected={pane.view === view} onClick={() => panes.select(i, view)}>{t(paneDef(view).label)}</button>
              ))}
              <span className="bt-tabs__end">
                {splittable && <Button variant="ghost" small icon="columns" aria-label={t('ui.pane.split')} title={t('ui.pane.split')} onClick={() => panes.split(i)} />}
                <Button variant="ghost" small icon="x" aria-label={t('ui.pane.close')} title={t('ui.pane.close')} onClick={() => panes.close(i)} />
              </span>
            </div>
            <div className="bt-pane__body" role="tabpanel" aria-label={t(paneDef(pane.view).label)}>{body(pane.view)}</div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}
