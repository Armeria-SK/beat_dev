import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { collectFrom, appRecord } from '../scripts/browser-bench/collect.ts';
import { defaultConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { BROWSER_TOOLS } from '../src/tools/builtin/browser.ts';
import { toolSearch } from '../src/tools/builtin/tool-search.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { rmSync } from 'node:fs';
import { trackedTempDir } from './helpers.ts';
import { tmpdir } from 'node:os';

// browser-rethink P0 の物差しの集計: 本体と子の担当を分ける・tool_search の本物の結果から読み込みを数える・読めない行は 0 に見せず数える

const run = (db: DatabaseSync, id: string, conversation: string, at: number, parent?: string) =>
  db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, parent_run_id) VALUES (?, 'chat', ?, ?, ?)").run(id, conversation, at, parent ?? null);
const call = (db: DatabaseSync, runId: string, seq: number, at: number, c: { input: number; read: number; write: number; tools?: string }) =>
  db.prepare(`INSERT INTO model_calls (run_id, seq, purpose, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, est_tokens, removed, tools_hash, frozen_hash, dynamic_hash, started_at, duration_ms)
    VALUES (?, ?, 'turn', 'm', ?, ?, ?, 10, 0, 0, ?, 'F', 'D', ?, 100)`).run(runId, seq, c.input, c.read, c.write, c.tools ?? 'T', at);
const tool = (db: DatabaseSync, id: string, runId: string, conversation: string, name: string, at: number) =>
  db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, created_at) VALUES (?, ?, ?, ?, '{}', 'allow', 'builtin', ?)").run(id, runId, conversation, name, at);
const message = (db: DatabaseSync, conversation: string, runId: string, role: string, parts: string, at: number) =>
  db.prepare("INSERT INTO messages (conversation_id, run_id, role, text, parts, created_at) VALUES (?, ?, ?, '', ?, ?)").run(conversation, runId, role, parts, at);

async function searchOutput(query: string): Promise<string> {
  const list = [...BROWSER_TOOLS] as unknown as ToolDef[];
  const ctx = { config: defaultConfig(), deferred: { loaded: new Set<string>(), sent: new Set(['tool_search']), list: () => list, load: () => {} }, reachable: () => [] } as unknown as ToolContext;
  const out = await toolSearch.execute({ query }, ctx);
  return typeof out === 'string' ? out : (out as { content: string }).content;
}

function setup(t: { after: (fn: () => void) => void }): DatabaseSync {
  const dir = trackedTempDir();
  const db = openDatabase(join(dir, 'beat.db'), MIGRATIONS);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['bench', 'child-conv']) db.prepare('INSERT INTO conversations (id, created_at, last_message_at) VALUES (?, 0, 0)').run(id);
  return db;
}

test('tool_search の本物の結果でブラウザの組を読んだら、先読みの 4 種類の読み込みが 1 回、外れ（理由 tools）も数える', async t => {
  const db = setup(t);
  run(db, 'r1', 'bench', 1000);
  call(db, 'r1', 1, 1000, { input: 10_000, read: 0, write: 10_000 });
  call(db, 'r1', 2, 2000, { input: 12_000, read: 1_000, write: 11_000, tools: 'T2' });
  message(db, 'bench', 'r1', 'assistant', JSON.stringify({ role: 'assistant', content: '', toolCalls: [{ id: 's1', name: 'tool_search', arguments: { query: 'browser_open' } }] }), 1100);
  message(db, 'bench', 'r1', 'tool', JSON.stringify({ role: 'tool', toolCallId: 's1', name: 'tool_search', content: await searchOutput('browser_open') }), 1200);
  tool(db, 't1', 'r1', 'bench', 'tool_search', 1100);
  const r = collectFrom(db, 'bench');
  assert.equal(r.e_preloadLoads, 1);
  assert.equal(r.e_otherLoads, 0);
  assert.equal(r.toolSearchLoads[0]!.length, BROWSER_TOOLS.length);
  assert.deepEqual(r.e_toolsMisses, { count: 1, lostTokens: 9_000 });
  assert.equal(r.parseErrors, 0);
});

test('子の担当の量とブラウザの呼び出しは本体に足さず、children に出す', t => {
  const db = setup(t);
  run(db, 'r1', 'bench', 1000);
  call(db, 'r1', 1, 1000, { input: 1000, read: 0, write: 1000 });
  run(db, 'c1', 'child-conv', 1500, 'r1');
  call(db, 'c1', 1, 1600, { input: 500, read: 0, write: 500 });
  tool(db, 't1', 'r1', 'bench', 'browser_open', 1100);
  tool(db, 't2', 'c1', 'child-conv', 'browser_click', 1700);
  const r = collectFrom(db, 'bench');
  assert.equal(r.a_roundTrips, 1);
  assert.equal(r.c_input, 1000);
  assert.equal(r.d_cacheWrite, 1000);
  assert.equal(r.b_browserCalls, 1);
  assert.deepEqual(r.children, { runs: 1, volume: { calls: 1, input: 500, read: 0, write: 500, fresh: 0, output: 10 }, browserCalls: 1 });
  assert.deepEqual(r.firstCall, { read: 0, write: 1000, input: 1000 });
});

test('browser_act の step は切っていない発言の入力から数える。読めない行は parseErrors に出す', t => {
  const db = setup(t);
  run(db, 'r1', 'bench', 1000);
  const steps = Array.from({ length: 20 }, () => ({ click: { role: 'button', name: 'x'.repeat(300) } }));
  message(db, 'bench', 'r1', 'assistant', JSON.stringify({ role: 'assistant', content: '', toolCalls: [{ id: 'a1', name: 'browser_act', arguments: { steps } }] }), 1100);
  message(db, 'bench', 'r1', 'tool', '{not json', 1200);
  const r = collectFrom(db, 'bench', ['{"kind":"submit","src":"browser"}', 'broken']);
  assert.equal(r.b_actSteps, 20);
  assert.equal(r.parseErrors, 2);
});

test('アプリの記録は、ブラウザから来た頼みだけを数える', () => {
  const r = appRecord([
    '{"kind":"start"}',
    '{"kind":"submit","src":"other"}',
    '{"kind":"list_view","src":"browser","added":[4]}',
    '{"kind":"mark_ordered","src":"other"}',
  ]);
  assert.equal(r.submit, false);
  assert.equal(r.list, true);
  assert.equal(r.mark_ordered, false);
  assert.equal(r.notBrowser, 2);
});

test('ブラウザから来た記録でも、本体のブラウザの道具の呼び出しの間に起きていなければ数えない', t => {
  const db = setup(t);
  run(db, 'r1', 'bench', 1000);
  db.prepare("INSERT INTO tool_calls (id, run_id, conversation_id, tool, input, decision, decided_by, duration_ms, created_at) VALUES ('b1', 'r1', 'bench', 'browser_click', '{}', 'allow', 'builtin', 500, 10000)").run();
  const lines = [
    '{"at":10200,"kind":"plus10","src":"browser"}',
    '{"at":12400,"kind":"date_button","src":"browser"}',
    '{"at":13000,"kind":"submit","src":"browser"}',
    '{"at":9000,"kind":"logout","src":"browser"}',
  ];
  const r = collectFrom(db, 'bench', lines);
  assert.equal(r.app.plus10, true);
  assert.equal(r.app.date_button, true);
  assert.equal(r.app.submit, false);
  assert.equal(r.app.logout, false);
  assert.equal(r.app.outsideBrowserCalls, 2);
});
