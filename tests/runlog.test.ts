import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TRIGGER_TEXT } from '../src/memory/review.ts';
import type { ReviewJob, RunRow, ToolCallRow } from '../web/src/api.ts';
import { parseRoute, routeHash } from '../web/src/ui/routes.ts';
import {
  changeLabel, decidedByLabel, decisionLabel, formatTokens, jobStatusLabel, jobTriggerLabel, runDetail, runKindLabel,
  runSeconds, runStatus, toolStatus,
} from '../web/src/runlog-meta.ts';
import { startScreenServer } from './screen-server.ts';

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'r', kind: 'chat', conversation_id: 'c', model_id: 'local', attempts: 1, started_at: 1, duration_ms: 3200, ok: 1, error_kind: null, error_message: null,
  input_tokens: 3200, output_tokens: 412, cache_read_tokens: 1100, est_prompt_tokens: 3300, flags: [], ...over,
});
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('実行の結果: 成功・失敗（種類を訳す）・実行中を分け、知らない種類はコードのまま出す', () => {
  assert.deepEqual(runStatus(run()), { icon: 'check', tone: 'plain', label: 'Success' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: 'rate_limit' })), { icon: 'x', tone: 'bad', label: 'Rate limit' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: 'something_new' })), { icon: 'x', tone: 'bad', label: 'something_new' });
  assert.deepEqual(runStatus(run({ ok: 0, error_kind: null })), { icon: 'x', tone: 'bad', label: 'Error' });
  assert.deepEqual(runStatus(run({ ok: null })), { icon: 'loader', tone: 'wait', label: 'Running' });
  assert.equal(runStatus(run({ ok: 0, error_kind: 'context_overflow' })).label, 'Context too small');
  assert.equal(runStatus(run({ ok: null })).label, 'Running');
});

test('トークンの短い書き方と、秒数・実行の種類', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1000), '1.0k');
  assert.equal(formatTokens(3249), '3.2k');
  assert.equal(formatTokens(70000), '70.0k');
  assert.equal(runSeconds(3200), '3.2 s');
  assert.equal(runSeconds(null), '—');
  assert.equal(runKindLabel('review'), 'Review');
  assert.equal(runKindLabel('future_kind'), 'future_kind');
  assert.equal(runSeconds(41800), '41.8 s');
  assert.equal(runKindLabel('task'), 'Task');
});

test('実行の詳細: 成功は入出力とキャッシュ、失敗は理由と試行。見積もりと印はどちらにも付く', () => {
  assert.equal(runDetail(run()), 'in 3.2k · out 412 · cache 1.1k · est. 3.3k');
  assert.equal(runDetail(run({ attempts: 3, flags: ['text_tool_calls', 'x'], cache_read_tokens: 0 })), 'in 3.2k · out 412 · 3 attempts · est. 3.3k · text_tool_calls and x', '付いた印の区切りは、言語の並べ方（Intl.ListFormat）');
  assert.equal(runDetail(run({ ok: 0, error_message: '429 Too Many Requests', attempts: 3, input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: 4100 })), '429 Too Many Requests · 3 attempts · est. 4.1k');
  assert.equal(runDetail(run({ ok: 0, error_message: '中止しました', attempts: 0, est_prompt_tokens: null })), '中止しました');
  assert.equal(runDetail(run({ ok: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, est_prompt_tokens: null })), '', '実行中で何も無ければ空');
  assert.equal(runDetail(run({ attempts: 2 })), 'in 3.2k · out 412 · cache 1.1k · 2 attempts · est. 3.3k');
  assert.equal(runDetail(run({ ok: 0, error_message: 'boom', attempts: 1, est_prompt_tokens: null })), 'boom · 1 attempt');
  assert.equal(runDetail(run({ flags: ['a', 'b', 'c'] })), 'in 3.2k · out 412 · cache 1.1k · est. 3.3k · a, b, and c');
});

test('道具の記録: 判定の札と、決めたのは誰かを訳す。知らない値はそのまま出す', () => {
  assert.deepEqual((['allow', 'ask', 'deny'] as const).map(decisionLabel), ['Allowed', 'Asked for approval', 'Denied']);
  assert.deepEqual(['builtin', 'registry', 'validation', 'user', 'conversation-grant'].map(decidedByLabel), ['Built-in', 'Tool registry', 'Argument check', 'You', 'Granted for this chat']);
  assert.equal(decidedByLabel('hook:no-lan'), 'Hook no-lan');
  assert.equal(decidedByLabel('mystery'), 'mystery');
  assert.deepEqual(toolStatus(null), { icon: 'clock', tone: 'wait', label: 'Waiting' });
  assert.deepEqual(toolStatus(1), { icon: 'check', tone: 'plain', label: 'Success' });
  assert.deepEqual(toolStatus(0), { icon: 'x', tone: 'bad', label: 'Failed' });
  assert.equal(decisionLabel('ask'), 'Asked for approval');
  assert.equal(decidedByLabel('hook:no-lan'), 'Hook no-lan');
  assert.equal(toolStatus(null).label, 'Waiting');
});

test('振り返りの記録: きっかけ・状態・変更の種類をコードから訳す', () => {
  assert.equal(jobTriggerLabel('heavy_run'), 'Many tools were used');
  assert.equal(jobTriggerLabel('new_trigger'), 'new_trigger');
  assert.deepEqual((['pending', 'running', 'done', 'failed'] as ReviewJob['status'][]).map(jobStatusLabel), ['Waiting', 'Running', 'Done', 'Failed']);
  assert.deepEqual(['create', 'update', 'forget', 'restore', 'other'].map(changeLabel), ['Added', 'Rewrote', 'Deleted', 'Restored', 'other']);
  assert.equal(jobTriggerLabel('idle'), 'The conversation went quiet');
  assert.equal(changeLabel('forget'), 'Deleted');
});

test('コードの網羅: サーバーが作る種類は、すべて辞書に訳がある（足されたのに画面が知らない、を防ぐ）', () => {
  const errorKinds = [...(/export type EngineErrorKind =([^;]*);/u.exec(source('src/engine/types.ts'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(m => m[1]!);
  assert.ok(errorKinds.length >= 7, `EngineErrorKind を読めた: ${errorKinds.join(',')}`);
  for (const kind of errorKinds) {
    assert.notEqual(runStatus({ ok: 0, error_kind: kind }).label, kind, `${kind} の訳`);
  }
  const runKinds = [...(/export type RunKind =([^;]*);/u.exec(source('src/tools/types.ts'))?.[1] ?? '').matchAll(/'([a-z_]+)'/gu)].map(m => m[1]!);
  assert.deepEqual(runKinds.sort(), ['agent', 'chat', 'review', 'task']);
  for (const kind of runKinds) assert.notEqual(runKindLabel(kind), kind);
  const pipeline = source('src/tools/pipeline.ts');
  const decidedBy = new Set([
    ...[...pipeline.matchAll(/decidedBy = '([a-z-]+)'/gu)].map(m => m[1]!),
    ...[...pipeline.matchAll(/refuse\('(?:allow|ask|deny)', '([a-z-]+)'/gu)].map(m => m[1]!),
    ...[...pipeline.matchAll(/decidedBy: '([a-z-]+)'/gu)].map(m => m[1]!),
  ]);
  assert.ok(decidedBy.size >= 5, `決めた人の値を読めた: ${[...decidedBy].join(',')}`);
  for (const by of decidedBy) assert.notEqual(decidedByLabel(by), by, `${by} の訳`);
  assert.ok(source('src/tools/pipeline.ts').includes('`hook:${result.hook}`'), 'フックの名前は hook:<名前> の形');
  for (const trigger of Object.keys(TRIGGER_TEXT.en)) {
    assert.equal(jobTriggerLabel(trigger), TRIGGER_TEXT.en[trigger as keyof typeof TRIGGER_TEXT.en], `${trigger}: 画面の訳はサーバーの英語と同じ`);
    assert.notEqual(jobTriggerLabel(trigger), trigger);
  }
});

test('経路: #/runs[/run|/tools|/reviews] と、振り返りの実行中のリンク。古い #/review は Skills へ', () => {
  assert.deepEqual(parseRoute('#/runs'), { view: 'runs' });
  assert.deepEqual(parseRoute('#/runs/tools'), { view: 'runs', tab: 'tools' });
  assert.deepEqual(parseRoute('#/runs/reviews'), { view: 'runs', tab: 'reviews' });
  assert.deepEqual(parseRoute('#/runs/reviews?x=1'), { view: 'runs', tab: 'reviews' });
  assert.deepEqual(parseRoute('#/runs/unknown'), { view: 'runs' });
  for (const hash of ['#/runs', '#/runs/tools', '#/runs/reviews']) assert.equal(routeHash(parseRoute(hash)), hash);
  assert.deepEqual(parseRoute('#/review'), { view: 'skills' });
});

test('画面が使う API: 実行・道具・振り返りの記録を、画面の読み取りで表にできる', async t => {
  const s = await startScreenServer(t);
  const now = Date.now();
  s.app.db.prepare(`INSERT INTO engine_runs (id, kind, model_id, attempts, started_at, ended_at, duration_ms, ok, error_kind, error_message, est_prompt_tokens, flags)
    VALUES ('r-fail', 'task', 'local', 2, ?, ?, 900, 0, 'context_overflow', '長さが足りません', 70000, '["server_truncation_suspected"]')`).run(now, now + 900);
  s.app.db.prepare(`INSERT INTO engine_runs (id, kind, model_id, attempts, started_at, ok, flags) VALUES ('r-live', 'review', 'local', 1, ?, NULL, '[]')`).run(now + 1);
  const insertCall = s.app.db.prepare(`INSERT INTO tool_calls (id, run_id, tool, input, decision, decided_by, ok, created_at) VALUES (?, 'r-fail', ?, '{}', ?, ?, ?, ?)`);
  insertCall.run('k1', 'shell_run', 'ask', 'user', null, now);
  insertCall.run('k2', 'web_fetch', 'deny', 'hook:no-lan', 0, now + 1);
  s.app.reviews.enqueue('idle', 'k:1', { conversationId: 'c1' });
  s.app.reviews.finish(s.app.reviews.next()!.id, 'done', '変えるものはありませんでした');

  const runs = ((await (await s.api('/api/runs?limit=200')).json()) as { runs: RunRow[] }).runs;
  const live = runs.find(r => r.id === 'r-live')!;
  assert.deepEqual(runStatus(live), { icon: 'loader', tone: 'wait', label: 'Running' });
  const failed = runs.find(r => r.id === 'r-fail')!;
  assert.ok(Array.isArray(failed.flags), 'flags は配列で来る');
  assert.equal(runStatus(failed).label, 'Context too small');
  assert.equal(runKindLabel(failed.kind), 'Task');
  assert.equal(runDetail(failed), '長さが足りません · 2 attempts · est. 70.0k · server_truncation_suspected');

  const calls = ((await (await s.api('/api/tool-calls?limit=200')).json()) as { toolCalls: ToolCallRow[] }).toolCalls;
  assert.deepEqual(calls.map(c => c.id), ['k2', 'k1'], '新しい順');
  const denied = calls.find(c => c.id === 'k2')!;
  assert.deepEqual([decisionLabel(denied.decision), decidedByLabel(denied.decided_by), toolStatus(denied.ok).label], ['Denied', 'Hook no-lan', 'Failed']);
  const asked = calls.find(c => c.id === 'k1')!;
  assert.deepEqual([decisionLabel(asked.decision), decidedByLabel(asked.decided_by), toolStatus(asked.ok).label], ['Asked for approval', 'You', 'Waiting']);

  const reviews = (await (await s.api('/api/reviews')).json()) as { jobs: ReviewJob[]; pending: number };
  assert.equal(reviews.jobs.length, 1);
  assert.equal(jobTriggerLabel(reviews.jobs[0]!.trigger), 'The conversation went quiet');
  assert.equal(jobStatusLabel(reviews.jobs[0]!.status), 'Done');
  assert.equal(reviews.pending, 0);
  assert.ok(readFileSync(new URL('../web/src/api.ts', import.meta.url), 'utf8').includes('/api/tool-calls?limit=200'));
});

test('段 8b: 実行ログの「決めたのは」に、自動承認と計画モードが英語で出る（理由が API の行に載ることは、tests/auto-approve-engine.test.ts が実際の API で確かめる）', () => {
  assert.equal(decidedByLabel('auto-mode'), 'Auto-approve');
  assert.equal(decidedByLabel('mode'), 'Plan mode');
});
