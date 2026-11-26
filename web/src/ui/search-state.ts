import type { Conversation, HistoryHit, Project } from '../api.ts';

export type SearchState = { kind: 'idle' } | { kind: 'loaded'; hits: readonly HistoryHit[] } | { kind: 'failed' };

export function searchView(state: SearchState): { hits: HistoryHit[]; note: 'none' | 'failed' | null } {
  if (state.kind === 'idle') return { hits: [], note: null };
  if (state.kind === 'failed') return { hits: [], note: 'failed' };
  const seen = new Set<string>();
  const hits = state.hits.filter(h => (seen.has(h.conversationId) ? false : (seen.add(h.conversationId), true)));
  return { hits, note: hits.length === 0 ? 'none' : null };
}

export type SearchTab = 'all' | 'conversations' | 'products';
export const SEARCH_TABS: readonly SearchTab[] = ['all', 'conversations', 'products'];

export interface SearchRow { kind: 'conversation' | 'product'; id: string; title: string | null; snippet: string; productName: string | null }

export const RECENT_LIMIT = 10;

export function searchRows(input: { query: string; tab: SearchTab; state: SearchState; conversations: readonly Conversation[]; projects: readonly Project[] }): SearchRow[] {
  const { query, tab, state, conversations, projects } = input;
  const q = query.trim().toLowerCase();
  const nameOf = (id: string | null | undefined): string | null => projects.find(p => p.id === id)?.name ?? null;
  const products: SearchRow[] = projects.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => ({ kind: 'product', id: p.id, title: p.name, snippet: '', productName: null }));
  const sessions: SearchRow[] = q
    ? searchView(state).hits.map(h => ({ kind: 'conversation', id: h.conversationId, title: h.title, snippet: h.snippet, productName: nameOf(h.projectId) }))
    : [...conversations].sort((a, b) => b.last_message_at - a.last_message_at).slice(0, RECENT_LIMIT).map(c => ({ kind: 'conversation', id: c.id, title: c.title, snippet: '', productName: nameOf(c.project_id) }));
  if (tab === 'products') return products;
  if (tab === 'conversations') return sessions;
  return q ? [...products, ...sessions] : sessions;
}

export function searchNote(input: { query: string; tab: SearchTab; state: SearchState; rows: number }): 'none' | 'failed' | null {
  const { query, tab, state, rows } = input;
  if (!query.trim()) return null;
  if (tab !== 'products' && state.kind === 'failed') return 'failed';
  return rows === 0 && (tab === 'products' || state.kind === 'loaded') ? 'none' : null;
}

export const stepIndex = (count: number, at: number, by: 1 | -1): number => (count <= 0 ? 0 : (at + by + count) % count);

export const stepTab = (tab: SearchTab, by: 1 | -1): SearchTab => SEARCH_TABS[stepIndex(SEARCH_TABS.length, SEARCH_TABS.indexOf(tab), by)]!;
