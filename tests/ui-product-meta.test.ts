import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../web/src/api.ts';
import { followProduct, formOf, inFilter, needsShelved, newTaskProduct, optionLabel, productLine, productName, settleFilter, withProduct } from '../web/src/ui/product-meta.ts';
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

test('productLine: 動いている製品の一覧がまだ届いていないあいだは、しまった一覧に無い製品を「しまった製品」と決めない（backlog 502）', () => {
  const shelved = [project('p2aaaa', { archived_at: 5 })];
  assert.equal(productLine('p1aaaa', [], shelved, false), null, '動いている製品かもしれないので、札を出さない');
  assert.deepEqual(productLine('p2aaaa', [], shelved, false), { name: 'P2AAAA', archived: true }, 'しまった一覧にあるものは決められる');
  assert.deepEqual(productLine('p1aaaa', [], shelved, true), { name: null, archived: true }, '届いたあとは、どちらにも無ければこれまでどおり');
  assert.deepEqual(productLine('p1aaaa', [], shelved), { name: null, archived: true }, '渡さなければ届いているとみなす');
  assert.equal(needsShelved('p1aaaa', [], null), true);
});

test('productLine: 動いている一覧に入っていても、しまった印（archived_at）のある製品はしまった製品として出す', () => {
  const stale = [project('p1aaaa', { archived_at: 5 })];
  assert.deepEqual(productLine('p1aaaa', stale, stale), { name: 'P1AAAA', archived: true });
});

test('productLine: しまった製品の一覧がまだ届いていない（null）なら、動いている一覧に無い製品の札は出さない。動いている製品は出す（backlog 308）', () => {
  const active = [project('p1aaaa')];
  assert.equal(productLine('p2aaaa', active, null), null);
  assert.deepEqual(productLine('p1aaaa', active, null), { name: 'P1AAAA', archived: false });
  assert.equal(productLine(null, active, null), null);
  assert.deepEqual(productLine('p2aaaa', active, []), { name: null, archived: true }, '届いて空なら、名前なしのしまった製品');
});

test('needsShelved: しまった製品の一覧を読みに行くのは、製品つきで、動いている一覧に無く、まだ届いていないときだけ', () => {
  const active = [project('p1aaaa'), project('p3aaaa', { archived_at: 5 })];
  assert.equal(needsShelved('p2aaaa', active, null), true);
  assert.equal(needsShelved('p3aaaa', active, null), true, 'しまった印のある製品は動いている一覧にあっても読む');
  assert.equal(needsShelved('p1aaaa', active, null), false);
  assert.equal(needsShelved(null, active, null), false);
  assert.equal(needsShelved('p2aaaa', active, []), false, '届いていれば読まない');
});

test('ui/product-meta: 製品の設定の欄は、触っていなければ別の所での変更に追いつく（書きかけ扱いにしない）。触った欄はそのまま', () => {
  const was = project('p1aaaa', { name: 'Shop', check_command: 'npm test' });
  const renamed = project('p1aaaa', { name: 'Shop v2', check_command: 'npm run check' });
  assert.deepEqual(followProduct(formOf(was), was, renamed), formOf(renamed), '触っていない欄は新しい値になる（Save で相手の変更を戻さない）');

  const typing = { ...formOf(was), name: 'My shop' };
  const kept = followProduct(typing, was, renamed);
  assert.equal(kept.name, 'My shop', '書きかけの名前は消さない');
  assert.equal(kept.check, 'npm run check', '触っていない確かめのコマンドは追いつく');

  const pinned = project('p1aaaa', { name: 'Shop', check_command: 'npm test', doc_language: 'ja', doc_language_pinned: true });
  assert.deepEqual(followProduct(formOf(was), was, pinned).lang, { pick: 'ja', other: '' });
  assert.deepEqual(followProduct({ ...formOf(was), lang: { pick: 'fr', other: '' } }, was, pinned).lang, { pick: 'fr', other: '' }, '選びかけの言語はそのまま');
});
