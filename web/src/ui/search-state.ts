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

export interface HeldSearch { query: string; state: SearchState }
export const IDLE_SEARCH: HeldSearch = { query: '', state: { kind: 'idle' } };

// 届いた結果は、それを頼んだ入力といっしょに持つ。入力が替わったあとの結果は、次の結果が来るまで出さない（古い入力の当たりを Enter で開かない）
export const freshSearch = (held: HeldSearch, query: string): SearchState => (held.query === query.trim() ? held.state : { kind: 'idle' });

// 会話は、いま画面にある一覧の題で先に探し（大文字小文字を問わない）、履歴の検索の結果（発言の中身）を続ける。同じ会話は 1 行
export function searchRows(input: { query: string; tab: SearchTab; state: SearchState; conversations: readonly Conversation[]; projects: readonly Project[] }): SearchRow[] {
  const { query, tab, state, conversations, projects } = input;
  const q = query.trim().toLowerCase();
  const nameOf = (id: string | null | undefined): string | null => projects.find(p => p.id === id)?.name ?? null;
  const products: SearchRow[] = projects.filter(p => !q || p.name.toLowerCase().includes(q)).map(p => ({ kind: 'product', id: p.id, title: p.name, snippet: '', productName: null }));
  const newest = [...conversations].sort((a, b) => b.last_message_at - a.last_message_at);
  const row = (c: Conversation): SearchRow => ({ kind: 'conversation', id: c.id, title: c.title, snippet: '', productName: nameOf(c.project_id) });
  let sessions: SearchRow[];
  if (q) {
    const titled = newest.filter(c => (c.title ?? '').toLowerCase().includes(q)).map(row);
    const seen = new Set(titled.map(r => r.id));
    const found: SearchRow[] = searchView(state).hits.filter(h => !seen.has(h.conversationId))
      .map(h => ({ kind: 'conversation', id: h.conversationId, title: h.title, snippet: h.snippet, productName: nameOf(h.projectId) }));
    sessions = [...titled, ...found];
  } else sessions = newest.slice(0, RECENT_LIMIT).map(row);
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

// ← → は、入力欄が空か、選んだ範囲が無くてカーソルがその端（← は先頭、→ は末尾）のときだけ種類を替える。ほかは、誤字を直すカーソルの移動に使う
export function switchesTab(key: 'ArrowLeft' | 'ArrowRight', caret: { value: string; selectionStart: number | null; selectionEnd: number | null } | null): boolean {
  if (!caret || caret.value === '') return true;
  const { selectionStart: from, selectionEnd: to } = caret;
  if (from === null || to === null || from !== to) return false;
  return key === 'ArrowLeft' ? from === 0 : from === caret.value.length;
}
