import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { minimalEffort, providerNote, renderReport, runProbe, summarizeRows, type ProbeRow } from '../scripts/judge-probe.ts';
import { approvalPaths } from '../src/tools/approvals.ts';
import { isInside, realish } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import type { ModelConfig, ProviderConfig } from '../src/config/schema.ts';
import type { ModelRequest, ProviderAdapter, StreamEvent } from '../src/providers/types.ts';
import { ACTION_BODY_LIMIT, TAINTED_NOTE } from '../src/tools/auto-approve.ts';
import { guardText, type GuardMessageKey } from '../src/shared/messages/guard.ts';
import { sanitizeModelInputText } from '../src/shared/redaction.ts';
import { JUDGE_CASES, JUDGE_CONTROLS, JUDGE_EXFIL_CASES, judgeCases, judgeControls, judgeExfilCases, type JudgeLayout } from './fixtures/judge-cases.ts';
import { tempDir } from './helpers.ts';

const provider: ProviderConfig = { id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
const model: ModelConfig = { id: 'fake-model', provider: 'fake', model: 'fake', maxOutputTokens: 8192, vision: false };
const ALLOW = '{"decision":"allow","reason":"serves the request"}';
const SECRET = 'zq-probe-secret-7f3a9c1d';
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

test('判定役の例: 通すべき 10 と積むべき 10 があり、どれも順 5 の形。外を読んだ例は 1 行の印だけで、段階 4 で消える理由を持たない', () => {
  assert.equal(JUDGE_CASES.length, 20);
  assert.equal(JUDGE_CASES.filter(c => c.expect === 'allow').length, 10);
  assert.equal(JUDGE_CASES.filter(c => c.expect === 'ask').length, 10);
  assert.equal(new Set([...JUDGE_CASES, ...JUDGE_CONTROLS].map(c => c.id)).size, JUDGE_CASES.length + JUDGE_CONTROLS.length);
  for (const c of JUDGE_CASES) {
    assert.equal(c.step, 5, c.id);
    assert.equal(c.input.tool, 'shell_run', c.id);
    assert.ok(c.input.userRequest.trim(), c.id);
    assert.ok(c.input.body.length <= ACTION_BODY_LIMIT, c.id);
    assert.ok(c.input.reasons.length > 0, c.id);
  }
  const bodies = JUDGE_CASES.map(c => `${c.expect} ${c.input.body}`);
  for (const [expect, pattern] of [['allow', /^Get-Content /u], ['allow', /^npm install dayjs$/u], ['allow', /^git fetch/u], ['allow', /^git checkout -b /u], ['allow', /^git stash/u], ['allow', /^npm test$/u], ['allow', /^curl\.exe .*127\.0\.0\.1:5173/u], ['ask', /^Stop-Service /u], ['ask', /^npm install chart-helper-pro/u], ['ask', /^git apply /u]] as const) {
    assert.ok(bodies.some(b => b.startsWith(`${expect} `) && pattern.test(b.slice(expect.length + 1))), `${expect} ${pattern}`);
  }
  const npmrc = JUDGE_CASES.find(c => c.input.body === 'npm test')!;
  assert.match(npmrc.input.reasons.join(' '), /\.npmrc/u);
  const taint = guardText('en', 'pipeline.taint', { sources: 'web_fetch' });
  for (const id of ['ask-npm-install-from-web', 'ask-git-apply-tainted', 'ask-force-push-tainted']) {
    const c = JUDGE_CASES.find(x => x.id === id)!;
    assert.equal(c.input.tainted, true, id);
  }
  for (const c of [...JUDGE_CASES, ...JUDGE_CONTROLS]) assert.ok(!c.input.reasons.includes(taint), c.id);
  assert.ok(JUDGE_CASES.some(c => c.expect === 'ask' && c.input.body.startsWith('Set-Content -Path C:\\Users\\owner\\Documents\\')));
});

test('判定役の例の対照: 製品の git add・git commit と方針 Ask の道具は順 3・4 で決まり、判定役に送らない', async () => {
  assert.deepEqual(JUDGE_CONTROLS.map(c => c.input.body.split(' ').slice(0, 2).join(' ')).filter(b => b.startsWith('git ')), ['git add', 'git commit']);
  assert.ok(JUDGE_CONTROLS.some(c => c.step === 3 && /settings/u.test(c.input.reasons.join(' '))));
  assert.ok(JUDGE_CONTROLS.some(c => c.step === 1 && /sk-ant-/u.test(c.input.body)));
  for (const c of JUDGE_CONTROLS) assert.notEqual(c.step, 5, c.id);
  const adapter = fakeAdapter(() => ({ text: ASK }));
  const rows = await runProbe({ model, provider, adapter, cases: [...JUDGE_CASES, ...JUDGE_CONTROLS], runs: 1, modes: ['a'], maxTokens: 400, timeoutMs: 2000 });
  assert.equal(rows.length, JUDGE_CASES.length);
  assert.equal(adapter.requests.length, JUDGE_CASES.length);
  for (const c of JUDGE_CONTROLS) assert.ok(!adapter.requests.some(r => userOf(r).includes(c.input.body)), c.id);
});

test('試しの提供元: 例ごと・回ごと・流し方ごとに 1 行。許すべきでないものを許した・切れた・読めない・時間切れを数え、表に出す', async () => {
  const wrong = JUDGE_CASES.find(c => c.id === 'ask-stop-service')!;
  const cut = JUDGE_CASES.find(c => c.id === 'allow-git-fetch')!;
  const junk = JUDGE_CASES.find(c => c.id === 'allow-git-stash')!;
  const slow = JUDGE_CASES.find(c => c.id === 'allow-npm-test-npmrc')!;
  const adapter = fakeAdapter(request => {
    const c = caseOf(request);
    if (c === wrong) return { text: ALLOW };
    if (c === cut) return { text: `<think>let me consider\n${ALLOW}`, stop: 'max_tokens' };
    if (c === junk) return { text: `I think this is fine. ${SECRET}` };
    if (c === slow) return { text: ALLOW, delayMs: 400 };
    return { text: c.expect === 'allow' ? ALLOW : ASK };
  });
  const rows = await runProbe({ model, provider, adapter, cases: JUDGE_CASES, runs: 2, modes: ['a', 'b'], effort: 'low', maxTokens: 400, timeoutMs: 150, secrets: [SECRET] });
  assert.equal(rows.length, JUDGE_CASES.length * 2 * 2);
  assert.ok(adapter.requests.every(r => r.maxOutputTokens === 400 && r.tools.length === 0));
  // AP-1d: an unreadable reply (the cut and the junk case) is asked once more, so each of their 2 runs sends 2 requests per mode
  assert.ok(adapter.requests.filter(r => r.effort === 'low').length === JUDGE_CASES.length * 2 + 4);
  assert.ok(adapter.requests.filter(r => r.effort === undefined).length === JUDGE_CASES.length * 2 + 4);
  const tainted = adapter.requests.find(r => userOf(r).includes('git apply'))!;
  assert.ok(userOf(tainted).includes(TAINTED_NOTE));
  const of = (id: string) => rows.filter(r => r.caseId === id);
  assert.ok(of(wrong.id).every(r => r.decision === 'allow' && r.wrongAllow));
  assert.ok(of(cut.id).every(r => r.decision === 'ask' && r.failed === 'unparsable' && r.truncated));
  assert.ok(of(junk.id).every(r => r.decision === 'ask' && r.failed === 'unparsable' && !r.truncated && r.raw.includes('fine') && !r.raw.includes(SECRET) && r.raw.includes('[REDACTED]')));
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

const STEP3_KEYS: readonly GuardMessageKey[] = ['guard.write_persona', 'guard.write_skill', 'guard.write_git', 'guard.write_instructions', 'list.tool_config', 'list.write_ancestor', 'list.secret_in_deps', 'list.git_config', 'code.git_config', 'list.git_hooks', 'list.git_remote', 'list.git_remote_local', 'file.git', 'file.instructions', 'file.persona', 'file.skill', 'file.skill_auto', 'file.tool_config'];
const STEP4_KEYS: readonly GuardMessageKey[] = ['code.file_run', 'code.stdin_run', 'code.cmd_is_file', 'code.arg_file', 'code.project_tool', 'list.command', 'list.external', 'list.git_write'];
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const keyOf = (reason: string): GuardMessageKey | undefined => (Object.entries(guardText.tables.en) as Array<[GuardMessageKey, string]>)
  .find(([, template]) => new RegExp(`^${escapeRe(template).replace(/\\\{\w+\\\}/gu, '[\\s\\S]*')}$`, 'u').test(reason))?.[0];

function judgeLayout(t: { after: (fn: () => void) => void }): JudgeLayout {
  const base = realish(tempDir(t));
  const home = join(base, 'home');
  const work = join(home, 'beat-work');
  const layout: JudgeLayout = { home, work, product: join(work, 'products', 'todo-app'), shop: join(work, 'products', 'shop-app'), outside: join(base, 'D') };
  for (const dir of [layout.product, layout.shop, join(layout.outside, 'notes'), join(home, 'Documents')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(layout.product, 'AGENTS.md'), '# rules\n');
  writeFileSync(join(layout.product, 'package.json'), '{"name":"todo"}\n');
  writeFileSync(join(layout.product, 'map.md'), '# map\n');
  writeFileSync(join(layout.shop, 'package.json'), '{"scripts":{"test":"node t.js"}}\n');
  writeFileSync(join(layout.shop, '.npmrc'), 'registry=https://registry.npmjs.org/\n');
  for (const repo of [layout.product, layout.shop]) {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/owner/app.git']);
  }
  return layout;
}

test('判定役の例は、今の見張りに本当にかけると、断られず確かめになり、理由とパスが例と同じで、順 3 の理由も順 4 の形も無い', { skip: process.platform !== 'win32' }, t => {
  const layout = judgeLayout(t);
  const policy = { roots: [{ path: layout.work, mode: 'write' as const }], deny: [] };
  const env = { ...process.env, HOME: layout.home, USERPROFILE: layout.home, APPDATA: join(layout.home, 'AppData', 'Roaming') };
  const check = (body: string, cwd: string) => checkShellCommand(body, cwd, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, env });
  const reasonsOf = (v: ReturnType<typeof check>) => v.limits ? [...v.reasons, guardText('en', 'code.limits')] : v.reasons;
  const step3 = (keys: Array<GuardMessageKey | undefined>) => keys.some(k => k !== undefined && STEP3_KEYS.includes(k));
  const step4Shape = (cwd: string, v: ReturnType<typeof check>, keys: Array<GuardMessageKey | undefined>) =>
    [layout.product, layout.shop].some(p => isInside(p, cwd) && v.paths.every(x => x.path !== undefined && isInside(p, x.path)))
    && keys.filter(k => k !== 'code.limits').every(k => k !== undefined && STEP4_KEYS.includes(k));
  for (const c of judgeCases(layout)) {
    const verdict = check(c.input.body, c.input.cwd!);
    assert.equal(verdict.decision, 'ask', c.id);
    const reasons = reasonsOf(verdict);
    assert.deepEqual(reasons, c.input.reasons, c.id);
    assert.deepEqual(approvalPaths(verdict.paths), c.input.paths, c.id);
    const keys = reasons.map(keyOf);
    assert.ok(keys.every(k => k !== undefined), `${c.id}: ${reasons}`);
    assert.ok(!step3(keys), `${c.id}: ${keys}`);
    assert.ok(!step4Shape(c.input.cwd!, verdict, keys), `${c.id} has the step-4 shape`);
  }
  const mapRun = check('.\\map.md', layout.product);
  assert.equal(mapRun.decision, 'ask');
  assert.ok(step4Shape(layout.product, mapRun, reasonsOf(mapRun).map(keyOf)), `map.md: ${reasonsOf(mapRun)}`);
  const hooksPath = check('git config core.hooksPath hooks', layout.product);
  assert.ok(step3(reasonsOf(hooksPath).map(keyOf)), `hooksPath: ${hooksPath.reasons}`);
  const controls = judgeControls(layout);
  for (const id of ['control-git-add', 'control-git-commit']) {
    const c = controls.find(x => x.id === id)!;
    const verdict = check(c.input.body, c.input.cwd!);
    assert.equal(verdict.decision, 'ask', id);
    assert.deepEqual(verdict.reasons, c.input.reasons, id);
    assert.ok(verdict.reasons.every(r => keyOf(r) === 'list.git_write'), id);
  }
  const key = controls.find(x => x.id === 'control-curl-key')!;
  assert.notEqual(check(key.input.body, key.input.cwd!).decision, 'ask');
});

test('判定役の持ち出しの例（W-1b）: 20 例とは別に 2 例。どちらも順 5・外を読んだ印・理由は list.redirect・宛先なし・本文は上限の中で鍵の形をしない・id が重ならない', t => {
  assert.deepEqual(JUDGE_EXFIL_CASES.map(c => [c.id, c.expect]), [['ask-get-exfil-tainted', 'ask'], ['allow-get-public-tainted', 'allow']]);
  assert.equal(new Set([...JUDGE_CASES, ...JUDGE_CONTROLS, ...JUDGE_EXFIL_CASES].map(c => c.id)).size, JUDGE_CASES.length + JUDGE_CONTROLS.length + 2);
  const redirect = guardText('en', 'list.redirect', { cmd: 'curl' });
  for (const c of JUDGE_EXFIL_CASES) {
    assert.equal(c.step, 5, c.id);
    assert.equal(c.input.tainted, true, c.id);
    assert.deepEqual(c.input.reasons, [redirect], c.id);
    assert.deepEqual(c.input.trusted, [], c.id);
    assert.ok(c.input.userRequest.trim(), c.id);
    assert.ok(c.input.body.length <= ACTION_BODY_LIMIT, c.id);
    assert.match(c.input.body, /^curl -sL /u, c.id);
    assert.equal(sanitizeModelInputText(c.input.body).text, c.input.body, `${c.id}: 鍵の形をしない（順 1 で断られない）`);
  }
  if (process.platform === 'win32') {
    const layout = judgeLayout(t);
    const policy = { roots: [{ path: layout.work, mode: 'write' as const }], deny: [] };
    for (const c of judgeExfilCases(layout)) {
      const verdict = checkShellCommand(c.input.body, c.input.cwd!, { policy, outsideRoots: 'ask', shell: 'powershell', windows: true, env: process.env });
      assert.equal(verdict.decision, 'ask', c.id);
      assert.deepEqual(verdict.reasons, c.input.reasons, c.id);
    }
  }
});

test('読めた答えの理由に秘密があっても、行と表には伏せて残す', async () => {
  const adapter = fakeAdapter(() => ({ text: `{"decision":"allow","reason":"fine ${SECRET}"}` }));
  const cases = [JUDGE_CASES.find(c => c.expect === 'allow')!];
  const rows = await runProbe({ model, provider, adapter, cases, runs: 1, modes: ['a'], maxTokens: 400, timeoutMs: 2000, secrets: [SECRET] });
  assert.equal(rows[0]!.decision, 'allow');
  assert.ok(!rows[0]!.reason.includes(SECRET) && rows[0]!.reason.includes('[REDACTED]'), rows[0]!.reason);
  assert.ok(!rows[0]!.raw.includes(SECRET));
  assert.ok(!renderReport(rows, { cases, controls: [], title: 't', notes: [] }).includes(SECRET));
});

test('表に書く提供元の 1 行: 送り先の URL の利用者名・パスワードと鍵を伏せる', () => {
  const withCreds: ProviderConfig = { ...provider, baseUrl: 'http://user:hunter2-pass@127.0.0.1:8081/v1?api_key=zq-probe-secret-7f3a9c1d' };
  const note = providerNote('m', withCreds, model, [SECRET]);
  assert.ok(!note.includes('hunter2-pass'), note);
  assert.ok(!note.includes(SECRET), note);
  assert.match(note, /127\.0\.0\.1:8081/u);
});
