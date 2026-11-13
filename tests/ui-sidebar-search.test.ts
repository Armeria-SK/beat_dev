import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('ui/Sidebar: 検索の失敗を failed にし、知らせは常にある role="status" の入れ物の中に出す', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'ui', 'Sidebar.tsx'), 'utf8');
  assert.match(source, /\.catch\(\s*\(\)\s*=>\s*\{[^}]*kind:\s*'failed'/u, '失敗を failed にする');
  assert.match(source, /searchView\(/u);
  assert.match(source, /<div[^>]*role="status"[^>]*>\s*\{view\.note === 'none'[\s\S]*?\{view\.note === 'failed'[\s\S]*?ui\.kanban\.loadFailed[\s\S]*?<\/div>/u, '入れ物は中身より前からある');
});
