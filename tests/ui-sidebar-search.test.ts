import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HistoryHit } from '../web/src/api.ts';
import { searchView } from '../web/src/ui/search-state.ts';

const hit = (conversationId: string, messageId: number): HistoryHit => ({ conversationId, title: conversationId, messageId, role: 'user', createdAt: 0, snippet: '' });

test('ui/search-state: 検索の失敗は「0 件」と分けて failed にする。届いた結果は会話ごとに 1 行、0 件なら none（backlog 242）', () => {
  assert.deepEqual(searchView({ kind: 'idle' }), { hits: [], note: null });
  assert.deepEqual(searchView({ kind: 'failed' }), { hits: [], note: 'failed' });
  assert.deepEqual(searchView({ kind: 'loaded', hits: [] }), { hits: [], note: 'none' });
  assert.deepEqual(searchView({ kind: 'loaded', hits: [hit('a', 1), hit('a', 2), hit('b', 3)] }), { hits: [hit('a', 1), hit('b', 3)], note: null });
});
