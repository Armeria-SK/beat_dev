export const menuLeft = (to: unknown, inside: boolean, opener: unknown): boolean => to !== null && to !== undefined && !inside && to !== opener;

export function menuStep(current: number, count: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

export function menuScrollFor(item: { top: number; height: number }, scrollTop: number, viewHeight: number): number {
  if (item.top < scrollTop) return item.top;
  if (item.top + item.height > scrollTop + viewHeight) return item.top + item.height - viewHeight;
  return scrollTop;
}

export interface Box { top: number; bottom: number; left: number; right: number }
export interface MenuFit { up: boolean; left: boolean; maxHeight: number; maxWidth: number }

export function menuFit(anchor: Box, bounds: Box, size: { width: number; height: number }, gap: number): MenuFit {
  const below = Math.max(0, bounds.bottom - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - bounds.top - gap);
  const up = size.height > below && above > below;
  const towardLeft = anchor.right - bounds.left;
  const towardRight = bounds.right - anchor.left;
  const left = size.width > towardLeft && towardRight > towardLeft;
  return { up, left, maxHeight: Math.floor(up ? above : below), maxWidth: Math.floor(Math.max(0, left ? towardRight : towardLeft)) };
}
