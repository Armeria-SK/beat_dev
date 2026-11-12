import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conversation, Project } from '../web/src/api.ts';
import {
  ALL_PRODUCTS, NO_PRODUCT, filterOptions, filterQuery, groupConversations, latestConversation, matchesFilter, mergeConversations, moreCount,
  noProductApi, overviewOrder, productKey, productOf, sidebarOrder, throttled, waitingTotal,
} from '../web/src/ui/products.ts';

// 製品の画面を持たない関数（web/src/ui/products.ts）。p2-product.md の 2-2z。

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id.toUpperCase(), root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});
const conv = (id: string, at: number, projectId?: string | null): Conversation => ({
  id, title: id, created_at: 0, last_message_at: at, ...(projectId === undefined ? {} : { project_id: projectId }),
});
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map(r => r.id);

test('ui/products: 会話を project_id で製品ごとに分ける（欄が無い・null は製品なし。順番は受け取ったまま）', () => {
  const projects = [project('p1aaaa'), project('p2aaaa')];
  const groups = groupConversations([conv('a', 5, 'p1aaaa'), conv('b', 4), conv('c', 3, null), conv('d', 2, 'p1aaaa'), conv('e', 1, 'gone01')], projects);
  assert.deepEqual(ids(groups.none), ['b', 'c']);
  assert.deepEqual(ids(groups.byProduct.get('p1aaaa')!), ['a', 'd']);
  assert.deepEqual(groups.byProduct.get('p2aaaa'), [], '会話の無い製品も空の一覧を持つ');
  assert.deepEqual(ids(groups.byProduct.get('gone01')!), ['e'], '一覧に無い製品の会話を、製品なしに混ぜない');

  const old = groupConversations([conv('a', 2), conv('b', 1)], []);
  assert.deepEqual(ids(old.none), ['a', 'b'], '製品の欄を返さないサーバーでは、全部が製品なし');
  assert.equal(old.byProduct.size, 0);
});

test('ui/products: サイドバーは作った順（しまった製品は出さない）、AllProducts は待ちの多い順 → 最後に動いた順', () => {
  const projects = [
    project('p3aaaa', { created_at: 30, last_activity_at: 500 }),
    project('p1aaaa', { created_at: 10, waiting: { proposals: 1, questions: 0, pending: 1 } }),
    project('p2aaaa', { created_at: 20, last_activity_at: 900 }),
    project('p4aaaa', { created_at: 40, waiting: { proposals: 0, questions: 3, pending: 0 }, last_activity_at: 1 }),
    project('p0aaaa', { created_at: 5, archived_at: 99, waiting: { proposals: 9, questions: 9, pending: 9 } }),
    project('p5aaaa', { created_at: 50 }),
  ];
  const before = ids(projects);
  assert.deepEqual(ids(sidebarOrder(projects)), ['p1aaaa', 'p2aaaa', 'p3aaaa', 'p4aaaa', 'p5aaaa']);
  assert.deepEqual(ids(overviewOrder(projects)), ['p4aaaa', 'p1aaaa', 'p2aaaa', 'p3aaaa', 'p5aaaa']);
  assert.deepEqual(ids(projects), before, '渡した配列は並べ替えない');
  assert.equal(waitingTotal(projects[1]!), 2);
  assert.equal(productOf(projects, 'p2aaaa')?.id, 'p2aaaa');
  assert.equal(productOf(projects, 'nope00'), undefined);
  assert.equal(productOf(projects, null), undefined);
});

test('ui/products: いちばん新しい会話（製品ごと・製品なし）', () => {
  const list = [conv('a', 5, 'p1aaaa'), conv('b', 9), conv('c', 7, 'p1aaaa'), conv('d', 2, null)];
  assert.equal(latestConversation(list, 'p1aaaa')?.id, 'c');
  assert.equal(latestConversation(list, null)?.id, 'b');
  assert.equal(latestConversation(list, 'p2aaaa'), undefined);
});

test('ui/products: more の読み方（鍵は製品の ID か "none"。無い・0・数でない値は 0）と、読み足した会話の合わせ方', () => {
  const more = { p1aaaa: 12, none: 3, p2aaaa: 0, bad: 'x' as unknown as number };
  assert.equal(productKey(null), NO_PRODUCT);
  assert.equal(productKey(undefined), NO_PRODUCT);
  assert.equal(productKey('p1aaaa'), 'p1aaaa');
  assert.equal(moreCount(more, 'p1aaaa'), 12);
  assert.equal(moreCount(more, null), 3);
  assert.equal(moreCount(more, 'p2aaaa'), 0);
  assert.equal(moreCount(more, 'bad'), 0);
  assert.equal(moreCount(more, 'toString'), 0);
  assert.equal(moreCount(undefined, 'p1aaaa'), 0);
  assert.equal(moreCount({}, null), 0);

  const merged = mergeConversations([conv('a', 9), conv('b', 5)], [conv('b', 5), conv('c', 7), conv('d', 1)]);
  assert.deepEqual(ids(merged), ['a', 'c', 'b', 'd'], '同じ会話は 1 つ、新しい順');
});

test('ui/products: 絞り込みの選択肢（All・製品ごと〔作った順・待ちの数〕・No product）と当てはめ', () => {
  const projects = [project('p2aaaa', { created_at: 2, waiting: { proposals: 1, questions: 1, pending: 0 } }), project('p1aaaa', { created_at: 1 }), project('p9aaaa', { archived_at: 5 })];
  assert.deepEqual(filterOptions(projects), [
    { key: ALL_PRODUCTS, name: null, waiting: 0 },
    { key: 'p1aaaa', name: 'P1AAAA', waiting: 0 },
    { key: 'p2aaaa', name: 'P2AAAA', waiting: 2 },
    { key: NO_PRODUCT, name: null, waiting: 0 },
  ]);
  assert.deepEqual(filterOptions([]).map(o => o.key), [ALL_PRODUCTS, NO_PRODUCT]);
  assert.equal(matchesFilter('p1aaaa', ALL_PRODUCTS), true);
  assert.equal(matchesFilter(undefined, ALL_PRODUCTS), true);
  assert.equal(matchesFilter('p1aaaa', 'p1aaaa'), true);
  assert.equal(matchesFilter('p2aaaa', 'p1aaaa'), false);
  assert.equal(matchesFilter(null, 'p1aaaa'), false);
  assert.equal(matchesFilter(null, NO_PRODUCT), true);
  assert.equal(matchesFilter(undefined, NO_PRODUCT), true);
  assert.equal(matchesFilter('p1aaaa', NO_PRODUCT), false);
  assert.equal(filterQuery(ALL_PRODUCTS), undefined);
  assert.equal(filterQuery(NO_PRODUCT), 'none');
  assert.equal(filterQuery('p1aaaa'), 'p1aaaa');
});

test('ui/products: 製品の口が無いサーバー（404）だけを「製品なし」と読む', () => {
  assert.equal(noProductApi({ status: 404 }), true);
  assert.equal(noProductApi(Object.assign(new Error('x'), { status: 404 })), true);
  for (const other of [{ status: 500 }, { status: 401 }, new TypeError('Failed to fetch'), null, undefined, 'x']) assert.equal(noProductApi(other), false);
});

test('ui/products: 間引き（最初はすぐ、待ちのあいだに来た分は 1 回にまとめる）', () => {
  let runs = 0;
  const timers: Array<() => void> = [];
  const call = throttled(() => { runs += 1; }, 2000, (fn, ms) => { assert.equal(ms, 2000); timers.push(fn); });
  call();
  assert.equal(runs, 1);
  call(); call(); call();
  assert.equal(runs, 1);
  timers.shift()!();
  assert.equal(runs, 2, '待ちのあいだの 3 回が 1 回になる');
  timers.shift()!();
  assert.equal(runs, 2, 'そのあと何も来なければ動かない');
  assert.equal(timers.length, 0);
  call();
  assert.equal(runs, 3);
});
