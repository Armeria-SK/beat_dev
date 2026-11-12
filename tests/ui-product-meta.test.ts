import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../web/src/api.ts';
import { inFilter, newTaskProduct, optionLabel, productLine, productName, settleFilter, withProduct } from '../web/src/ui/product-meta.ts';
import { ALL_PRODUCTS, NO_PRODUCT, filterOptions } from '../web/src/ui/products.ts';

// 絞り込みと製品の名前の、画面を持たない関数（web/src/ui/product-meta.ts）。p2-product.md の 2-2c。

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id, name: id.toUpperCase(), root: `C:\\work\\${id}`, check_command: null, scout_mode: 'off', remotes: [], archived_at: null, created_at: 0, updated_at: 0,
  is_git: false, folder_missing: false, waiting: { proposals: 0, questions: 0, pending: 0 }, running: 0, last_activity_at: null, ...over,
});

test('ui/product-meta: 選んだ製品が一覧から消えたら（しまった・知らない）All に戻す。All と No product はそのまま', () => {
  const projects = [project('p1aaaa'), project('p2aaaa', { archived_at: 5 })];
  assert.equal(settleFilter('p1aaaa', projects), 'p1aaaa');
  assert.equal(settleFilter('p2aaaa', projects), ALL_PRODUCTS);
  assert.equal(settleFilter('gone01', projects), ALL_PRODUCTS);
  assert.equal(settleFilter(NO_PRODUCT, []), NO_PRODUCT);
  assert.equal(settleFilter(ALL_PRODUCTS, []), ALL_PRODUCTS);
});

test('ui/product-meta: 絞り込みは行を隠すだけで並びを変えない。No product は製品なし（欄が無い行も）だけ', () => {
  const rows = [{ id: 'a', project_id: 'p1aaaa' }, { id: 'b' }, { id: 'c', project_id: null }, { id: 'd', project_id: 'p2aaaa' }, { id: 'e', project_id: 'p1aaaa' }];
  assert.deepEqual(inFilter(rows, ALL_PRODUCTS).map(r => r.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(inFilter(rows, 'p1aaaa').map(r => r.id), ['a', 'e']);
  assert.deepEqual(inFilter(rows, NO_PRODUCT).map(r => r.id), ['b', 'c']);
});

test('ui/product-meta: 絞り込みの札は、待ちが 1 以上なら中黒のあとに数。All と No product は渡した言葉', () => {
  const labels = filterOptions([project('p1aaaa', { waiting: { proposals: 1, questions: 2, pending: 0 } }), project('p2aaaa')]).map(o => optionLabel(o, 'All', 'No product'));
  assert.deepEqual(labels, ['All', 'P1AAAA · 3', 'P2AAAA', 'No product']);
});

test('ui/product-meta: New task の製品は今の絞り込み（All と No product は製品なし）。製品なしは projectId を送らない', () => {
  assert.equal(newTaskProduct('p1aaaa'), 'p1aaaa');
  assert.equal(newTaskProduct(ALL_PRODUCTS), null);
  assert.equal(newTaskProduct(NO_PRODUCT), null);
  assert.deepEqual(withProduct({ title: 'x' }, 'p1aaaa'), { title: 'x', projectId: 'p1aaaa' });
  assert.deepEqual(withProduct({ title: 'x' }, null), { title: 'x' });
});

test('ui/product-meta: 製品の名前と、しまった製品の見分け（製品なしは null）', () => {
  const active = [project('p1aaaa')];
  const archived = [project('p2aaaa', { archived_at: 5 })];
  assert.equal(productName(active, 'p1aaaa'), 'P1AAAA');
  assert.equal(productName(active, null), null);
  assert.equal(productName(active, 'p2aaaa'), null);
  assert.equal(productLine(null, active, archived), null);
  assert.equal(productLine(undefined, active, archived), null);
  assert.deepEqual(productLine('p1aaaa', active, archived), { name: 'P1AAAA', archived: false });
  assert.deepEqual(productLine('p2aaaa', active, archived), { name: 'P2AAAA', archived: true });
  assert.deepEqual(productLine('gone01', active, []), { name: null, archived: true }, '一覧に無い製品を、製品なしと言わない');
});
