import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProduct, compareSets, madeUpPaths, renderReport, runProbe, scoreAnswer, searchHit, summarize, type SetSummary } from '../scripts/mesh-probe.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import { compactSystem } from '../src/engine/prompts.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { MESH_QUESTIONS, PLAN_TEXT, PRODUCT_CHANGES, PRODUCT_FILES } from './fixtures/mesh-questions.ts';
import { tempDir } from './helpers.ts';

const provider: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
const model: ModelConfig = { id: 'fake-model', provider: 'fake', model: 'fake', contextLength: 65536, minContext: 8192, maxOutputTokens: 4096, vision: false };
const SUMMARY = '- The owner is moving the coupon logic; next is allergy labels.';
const SECRET = 'zq-mesh-secret-4b8e2d7a';
const MESH_GUIDE_MARK = 'The text between the MESH markers';
const FINAL = new Set([...Object.keys(PRODUCT_FILES).filter(rel => !PRODUCT_CHANGES.some(c => c.from === rel)), ...PRODUCT_CHANGES.map(c => c.to)]);

function fakeAdapter(leak = false): ProviderAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider,
    requests,
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      if (request.system.frozen === compactSystem('en')) { yield { type: 'text', delta: SUMMARY }; yield { type: 'done', stop: 'end_turn' }; return; }
      const question = MESH_QUESTIONS.find(q => q.text === request.messages[0]?.content)!;
      const mesh = request.tools.some(t => t.name === 'mesh_search');
      yield { type: 'usage', usage: { inputTokens: 1 } };
      yield { type: 'usage', usage: { inputTokens: mesh ? 110 : 100 } };
      if (mesh && request.messages.at(-1)?.role === 'user') {
        const query = question.kind === 'location' ? question.mapRow! : question.kind === 'plan' ? 'next' : 'push';
        yield { type: 'tool_call', call: { id: `call-${requests.length}`, name: leak ? `leak_${SECRET}` : 'mesh_search', arguments: { query } } };
        yield { type: 'done', stop: 'tool_use' };
        return;
      }
      const reply = question.kind === 'plan' ? `Answer: ${question.answers[0]}`
        : !mesh ? 'It is in src/orders/table.ts'
        : question.kind === 'control' ? (question.lang === 'es' ? 'No existe en este producto.' : '見つかりませんでした。')
        : `Answer: ${question.answers[0]}`;
      yield { type: 'text', delta: leak ? `${reply} ${SECRET}` : reply };
      yield { type: 'done', stop: 'end_turn' };
    },
    async probe() { throw new Error('not used'); },
  };
}

const setSummary = (patch: Partial<SetSummary>): SetSummary => ({
  model: 'm', set: 'a', questions: 12, correct: 3, location: 0, plan: 3, controlUnknown: 0, controlConfident: 3,
  firstSearchHits: null, madeUp: 9, trustedStale: 0, toolCalls: 0, medianToolCalls: 0, medianTokens: 100, failed: 0, ...patch,
});

test('測りの問い: 12 個（場所 6・計画と状態 3・対照 3）、9 個は持ち主の言語・3 個は別の言語、2 個は古くした行に当たり、場所の正解は作業フォルダに実在し、対照の答えは製品に無い', () => {
  assert.equal(MESH_QUESTIONS.length, 12);
  assert.equal(new Set(MESH_QUESTIONS.map(q => q.id)).size, 12);
  assert.deepEqual(['location', 'plan', 'control'].map(kind => MESH_QUESTIONS.filter(q => q.kind === kind).length), [6, 3, 3]);
  assert.equal(MESH_QUESTIONS.filter(q => q.lang === 'ja').length, 9);
  assert.equal(MESH_QUESTIONS.filter(q => q.lang !== 'ja').length, 3);
  const stale = MESH_QUESTIONS.filter(q => q.stale !== undefined);
  assert.equal(stale.length, 2);
  for (const q of MESH_QUESTIONS.filter(q => q.kind === 'location')) {
    assert.ok(q.mapRow && q.answers.every(answer => FINAL.has(answer) && answer.startsWith(`${q.mapRow}/`)), q.id);
  }
  for (const q of stale) assert.ok(![...FINAL].some(rel => rel.includes(q.stale!)), q.id);
  assert.ok(MESH_QUESTIONS.filter(q => q.kind === 'control').every(q => q.answers.length === 0));
  assert.ok(![...FINAL].some(rel => /allerg/iu.test(rel)));
  assert.match(PLAN_TEXT, /allergy filter on the menu list \(next\)/u);
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

test('採点: パスが入っていれば正答、古い行のパスだけなら「古い行を信じた」。対照は「分からない」と言えて、作ったパスが無いときだけ正答', () => {
  const l4 = MESH_QUESTIONS.find(q => q.id === 'L4')!;
  assert.deepEqual(scoreAnswer(l4, 'server\\discounts\\apply.ts です'), { correct: true, saidUnknown: null, trustedStale: false });
  assert.deepEqual(scoreAnswer(l4, 'server/coupons/apply.ts にあります'), { correct: false, saidUnknown: null, trustedStale: true });
  assert.deepEqual(scoreAnswer(l4, 'わかりません'), { correct: false, saidUnknown: null, trustedStale: false });
  const k1 = MESH_QUESTIONS.find(q => q.id === 'K1')!;
  const k3 = MESH_QUESTIONS.find(q => q.id === 'K3')!;
  assert.deepEqual(scoreAnswer(k1, 'その部品はまだ無いです。計画では次の作業です。'), { correct: true, saidUnknown: true, trustedStale: false });
  assert.deepEqual(scoreAnswer(k3, 'No existe ningún archivo de notificaciones.'), { correct: true, saidUnknown: true, trustedStale: false });
  assert.deepEqual(scoreAnswer(k1, 'web/components/AllergyFilter.tsx にあります', ['web/components/allergyfilter.tsx']), { correct: false, saidUnknown: false, trustedStale: false });
  assert.deepEqual(scoreAnswer(k1, '見つかりません。web/components/AllergyFilter.tsx かも', ['web/components/allergyfilter.tsx']), { correct: false, saidUnknown: true, trustedStale: false });
});

test('作ったパス: 作業フォルダに無いパスを数え、HTTP の動詞のあと・製品の中身にある文字・拡張子も知っている上のフォルダも無い語・mesh のファイルは数えない', () => {
  const root = 'C:\\work\\bento';
  assert.deepEqual(madeUpPaths(`C:\\work\\bento\\server\\db\\schema.ts と plan.md、src/orders/table.ts、y/o、https://example.com/a/b`, root), ['src/orders/table.ts']);
  assert.deepEqual(madeUpPaths('discounts/apply.ts と CartBadge.tsx と Missing.tsx', root), ['missing.tsx']);
  assert.deepEqual(madeUpPaths('POST /api/orders で受けて、GET /api/allergens も足す。PUT /web/checkout も。and/or で選べる', root), []);
  assert.deepEqual(madeUpPaths('地図は data/projects/x/MAP.md と STATE.md にある。/api/menu を読む', root), []);
  assert.deepEqual(madeUpPaths('server/discount/apply.ts と server/allergens と web/components/CartBadge.tsx', root), ['server/discount/apply.ts', 'server/allergens']);
});

test('最初の mesh_search の当たり: 期待した地図の行のパスか、答えのファイルのパスが結果にあれば当たり（行の名前の一部だけでは当たらない）', () => {
  const l5 = MESH_QUESTIONS.find(q => q.id === 'L5')!;
  const l1 = MESH_QUESTIONS.find(q => q.id === 'L1')!;
  assert.equal(searchHit(l5, 'MAP.md:10 - jobs — nightly cleanup of old orders (cleanup.ts) [stale]'), true);
  assert.equal(searchHit(l5, 'the old cleanup job and the jobsite'), false);
  assert.equal(searchHit(l1, 'MAP.md:6 - server/db — database tables'), true);
  assert.equal(searchHit(l1, 'see server\\db\\schema.ts'), true);
  assert.equal(searchHit(l1, 'server/dbx — other'), false);
});

test('線の判定: 効いた・3 問の境目・作ったパスの半分の境目・正答が減る害・作ったパスが増える害・1.2 倍の境目・土台が 0・失敗のある組・C が B を上回るか', () => {
  const base = setSummary({});
  const sizes = { base: 1000, next: 1200 };
  assert.equal(compareSets(base, setSummary({ correct: 6, madeUp: 4 }), sizes).verdict, 'helped');
  assert.equal(compareSets(base, setSummary({ correct: 5, madeUp: 4 }), sizes).verdict, 'no harm');
  assert.equal(compareSets(base, setSummary({ correct: 6, madeUp: 5 }), sizes).verdict, 'no harm');
  assert.equal(compareSets(base, setSummary({ correct: 2, madeUp: 4 }), sizes).verdict, 'harm: correct fell');
  assert.equal(compareSets(base, setSummary({ correct: 6, madeUp: 10 }), sizes).verdict, 'harm: made-up paths rose');
  const over = compareSets(base, setSummary({ correct: 6, madeUp: 4 }), { base: 1000, next: 1210 });
  assert.deepEqual([over.tokenRatio, over.verdict], [1.21, 'harm: tokens 1.21x']);
  assert.equal(compareSets(base, setSummary({ correct: 2, madeUp: 10 }), { base: 1000, next: 1300 }).verdict, 'harm: correct fell, made-up paths rose, tokens 1.3x');
  const zero = compareSets(base, setSummary({ correct: 6, madeUp: 0 }), { base: 0, next: 100 });
  assert.deepEqual([zero.tokenRatio, zero.verdict], [null, 'n/a: no base request size']);
  assert.equal(compareSets(base, setSummary({ correct: 6, madeUp: 0, failed: 2 }), sizes).verdict, 'n/a: 2 failed questions');
  assert.equal(compareSets(setSummary({ correct: 10, madeUp: 0 }), setSummary({ correct: 11, madeUp: 0 }), sizes, 'beats').verdict, 'beats the base');
  assert.equal(compareSets(setSummary({ correct: 10, madeUp: 0 }), setSummary({ correct: 10, madeUp: 0 }), sizes, 'beats').verdict, 'does not beat the base: drop the map');
});

test('試しの提供元で、A・B・C の 3 組 × 12 問の表が出る。要約と目次が頼みに入り、C は最初の mesh_search で地図の行を当て、トークンの線は本物の製品チャットの頼みの増え方で見る', async t => {
  const adapter = fakeAdapter();
  const result = await runProbe({ model, adapter, sets: ['a', 'b', 'c'], base: realpathSync.native(tempDir(t)), maxTurns: 4, maxTokens: 500, timeoutMs: 10_000 });
  assert.equal(result.rows.length, 36);
  for (const set of ['a', 'b', 'c']) assert.equal(result.rows.filter(r => r.set === set).length, 12);
  const asked = adapter.requests.filter(r => r.system.frozen !== compactSystem('en'));
  assert.ok(asked.every(r => r.system.dynamic.includes(SUMMARY)));
  assert.equal(adapter.requests.filter(r => r.system.frozen === compactSystem('en')).length, 1);
  const plain = asked.filter(r => !r.tools.some(tool => tool.name === 'mesh_search'));
  assert.equal(plain.length, 12);
  assert.ok(plain.every(r => !r.system.dynamic.includes(MESH_GUIDE_MARK) && !r.system.dynamic.includes('STATE.md')));
  assert.equal(asked.filter(r => r.system.dynamic.includes(MESH_GUIDE_MARK)).length, 48);
  assert.equal(asked.filter(r => r.system.dynamic.includes('MAP.md —')).length, 24);
  const summary = summarize(result.rows);
  const of = (set: string) => summary.find(s => s.set === set)!;
  assert.deepEqual([of('a').correct, of('a').madeUp, of('a').controlUnknown, of('a').controlConfident, of('a').firstSearchHits], [3, 9, 0, 3, null]);
  assert.deepEqual([of('b').correct, of('b').madeUp, of('b').controlUnknown, of('b').firstSearchHits], [12, 0, 3, 1]);
  assert.deepEqual([of('c').correct, of('c').firstSearchHits, of('c').toolCalls, of('c').medianTokens, of('a').medianTokens], [12, 6, 12, 220, 100]);
  assert.ok(result.request.base > 1000, String(result.request.base));
  assert.equal(result.request.added.a, 0);
  assert.ok(result.request.added.c! > result.request.added.b! && result.request.added.b! > 0);
  const ratio = Math.round(((result.request.base + result.request.added.c!) / result.request.base) * 100) / 100;
  assert.ok(ratio > 1 && ratio <= 1.2, String(ratio));
  const report = renderReport(result.rows, { title: 'Mesh probe', notes: result.notes, requests: { [model.id]: result.request } });
  assert.match(report, /\| fake-model \| c \| 12 \/ 12 \| 6 \| 3 \| 3 \| 0 \| 6 \| 0 \| 0 \| 12 \/ 1 \| 220 \| \d+ \(\d+ \+ \d+\) \| 0 \|/u);
  assert.match(report, new RegExp(`\\| fake-model \\| a -> c \\| 9 \\| 9 -> 0 \\| ${ratio} \\| helped \\|`, 'u'));
  assert.match(report, /\| fake-model \| b -> c \| 0 \| 0 -> 0 \| [\d.]+ \| does not beat the base: drop the map \|/u);
  assert.equal(report.split('\n').filter(line => /^\| fake-model \| (a|b|c) \| [LPK]\d \|/u.test(line)).length, 36);
});

test('鍵らしい文字: モデルの答えや道具の名前に鍵が入っても、表には出ない', async t => {
  const adapter = fakeAdapter(true);
  const result = await runProbe({ model, adapter, sets: ['b'], questions: MESH_QUESTIONS.slice(0, 2), base: realpathSync.native(tempDir(t)), maxTurns: 3, maxTokens: 500, timeoutMs: 10_000, secrets: [SECRET] });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(r => r.tools.length === 1 && !r.tools[0]!.includes(SECRET) && r.tools[0]!.includes('[REDACTED]')), JSON.stringify(result.rows.map(r => r.tools)));
  assert.ok(result.rows.every(r => !r.answer.includes(SECRET) && r.answer.includes('[REDACTED]')));
  const report = renderReport(result.rows, { title: 't', notes: result.notes, requests: { [model.id]: result.request } });
  assert.ok(!report.includes(SECRET));
  assert.match(report, /\[REDACTED\]/u);
});

test('相手に届かないモデルでも最後まで走り、どの問いも失敗として表に残り、トークンと判定は n/a', async t => {
  const dead: ProviderAdapter = { provider, async *stream() { throw new Error('connect ECONNREFUSED 127.0.0.1:1'); }, async probe() { throw new Error('not used'); } };
  const result = await runProbe({ model, adapter: dead, sets: ['a', 'c'], base: realpathSync.native(tempDir(t)), maxTurns: 2, maxTokens: 100, timeoutMs: 1000 });
  assert.equal(result.rows.length, 24);
  assert.ok(result.rows.every(r => r.failed?.includes('ECONNREFUSED') && !r.correct));
  assert.match(result.notes.join('\n'), /compaction failed/u);
  const report = renderReport(result.rows, { title: 'Mesh probe', notes: result.notes, requests: { [model.id]: result.request } });
  assert.match(report, /^\| fake-model \| c \| 0 \/ 12 .*\| 0 \/ n\/a \| n\/a \| \d+ \(\d+ \+ \d+\) \| 12 \|$/mu);
  assert.match(report, /\| fake-model \| a -> c \| 0 \| 0 -> 0 \| [\d.]+ \| n\/a: 24 failed questions \|/u);
});
