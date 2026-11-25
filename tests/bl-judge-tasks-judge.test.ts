import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { ProviderError } from '../src/providers/types.ts';
import type { StopReason } from '../src/engine/types.ts';
import { judgeOnce, parseVerdict, type ClassifierInput, type ClassifierPrompt, type JudgeCall, type JudgeReply } from '../src/tools/auto-approve.ts';
import { judgeStats, recordJudgeCall } from '../src/tools/judge-stats.ts';
import { CONVERSATION, fakeModel, settled, startApp } from './app-setup.ts';
import type { Script } from './helpers.ts';

// BL-judge-tasks: 113（理由の切れ目）と 137（同じモデルを 2 回書いたときの数え・slot_timeout の見せ方）。判定役の答えの決まり（allow / ask）は変えない

const reasonOf = (reason: string): string => parseVerdict(JSON.stringify({ decision: 'ask', reason }))!.reason;

test('113: 理由が 120 字を超えるときは、切ったことが必ず … で分かる。文の終わりで切るのは上限の近くにあるときだけ（早い文の終わりで後ろを捨てない）', () => {
  const first = 'The command only reads a file inside the product folder and prints it.';
  const second = 'It then sends the text to a remote server that the request did not name at all.';
  assert.ok(first.length >= 60 && first.length + 1 + second.length > 120, `${first.length} ${second.length}`);
  const early = reasonOf(`${first} ${second}`);
  assert.ok(early.length <= 120 && early.endsWith('…'), `切ったことが … で分かる: ${early}`);
  assert.ok(early.includes('sends'), `2 文目（判定役の気にした所）が、1 文目の終わりで丸ごと消えない: ${early}`);

  const late = `${'a'.repeat(100)}. ${'b'.repeat(60)}`;
  assert.equal(reasonOf(late), `${'a'.repeat(100)}.…`, '文の終わりが上限の近くにあれば、そこで切って … を付ける');

  const jp = `${'あ'.repeat(70)}。${'い'.repeat(100)}`;
  const jpCut = reasonOf(jp);
  assert.ok(jpCut.length === 120 && jpCut.startsWith(`${'あ'.repeat(70)}。`) && jpCut.endsWith('…'), `日本語でも、早い句点で後ろを捨てない: ${jpCut}`);

  const words = reasonOf('word '.repeat(40));
  assert.ok(words.length <= 120 && /word…$/u.test(words), words);

  const flat = reasonOf(`short. ${'word '.repeat(40)}`);
  assert.ok(flat.length <= 120 && flat.endsWith('…') && flat.length > 60, `早い文の終わりだけに縮めない: ${flat}`);

  const solid = reasonOf('あ'.repeat(300));
  assert.equal(solid.length, 120);
  assert.ok(solid.endsWith('…'));
});

test('113: 120 字ちょうどまでは切らず、… も付けない。切るときも秘密は先に伏せたまま・サロゲートペアを割らない', () => {
  const exact = `${'a'.repeat(59)}. ${'b'.repeat(59)}`;
  assert.equal(exact.length, 120);
  assert.equal(reasonOf(exact), exact);

  const leaky = reasonOf(`${'x'.repeat(100)} key sk-ant-api03-${'a'.repeat(60)} and more text after it`);
  assert.doesNotMatch(leaky, /sk-ant|aaaa/u);
  assert.ok(leaky.length <= 120);

  const emoji = reasonOf('😀'.repeat(100));
  assert.ok(emoji.length <= 120 && emoji.endsWith('…'));
  assert.doesNotMatch(emoji, /\p{Surrogate}/u, '割れた半分が残らない');
});

const input: ClassifierInput = { userRequest: 'read the memo', tool: 'shell_run', title: 'read', body: 'cat memo.txt', reasons: ['outside'], paths: [] };
const ALLOW = '{"decision":"allow","reason":"ok"}';
const signal = new AbortController().signal;
const staged = { answerMs: 5_000, slotWaitMs: 5_000 };

// chat.ts の #autoAsk と #askJudge がするとおりに呼ぶ: 候補ごとに queued → started → used（その呼び出しの使用量。足し上げた値）
async function twoCandidates(ask: JudgeCall, first: { model: string; usage: { inputTokens: number; outputTokens: number } }, last: { model: string; usage: { inputTokens: number; outputTokens: number } }): Promise<JudgeReply> {
  ask.queued(); ask.started(); ask.used?.(first.model, first.usage);
  ask.queued(); ask.started(); ask.used?.(last.model, last.usage);
  return { text: ALLOW, model: last.model, usage: last.usage };
}

test('137: 判定役の一覧に同じモデルを 2 回書いても、1 つ目の呼び出しの使用量は 2 つ目に上書きされない（足し上げる）', async () => {
  const { verdict, spend } = await judgeOnce(input, async (_prompt: ClassifierPrompt, _signal: AbortSignal, call?: JudgeCall) => twoCandidates(call!, { model: 'm1', usage: { inputTokens: 100, outputTokens: 40 } }, { model: 'm1', usage: { inputTokens: 60, outputTokens: 10 } }), signal, staged);
  assert.equal(verdict.decision, 'allow');
  assert.deepEqual([spend.model, spend.inputTokens, spend.outputTokens], ['m1', 160, 50]);
});

test('137: 別のモデルに切り替わったときの足し上げは今までどおり（対照）。1 つの呼び出しが途中の使用量を何度も知らせても二重に数えない', async () => {
  const other = await judgeOnce(input, async (_p, _s, call) => twoCandidates(call!, { model: 'm1', usage: { inputTokens: 100, outputTokens: 40 } }, { model: 'm2', usage: { inputTokens: 60, outputTokens: 10 } }), signal, staged);
  assert.deepEqual([other.spend.model, other.spend.inputTokens, other.spend.outputTokens], ['m2', 160, 50]);

  const streaming = await judgeOnce(input, async (_p, _s, call) => {
    call!.queued(); call!.started();
    call!.used?.('m1', { inputTokens: 100, outputTokens: 5 });
    call!.used?.('m1', { inputTokens: 100, outputTokens: 30 });
    return { text: ALLOW, model: 'm1', usage: { inputTokens: 100, outputTokens: 30 } };
  }, signal, staged);
  assert.deepEqual([streaming.spend.inputTokens, streaming.spend.outputTokens], [100, 30]);
});

const say = (text: string, usage: { inputTokens: number; outputTokens: number }): Script => async function* () {
  yield { type: 'text', delta: text };
  yield { type: 'usage', usage };
  yield { type: 'done', stop: 'end_turn' as StopReason };
};
const breaksAfterUsage = (usage: { inputTokens: number; outputTokens: number }): Script => async function* () {
  yield { type: 'usage', usage };
  throw new ProviderError('provider_error', 'the judge stopped answering', { code: 'connect' });
};
const toolCall = (name: string, args: unknown): Script => async function* () {
  yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args } };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};
const isClassifier = (req: { tools: unknown[]; system: { frozen: string } }): boolean => req.tools.length === 0 && req.system.frozen.includes('safety checker');

test('137（エンジンを通して）: routing.judge に同じモデルを 2 つ書き、1 つ目が使用量を知らせたあと止まっても、judge_calls の使用量は 2 回分', async t => {
  const s = await startApp(t, { models: [fakeModel('m1'), fakeModel('m2')], configure: c => { c.routing.judge = ['m2', 'm2']; } });
  const outside = join(s.paths.data, 'outside.txt');
  mkdirSync(s.paths.workspace, { recursive: true });
  writeFileSync(outside, 'memo');
  const command = process.platform === 'win32' ? `Get-Content "${outside}"` : `cat "${outside}"`;
  s.adapter().scripts = [toolCall('shell_run', { command }), breaksAfterUsage({ inputTokens: 100, outputTokens: 40 }), say(ALLOW, { inputTokens: 100, outputTokens: 30 }), say('done', { inputTokens: 1, outputTokens: 1 })];
  const sent = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'read the memo', permissionMode: 'auto' });
  await settled(s.app, sent.body.runId);
  assert.deepEqual(s.adapter().calls.filter(isClassifier).map(c => c.model.id), ['m2', 'm2'], '同じモデルを 2 回呼ぶ');
  const rows = s.app.db.prepare('SELECT outcome, input_tokens AS inputTokens, output_tokens AS outputTokens FROM judge_calls').all().map(r => ({ ...r }));
  assert.deepEqual(rows, [{ outcome: 'allow', inputTokens: 200, outputTokens: 70 }]);
});

test('137: 別のモデルに切り替わったあとの slot_timeout は「モデルを呼ぶ前」と出さない。モデルを呼ぶ前の slot_timeout は今までどおり', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const base = { runKind: 'task' as const, projectId: null, tool: 'shell_run', reasonKeys: ['ask.curl'], askKinds: ['taint'], outcome: 'failed' as const, failed: 'slot_timeout' };
  recordJudgeCall(db, { ...base, runId: 'before', spend: { ms: 40_000 } }, 1_000);
  recordJudgeCall(db, { ...base, runId: 'after', spend: { ms: 60_000, model: 'm1', inputTokens: 100, outputTokens: 4 } }, 2_000);
  recordJudgeCall(db, { ...base, runId: 'no_judge', failed: 'no_judge', spend: { ms: 0 } }, 3_000);
  const failures = judgeStats(db, { since: 0, until: 10_000 }).failures;
  assert.deepEqual(failures.map(f => [f.reason, f.beforeModel, f.calls, f.inputTokens]).sort(), [['no_judge', true, 1, 0], ['slot_timeout', false, 1, 100], ['slot_timeout', true, 1, 0]]);
});
