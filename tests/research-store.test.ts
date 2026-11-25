import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { ResearchError } from '../src/research/labels.ts';
import { confirmedPicks, ResearchStore } from '../src/research/store.ts';
import { Value } from '@sinclair/typebox/value';
import { ResearchConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { Conversations } from '../src/db/conversations.ts';
import { researchSettings } from '../src/research/settings.ts';
import { testConfig } from './helpers.ts';

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
    assert.equal(codeOf(() => store.addPart(run.id, { taskId: 't-other', conversationId: 'c-other', kind: 'first' })), 'finished', end);
    assert.deepEqual(store.items(run.id), before);
    const row = store.get(run.id)!;
    assert.equal(row.status, end);
    assert.ok(row.finished_at !== null);
    assert.equal(store.runningFor(`r-${end}`), undefined);
  }
  const libs = store.start({ projectId: 'p2', phase: 'libraries', mode: 'batch' });
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

  const libs = store.start({ projectId: 'p2', phase: 'libraries', mode: 'batch' });
  for (let n = 1; n <= 6; n++) store.addChoice(libs.id, { label: `Question ${n}`, options: ['A', 'B'], recommended: 1 });
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Question 7', options: ['A', 'B'] })), 'too_many');
  assert.equal(codeOf(() => store.addSource(libs.id, similar(1))), 'kind_phase');
});

test('記録の store: やり方の問いは選択肢 2〜4 で、問いも選択肢も名前の形を通る。おすすめは範囲の外なら空', t => {
  const { store } = setup(t);
  const libs = store.start({ projectId: 'p2', phase: 'libraries', mode: 'batch' });
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
  const b = store.start({ projectId: 'p2', runId: 'r2', phase: 'products', mode: 'one_by_one' });
  store.finish(b.id, 'done');
  assert.equal(store.failRunning(), 1);
  assert.deepEqual([store.get(a.id)!.status, store.get(b.id)!.status], ['failed', 'done']);
});

test('記録の store: 部分の実行は setPart で実行を替え、runningFor は今の実行だけを返す', t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'one_by_one' });
  store.setPart(run.id, store.addPart(run.id, { taskId: 't1', conversationId: 'cr1', kind: 'first' }), { runId: 'r2' });
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

test('記録の store: 選択肢には裸のドメインの決まりが効かない（Socket.IO・ASP.NET Core・draw.io export）が、問いには効く', t => {
  const { store } = setup(t);
  const libs = store.start({ projectId: 'p2', phase: 'libraries', mode: 'batch' });
  const row = store.addChoice(libs.id, { label: 'Realtime library', options: ['Socket.IO', 'ASP.NET Core', 'draw.io export'] });
  assert.deepEqual(JSON.parse(row.options!), ['Socket.IO', 'ASP.NET Core', 'draw.io export']);
  assert.equal(codeOf(() => store.addChoice(libs.id, { label: 'Use Socket.IO', options: ['Yes', 'No'] })), 'label_url');
});

test('記録の store（R3.11 H2）: 1 つの製品で動いている記録は 1 つまで。ほかの製品は始められ、終われば次を始められる', t => {
  const { store } = setup(t);
  const a = store.start({ projectId: 'p1', phase: 'products', mode: 'batch', auto: true, sourceConversationId: 'c1' });
  assert.equal(codeOf(() => store.start({ projectId: 'p1', phase: 'products', mode: 'batch' })), 'running');
  assert.equal(codeOf(() => store.start({ projectId: 'p1', phase: 'libraries', mode: 'batch' })), 'running');
  assert.equal(codeOf(() => store.start({ projectId: 'p2', phase: 'products', mode: 'batch' })), 'ok');
  assert.deepEqual([store.get(a.id)!.auto, store.get(a.id)!.source_conversation_id], [1, 'c1']);
  assert.equal(store.hasAny('p1', 'products'), true);
  assert.equal(store.hasAny('p1', 'libraries'), false);
  store.finish(a.id, 'cancelled', { partial: true, stopReason: 'skip' });
  assert.deepEqual([store.get(a.id)!.partial, store.get(a.id)!.stop_reason], [1, 'skip']);
  assert.equal(codeOf(() => store.start({ projectId: 'p1', phase: 'products', mode: 'batch' })), 'ok');
});

test('記録の store（R3.3）: 部分（parts）は running のあいだだけ足せる。実行の id と終わりを書ける', t => {
  const { store } = setup(t);
  const run = store.start({ projectId: 'p1', phase: 'products', mode: 'one_by_one' });
  const index = store.addPart(run.id, { taskId: 't1', conversationId: 'cr1', kind: 'first' });
  store.setPart(run.id, index, { runId: 'run-1' });
  assert.equal(store.runningFor('run-1')!.id, run.id);
  store.setPart(run.id, index, { end: 'done' });
  assert.deepEqual(store.parts(run.id), [{ taskId: 't1', conversationId: 'cr1', kind: 'first', runId: 'run-1', end: 'done' }]);
  store.finish(run.id, 'done');
  assert.equal(codeOf(() => store.addPart(run.id, { taskId: 't2', conversationId: 'cr2', kind: 'candidate' })), 'finished');
  assert.equal(store.parts(run.id).length, 1);
});

test('記録の store（D9・L4）: 終えるとき、持ち主が元の会話で言った機能の名前に「あなたが言った」が付き、定番より強い。generated・askAnswer・note・ほかの会話・短い名前には付かない', t => {
  const { db, store } = setup(t);
  const conversations = new Conversations(db);
  const plan = conversations.create({ projectId: 'p1' });
  const other = conversations.create({ projectId: 'p1' });
  conversations.append(plan.id, { role: 'user', content: 'I want a Markdown preview pane and Tags for notes.' });
  conversations.append(plan.id, { role: 'user', content: 'Add full text search everywhere', generated: true });
  conversations.append(plan.id, { role: 'user', content: 'Sync across devices please', askAnswer: true });
  conversations.append(plan.id, { role: 'user', content: 'Version history of notes', note: 'pending' });
  conversations.append(other.id, { role: 'user', content: 'Encrypted vault storage' });
  const run = store.start({ projectId: 'p1', phase: 'products', mode: 'batch', sourceConversationId: plan.id });
  const a = store.addSource(run.id, similar(1));
  const b = store.addSource(run.id, similar(2));
  store.addFeature(run.id, { label: 'Markdown preview', evidence: [{ similar: a.id, url: 'https://example.com/p1', quote: 'Markdown preview' }, { similar: b.id, url: 'https://example.com/p2', quote: 'Markdown preview' }] });
  for (const label of ['Tags', 'Full text search', 'Sync across devices', 'Version history', 'Encrypted vault storage']) store.addFeature(run.id, { label, evidence: [] });
  store.finish(run.id, 'done');
  const reasons = Object.fromEntries(store.items(run.id).filter(i => i.kind === 'feature').map(i => [i.name_or_label, i.default_reason]));
  assert.deepEqual(reasons, { 'Markdown preview': 'owner_said', 'Tags': null, 'Full text search': null, 'Sync across devices': null, 'Version history': null, 'Encrypted vault storage': null });
});

test('設定（D13）: 調べる設定の既定と、Settings の全体の設定の反映。上限の外（候補 9）は設定として通らない', () => {
  const base = testConfig();
  const { research: _off, ...plain } = base;
  assert.deepEqual(researchSettings(plain), { when: 'new', mode: 'auto', limits: { candidates: 8, searches: 15, fetches: 30, minutes: 20 }, askLanguage: true, preferLanguages: [], avoidLanguages: [] });
  const global = researchSettings({ ...base, research: { when: 'button', limits: { fetches: 10 }, preferLanguages: ['Go'] } });
  assert.deepEqual([global.when, global.limits, global.preferLanguages], ['button', { candidates: 8, searches: 15, fetches: 10, minutes: 20 }, ['Go']]);
  assert.equal(Value.Check(ResearchConfig, { limits: { candidates: 9 } }), false);
  assert.equal(Value.Check(ResearchConfig, { preferLanguages: ['COBOL'] }), false);
  assert.doesNotThrow(() => parseConfig({ ...base, research: { when: 'new', mode: 'one_by_one' }, routing: { ...base.routing, research: ['claude-haiku'] } }));
});

test('試験の既定（R3.11 M9）: testConfig は自動で調べない', () => {
  assert.equal(researchSettings(testConfig()).when, 'off');
});

test('記録の store（審査 LOW-5）: 見せた印は名前の欄を含む（名前が変われば印も変わる）', t => {
  const { db, store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'batch' });
  const row = store.addSource(run.id, similar(1));
  const before = store.shownHash(run.id);
  db.prepare('UPDATE research_items SET name_or_label = ? WHERE id = ?').run('Product renamed', row.id);
  assert.notEqual(store.shownHash(run.id), before);
});

test('記録の store（審査 LOW-5）: confirmedPicks は確定した記録の選びだけを返す（done の記録の選びは数えない）', t => {
  const { db, store } = setup(t);
  const run = store.start({ projectId: 'p1', runId: 'r1', phase: 'products', mode: 'batch' });
  const { row } = store.addFeature(run.id, { label: 'Live preview', evidence: [] });
  store.finish(run.id, 'done');
  db.prepare("UPDATE research_items SET decision = 'picked' WHERE id = ?").run(row.id);
  assert.deepEqual(confirmedPicks(db, 'p1'), []);
  db.prepare("UPDATE research_runs SET status = 'confirmed' WHERE id = ?").run(run.id);
  assert.deepEqual(confirmedPicks(db, 'p1').map(p => p.label), ['Live preview']);
});
