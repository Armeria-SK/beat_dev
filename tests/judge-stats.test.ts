import assert from 'node:assert/strict';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { App } from '../src/app.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import type { JudgeReply } from '../src/tools/auto-approve.ts';
import { judgeStats, recordJudgeCall } from '../src/tools/judge-stats.ts';
import { runToolCall, type PipelineDeps } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { PreCheck, ToolContext, ToolDef } from '../src/tools/types.ts';
import { createWebServer } from '../src/web/server.ts';
import { readStats, renderStats } from '../scripts/judge-stats.ts';
import { FakeAdapter, tempDir, testConfig } from './helpers.ts';

const SECRET_INPUT = 'INPUT-MARK-7f3a';
const REQUEST_TEXT = 'REQUEST-MARK-91bc';
const REASON_TEXT = 'REASON-MARK-c40d';

const asking = (name: string, check: PreCheck): ToolDef<{ command: string }> => ({
  name, description: `${name} (test)`, input: Type.Object({ command: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task', 'agent', 'review'],
  preCheck: () => check,
  execute: async () => ({ content: 'ran' }),
});

const TOOLS: Array<ToolDef<{ command: string }>> = [
  asking('judged_tool', { decision: 'ask', reasons: [REASON_TEXT], askKinds: ['risky_command'], reasonKeys: ['list.flag', 'list.form', `rm -rf ${SECRET_INPUT}`] }),
  asking('refused_tool', { decision: 'ask', reasons: [REASON_TEXT], askKinds: ['risky_command'], reasonKeys: ['lex.denied'] }),
  asking('owner_tool', { decision: 'ask', reasons: [REASON_TEXT], askKinds: ['code'], reasonKeys: ['file.git'] }),
  asking('plain_tool', { decision: 'allow', reasons: [] }),
  asking('shell_run', { decision: 'ask', reasons: [REASON_TEXT], askKinds: ['code'], reasonKeys: ['list.npm_script'], productRun: 'product-code' }),
];

function rig(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const registry = new ToolRegistry();
  for (const tool of TOOLS) registry.register(tool as unknown as ToolDef);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const root = join(paths.workspace, 'prod');
  mkdirSync(root, { recursive: true });
  const project = { id: 'p1', root };
  const ctx: ToolContext = {
    runId: 'run-1', conversationId: 'conv-1', kind: 'chat', signal: new AbortController().signal, config, paths, policy: buildPolicy(config, paths, { root }, [root]),
    workspace: root, taint: { tainted: false, sources: [] }, log: () => undefined, project, permissionMode: 'auto',
  };
  const judge: { answer: string | JudgeReply | Error } = { answer: '{"decision":"allow","reason":"fits"}' };
  const deps = (extra: Partial<PipelineDeps> = {}): PipelineDeps => ({
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, conversationTainted: () => false,
    lastUserRequest: () => `please run it ${REQUEST_TEXT}`,
    autoClassify: async () => { if (judge.answer instanceof Error) throw judge.answer; return judge.answer; },
    ...extra,
  });
  const call = (name: string, c: Partial<ToolContext> = {}, extra: Partial<PipelineDeps> = {}) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: { command: `do ${SECRET_INPUT}` } }, { ...ctx, ...c }, deps(extra));
  const rows = () => db.prepare('SELECT * FROM judge_calls ORDER BY id').all().map(r => ({ ...r })) as Array<Record<string, unknown>>;
  return { db, call, judge, rows };
}

test('5-J1: 判定役を呼ぶ道（許す・聞きたい・答えられない・判定役が無い）は 1 件ずつ記録し、実行・種類・製品・道具・キー・答え・トークン・モデル・時間が入る', async t => {
  const r = rig(t);
  r.judge.answer = { text: '{"decision":"allow","reason":"fits"}', model: 'judge-model-a', usage: { inputTokens: 812, outputTokens: 19 } };
  assert.equal((await r.call('judged_tool')).decidedBy, 'auto-mode');
  r.judge.answer = '{"decision":"ask","reason":"not sure"}';
  assert.equal((await r.call('judged_tool', { kind: 'task', runId: 'run-2', task: { id: 't1', control: { outcome: 'none' } } })).decidedBy, 'pending');
  r.judge.answer = 'no idea';
  assert.equal((await r.call('judged_tool', { kind: 'agent', runId: 'run-3', parent: { runId: 'run-1', conversationId: 'conv-1', kind: 'chat', title: 'child' } })).decidedBy, 'pending');
  assert.equal((await r.call('judged_tool', {}, { autoClassify: undefined })).decidedBy, 'pending');
  const rows = r.rows();
  assert.deepEqual(rows.map(row => [row.run_id, row.run_kind, row.project_id, row.tool, row.outcome, row.failed, row.judge_model, row.input_tokens, row.output_tokens]), [
    ['run-1', 'chat', 'p1', 'judged_tool', 'allow', null, 'judge-model-a', 812, 19],
    ['run-2', 'task', 'p1', 'judged_tool', 'ask', null, null, null, null],
    ['run-3', 'agent', 'p1', 'judged_tool', 'failed', 'unparsable', null, null, null],
    ['run-1', 'chat', 'p1', 'judged_tool', 'failed', 'no_judge', null, null, null],
  ]);
  for (const row of rows) {
    assert.deepEqual(JSON.parse(String(row.reason_keys)), ['list.flag', 'list.form'], 'キーの形でない文字はキーに入れない');
    assert.deepEqual(JSON.parse(String(row.ask_kinds)), ['risky_command']);
    assert.ok(Number.isInteger(row.duration_ms) && Number(row.duration_ms) >= 0);
  }
});

test('5-J1: 記録に命令の文・入力・頼みの文・理由の文が入らない', async t => {
  const r = rig(t);
  r.judge.answer = { text: '{"decision":"allow","reason":"fits"}', model: 'judge-model-a', usage: { inputTokens: 1, outputTokens: 1 } };
  await r.call('judged_tool');
  r.judge.answer = '{"decision":"ask","reason":"no"}';
  await r.call('judged_tool');
  const rows = r.rows();
  assert.equal(rows.length, 2);
  for (const row of rows) for (const [column, value] of Object.entries(row)) {
    for (const mark of [SECRET_INPUT, REQUEST_TEXT, REASON_TEXT, 'do ', 'please']) assert.ok(!String(value).toLowerCase().includes(mark.toLowerCase()), `${column} に ${mark}`);
  }
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['ask_kinds', 'created_at', 'duration_ms', 'failed', 'id', 'input_tokens', 'judge_model', 'outcome', 'output_tokens', 'project_id', 'reason_keys', 'run_id', 'run_kind', 'tool']);
});

test('5-J1: 判定役を呼ばない道（順 1 で断る・順 3 で持ち主へ積む・順 4 で動かす・確かめの要らない呼び出し）は記録しない', async t => {
  const r = rig(t);
  assert.equal((await r.call('refused_tool')).decision, 'deny');
  assert.equal((await r.call('owner_tool')).decidedBy, 'pending');
  assert.equal((await r.call('shell_run')).decidedBy, 'product-code');
  assert.equal((await r.call('plain_tool')).decision, 'allow');
  assert.deepEqual(r.rows(), []);
});

test('5-J1: 集計は日・実行・キー・種類・モデルごとの数とトークンと時間を返し、製品で絞れる', t => {
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const day1 = Date.UTC(2026, 10, 10, 12);
  const day2 = Date.UTC(2026, 10, 11, 12);
  const base = { runKind: 'chat' as const, tool: 'shell_run', askKinds: ['taint'] };
  recordJudgeCall(db, { ...base, runId: 'a', projectId: 'p1', reasonKeys: ['list.flag'], outcome: 'allow', spend: { ms: 100, model: 'm1', inputTokens: 500, outputTokens: 10 } }, day1);
  recordJudgeCall(db, { ...base, runId: 'a', projectId: 'p1', reasonKeys: ['list.flag', 'ask.curl'], askKinds: ['taint', 'egress'], outcome: 'ask', spend: { ms: 200, model: 'm1', inputTokens: 600, outputTokens: 20 } }, day1);
  recordJudgeCall(db, { ...base, runId: 'b', runKind: 'task', projectId: null, reasonKeys: ['ask.curl'], outcome: 'failed', failed: 'timeout', spend: { ms: 300 } }, day2);
  const all = judgeStats(db, { since: day1 - 86_400_000, until: day2 + 1, timezone: 'UTC' });
  assert.deepEqual(all.totals, { calls: 3, allow: 1, ask: 1, failed: 1, inputTokens: 1100, outputTokens: 30, ms: 600 });
  assert.deepEqual(all.keys.map(k => [k.key, k.calls, k.inputTokens]), [['ask.curl', 2, 600], ['list.flag', 2, 1100]]);
  assert.deepEqual(all.askKinds.map(k => [k.kind, k.calls]), [['taint', 3], ['egress', 1]]);
  assert.deepEqual(all.days.map(d => [d.day, d.calls, d.ms]), [['2026-11-10', 2, 300], ['2026-11-11', 1, 300]]);
  assert.deepEqual(all.runs.map(run => [run.runId, run.runKind, run.calls]), [['a', 'chat', 2], ['b', 'task', 1]]);
  assert.deepEqual(all.models.map(m => [m.model, m.calls]), [['m1', 2], [null, 1]]);
  assert.equal(judgeStats(db, { since: 0, project: 'p1' }).totals.calls, 2);
  assert.equal(judgeStats(db, { since: 0, project: null }).totals.calls, 1);
  assert.equal(judgeStats(db, { since: day2 - 3_600_000 }).totals.calls, 1, '期間の外は数えない');
});

test('5-J1: /api/judge/stats がキーごとの数を返し、製品で絞れる', async t => {
  const closing: Array<() => void> = [];
  t.after(() => { for (const close of closing.splice(0)) close(); });
  const root = tempDir(t);
  const paths = resolvePaths(root);
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const app = new App({ paths, databasePath: join(root, 'beat.db'), log: () => undefined, workerTimers: false, adapterOverride: p => new FakeAdapter(p) });
  closing.push(() => app.close());
  const now = Date.now();
  recordJudgeCall(app.db, { runId: 'a', runKind: 'chat', projectId: 'shop01', tool: 'shell_run', reasonKeys: ['ask.curl'], askKinds: ['egress'], outcome: 'ask', spend: { ms: 5, inputTokens: 40 } }, now);
  recordJudgeCall(app.db, { runId: 'b', runKind: 'task', projectId: null, tool: 'web_fetch', reasonKeys: ['web.long_query'], askKinds: ['web'], outcome: 'allow', spend: { ms: 5 } }, now);
  recordJudgeCall(app.db, { runId: 'old', runKind: 'task', projectId: null, tool: 'web_fetch', reasonKeys: ['web.long_query'], askKinds: ['web'], outcome: 'allow', spend: { ms: 5 } }, now - 40 * 86_400_000);
  const web = createWebServer(app);
  await new Promise<void>(resolve => web.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(web.server.address() as AddressInfo).port}`;
  web.setOrigins([origin]);
  closing.unshift(() => { web.server.closeAllConnections(); web.server.close(); });
  const get = async (path: string) => (await fetch(`${origin}${path}`, { headers: { Origin: origin } })).json() as Promise<any>;
  const week = await get('/api/judge/stats');
  assert.deepEqual(week.keys.map((k: { key: string; calls: number }) => [k.key, k.calls]), [['ask.curl', 1], ['web.long_query', 1]]);
  assert.equal(week.totals.inputTokens, 40);
  assert.equal((await get('/api/judge/stats?days=60')).totals.calls, 3);
  assert.deepEqual((await get('/api/judge/stats?project=shop01')).askKinds.map((k: { kind: string }) => k.kind), ['egress']);
  assert.equal((await get('/api/judge/stats?project=none')).totals.calls, 1);
});

test('5-J1: scripts/judge-stats.ts は DB を読むだけで、表を書く', t => {
  const path = join(tempDir(t), 'beat.db');
  const db = openDatabase(path, MIGRATIONS);
  const now = Date.UTC(2026, 10, 12, 9);
  recordJudgeCall(db, { runId: 'a', runKind: 'chat', projectId: null, tool: 'shell_run', reasonKeys: ['ask.curl'], askKinds: ['taint'], outcome: 'ask', spend: { ms: 7, model: 'm1', inputTokens: 3, outputTokens: 2 } }, now);
  db.close();
  const before = statSync(path).mtimeMs;
  const stats = readStats(path, { days: 7, timezone: 'UTC', runs: 5, now });
  assert.equal(stats.totals.calls, 1);
  const text = renderStats(stats);
  assert.match(text, /^ask\.curl\t1\t0\t1\t0\t3\t2\t7$/mu);
  assert.match(text, /^taint\t1\t/mu);
  assert.equal(statSync(path).mtimeMs, before, 'DB を書き換えない');
  assert.throws(() => readStats(join(tempDir(t), 'missing.db'), { days: 7, timezone: 'UTC', runs: 5 }), /no database/u);
});
