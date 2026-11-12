import type { PlainKey } from '../i18n/index.ts';

export type PaneView = 'plan';

export interface PaneContext { productId: string | null }

export interface PaneDef { view: PaneView; label: PlainKey; counted: boolean; opens: (c: PaneContext) => boolean }

export const PANES: readonly PaneDef[] = [
  { view: 'plan', label: 'ui.pane.plan', counted: false, opens: c => c.productId !== null },
];

const VIEW_ORDER = ['plan', 'questions', 'kanban', 'pending', 'changes', 'files', 'terminal', 'browser'];
const NARROW_FIRST = ['questions', 'kanban', 'pending', 'notifications'];

export interface OpenPane { view: PaneView; width: number }
export type PaneLayout = readonly OpenPane[];

export const CONVERSATION_MIN = 340;
export const PANE_MIN = 300;
export const PANE_DEFAULT = 440;
export const GUTTER = 8;
export const KEY_STEP = 16;
export const STORE_KEY = 'beat.panes';

export const paneDef = (view: PaneView): PaneDef => PANES.find(p => p.view === view)!;

export const openable = (ctx: PaneContext): PaneView[] => PANES.filter(p => p.opens(ctx)).map(p => p.view);

export function tabOrder<V extends string>(views: readonly V[], narrow: boolean): V[] {
  const order = narrow ? [...NARROW_FIRST, ...VIEW_ORDER.filter(v => !NARROW_FIRST.includes(v))] : VIEW_ORDER;
  const rank = (v: string) => { const i = order.indexOf(v); return i < 0 ? order.length : i; };
  return [...views].sort((a, b) => rank(a) - rank(b));
}

export const visiblePanes = (layout: PaneLayout, views: readonly PaneView[]): PaneLayout => layout.filter(p => views.includes(p.view));

export function togglePanes(shown: PaneLayout, views: readonly PaneView[]): PaneLayout {
  if (shown.length > 0) return [];
  const first = views[0];
  return first ? [{ view: first, width: PANE_DEFAULT }] : [];
}

export const closePane = (layout: PaneLayout, index: number): PaneLayout => layout.filter((_, i) => i !== index);

export const selectView = (layout: PaneLayout, index: number, view: PaneView): PaneLayout =>
  layout.map((p, i) => (i === index ? { ...p, view } : p));

export const panesWidth = (layout: PaneLayout): number =>
  (layout.length ? layout.reduce((sum, p) => sum + p.width, 0) + GUTTER * (layout.length + 1) : 0);

export const maxPanes = (room: number): number => Math.max(0, Math.floor((room - CONVERSATION_MIN - GUTTER) / (PANE_MIN + GUTTER)));

export const singlePane = (narrow: boolean, room: number): boolean => narrow || maxPanes(room) === 0;

export const keepHidden = (next: PaneLayout, all: PaneLayout, shown: PaneLayout): PaneLayout => [...next, ...all.slice(shown.length)];

export function paneRange(layout: PaneLayout, index: number, room: number): { min: number; max: number } {
  const pane = layout[index];
  if (!pane) return { min: PANE_MIN, max: PANE_MIN };
  if (index === 0) return { min: PANE_MIN, max: room - CONVERSATION_MIN - (panesWidth(layout) - pane.width) };
  return { min: PANE_MIN, max: pane.width + layout[index - 1]!.width - PANE_MIN };
}

export const showSplit = (views: readonly string[], layout: PaneLayout, room: number): boolean =>
  views.length >= 2 && maxPanes(room) > layout.length;

export function fitLayout(layout: PaneLayout, room: number): PaneLayout {
  const kept = layout.slice(0, maxPanes(room)).map(p => ({ ...p, width: Math.max(PANE_MIN, p.width) }));
  let over = CONVERSATION_MIN + panesWidth(kept) - room;
  for (let i = kept.length - 1; i >= 0 && over > 0; i--) {
    const take = Math.min(over, kept[i]!.width - PANE_MIN);
    kept[i] = { ...kept[i]!, width: kept[i]!.width - take };
    over -= take;
  }
  return kept;
}

export function resizePane(layout: PaneLayout, index: number, dx: number, room: number): PaneLayout {
  const panes = layout.map(p => ({ ...p }));
  const pane = panes[index];
  if (!pane) return layout;
  if (index === 0) {
    const others = panesWidth(panes) - pane.width;
    pane.width = Math.min(Math.max(PANE_MIN, pane.width - dx), room - CONVERSATION_MIN - others);
    return panes;
  }
  const left = panes[index - 1]!;
  const step = Math.min(Math.max(dx, PANE_MIN - left.width), pane.width - PANE_MIN);
  left.width += step;
  pane.width -= step;
  return panes;
}

export function parseLayout(raw: string | null): PaneLayout {
  if (!raw) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.flatMap((p: unknown) => {
    const { view, width } = (p ?? {}) as { view?: unknown; width?: unknown };
    if (!PANES.some(d => d.view === view) || typeof width !== 'number' || !Number.isFinite(width)) return [];
    return [{ view: view as PaneView, width: Math.max(PANE_MIN, Math.round(width)) }];
  });
}
