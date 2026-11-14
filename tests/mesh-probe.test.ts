import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProduct, madeUpPaths, renderReport, runProbe, scoreAnswer, summarize } from '../scripts/mesh-probe.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { compactSystem } from '../src/engine/prompts.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { MESH_QUESTIONS, PRODUCT_CHANGES, PRODUCT_FILES } from './fixtures/mesh-questions.ts';
import { tempDir } from './helpers.ts';

const provider: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
const model: ModelConfig = { id: 'fake-model', provider: 'fake', model: 'fake', contextLength: 65536, minContext: 8192, maxOutputTokens: 4096, vision: false };
const SUMMARY = '- The owner is moving the coupon logic; next is allergy labels.';
const FINAL = new Set([...Object.keys(PRODUCT_FILES).filter(rel => !PRODUCT_CHANGES.some(c => c.from === rel)), ...PRODUCT_CHANGES.map(c => c.to)]);

function fakeAdapter(): ProviderAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider,
    requests,
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      if (request.system.frozen === compactSystem('en')) { yield { type: 'text', delta: SUMMARY }; yield { type: 'done', stop: 'end_turn' }; return; }
      const question = MESH_QUESTIONS.find(q => q.text === request.messages[0]?.content)!;
      const mesh = request.tools.some(t => t.name === 'mesh_search');
      yield { type: 'usage', usage: { inputTokens: mesh ? 110 : 100 } };
      if (mesh && request.messages.at(-1)?.role === 'user') {
        const query = question.kind === 'plan' ? 'next' : question.answers[0]!.split('/').slice(0, -1).join('/');
        yield { type: 'tool_call', call: { id: `call-${requests.length}`, name: 'mesh_search', arguments: { query } } };
        yield { type: 'done', stop: 'tool_use' };
        return;
      }
      yield { type: 'text', delta: mesh || question.kind === 'plan' ? `Answer: ${question.answers[0]}` : 'It is in src/orders/table.ts' };
      yield { type: 'done', stop: 'end_turn' };
    },
    async probe() { throw new Error('not used'); },
  };
}

test('測りの問い: 12 個（場所 6・計画と状態 3・画面の部品 3）、9 個は持ち主の言語・3 個は別の言語、2 個は古くした行に当たり、正解のパスは作業フォルダに実在する', () => {
  assert.equal(MESH_QUESTIONS.length, 12);
  assert.equal(new Set(MESH_QUESTIONS.map(q => q.id)).size, 12);
  assert.deepEqual(['location', 'plan', 'screen'].map(kind => MESH_QUESTIONS.filter(q => q.kind === kind).length), [6, 3, 3]);
  assert.equal(MESH_QUESTIONS.filter(q => q.lang === 'ja').length, 9);
  assert.equal(MESH_QUESTIONS.filter(q => q.lang !== 'ja').length, 3);
  const stale = MESH_QUESTIONS.filter(q => q.stale !== undefined);
  assert.equal(stale.length, 2);
  for (const q of MESH_QUESTIONS.filter(q => q.kind !== 'plan')) for (const answer of q.answers) assert.ok(FINAL.has(answer), `${q.id} ${answer}`);
  for (const q of stale) assert.ok(![...FINAL].some(rel => rel.includes(q.stale!)), q.id);
});

test('測りの製品: C は地図の 2 行が古い印（missing・stale）で読め、B に地図は無く、A は mesh の道具も目次も持たない。用語の表は g の組だけ', async t => {
  const base = realpathSync.native(tempDir(t));
  const read = async (set: 'a' | 'b' | 'c' | 'cg', file: string) => {
    const env = await buildProduct(join(base, 'p'), set, model, provider);
    try {
      const out = env.tools.some(tool => tool.name === 'mesh_read') ? await env.run({ id: 'r', name: 'mesh_read', arguments: { file } }, env.ctx(new AbortController().signal)) : undefined;
      return { env, out };
    } finally { env.close(); }
  };
  const c = await read('c', 'MAP.md');
  assert.match(c.out!.content, /server\/coupons .*\[missing\]/u);
  assert.match(c.out!.content, /- jobs .*cleanup\.ts.*\[stale\]/u);
  assert.match(c.env.meshIndex, /MAP\.md — 9 parts \(1 stale, 1 missing\)/u);
  assert.doesNotMatch(c.env.meshIndex, /GLOSSARY\.md/u);
  const b = await read('b', 'MAP.md');
  assert.equal(b.out!.isError, true);
  assert.match(b.env.meshIndex, /STATE\.md/u);
  assert.match(b.env.meshIndex, /next: Add allergy labels/u);
  const cg = await read('cg', 'GLOSSARY.md');
  assert.match(cg.out!.content, /カートの数 → web\/components\/CartBadge\.tsx/u);
  const a = await read('a', 'MAP.md');
  assert.equal(a.out, undefined);
  assert.equal(a.env.meshIndex, '');
  assert.deepEqual(a.env.tools.map(tool => tool.name), ['file_list', 'file_read']);
});

test('採点: パスが入っていれば正答、古い行のパスだけなら「古い行を信じた」、作業フォルダに無いパスを数える', () => {
  const l4 = MESH_QUESTIONS.find(q => q.id === 'L4')!;
  assert.deepEqual(scoreAnswer(l4, 'server\\discounts\\apply.ts です'), { correct: true, trustedStale: false });
  assert.deepEqual(scoreAnswer(l4, 'server/coupons/apply.ts にあります'), { correct: false, trustedStale: true });
  assert.deepEqual(scoreAnswer(l4, 'わかりません'), { correct: false, trustedStale: false });
  const root = 'C:\\work\\bento';
  assert.deepEqual(madeUpPaths(`C:\\work\\bento\\server\\db\\schema.ts と plan.md、src/orders/table.ts、y/o、https://example.com/a/b`, root), ['src/orders/table.ts']);
  assert.deepEqual(madeUpPaths('discounts/apply.ts と CartBadge.tsx と Missing.tsx', root), ['missing.tsx']);
});

test('試しの提供元で、A・B・C の 3 組 × 12 問の表が出る。圧縮のあとの要約が毎回の頼みに入り、C は最初の mesh_search で、入口の書いてある地図の行の場所を当てる', async t => {
  const adapter = fakeAdapter();
  const result = await runProbe({ model, adapter, sets: ['a', 'b', 'c'], base: realpathSync.native(tempDir(t)), maxTurns: 4, maxTokens: 500, timeoutMs: 10_000 });
  assert.equal(result.rows.length, 36);
  for (const set of ['a', 'b', 'c']) assert.equal(result.rows.filter(r => r.set === set).length, 12);
  const asked = adapter.requests.filter(r => r.system.frozen !== compactSystem('en'));
  assert.ok(asked.every(r => r.system.dynamic.includes(SUMMARY)));
  assert.equal(adapter.requests.filter(r => r.system.frozen === compactSystem('en')).length, 1);
  const summary = summarize(result.rows);
  const of = (set: string) => summary.find(s => s.set === set)!;
  assert.equal(of('a').correct, 3);
  assert.equal(of('a').madeUp, 9);
  assert.equal(of('a').firstSearchHits, null);
  assert.equal(of('c').correct, 12);
  assert.equal(of('c').firstSearchHits, 2);
  assert.equal(of('b').firstSearchHits, 0);
  assert.equal(of('c').toolCalls, 12);
  assert.ok(result.added.c! > result.added.b! && result.added.b! > 0);
  const report = renderReport(result.rows, { title: 'Mesh probe', notes: result.notes, added: { [model.id]: result.added } });
  assert.match(report, /\| fake-model \| c \| 12 \/ 12 \| 6 \| 3 \| 3 \| 2 \| 0 \| 0 \| 12 \/ 1 \| 220 \|/u);
  assert.match(report, /\| fake-model \| a -> c \| 9 \| 9 -> 0 \| 2\.2 \| harm \|/u);
  assert.match(report, /\| fake-model \| b -> c \| 0 \| 0 -> 0 \| 1 \| no harm \|/u);
  assert.equal(report.split('\n').filter(line => /^\| fake-model \| (a|b|c) \| [LPU]\d \|/u.test(line)).length, 36);
});

test('相手に届かないモデルでも最後まで走り、どの問いも失敗として表に残る', async t => {
  const dead: ProviderAdapter = { provider, async *stream() { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); }, async probe() { throw new Error('not used'); } };
  const result = await runProbe({ model, adapter: dead, sets: ['a', 'c'], base: realpathSync.native(tempDir(t)), maxTurns: 2, maxTokens: 100, timeoutMs: 1000 });
  assert.equal(result.rows.length, 24);
  assert.ok(result.rows.every(r => r.failed?.includes('ECONNREFUSED') && !r.correct));
  assert.match(result.notes.join('\n'), /compaction failed/u);
  assert.match(renderReport(result.rows, { title: 'Mesh probe', notes: result.notes, added: {} }), /\| fake-model \| c \| 0 \/ 12 .*\| 12 \|$/mu);
});
