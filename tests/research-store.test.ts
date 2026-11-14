import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { ResearchError } from '../src/research/labels.ts';
import { ResearchStore } from '../src/research/store.ts';

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (error) { if (error instanceof ResearchError) return error.code; throw error; }
  return 'ok';
};

function setup(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  let now = 1000;
  const store = new ResearchStore(db, { now: () => now++ });
  return { db, store };
}

const similar = (n: number) => ({ kind: 'similar' as const, name: `Product ${n}`, url: `https://example.com/p${n}`, evidence: {} });

test('記録の store: 終わった記録（done / failed / cancelled / skipped）の書き換えは断られ、行の数も中身も変わらない', t => {
  const { store } = setup(t);
  for (const end of ['done', 'failed', 'cancelled', 'skipped'] as const) {
    const run = store.start({ projectId: 'p1', runId: `r-${end}`, phase: 'products', mode: 'batch' });
    store.addSource(run.id, similar(1));
    store.finish(run.id, end);
    const before = store.items(run.id);
    assert.equal(codeOf(() => store.addSource(run.id, similar(2))), 'finished', end);
    assert.equal(codeOf(() => store.addFeature(run.id, { label: 'Live preview', evidence: [] })), 'finished', end);
    assert.equal(codeOf(() => store.finish(run.id, 'done')), 'finished', end);
    assert.equal(codeOf(() => store.attachRun(run.id, 'r-other')), 'finished', end);
    assert.deepEqual(store.items(run.id), before);
    const row = store.get(run.id)!;
    assert.equal(row.status, end);
    assert.ok(row.finished_at !== null);
    assert.equal(store.runningFor(`r-${end}`), undefined);
  }
  const libs = store.start({ projectId: 'p1', phase: 'libraries', mode: 'batch' });
  store.finish(libs.id, 'done');
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Language', options: ['Go', 'Rust'] })), 'finished');
  assert.equal(codeOf(() => store.addSource('nope', similar(1))), 'not_found');
});

test('記録の store: 上限（似ているもの 8・機能 40・やり方の問い 6）と、段（phase）に合わない種類を断る。同じ名前の機能は上限でもまとまる', t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'batch' });
  for (let n = 1; n <= 8; n++) store.addSource(run.id, similar(n));
  assert.equal(codeOf(() => store.addSource(run.id, similar(9))), 'too_many');
  for (let n = 1; n <= 40; n++) store.addFeature(run.id, { label: `Feature ${n}`, evidence: [] });
  assert.equal(codeOf(() => store.addFeature(run.id, { label: 'Feature 41', evidence: [] })), 'too_many');
  assert.equal(store.addFeature(run.id, { label: 'FEATURE  1', evidence: [] }).merged, true);
  assert.equal(codeOf(() => store.addChoice(run.id, { label: 'Language', options: ['Go', 'Rust'] })), 'kind_phase');
  assert.equal(codeOf(() => store.addSource(run.id, { ...similar(1), kind: 'library' })), 'kind_phase');

  const libs = store.start({ projectId: 'p1', phase: 'libraries', mode: 'batch' });
  for (let n = 1; n <= 6; n++) store.addChoice(libs.id, { label: `Question ${n}`, options: ['A', 'B'], recommended: 1 });
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Question 7', options: ['A', 'B'] })), 'too_many');
  assert.equal(codeOf(() => store.addSource(libs.id, similar(1))), 'kind_phase');
});

test('記録の store: やり方の問いは選択肢 2〜4 で、問いも選択肢も名前の形を通る。おすすめは範囲の外なら空', t => {
  const { store } = setup(t);
  const libs = store.start({ projectId: 'p1', phase: 'libraries', mode: 'batch' });
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Language', options: ['Go'] })), 'options_count');
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Language', options: ['A', 'B', 'C', 'D', 'E'] })), 'options_count');
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Language', options: ['Go', 'run $(x)'] })), 'label_shell');
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'see www.x', options: ['Go', 'Rust'] })), 'label_url');
  const row = store.addChoice(libs.id, { label: ' Language ', options: ['Go', 'Rust'], recommended: 5 });
  assert.deepEqual([row.name_or_label, JSON.parse(row.options!), row.recommended], ['Language', ['Go', 'Rust'], null]);
  assert.equal(store.items(libs.id).length, 1);
});

test('記録の store: 再起動のときの片付けで running の記録が failed になり、終わった記録は変わらない', t => {
  const { store } = setup(t);
  const a = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'batch' });
  const b = store.start({ projectId: 'p1', runId: 'r2', phase: 'products', mode: 'one_by_one' });
  store.finish(b.id, 'done');
  assert.equal(store.failRunning(), 1);
  assert.deepEqual([store.get(a.id)!.status, store.get(b.id)!.status], ['failed', 'done']);
});

test('記録の store: 1 件ずつの続きの実行は attachRun で実行を替え、runningFor は今の実行だけを返す', t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'one_by_one' });
  store.attachRun(run.id, 'r2');
  assert.equal(store.runningFor('r1'), undefined);
  assert.equal(store.runningFor('r2')!.id, run.id);
});

test('記録の store: 機能の根拠は、その似ているものの行の URL の抜き書きだけを数える（別の URL の抜き書きを付けても、定番にも「持っている」にもならない）', t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'batch' });
  const a = store.addSource(run.id, similar(1));
  const b = store.addSource(run.id, similar(2));
  const { row } = store.addFeature(run.id, { label: 'Live preview', evidence: [
    { similar: a.id, url: 'https://example.com/p1', quote: 'Live preview' },
    { similar: b.id, url: 'https://example.com/p1', quote: 'Live preview' },
    { similar: 99, url: 'https://example.com/p2', quote: 'Live preview' },
  ] });
  assert.deepEqual([row.default_checked, JSON.parse(row.products)], [0, [a.id]]);
  const both = store.addFeature(run.id, { label: 'Live preview', evidence: [{ similar: b.id, url: 'https://EXAMPLE.com/p2/', quote: 'has live preview' }] });
  assert.deepEqual([both.row.default_checked, both.row.default_reason, JSON.parse(both.row.products)], [1, 'standard', [a.id, b.id]]);
});
