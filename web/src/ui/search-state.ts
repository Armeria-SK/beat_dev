import type { HistoryHit } from '../api.ts';

export type SearchState = { kind: 'idle' } | { kind: 'loaded'; hits: readonly HistoryHit[] } | { kind: 'failed' };

export function searchView(state: SearchState): { hits: HistoryHit[]; note: 'none' | 'failed' | null } {
  if (state.kind === 'idle') return { hits: [], note: null };
  if (state.kind === 'failed') return { hits: [], note: 'failed' };
  const seen = new Set<string>();
  const hits = state.hits.filter(h => (seen.has(h.conversationId) ? false : (seen.add(h.conversationId), true)));
  return { hits, note: hits.length === 0 ? 'none' : null };
}
