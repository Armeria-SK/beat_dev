import assert from 'node:assert/strict';
import { test } from 'node:test';
import { minimalEffort, renderReport, runProbe, summarizeRows, type ProbeRow } from '../scripts/judge-probe.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { ACTION_BODY_LIMIT, TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import { guardText } from '../src/shared/messages/guard.ts';
import { JUDGE_CASES, JUDGE_CONTROLS } from './fixtures/judge-cases.ts';

const provider: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
const model: ModelConfig = { id: 'fake-model', provider: 'fake', model: 'fake', minContext: 65536, maxOutputTokens: 8192, vision: false };
const ALLOW = '{"decision":"allow","reason":"serves the request"}';
const ASK = '{"decision":"ask","reason":"not needed for the request"}';

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function fakeAdapter(reply: (request: ModelRequest) => { text: string; stop?: 'end_turn' | 'max_tokens'; delayMs?: number }): ProviderAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    provider,
    requests,
    async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const { text, stop = 'end_turn', delayMs = 0 } = reply(request);
      if (delayMs) await sleep(delayMs, request.signal);
      yield { type: 'text', delta: text };
      yield { type: 'done', stop };
    },
    async probe() { throw new Error('not used'); },
  };
}

const userOf = (request: ModelRequest) => String(request.messages[0]?.content ?? '');
const caseOf = (request: ModelRequest) => JUDGE_CASES.find(c => userOf(request).includes(c.input.userRequest) && userOf(request).includes(c.input.body.split('\n')[0]!))!;

test('判定役の例: 通すべき 10 と積むべき 10 があり、どれも順 5 に来る形で、判定役の前の決まりで先に断られない材料になっている', () => {
  assert.equal(JUDGE_CASES.length, 20);
  assert.equal(JUDGE_CASES.filter(c => c.expect === 'allow').length, 10);
  assert.equal(JUDGE_CASES.filter(c => c.expect === 'ask').length, 10);
  assert.equal(new Set([...JUDGE_CASES, ...JUDGE_CONTROLS].map(c => c.id)).size, JUDGE_CASES.length + JUDGE_CONTROLS.length);
  for (const c of JUDGE_CASES) {
    assert.equal(c.step, 5, c.id);
    assert.ok(c.input.userRequest.trim(), c.id);
    assert.ok(c.input.body.length <= ACTION_BODY_LIMIT, c.id);
    assert.ok(c.input.reasons.length > 0, c.id);
  }
  const bodies = JUDGE_CASES.map(c => `${c.expect} ${c.input.body}`);
  for (const [expect, pattern] of [['allow', /^cat /u], ['allow', /^npm install dayjs$/u], ['allow', /^git fetch/u], ['allow', /^git checkout -b /u], ['allow', /^git stash/u], ['allow', /^npm test$/u], ['allow', /^curl .*127\.0\.0\.1:5173/u], ['ask', /^systemctl stop/u], ['ask', /^npm install chart-helper-pro/u], ['ask', /^git apply /u]] as const) {
    assert.ok(bodies.some(b => b.startsWith(`${expect} `) && pattern.test(b.slice(expect.length + 1))), `${expect} ${pattern}`);
  }
  const npmrc = JUDGE_CASES.find(c => c.input.body === 'npm test')!;
  assert.match(npmrc.input.reasons.join(' '), /\.npmrc/u);
  const taint = guardText('en', 'pipeline.taint', { sources: 'web_fetch' });
  for (const id of ['ask-npm-install-from-web', 'ask-git-apply-tainted']) {
    const c = JUDGE_CASES.find(x => x.id === id)!;
    assert.equal(c.input.tainted, true, id);
    assert.ok(c.input.reasons.includes(taint), id);
  }
  assert.ok(JUDGE_CASES.some(c => c.expect === 'ask' && c.input.tool === 'file_write' && c.input.paths.some(p => p.input.startsWith('C:\\Users\\owner\\') && p.mode === 'write')));
});

test('判定役の例の対照: 製品の git add・git commit と方針 Ask の道具は順 3・4 で決まり、判定役に送らない', async () => {
  assert.deepEqual(JUDGE_CONTROLS.map(c => c.input.body.split(' ').slice(0, 2).join(' ')).filter(b => b.startsWith('git ')), ['git add', 'git commit']);
  assert.ok(JUDGE_CONTROLS.some(c => c.step === 3 && /settings/u.test(c.input.reasons.join(' '))));
  for (const c of JUDGE_CONTROLS) assert.notEqual(c.step, 5, c.id);
  const adapter = fakeAdapter(() => ({ text: ASK }));
  const rows = await runProbe({ model, provider, adapter, cases: [...JUDGE_CASES, ...JUDGE_CONTROLS], runs: 1, modes: ['a'], maxTokens: 400, timeoutMs: 2000 });
  assert.equal(rows.length, JUDGE_CASES.length);
  assert.equal(adapter.requests.length, JUDGE_CASES.length);
  for (const c of JUDGE_CONTROLS) assert.ok(!adapter.requests.some(r => userOf(r).includes(c.input.body)), c.id);
});

test('試しの提供元: 例ごと・回ごと・流し方ごとに 1 行。許すべきでないものを許した・切れた・読めない・時間切れを数え、表に出す', async () => {
  const wrong = JUDGE_CASES.find(c => c.id === 'ask-systemctl-stop')!;
  const cut = JUDGE_CASES.find(c => c.id === 'allow-git-fetch')!;
  const junk = JUDGE_CASES.find(c => c.id === 'allow-git-stash')!;
  const slow = JUDGE_CASES.find(c => c.id === 'allow-npm-test-npmrc')!;
  const adapter = fakeAdapter(request => {
    const c = caseOf(request);
    if (c === wrong) return { text: ALLOW };
    if (c === cut) return { text: '<think>let me consider', stop: 'max_tokens' };
    if (c === junk) return { text: 'I think this is fine.' };
    if (c === slow) return { text: ALLOW, delayMs: 400 };
    return { text: c.expect === 'allow' ? ALLOW : ASK };
  });
  const rows = await runProbe({ model, provider, adapter, cases: JUDGE_CASES, runs: 2, modes: ['a', 'b'], effort: 'low', maxTokens: 400, timeoutMs: 150 });
  assert.equal(rows.length, JUDGE_CASES.length * 2 * 2);
  assert.ok(adapter.requests.every(r => r.maxOutputTokens === 400 && r.tools.length === 0));
  assert.ok(adapter.requests.filter(r => r.effort === 'low').length === JUDGE_CASES.length * 2);
  assert.ok(adapter.requests.filter(r => r.effort === undefined).length === JUDGE_CASES.length * 2);
  const tainted = adapter.requests.find(r => userOf(r).includes('git apply'))!;
  assert.ok(userOf(tainted).includes(TAINTED_NOTE));
  const of = (id: string) => rows.filter(r => r.caseId === id);
  assert.ok(of(wrong.id).every(r => r.decision === 'allow' && r.wrongAllow));
  assert.ok(of(cut.id).every(r => r.decision === 'ask' && r.failed === 'unparsable' && r.truncated));
  assert.ok(of(junk.id).every(r => r.decision === 'ask' && r.failed === 'unparsable' && !r.truncated && r.raw.includes('fine')));
  assert.ok(of(slow.id).every(r => r.decision === 'ask' && r.failed === 'timeout'));
  assert.equal(rows.filter(r => r.wrongAllow).length, 4);
  const summary = summarizeRows(rows);
  assert.equal(summary.length, 2);
  for (const s of summary) {
    assert.equal(s.calls, 40);
    assert.equal(s.wrongAllow, 2);
    assert.deepEqual(s.wrongAllowCases, [wrong.id]);
    assert.equal(s.failed, 6);
    assert.equal(s.failedPct, 15);
    assert.equal(s.truncated, 2);
    assert.ok(s.medianMs >= 0);
  }
  const report = renderReport(rows, { cases: JUDGE_CASES, controls: JUDGE_CONTROLS, title: 'fake run', notes: [] });
  for (const c of JUDGE_CASES) assert.ok(report.includes(c.id), c.id);
  for (const c of JUDGE_CONTROLS) assert.ok(report.includes(c.id), c.id);
  assert.match(report, /WRONG ALLOW/u);
  assert.match(report, /\| a \|.*\| 2 \|/u);
  assert.match(report, /truncated/u);
  assert.match(report, /timeout/u);
});

test('取り合いの中 (c): 別の長い返事が枠を持っているあいだ判定役は枠を待ち、その待ちも時間に数える', async () => {
  const LONG = 400;
  const adapter = fakeAdapter(request => request.system.frozen.includes('JUDGE-PROBE-CONTENTION') ? { text: 'a long essay', delayMs: LONG } : { text: ASK });
  const one = [JUDGE_CASES.find(c => c.expect === 'ask')!];
  const waited = await runProbe({ model, provider, adapter, cases: one, runs: 1, modes: ['c'], maxTokens: 400, timeoutMs: 3000 });
  assert.equal(waited.length, 1);
  assert.equal(waited[0]!.failed, undefined);
  assert.ok(waited[0]!.waitMs >= LONG - 100, String(waited[0]!.waitMs));
  assert.ok(waited[0]!.ms >= waited[0]!.waitMs);
  assert.equal(adapter.requests.filter(r => r.system.frozen.includes('JUDGE-PROBE-CONTENTION')).length, 1);
  const starved = await runProbe({ model, provider, adapter, cases: one, runs: 1, modes: ['c'], maxTokens: 400, timeoutMs: 100 });
  assert.equal(starved[0]!.failed, 'timeout');
  assert.equal(starved[0]!.decision, 'ask');
});

test('考える量の最小: 知っている順で一番小さいもの。無ければ undefined', () => {
  assert.equal(minimalEffort(['high', 'low', 'medium']), 'low');
  assert.equal(minimalEffort(['medium', 'none', 'minimal']), 'none');
  assert.equal(minimalEffort(['turbo']), 'turbo');
  assert.equal(minimalEffort([]), undefined);
});

test('表の数え方: 読めない・切れた・時間切れ・呼べないを答えない割合に数え、許すべきでないものを許した数は例ごとに出す', () => {
  const row = (over: Partial<ProbeRow>): ProbeRow => ({ model: 'm', mode: 'a', caseId: 'x', expect: 'ask', run: 1, decision: 'ask', reason: '', truncated: false, raw: '', ms: 10, waitMs: 0, wrongAllow: false, ...over });
  const s = summarizeRows([row({ ms: 30 }), row({ ms: 10, failed: 'error' }), row({ ms: 20, decision: 'allow', wrongAllow: true, caseId: 'y' }), row({ ms: 40, expect: 'allow', decision: 'ask' })])[0]!;
  assert.equal(s.calls, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.failedPct, 25);
  assert.equal(s.wrongAllow, 1);
  assert.deepEqual(s.wrongAllowCases, ['y']);
  assert.equal(s.wrongAsk, 1);
  assert.equal(s.medianMs, 25);
});
