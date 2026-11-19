import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { APP_ROOT } from '../src/paths.ts';
import { toolText } from '../src/shared/messages/tools.ts';
import { openReadOnly, readReport, renderReport, type TokenReport } from '../scripts/token-report.ts';
import { tempDir } from './helpers.ts';

// TE-0 の報告の台本: 量は model_calls から。子の実行と判定役は親に足す。外れた理由・間・読み直し・切れた出力を数える。DB は読むだけ

const BASE = Date.parse('2026-11-19T00:00:00Z');
const MIN = 60_000;
const AT = MIGRATIONS.findIndex(m => typeof m === 'string' && m.includes('CREATE TABLE model_calls'));
const CUT = toolText('en', 'pipeline.truncated', { shown: '16,000', total: '40,000', note: toolText('en', 'pipeline.note_none') });

interface Call { run: string; seq: number; purpose?: string; input: number; read: number | null; write: number | null; output?: number; at: number; tools?: string; frozen?: string; dynamic?: string; removed?: number }
const call = (db: DatabaseSync, c: Call) => db.prepare(`INSERT INTO model_calls (run_id, seq, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, est_tokens, removed, tools_hash, frozen_hash, dynamic_hash, started_at, duration_ms)
  VALUES (?, ?, ?, 'm', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 100)`).run(c.run, c.seq, c.purpose ?? 'turn', c.input, c.read, c.write, c.output ?? 10, c.removed ?? 0, c.tools ?? 'T', c.frozen ?? 'F', c.dynamic ?? 'D', c.at);
const run = (db: DatabaseSync, id: string, kind: string, conversation: string, at: number, extra: { parent?: string; flags?: string[] } = {}) =>
  db.prepare('INSERT INTO engine_runs (id, kind, conversation_id, started_at, parent_run_id, flags) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, conversation, at, extra.parent ?? null, JSON.stringify(extra.flags ?? []));
const conversation = (db: DatabaseSync, id: string) => db.prepare('INSERT INTO conversations (id, created_at, last_message_at) VALUES (?, 0, 0)').run(id);
const message = (db: DatabaseSync, conv: string, runId: string, at: number, m: Record<string, unknown> & { role: string }) => {
  const text = m.role === 'tool' ? `[${String(m.name)}] ${String(m.content)}` : String(m.content ?? '');
  db.prepare('INSERT INTO messages (conversation_id, run_id, role, text, parts, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(conv, runId, m.role, text, JSON.stringify(m), at);
  return text.length;
};
const readCall = (db: DatabaseSync, conv: string, runId: string, at: number, id: string, args: Record<string, unknown>, content: string) => {
  message(db, conv, runId, at - 1, { role: 'assistant', content: '', toolCalls: [{ id, name: 'file_read', arguments: args }] });
  return message(db, conv, runId, at, { role: 'tool', toolCallId: id, name: 'file_read', content });
};

function build(path: string) {
  const db = openDatabase(path, MIGRATIONS);
  try {
    for (const id of ['c1', 'c1-child', 'c2']) conversation(db, id);
    // r1: 2 回の turn と 1 回の捨てた呼び出し・要約 1 回・子の実行 1 本・判定役 3 回（子の 1 回も）・切れた shell の出力 1 つ
    run(db, 'r1', 'chat', 'c1', BASE);
    call(db, { run: 'r1', seq: 1, input: 1000, read: 0, write: 900, at: BASE + 1000 });
    call(db, { run: 'r1', seq: 2, input: 1100, read: 900, write: 150, at: BASE + 2000 });
    call(db, { run: 'r1', seq: 3, purpose: 'discarded', input: 1200, read: 1050, write: 100, at: BASE + 3000 });
    call(db, { run: 'r1', seq: 4, purpose: 'compact', input: 4000, read: null, write: null, output: 300, at: BASE + 4000, frozen: 'S', tools: 'none', dynamic: 'none', removed: 6 });
    run(db, 'r1c', 'agent', 'c1-child', BASE + 1500, { parent: 'r1' });
    call(db, { run: 'r1c', seq: 1, input: 500, read: 0, write: 0, output: 5, at: BASE + 1600 });
    for (const [runId, input, output] of [['r1', 300, 20], ['r1', 200, 10], ['r1c', 100, 5]] as const) {
      db.prepare("INSERT INTO judge_calls (run_id, run_kind, tool, outcome, input_tokens, output_tokens, duration_ms, created_at) VALUES (?, 'chat', 'shell_run', 'allow', ?, ?, 5, ?)").run(runId, input, output, BASE + 1700);
    }
    db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, full_ref, created_at) VALUES ('t1', 'r1', 'c1', 'shell_run', '{}', 'allow', 'policy', 'tool_outputs/x.log', ?)").run(BASE + 1800);
    db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, created_at) VALUES ('t2', 'r1', 'c1', 'shell_run', '{}', 'allow', 'policy', ?)").run(BASE + 1900);
    const k1 = readCall(db, 'c1', 'r1', BASE + 1100, 'k1', { path: 'src/a.txt' }, `${'a'.repeat(50)}\n\n${CUT}`);
    const k2 = readCall(db, 'c1', 'r1', BASE + 2100, 'k2', { path: './src\\a.txt' }, 'a'.repeat(30));
    // r2: 10 分あと、dynamic が変わって前半を書き直す。要約のあとに、要約の前に読んだ（切れていた）ファイルを別の範囲で読む
    run(db, 'r2', 'chat', 'c1', BASE + 600_000, { flags: ['thinking_replay_rejected'] });
    call(db, { run: 'r2', seq: 1, input: 1400, read: 0, write: 1300, at: BASE + 3000 + 10 * MIN, dynamic: 'D2' });
    call(db, { run: 'r2', seq: 2, input: 1400, read: 1300, write: 50, at: BASE + 3000 + 11 * MIN, dynamic: 'D2' });
    const k3 = readCall(db, 'c1', 'r2', BASE + 604_000, 'k3', { path: 'src/a.txt', offset: 10 }, 'b'.repeat(20));
    const k4 = readCall(db, 'c1', 'r2', BASE + 605_000, 'k4', { path: 'src/b.txt' }, 'c'.repeat(10));
    const shell = message(db, 'c1', 'r2', BASE + 606_000, { role: 'tool', toolCallId: 'k5', name: 'shell_run', content: 'ok' });
    // r3: 前の呼び出しとの違いの順に、外れた理由を 1 つずつ（道具・固定・dynamic・外した数・5 分超・それ以外）。2 つ違うときは先の方（道具と固定 → 道具、固定と dynamic → 固定）。最後は読める
    const T3 = BASE + 2 * 60 * MIN;
    run(db, 'r3', 'task', 'c2', T3);
    const steps: Array<Partial<Call> & { at: number }> = [
      { at: T3 }, { at: T3 + 1000, tools: 'T2', frozen: 'F2' }, { at: T3 + 2000, tools: 'T2', frozen: 'F3', dynamic: 'D2' }, { at: T3 + 3000, tools: 'T2', frozen: 'F3', dynamic: 'D3' },
      { at: T3 + 4000, tools: 'T2', frozen: 'F3', dynamic: 'D3', removed: 3 }, { at: T3 + 4000 + 6 * MIN, tools: 'T2', frozen: 'F3', dynamic: 'D3', removed: 3 },
    ];
    steps.forEach((s, i) => call(db, { run: 'r3', seq: i + 1, input: 1000, read: 0, write: 1000, ...s }));
    const same = { tools: 'T2', frozen: 'F3', dynamic: 'D3', removed: 3 };
    call(db, { run: 'r3', seq: 7, input: 1100, read: 100, write: 1000, at: T3 + 5000 + 7 * MIN, ...same });
    call(db, { run: 'r3', seq: 8, input: 1100, read: 1100, write: 0, at: T3 + 6000 + 7 * MIN, ...same });
    // 期間の外の古い実行（数えない）
    run(db, 'old', 'chat', 'c2', BASE - 30 * 24 * 60 * MIN);
    call(db, { run: 'old', seq: 1, input: 99_999, read: 0, write: 0, at: BASE - 30 * 24 * 60 * MIN });
    return { k1, k2, k3, k4, shell };
  } finally { db.close(); }
}

const NOW = BASE + 24 * 60 * MIN;
const report = (path: string): TokenReport => readReport(path, { days: 7, runs: 20, now: NOW });
const byId = (r: TokenReport, id: string) => r.runs.find(x => x.runId === id)!;

test('量は model_calls から: 子の実行と判定役は親に足し、要約は別に。重みつきの量 = 読み×0.1 + 書き×1.25 + 残り。期間の外は数えない', t => {
  const path = join(tempDir(t), 'beat.db');
  build(path);
  const r = report(path);
  assert.deepEqual(r.runs.map(x => x.runId), ['r3', 'r2', 'r1'], '子の実行は親の行に入り、古い実行は無い');
  const r1 = byId(r, 'r1');
  assert.deepEqual([r1.turn, r1.discarded, r1.compact, r1.children], [3, 1, 1, 1], '子の turn も親に入る');
  assert.deepEqual({ ...r1.volume }, { calls: 4, input: 3800, read: 1950, write: 1150, fresh: 700, output: 35, weighted: 2332.5, readShare: 1950 / 3800 });
  assert.deepEqual([r1.compactVolume.input, r1.compactVolume.output, r1.compactVolume.weighted], [4000, 300, 4000]);
  assert.deepEqual(r1.judge, { calls: 3, input: 600, output: 35 });
  assert.equal(r1.weightedTotal, 2332.5 + 4000 + 600);
  assert.equal(r.totals.volume.input, 3800 + 2800 + 6 * 1000 + 2200, '古い実行の 99,999 は入らない');
  assert.equal(r.totals.compactVolume.calls, 1);
  assert.equal(r.totals.weightedTotal, r.runs.reduce((n, x) => n + x.weightedTotal, 0));
  const c1 = r.conversations.find(c => c.conversationId === 'c1')!;
  assert.equal(c1.runs, 2);
  assert.equal(c1.volume.input, 3800 + 2800, '会話 c1 の行には子の会話（c1-child）の呼び出しも親の実行ごと入る');
  assert.equal(r.thinkingReplayRejected, 1);
  assert.equal(byId(r, 'r2').thinkingReplayRejected, true);
});

test('外れた理由: 前の呼び出しが置いた分の 95% 未満しか読めなければ、最初に違う所（道具・固定・dynamic・外した数・5 分超・それ以外）で 1 つ数える', t => {
  const path = join(tempDir(t), 'beat.db');
  build(path);
  const r = report(path);
  assert.deepEqual(r.misses.map(m => [m.reason, m.count, m.lostTokens]), [
    ['tools', 1, 1000], ['frozen', 1, 1000], ['dynamic', 2, 1000 + 1150], ['removed', 1, 1000], ['gap_5min', 1, 1000], ['history', 1, 900],
  ]);
  assert.deepEqual([byId(r, 'r1').misses, byId(r, 'r2').misses, byId(r, 'r3').misses], [0, 1, 6], '要約の呼び出しは比べの鎖に入らない（r1 の 2・3 回目は読める）');
  assert.equal(r.gaps.count, 2, 'r2 の頭（10 分）と r3 の 6 回目（6 分）');
  assert.equal(r.gaps.longGapWrite, 1300 + 1000);
  assert.equal(r.gaps.longGapShare, (2300 * 1.25) / r.totals.weightedTotal);
});

test('読み直し: 同じパス・範囲（上限）・切れた結果のあとの読み直し・要約のあとの読み直し・切れた出力（full_ref）を実行ごとに数える', t => {
  const path = join(tempDir(t), 'beat.db');
  const chars = build(path);
  const r = report(path);
  const r1 = byId(r, 'r1');
  const r2 = byId(r, 'r2');
  assert.deepEqual([r1.fileReads, r1.dupReads, r1.dupChars, r1.rereadAfterCut, r1.rereadAfterCompact, r1.cutOutputs], [2, 1, chars.k2, 1, 0, 1], 'パスの書き方（./ と \\）は同じに見る');
  assert.deepEqual([r2.fileReads, r2.dupReads, r2.dupChars, r2.rereadAfterCut, r2.rereadAfterCompact, r2.cutOutputs], [2, 0, 0, 1, 1, 0], '範囲が違えば重複ではない');
  assert.equal(r1.toolChars, chars.k1 + chars.k2);
  assert.equal(r2.toolChars, chars.k3 + chars.k4 + chars.shell);
  assert.deepEqual(r.reads, { fileReads: 4, dupReads: 1, dupChars: chars.k2, toolChars: chars.k1 + chars.k2 + chars.k3 + chars.k4 + chars.shell, rereadAfterCut: 2, cutOutputs: 1, rereadAfterCompact: 1 });
  const text = renderReport(r);
  assert.match(text, /upper bound/u);
  assert.match(text, /\ndynamic\t2\t2150\n/u);
});

test('台本は空の DB・古い DB（model_calls が無い）・表の無い DB で落ちず、DB を書き換えない', t => {
  const dir = tempDir(t);
  const empty = join(dir, 'empty.db');
  openDatabase(empty, MIGRATIONS).close();
  const e = report(empty);
  assert.deepEqual([e.runs.length, e.totals.volume.calls, e.totals.weightedTotal, e.notes.length], [0, 0, 0, 0]);
  assert.match(renderReport(e), /^# Token report /u);

  const old = join(dir, 'old.db');
  const db = openDatabase(old, MIGRATIONS.slice(0, AT));
  conversation(db, 'c1');
  run(db, 'r1', 'chat', 'c1', BASE);
  readCall(db, 'c1', 'r1', BASE + 10, 'k1', { path: 'a.txt' }, 'x');
  db.close();
  const before = createHash('sha256').update(readFileSync(old)).digest('hex');
  const o = report(old);
  assert.match(o.notes.join('\n'), /no model_calls table/u);
  assert.deepEqual([o.runs.length, o.totals.volume.calls, o.reads.fileReads], [1, 0, 1]);
  assert.equal(createHash('sha256').update(readFileSync(old)).digest('hex'), before, '移し替えもしない');

  const bare = join(dir, 'bare.db');
  writeFileSync(bare, '');
  assert.match(report(bare).notes.join('\n'), /no engine_runs table/u);
  const ro = openReadOnly(old);
  try { assert.throws(() => ro.prepare("INSERT INTO engine_runs (id, kind, started_at) VALUES ('x', 'chat', 1)").run(), /readonly/iu); } finally { ro.close(); }
});

test('コマンドとして流すと表を出し、--json で同じ数を返す。無いパスは使い方の誤りで終わる', t => {
  const path = join(tempDir(t), 'beat.db');
  build(path);
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  const script = join(APP_ROOT, 'scripts', 'token-report.ts');
  const text = spawnSync(process.execPath, [script, '--db', path, '--days', '3650'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /## Totals\n/u);
  assert.match(text.stdout, /\nr1\tchat\t3\/1\/1\t1\t/u);
  const json = spawnSync(process.execPath, [script, '--db', path, '--days', '3650', '--json'], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.equal((JSON.parse(json.stdout) as TokenReport).totals.compactVolume.input, 4000);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), before);
  const missing = spawnSync(process.execPath, [script, '--db', join(path, 'nope.db')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no database at/u);
});
