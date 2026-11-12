export interface FocusCandidate { isConnected: boolean; getClientRects(): { length: number } }

export function pickFocus<T extends FocusCandidate>(
  candidates: ReadonlyArray<T | null | undefined>, body: unknown, hidden: (el: T) => boolean,
): T | null {
  for (const el of candidates) {
    if (!el || el === body || !el.isConnected || el.getClientRects().length === 0 || hidden(el)) continue;
    return el;
  }
  return null;
}
