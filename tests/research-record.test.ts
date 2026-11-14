import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { beginPages, endPages, normalizeUrl, OpenedPages, pagesOf } from '../src/research/evidence.ts';
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
  assert.ok(pages.quoted('https://EXAMPLE.com/a/', 'mit license'));
  assert.ok(pages.quoted('https://example.com/a', 'ＭＩＴ　License'));
  assert.ok(!pages.quoted('https://example.com/a', 'Apache License'));
  assert.ok(!pages.quoted('https://example.com/a', '   '));
  assert.ok(!pages.quoted('https://example.com/b', 'MIT License'));
  assert.ok(!pages.has('https://example.com/b'));
});

test('開けたページの表: 1 ページ 20,000 字まで（そのあとの文は当たらない）', () => {
  const pages = new OpenedPages();
  pages.add('https://example.com/long', `${'x'.repeat(20_000)}TAILWORD`);
  assert.ok(!pages.quoted('https://example.com/long', 'TAILWORD'));
  pages.add('https://example.com/short', `${'y'.repeat(100)}TAILWORD`);
  assert.ok(pages.quoted('https://example.com/short', 'tailword'));
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
  const out = await record(db, { kind: 'similar', name: 'Acme Notes', url: 'HTTPS://GitHub.com/acme/notes/', license: 'MIT License', updated: '2026-10-01', language: 'TypeScript' });
  assert.equal(out.isError, undefined, out.content);
  const [row] = store.items(research.id);
  assert.equal(row!.url, 'https://github.com/acme/notes');
  assert.deepEqual([row!.license, row!.updated, row!.language], ['MIT License', '2026-10-01', 'TypeScript']);
  assert.deepEqual(JSON.parse(row!.evidence), { url: 'https://github.com/acme/notes', license: 'MIT License', updated: '2026-10-01', language: 'TypeScript' });
});

test('research_record: 別の実行で開いた URL は当たらない（表は実行ごと）', async t => {
  const { db, store } = setup(t, 'run-1');
  pagesOf('run-1')!.add('https://example.com/a', PAGE_A);
  const other = store.start({ projectId: 'p1', runId: 'run-2', phase: 'products', mode: 'one_by_one' });
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
  const out = await record(db, { kind: 'similar', name: 'Typora', url: 'https://example.com/a', license: 'Apache-2.0', updated: '2026-10-01', language: 'Go' });
  assert.match(out.content, /Unknown \(not found word for word on the page\): license, language/u);
  const [row] = store.items(research.id);
  assert.deepEqual([row!.license, row!.updated, row!.language], [null, '2026-10-01', null]);
  assert.deepEqual(JSON.parse(row!.evidence), { url: 'https://example.com/a', updated: '2026-10-01' });
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
