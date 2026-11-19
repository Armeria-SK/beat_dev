import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import type { ModelConfig } from '../src/config/schema.ts';
import { eraseConversation } from '../src/db/erase.ts';
import type { StopReason, Usage } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import type { ModelRequest, ProbeResult } from '../src/providers/types.ts';
import { tokenReport } from '../scripts/token-report.ts';
import { FakeAdapter, reply, tempDir, testConfig, type Script, withLoad } from './helpers.ts';

// TE-0: モデルの呼び出し 1 回ごとに model_calls へ 1 行。turn と discarded の合計が engine_runs の量と一致し、要約（compact）は engine_runs に入らない

const C = 'c1';

async function setup(t: { after: (fn: () => void) => void }, model: ModelConfig = { id: 'm', provider: 'fake', model: 'x', contextLength: 65536, maxOutputTokens: 1024, vision: false }, probe: Partial<ProbeResult> = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.providers = [{ id: 'fake', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 }];
  config.models = [model];
  config.routing = { chat: ['m'], background: [], retriesPerModel: 0 };
  config.memory.review = false;
  writeFileSync(paths.config, JSON.stringify(config));
  const clock = { now: Date.parse('2026-11-19T10:00:00Z') };
  let adapter!: FakeAdapter;
  const logs: string[] = [];
  const app = new App({ paths, databasePath: ':memory:', log: line => { logs.push(line); }, now: () => clock.now, workerTimers: false, adapterOverride: p => (adapter = new FakeAdapter(p)) });
  adapter.probeResult = probe;
  await app.status.probeAll(app.config());
  t.after(() => app.close());
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'notes.txt'), 'line of the notes file\n'.repeat(120));
  const run = async (text: string) => {
    const outcome = app.engine.send(C, text);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    const result = await app.engine.wait(outcome.runId);
    return { runId: outcome.runId, result };
  };
  return { app, adapter: () => adapter, clock, run, paths, logs };
}

const used = (n: number): Usage => ({ inputTokens: 1000 * n, cacheReadTokens: 700 * n, cacheWriteTokens: 200 * n, outputTokens: 10 * n });
const withUsage = (usage: Usage, step: Script): Script => async function* (req: ModelRequest) {
  yield { type: 'usage', usage };
  yield* step(req);
};
const readNotes: Script = async function* (req) {
  for (const c of withLoad({ id: `call_${Math.random().toString(36).slice(2)}`, name: 'file_read', arguments: { path: 'notes.txt' } }, req)) yield { type: 'tool_call', call: c };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

interface CallRow { run_id: string; seq: number; purpose: string; model: string; input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; output_tokens: number | null; est_tokens: number | null; removed: number; tools_hash: string; frozen_hash: string; dynamic_hash: string; started_at: number; duration_ms: number }
const callsOf = (app: App, runId: string): CallRow[] => app.db.prepare('SELECT * FROM model_calls WHERE run_id = ? ORDER BY seq').all(runId) as unknown as CallRow[];
const sum = (rows: CallRow[], key: 'input_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'output_tokens') => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

function assertMatchesRun(app: App, runId: string): void {
  const run = app.runs.get(runId)!;
  const counted = callsOf(app, runId).filter(r => r.purpose !== 'compact');
  for (const key of ['input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens'] as const) assert.equal(sum(counted, key), run[key] ?? 0, key);
}

test('3 回の呼び出しの実行で 3 行（seq 1〜3・turn）。量の合計が engine_runs と同じ。道具・固定・dynamic の hash は実行のあいだ同じ', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(withUsage(used(1), readNotes), withUsage(used(2), readNotes), withUsage(used(3), reply('done')));
  const { runId, result } = await s.run('read it twice');
  assert.ok(result!.ok);
  const rows = callsOf(s.app, runId);
  assert.deepEqual(rows.map(r => [r.seq, r.purpose, r.model]), [[1, 'turn', 'm'], [2, 'turn', 'm'], [3, 'turn', 'm']]);
  assert.deepEqual(rows.map(r => r.input_tokens), [1000, 2000, 3000]);
  assertMatchesRun(s.app, runId);
  assert.equal(s.app.runs.get(runId)!.input_tokens, 6000, 'engine_runs の数え方は前のまま（3 回の合計）');
  assert.equal(new Set(rows.map(r => r.tools_hash)).size, 1);
  assert.equal(new Set(rows.map(r => r.frozen_hash)).size, 1);
  assert.equal(new Set(rows.map(r => r.dynamic_hash)).size, 1);
  assert.ok(rows.every(r => /^[0-9a-f]{16}$/u.test(r.tools_hash) && r.est_tokens! > 0 && r.removed === 0 && r.started_at > 0));
  assert.ok(rows[1]!.est_tokens! > rows[0]!.est_tokens!, '見積もりは呼び出しごと（読んだ分だけ増える）');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const req = s.adapter().calls[0]!;
  assert.deepEqual([rows[0]!.tools_hash, rows[0]!.frozen_hash, rows[0]!.dynamic_hash], [hash(JSON.stringify(req.tools)), hash(req.system.frozen), hash(req.system.dynamic)], '送った道具の仕様・固定・dynamic の hash');
});

const thinkingOnly: Script = async function* () {
  yield { type: 'reasoning', delta: '' };
  yield { type: 'usage', usage: { inputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 64_000 } };
  yield { type: 'done', stop: 'max_tokens' as StopReason };
};

test('考えるだけで上限に達して捨てた呼び出しは discarded の 1 行。turn と discarded の合計が engine_runs と同じ', async t => {
  const s = await setup(t, { id: 'm', provider: 'fake', model: 'x', contextLength: 1_000_000, vision: false }, { maxOutput: 128_000 });
  s.adapter().scripts.push(thinkingOnly, withUsage(used(1), reply('done')));
  const { runId, result } = await s.run('think');
  assert.ok(result!.ok);
  assert.deepEqual(callsOf(s.app, runId).map(r => [r.seq, r.purpose, r.input_tokens]), [[1, 'discarded', 500], [2, 'turn', 1000]]);
  assert.ok(JSON.parse(s.app.runs.get(runId)!.flags).includes('output_raised'), '前提: 上げてやり直した');
  assertMatchesRun(s.app, runId);
  assert.equal(s.app.runs.get(runId)!.output_tokens, 64_010);
});

test('要約の呼び出しは compact の行（外した発言の数つき）。engine_runs には入らず、turn と discarded の合計が engine_runs と同じ', async t => {
  const s = await setup(t, { id: 'm', provider: 'fake', model: 'x', contextLength: 20_500, maxOutputTokens: 1024, vision: false });
  let compacts = 0;
  let calls = 0;
  s.adapter().scripts = Array.from({ length: 40 }, () => async function* (req: ModelRequest) {
    if (req.tools.length === 0) { compacts++; yield { type: 'usage' as const, usage: { inputTokens: 4000, outputTokens: 300 } }; yield* reply('SUMMARY')(req); return; }
    calls++;
    if (calls === 8) s.app.engine.addNote(C, 'note', false);
    yield* withUsage({ outputTokens: 7 }, calls === 24 ? reply('done') : readNotes)(req);
  });
  const { runId, result } = await s.run('start the build');
  assert.ok(result!.ok, JSON.stringify(result));
  assert.ok(compacts > 0, '前提: 要約した');
  const rows = callsOf(s.app, runId);
  const compactRows = rows.filter(r => r.purpose === 'compact');
  assert.equal(compactRows.length, compacts);
  assert.ok(compactRows.every(r => r.input_tokens === 4000 && r.output_tokens === 300 && r.removed >= 4 && r.est_tokens! > 0));
  assert.notEqual(compactRows[0]!.frozen_hash, rows.find(r => r.purpose === 'turn')!.frozen_hash, '要約の system は会話の system と別');
  assertMatchesRun(s.app, runId);
  const turns = rows.filter(r => r.purpose === 'turn').length;
  assert.equal(s.app.runs.get(runId)!.output_tokens, turns * 7, '要約の量（出力 300）は engine_runs に入らない');
  assert.equal(s.app.runs.get(runId)!.input_tokens, null, '要約の入力（4000）も入らない');
  assert.deepEqual(rows.map(r => r.seq), rows.map((_, i) => i + 1), 'seq は要約も含めて 1 から順に');
  const report = tokenReport(s.app.db, { since: 0, until: Date.parse('2100-01-01'), runLimit: 10 });
  assert.equal(report.totals.compactVolume.input, 4000 * compacts);
  assert.equal(report.totals.volume.output, turns * 7);
  assert.equal(report.runs[0]!.compact, compacts);
});

test('会話を消しても model_calls の行は残る。列は数字と hash だけで、会話の文を含まない', async t => {
  const s = await setup(t);
  s.adapter().scripts.push(withUsage(used(1), readNotes), withUsage(used(1), reply('SECRET-REPLY-TEXT')));
  const { runId } = await s.run('SECRET-USER-TEXT');
  const before = callsOf(s.app, runId);
  assert.equal(before.length, 2);
  eraseConversation({ db: s.app.db, uploadsDir: s.paths.uploads, toolOutputsDir: join(s.paths.data, 'tool_outputs') }, C);
  assert.equal(s.app.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(C)!.n, 0, '前提: 発言は消えた');
  assert.deepEqual(callsOf(s.app, runId), before);
  const columns = (s.app.db.prepare('PRAGMA table_info(model_calls)').all() as Array<{ name: string }>).map(c => c.name);
  assert.deepEqual(columns, ['id', 'run_id', 'seq', 'purpose', 'model', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'est_tokens', 'removed', 'tools_hash', 'frozen_hash', 'dynamic_hash', 'started_at', 'duration_ms']);
  const dump = JSON.stringify(s.app.db.prepare('SELECT * FROM model_calls').all());
  assert.ok(!dump.includes('SECRET') && !dump.includes('notes'), dump);
});

test('提供元が考える部分の送り返しを断って送り直したら、実行の印 thinking_replay_rejected が 1 つ付く', async t => {
  const s = await setup(t);
  const rejected: Script = async function* (req) { yield { type: 'replay_rejected' }; yield* reply('ok')(req); };
  s.adapter().scripts.push(rejected);
  const { runId } = await s.run('hi');
  assert.deepEqual(JSON.parse(s.app.runs.get(runId)!.flags), ['thinking_replay_rejected']);
  s.adapter().scripts.push(reply('ok'));
  const next = await s.run('again');
  assert.deepEqual(JSON.parse(s.app.runs.get(next.runId)!.flags), []);
});

test('取り消した実行: 終えた呼び出しは model_calls に残り、engine_runs の量は空のまま（決まりは ok か失敗で終わった実行だけ）。考える部分の断りの印は残る', async t => {
  const s = await setup(t);
  let runId = '';
  const stopped: Script = async function* (req) {
    yield { type: 'replay_rejected' };
    s.app.engine.stop(runId);
    throw req.signal.reason;
  };
  s.adapter().scripts.push(withUsage(used(1), readNotes), stopped);
  const outcome = s.app.engine.send(C, 'read it');
  assert.ok(outcome.ok);
  runId = outcome.runId;
  const result = await s.app.engine.wait(runId);
  assert.equal(result!.ok, false);
  const run = s.app.runs.get(runId)!;
  assert.equal(run.error_kind, 'cancelled');
  assert.deepEqual(callsOf(s.app, runId).map(r => [r.purpose, r.input_tokens]), [['turn', 1000]]);
  assert.deepEqual([run.input_tokens, run.cache_read_tokens, run.cache_write_tokens, run.output_tokens], [null, null, null, null], 'engine_runs の量の列は前のまま空');
  assert.deepEqual(JSON.parse(run.flags), ['thinking_replay_rejected']);
});

test('model_calls に書けなくても、実行と要約は止まらない（[WARN] を残す）', async t => {
  const s = await setup(t);
  s.app.db.exec('DROP TABLE model_calls');
  s.adapter().scripts.push(withUsage(used(1), readNotes), withUsage(used(1), reply('all done')));
  const { runId, result } = await s.run('read it');
  assert.equal(result!.ok, true, JSON.stringify(result));
  assert.ok(s.app.conversations.messages(C).some(m => m.role === 'assistant' && m.text === 'all done'), '返事は保存された');
  assert.equal(s.app.runs.get(runId)!.input_tokens, 2000);
  assert.equal(s.logs.filter(line => line.startsWith(`[WARN] could not record a model call of run ${runId}`)).length, 2);
});
