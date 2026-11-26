import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, HistoryHit, Project } from '../web/src/api.ts';
import { freshSearch, IDLE_SEARCH, RECENT_LIMIT, SEARCH_TABS, searchNote, searchRows, searchView, stepIndex, stepTab, switchesTab, type SearchState } from '../web/src/ui/search-state.ts';

const hit = (conversationId: string, messageId: number): HistoryHit => ({ conversationId, title: conversationId, messageId, role: 'user', createdAt: 0, snippet: '' });

test('ui/search-state: 検索の失敗は「0 件」と分けて failed にする。届いた結果は会話ごとに 1 行、0 件なら none（backlog 242）', () => {
  assert.deepEqual(searchView({ kind: 'idle' }), { hits: [], note: null });
  assert.deepEqual(searchView({ kind: 'failed' }), { hits: [], note: 'failed' });
  assert.deepEqual(searchView({ kind: 'loaded', hits: [] }), { hits: [], note: 'none' });
  assert.deepEqual(searchView({ kind: 'loaded', hits: [hit('a', 1), hit('a', 2), hit('b', 3)] }), { hits: [hit('a', 1), hit('b', 3)], note: null });
});

const project = (id: string, name: string): Project => ({
  id, name, root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 1, updated_at: 1,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null,
});
const chat = (id: string, title: string | null, at: number, projectId: string | null): Conversation => ({ id, title, created_at: 0, last_message_at: at, project_id: projectId });
const SHOP = project('p1', 'Shop');
const BLOG = project('p2', 'Blog');
const CHATS = [chat('a', 'Old', 1, null), chat('b', 'Cart', 3, 'p1'), chat('c', null, 2, 'p2')];
const none: SearchState = { kind: 'idle' };
const ids = (rows: Array<{ kind: string; id: string }>) => rows.map(r => `${r.kind}:${r.id}`);

test('ui/search-state: 何も打たないとき、All と Sessions は最近の会話（新しい順・上限あり）、Products は製品の全部。製品の名前は会話の行に付く', () => {
  const all = searchRows({ query: '  ', tab: 'all', state: none, conversations: CHATS, projects: [SHOP, BLOG] });
  assert.deepEqual(ids(all), ['conversation:b', 'conversation:c', 'conversation:a']);
  assert.deepEqual(all.map(r => r.productName), ['Shop', 'Blog', null]);
  assert.deepEqual(searchRows({ query: '', tab: 'conversations', state: none, conversations: CHATS, projects: [SHOP, BLOG] }), all);
  assert.deepEqual(ids(searchRows({ query: '', tab: 'products', state: none, conversations: CHATS, projects: [SHOP, BLOG] })), ['product:p1', 'product:p2']);
  const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) => chat(`m${i}`, `T${i}`, i, null));
  const recent = searchRows({ query: '', tab: 'all', state: none, conversations: many, projects: [] });
  assert.equal(recent.length, RECENT_LIMIT);
  assert.equal(recent[0]!.id, `m${RECENT_LIMIT + 4}`, '一番新しいものから');
});

test('ui/search-state: 打ったとき、製品は名前（大文字小文字を問わない）で絞り、会話は履歴の検索の結果（会話ごとに 1 行）。All は製品が先、種類を選べばその種類だけ', () => {
  const loaded: SearchState = { kind: 'loaded', hits: [hit('b', 1), hit('b', 2), hit('a', 3)] };
  const input = { query: ' sHo ', state: loaded, conversations: CHATS, projects: [SHOP, BLOG] };
  assert.deepEqual(ids(searchRows({ ...input, tab: 'all' })), ['product:p1', 'conversation:b', 'conversation:a']);
  assert.deepEqual(ids(searchRows({ ...input, tab: 'products' })), ['product:p1']);
  assert.deepEqual(ids(searchRows({ ...input, tab: 'conversations' })), ['conversation:b', 'conversation:a']);
  assert.deepEqual(searchRows({ ...input, tab: 'conversations' }).map(r => r.productName), [null, null], '前提: hit に projectId が無いと製品の名前は無い');
  const tagged: SearchState = { kind: 'loaded', hits: [{ ...hit('b', 1), projectId: 'p1', snippet: 'the cart' }] };
  assert.deepEqual(searchRows({ ...input, state: tagged, tab: 'conversations' }), [{ kind: 'conversation', id: 'b', title: 'b', snippet: 'the cart', productName: 'Shop' }]);
  assert.deepEqual(ids(searchRows({ ...input, state: none, tab: 'all' })), ['product:p1'], '履歴の結果がまだ無い間は製品だけ');
});

test('ui/search-state: 知らせ。失敗は会話の種類（All / Sessions）にだけ、行があっても出す。「当てはまるものはない」は行が 0 のとき。Products は履歴に頼らない', () => {
  const failed: SearchState = { kind: 'failed' };
  const loaded: SearchState = { kind: 'loaded', hits: [] };
  assert.equal(searchNote({ query: '', tab: 'all', state: failed, rows: 0 }), null, '何も打っていなければ何も出さない');
  assert.equal(searchNote({ query: 'x', tab: 'all', state: failed, rows: 2 }), 'failed');
  assert.equal(searchNote({ query: 'x', tab: 'conversations', state: failed, rows: 0 }), 'failed');
  assert.equal(searchNote({ query: 'x', tab: 'products', state: failed, rows: 0 }), 'none');
  assert.equal(searchNote({ query: 'x', tab: 'all', state: loaded, rows: 0 }), 'none');
  assert.equal(searchNote({ query: 'x', tab: 'all', state: loaded, rows: 1 }), null);
  assert.equal(searchNote({ query: 'x', tab: 'all', state: none, rows: 0 }), null, '結果を待っている間は「ない」と言わない');
});

test('ui/search-state: 種類のタブと選ぶ行の動き。端は回る。0 件のときは動かない', () => {
  assert.deepEqual(SEARCH_TABS, ['all', 'conversations', 'products']);
  assert.deepEqual(SEARCH_TABS.map(tab => stepTab(tab, 1)), ['conversations', 'products', 'all']);
  assert.deepEqual(SEARCH_TABS.map(tab => stepTab(tab, -1)), ['products', 'all', 'conversations']);
  assert.equal(stepIndex(3, 2, 1), 0);
  assert.equal(stepIndex(3, 0, -1), 2);
  assert.equal(stepIndex(3, 1, 1), 2);
  assert.equal(stepIndex(0, 0, 1), 0);
  assert.equal(stepIndex(1, 0, -1), 0);
});

test('ui/search-state: 会話は、いま画面にある一覧の題でも探す（大文字小文字を問わない・新しい順）。履歴の結果が来る前から出て、同じ会話は 1 行（題の当たりが先）', () => {
  const chats = [chat('a', 'Fix the CART bug', 1, null), chat('b', 'Cart total', 3, 'p1'), chat('c', 'Other', 2, 'p2'), chat('d', null, 4, null)];
  const query = { query: ' cArT ', conversations: chats, projects: [SHOP, BLOG] };
  assert.deepEqual(ids(searchRows({ ...query, tab: 'conversations', state: none })), ['conversation:b', 'conversation:a'], '履歴の結果が来る前でも、題の当たりが新しい順に出る');
  assert.deepEqual(searchRows({ ...query, tab: 'conversations', state: none }).map(r => r.productName), ['Shop', null]);
  assert.deepEqual(ids(searchRows({ ...query, tab: 'conversations', state: { kind: 'failed' } })), ['conversation:b', 'conversation:a'], '履歴の検索が失敗しても、題の当たりは残る');
  const loaded: SearchState = { kind: 'loaded', hits: [{ ...hit('c', 1), snippet: 'a cart in the text' }, hit('b', 2)] };
  const rows = searchRows({ ...query, tab: 'conversations', state: loaded });
  assert.deepEqual(ids(rows), ['conversation:b', 'conversation:a', 'conversation:c'], '題の当たり → 発言の当たり。b は両方に当たっても 1 行');
  assert.equal(rows[0]!.snippet, '', '題の当たりの行に、発言の抜粋は付けない');
  assert.equal(rows[2]!.snippet, 'a cart in the text');
  assert.deepEqual(ids(searchRows({ ...query, tab: 'all', state: none })), ['conversation:b', 'conversation:a'], 'All でも同じ（製品の当たりが無ければ会話だけ）');
  assert.deepEqual(searchRows({ ...query, query: 'zzz', tab: 'conversations', state: none }), []);
});

test('ui/search-state: 届いた結果は、頼んだ入力といっしょに持つ。入力が替わったあとは、次の結果が来るまで idle（古い入力の当たりを出さない）', () => {
  const loaded: SearchState = { kind: 'loaded', hits: [hit('a', 1)] };
  assert.deepEqual(IDLE_SEARCH, { query: '', state: { kind: 'idle' } });
  assert.equal(freshSearch({ query: 'sho', state: loaded }, 'sho'), loaded);
  assert.equal(freshSearch({ query: 'sho', state: loaded }, '  sho '), loaded, '前後の空白は同じ入力');
  assert.deepEqual(freshSearch({ query: 'sho', state: loaded }, 'shop'), { kind: 'idle' });
  assert.deepEqual(freshSearch({ query: 'sho', state: loaded }, ''), { kind: 'idle' });
  assert.deepEqual(freshSearch({ query: 'sho', state: { kind: 'failed' } }, 'sh'), { kind: 'idle' }, '失敗の知らせも、替わった入力には持ち越さない');
});

test('ui/search-state: ← → は、欄が空か、選んだ範囲が無くてカーソルがその端のときだけタブを替える。それ以外はカーソルの移動に任せる', () => {
  const at = (value: string, from: number | null, to: number | null = from) => ({ value, selectionStart: from, selectionEnd: to });
  assert.equal(switchesTab('ArrowLeft', at('', 0)), true, '空なら ←');
  assert.equal(switchesTab('ArrowRight', at('', 0)), true, '空なら →');
  assert.equal(switchesTab('ArrowRight', null), true, '欄の外（× の上）では常にタブ');
  assert.equal(switchesTab('ArrowLeft', at('shop', 0)), true, '先頭の ← はタブ');
  assert.equal(switchesTab('ArrowLeft', at('shop', 2)), false, '途中の ← はカーソル');
  assert.equal(switchesTab('ArrowLeft', at('shop', 4)), false, '末尾の ← はカーソル（タブではない）');
  assert.equal(switchesTab('ArrowRight', at('shop', 4)), true, '末尾の → はタブ');
  assert.equal(switchesTab('ArrowRight', at('shop', 0)), false, '先頭の → はカーソル');
  assert.equal(switchesTab('ArrowRight', at('shop', 2)), false);
  assert.equal(switchesTab('ArrowLeft', at('shop', 0, 4)), false, '全部選んでいるとき（再び開いた直後）は、端でもカーソルの移動');
  assert.equal(switchesTab('ArrowRight', at('shop', 0, 4)), false);
  assert.equal(switchesTab('ArrowLeft', at('shop', null, null)), false);
});
