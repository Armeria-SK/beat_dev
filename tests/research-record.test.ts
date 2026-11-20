import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { beginPages, endPages, normalizeUrl, OpenedPages, pageKey, pagesOf } from '../src/research/evidence.ts';
import { ResearchStore } from '../src/research/store.ts';
import { researchRecord } from '../src/tools/builtin/research.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { testConfig } from './helpers.ts';

const PAGE_A = 'Typora-like editor. Released under the MIT License. Last updated 2026-10-01. Written in TypeScript. Features: Live preview, Table editor, Export to PDF.';
const PAGE_B = 'Another notes app. Licensed GPL-3.0. Written in Rust. It has a live preview and a table editor.';

function setup(t: { after: (fn: () => void) => void }, runId = 'run-1') {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => { db.close(); endPages(runId); });
  const store = new ResearchStore(db);
  const research = store.start({ projectId: 'p1', conversationId: 'c-research', runId, phase: 'products', mode: 'batch' });
  const pages = beginPages(runId);
  return { db, store, research, pages };
}

function ctx(db: DatabaseSync, runId = 'run-1'): ToolContext {
  return {
    runId, conversationId: 'c-research', kind: 'task', signal: new AbortController().signal, config: testConfig(), paths: undefined as never,
    policy: undefined as never, workspace: '.', log: () => undefined, taint: { tainted: true, sources: ['web'] },
    services: { db, memory: undefined as never, emit: () => undefined },
  };
}

const record = (db: DatabaseSync, input: Record<string, unknown>, runId = 'run-1') => researchRecord.execute(input as never, ctx(db, runId));

test('URL の正規化: スキームとホストを小文字に、末尾の / と #… を外す。http(s) でないものは null', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Repo/'), 'https://example.com/Repo');
  assert.equal(normalizeUrl('https://example.com/a#readme'), 'https://example.com/a');
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(normalizeUrl('ftp://example.com/x'), null);
  assert.equal(normalizeUrl('javascript:alert(1)'), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('開けたページの表: 抜き書きは NFKC・大文字小文字・空白をそろえて当て、表に無いページ・空の抜き書きは当たらない', () => {
  const pages = new OpenedPages();
  pages.add('https://example.com/a', 'Released under the  MIT\nLicense.');
  assert.ok(pages.quoted('https://EXAMPLE.com/a/', 'released under the mit license'));
  assert.ok(pages.quoted('https://example.com/a', 'Released under the ＭＩＴ　License'));
  assert.ok(!pages.quoted('https://example.com/a', 'Released under the Apache License'));
  assert.ok(!pages.quoted('https://example.com/a', '   '));
  assert.ok(!pages.quoted('https://example.com/b', 'MIT License'));
  assert.ok(!pages.has('https://example.com/b'));
});

test('開けたページの表: 1 ページ 20,000 字まで（そのあとの文は当たらない）', () => {
  const pages = new OpenedPages();
  pages.add('https://example.com/long', `${'x'.repeat(20_000)}TAILWORD SENTENCE`);
  assert.ok(!pages.quoted('https://example.com/long', 'TAILWORD SENTENCE'));
  pages.add('https://example.com/short', `${'y'.repeat(100)}TAILWORD SENTENCE`);
  assert.ok(pages.quoted('https://example.com/short', 'tailword sentence'));
});

test('開けたページの表: 短すぎる抜き書き（3-1b と同じ重さの下限）は当たらない。「MIT」は commits の中、「Rust」は trust の中、「2」は 1,234 の中に当たらない', () => {
  const pages = new OpenedPages();
  pages.add('https://example.com/a', 'See all commits. We trust our users. Stars: 1,234.');
  for (const quote of ['MIT', 'Rust', '2', 'commits']) assert.ok(!pages.quoted('https://example.com/a', quote), quote);
  assert.ok(pages.quoted('https://example.com/a', 'We trust our users.'));
});

test('ページの同じさ（pageKey）: スキーム・クエリ・パスの大文字小文字・末尾の / を見ない', () => {
  const keys = ['https://example.com/Acme/Notes?a=1', 'http://EXAMPLE.com/acme/notes/?b=2', 'https://example.com/acme/notes#x'].map(pageKey);
  assert.deepEqual(new Set(keys), new Set(['example.com/acme/notes']));
  assert.notEqual(pageKey('https://example.com/acme/other'), keys[0]);
  assert.equal(pageKey('mailto:x'), null);
});

test('research_record: 開けていない URL の候補は断られ、何も書かれない', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://example.com/a', PAGE_A);
  const out = await record(db, { kind: 'similar', name: 'Typora', url: 'https://other.example.com/x', license: 'MIT License' });
  assert.equal(out.isError, true);
  assert.match(out.content, /has not opened/u);
  assert.equal(store.items(research.id).length, 0);
});

test('research_record: リダイレクトのあとの URL で開いたページは当たる。大文字のホスト・末尾の / も同じ', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://github.com/acme/notes', PAGE_A);
  const out = await record(db, { kind: 'similar', name: 'Acme Notes', url: 'HTTPS://GitHub.com/acme/notes/', license: 'Released under the MIT License.', updated: 'Last updated 2026-10-01.', language: 'Written in TypeScript.' });
  assert.equal(out.isError, undefined, out.content);
  const [row] = store.items(research.id);
  assert.equal(row!.url, 'https://github.com/acme/notes');
  assert.deepEqual([row!.license, row!.updated, row!.language], ['Released under the MIT License.', 'Last updated 2026-10-01.', 'Written in TypeScript.']);
  assert.deepEqual(JSON.parse(row!.evidence), { url: 'https://github.com/acme/notes', license: 'Released under the MIT License.', updated: 'Last updated 2026-10-01.', language: 'Written in TypeScript.' });
});

test('research_record: 別の実行で開いた URL は当たらない（表は実行ごと）', async t => {
  const { db, store } = setup(t, 'run-1');
  pagesOf('run-1')!.add('https://example.com/a', PAGE_A);
  const other = store.start({ projectId: 'p2', runId: 'run-2', phase: 'products', mode: 'one_by_one' });
  beginPages('run-2');
  t.after(() => endPages('run-2'));
  const out = await record(db, { kind: 'similar', name: 'Typora', url: 'https://example.com/a' }, 'run-2');
  assert.equal(out.isError, true);
  assert.match(out.content, /has not opened/u);
  assert.equal(store.items(other.id).length, 0);
});

test('research_record: 抜き書きが合わないライセンス・日付・言語は「不明」（NULL）で載り、候補は落ちない', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://example.com/a', PAGE_A);
  const out = await record(db, { kind: 'similar', name: 'Typora', url: 'https://example.com/a', license: 'Released under the Apache License.', updated: 'Last updated 2026-10-01.', language: 'Written in Go.' });
  assert.match(out.content, /Unknown \(too short, or not found word for word on the page; quote the whole sentence\): license, language/u);
  const [row] = store.items(research.id);
  assert.deepEqual([row!.license, row!.updated, row!.language], [null, 'Last updated 2026-10-01.', null]);
  assert.deepEqual(JSON.parse(row!.evidence), { url: 'https://example.com/a', updated: 'Last updated 2026-10-01.' });
});

test('research_record: 単語だけの抜き書きは「不明」。「MIT」は commits だけのページ、「Rust」は trust だけのページ、「2」は 1,234 だけのページに当たらない', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://example.com/c', 'See all commits. We trust our users. Stars: 1,234.');
  pages.add('https://example.com/a', PAGE_A);
  await record(db, { kind: 'similar', name: 'Commits App', url: 'https://example.com/c', license: 'MIT', language: 'Rust', updated: '2' });
  await record(db, { kind: 'similar', name: 'Typora', url: 'https://example.com/a', license: 'MIT', language: 'TypeScript', updated: '2026-10-01' });
  assert.deepEqual(store.items(research.id).map(r => [r.license, r.updated, r.language]), [[null, null, null], [null, null, null]]);
});

test('research_record: 抜き書きの無い欄（モデルの記憶だけの値）は載らない', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://example.com/a', PAGE_A);
  await record(db, { kind: 'similar', name: 'Typora', url: 'https://example.com/a' });
  const [row] = store.items(research.id);
  assert.deepEqual([row!.license, row!.updated, row!.language], [null, null, null]);
});

test('research_record: 名前の形の外れは道具の誤りで返り、書かれない', async t => {
  const { db, store, research, pages } = setup(t);
  pages.add('https://example.com/a', PAGE_A);
  for (const name of ['see https://x.example', 'run $(id)', 'two\nlines', '[x](y)', 'sk-ant-test-0000000000000000']) {
    const out = await record(db, { kind: 'similar', name, url: 'https://example.com/a' });
    assert.equal(out.isError, true, name);
  }
  const feature = await record(db, { kind: 'feature', name: '# heading', evidence: [] });
  assert.equal(feature.isError, true);
  assert.equal(store.items(research.id).length, 0);
});

test('research_record: 調べる実行でない（記録が無い・開けたページの表が無い）ときは断る', async t => {
  const { db } = setup(t);
  const out = await record(db, { kind: 'similar', name: 'X', url: 'https://example.com/a' }, 'run-unknown');
  assert.equal(out.isError, true);
  assert.match(out.content, /only while a research run/u);
});

test('research_record: allowedIn は空のまま（どの実行にも渡らない）', () => {
  assert.deepEqual(researchRecord.allowedIn, []);
});

async function twoProducts(t: { after: (fn: () => void) => void }) {
  const s = setup(t);
  s.pages.add('https://a.example.com/notes', PAGE_A);
  s.pages.add('https://b.example.com/notes', PAGE_B);
  await record(s.db, { kind: 'similar', name: 'Acme Notes', url: 'https://a.example.com/notes' });
  await record(s.db, { kind: 'similar', name: 'Beta Notes', url: 'https://b.example.com/notes' });
  return s;
}

test('定番: 名前が 2 つの別の似ているもののページの抜き書きに入れば、初めのチェックが付く（理由 standard）', async t => {
  const { db, store, research } = await twoProducts(t);
  const out = await record(db, { kind: 'feature', name: 'Live preview', evidence: [
    { url: 'https://a.example.com/notes', quote: 'Features: Live preview' },
    { url: 'https://b.example.com/notes/', quote: 'It has a live preview' },
  ] });
  assert.equal(out.isError, undefined, out.content);
  const feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, feature.default_reason], [1, 'standard']);
  assert.equal(JSON.parse(feature.products).length, 2);
});

test('定番: 1 つの似ているもののページに 2 回書かれていても定番にならない', async t => {
  const { db, store, research } = await twoProducts(t);
  await record(db, { kind: 'feature', name: 'Live preview', evidence: [
    { url: 'https://a.example.com/notes', quote: 'Features: Live preview' },
    { url: 'https://a.example.com/notes', quote: 'Live preview, Table editor' },
  ] });
  const feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, feature.default_reason], [0, null]);
});

test('定番: 同じページを 2 つの似ているものの行で使い回しても定番にならない（別の行の URL の抜き書きは数えず、同じ URL の行は 2 つ作れない）', async t => {
  const { db, store, research, pages } = await twoProducts(t);
  await record(db, { kind: 'feature', name: 'Live preview', evidence: [
    { url: 'https://a.example.com/notes', quote: 'Features: Live preview' },
    { url: 'https://a.example.com/notes', quote: 'Live preview' },
    { url: 'https://c.example.com/notes', quote: 'Live preview' },
  ] });
  let feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, JSON.parse(feature.products)], [0, [1]]);
  pages.add('https://A.example.com/notes/#x', PAGE_A);
  const again = await record(db, { kind: 'similar', name: 'Acme Notes Copy', url: 'https://A.example.com/notes/#x' });
  assert.equal(again.isError, true);
  assert.match(again.content, /already has a row/u);
  feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.equal(feature.default_checked, 0);
});

test('定番: 抜き書きがページに無ければ根拠に数えず、名前を含まない抜き書きは「持っている」に数えても定番には数えない', async t => {
  const { db, store, research } = await twoProducts(t);
  await record(db, { kind: 'feature', name: 'Live preview', evidence: [
    { url: 'https://a.example.com/notes', quote: 'Features: Live preview' },
    { url: 'https://b.example.com/notes', quote: 'It has live preview everywhere' },
  ] });
  let feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, JSON.parse(feature.products)], [0, [1]]);
  await record(db, { kind: 'feature', name: 'live  PREVIEW', evidence: [{ url: 'https://b.example.com/notes', quote: 'a table editor' }] });
  feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, JSON.parse(feature.products)], [0, [1, 2]]);
  await record(db, { kind: 'feature', name: 'Live preview', evidence: [{ url: 'https://b.example.com/notes', quote: 'a live preview' }] });
  feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, feature.default_reason], [1, 'standard']);
  assert.equal(store.items(research.id).filter(i => i.kind === 'feature').length, 1);
});

test('同じページ: クエリだけ・スキームだけ・パスの大文字小文字だけが違う URL は同じページとして 2 つ目の行を断る（定番を作れない）', async t => {
  const { db, store, research, pages } = setup(t);
  const urls = ['https://example.com/acme/notes?a=1', 'https://example.com/acme/notes?b=2', 'http://example.com/acme/notes', 'https://example.com/ACME/Notes/'];
  for (const url of urls) pages.add(url, PAGE_A);
  const first = await record(db, { kind: 'similar', name: 'Acme Notes', url: urls[0] });
  assert.equal(first.isError, undefined, first.content);
  for (const [i, url] of urls.slice(1).entries()) {
    const out = await record(db, { kind: 'similar', name: `Acme Copy ${i}`, url });
    assert.equal(out.isError, true, url);
    assert.match(out.content, /already has a row/u);
  }
  const out = await record(db, { kind: 'feature', name: 'Live preview', evidence: urls.map(url => ({ url, quote: 'Features: Live preview' })) });
  assert.doesNotMatch(out.content, /Products seen/u);
  const feature = store.items(research.id).find(i => i.kind === 'feature')!;
  assert.deepEqual([feature.default_checked, JSON.parse(feature.products)], [0, [1]]);
});

test('定番: 名前は語の切れ目で当てる。「Mit」は commits を含む抜き書きでは定番にならず、「Live preview」は語として入れば当たる', async t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p-x', runId: 'run-x', phase: 'products', mode: 'batch' });
  const a = store.addSource(run.id, { kind: 'similar', name: 'A', url: 'https://a.example.com/x', evidence: {} });
  const b = store.addSource(run.id, { kind: 'similar', name: 'B', url: 'https://b.example.com/x', evidence: {} });
  const mit = store.addFeature(run.id, { label: 'Mit', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: 'See all the commits here' },
    { similar: b.id, url: 'https://b.example.com/x', quote: 'Summit notes are shared' },
  ] });
  assert.deepEqual([mit.row.default_checked, mit.row.default_reason], [0, null]);
  const live = store.addFeature(run.id, { label: 'Live preview', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: 'It has (live preview) built in' },
    { similar: b.id, url: 'https://b.example.com/x', quote: 'Live  Preview, tables and more' },
  ] });
  assert.deepEqual([live.row.default_checked, live.row.default_reason], [1, 'standard']);
  const glued = store.addFeature(run.id, { label: 'preview', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: 'The previews are fast now' },
    { similar: b.id, url: 'https://b.example.com/x', quote: 'A preview pane is included' },
  ] });
  assert.equal(glued.row.default_checked, 0);
  const left = store.addFeature(run.id, { label: 'view', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: 'A preview pane is included' },
    { similar: b.id, url: 'https://b.example.com/x', quote: 'The preview is live everywhere' },
  ] });
  assert.equal(left.row.default_checked, 0);
  const wide = store.addFeature(run.id, { label: '目次', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: '見出しから目次を作ります' },
    { similar: b.id, url: 'https://b.example.com/x', quote: '自動の目次があります' },
  ] });
  assert.equal(wide.row.default_checked, 1);
});

test('research_record: 機能の根拠を落としたときは、落とした数と理由を返す', async t => {
  const { db } = await twoProducts(t);
  const out = await record(db, { kind: 'feature', name: 'Table editor', evidence: [
    { url: 'https://a.example.com/notes', quote: 'Live preview, Table editor, Export to PDF' },
    { url: 'https://a.example.com/notes', quote: 'Table editor' },
    { url: 'https://z.example.com/notes', quote: 'It has a table editor' },
  ] });
  assert.match(out.content, /^Recorded as #3\. Evidence not kept: 2 of 3 \(1 with a url that is not a similar row of this research, 1 too short or not found word for word on that page; quote the whole sentence\)\.$/u);
  const all = await record(db, { kind: 'feature', name: 'Export to PDF', evidence: [{ url: 'https://b.example.com/notes', quote: 'Export to PDF' }] });
  assert.match(all.content, /Evidence not kept: 1 of 1/u);
});

test('定番: 行が同じページを指していれば（表に直接入った ?a と ?b の行でも）1 つに数える', async t => {
  const { db, store } = setup(t);
  const run = store.start({ projectId: 'p-y', runId: 'run-y', phase: 'products', mode: 'batch' });
  const insert = db.prepare("INSERT INTO research_items (research_id, kind, name_or_label, url) VALUES (?, 'similar', ?, ?)");
  const a = Number(insert.run(run.id, 'A', 'https://example.com/notes?a=1').lastInsertRowid);
  const b = Number(insert.run(run.id, 'B', 'http://example.com/Notes?b=2').lastInsertRowid);
  const { row } = store.addFeature(run.id, { label: 'Live preview', evidence: [
    { similar: a, url: 'https://example.com/notes?a=1', quote: 'Features: Live preview' },
    { similar: b, url: 'http://example.com/Notes?b=2', quote: 'It has a live preview' },
  ] });
  assert.deepEqual([row.default_checked, JSON.parse(row.products)], [0, [a, b]]);
});

test('ページの同じさ（pageKey）: ホストの末尾の . とポートの違いも同じページ', () => {
  const keys = ['https://example.com./acme/notes', 'https://example.com:8443/acme/notes', 'http://EXAMPLE.com.:80/Acme/Notes/'].map(pageKey);
  assert.deepEqual(new Set(keys), new Set(['example.com/acme/notes']));
});

test('定番: 漢字・かなだけの名前は 2 字以上のときだけ当てる（1 字の「表」は当てない）', async t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p-z', runId: 'run-z', phase: 'products', mode: 'batch' });
  const a = store.addSource(run.id, { kind: 'similar', name: 'A', url: 'https://a.example.com/x', evidence: {} });
  const b = store.addSource(run.id, { kind: 'similar', name: 'B', url: 'https://b.example.com/x', evidence: {} });
  const evidence = (word: string) => [
    { similar: a.id, url: 'https://a.example.com/x', quote: `ここに${word}の機能があります` },
    { similar: b.id, url: 'https://b.example.com/x', quote: `こちらにも${word}を用意しています` },
  ];
  assert.equal(store.addFeature(run.id, { label: '表', evidence: evidence('表') }).row.default_checked, 0);
  assert.equal(store.addFeature(run.id, { label: '表計算', evidence: evidence('表計算') }).row.default_checked, 1);
  assert.equal(store.addFeature(run.id, { label: 'X', evidence: [
    { similar: a.id, url: 'https://a.example.com/x', quote: 'Export X to a file today' },
    { similar: b.id, url: 'https://b.example.com/x', quote: 'The X button saves it all' },
  ] }).row.default_checked, 1);
});
