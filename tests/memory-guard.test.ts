import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryError, MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { memoryForget, memorySave, memorySearch, memoryUpdate } from '../src/tools/builtin/memory.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const memory = new MemoryStore(db);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(memorySave).register(memoryUpdate).register(memoryForget).register(memorySearch);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
    services: { db, memory, emit: () => undefined },
  };
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const judge = { answer: '{"decision":"ask","reason":"the owner should look"}', calls: 0 };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: () => undefined, lastUserRequest: () => 'remember this',
      autoClassify: async () => { judge.calls++; return judge.answer; },
    });
  const waiting = () => pending.list({ status: 'waiting' });
  const approve = async (id: number) => replayAction(pending.claim(id), {
    db, store: pending, registry, config: () => parsed, paths, conversationExists: () => true, conversationTainted: () => false, log: () => undefined,
    services: () => ({ db, memory, emit: () => undefined }),
  });
  return { ctx, call, approvals, memory, db, config: parsed, pending, judge, waiting, approve };
}

const tainted = (ctx: ToolContext): ToolContext => ({ ...ctx, taint: { tainted: true, sources: ['web_fetch'] } });

// ── Web や添付を読んだ後の保存 ──

test('memory_save（P3 で反転）: ふつうも、Web や添付を読んだ後も承認なし（外を読んだことで聞き方を変えない。持ち主の決め 2026-11-21、R18）', async t => {
  const s = setup(t);
  const plain = await s.call('memory_save', { book: 'user', content: '紅茶が好き' });
  assert.equal(plain.decision, 'allow');
  const after = await s.call('memory_save', { book: 'user', content: 'ページに書かれていた内容' }, tainted(s.ctx));
  assert.deepEqual([after.decision, after.decidedBy], [plain.decision, plain.decidedBy], after.output.content);
  assert.equal(s.judge.calls, 0);
  assert.equal(s.waiting().length, 0);
  assert.deepEqual(s.memory.list().map(m => m.content), ['紅茶が好き', 'ページに書かれていた内容']);
});

test('memory_save: 外から読んだ後でも、読むだけの記憶の道具は確認しない。古い設定 taintEscalation: false は読み込みで落ちる', async t => {
  const s = setup(t);
  const search = await s.call('memory_search', { query: '紅茶' }, tainted(s.ctx));
  assert.equal(search.decision, 'allow');
  const old = setup(t, c => { (c.tools as unknown as Record<string, unknown>)['taintEscalation'] = false; });
  assert.equal('taintEscalation' in old.ctx.config.tools, false, '古い設定は読み込みで落ちる');
  const saved = await old.call('memory_save', { book: 'user', content: '設定で切ったつもり' }, tainted(old.ctx));
  assert.equal(saved.decision, 'allow', saved.output.content);
});

// ── 1 回の実行での件数 ──

test('memory_save: 1 回の実行で記憶できるのは 5 件まで。6 件目は断る（英語の文）', async t => {
  const s = setup(t);
  for (let i = 1; i <= 3; i++) assert.equal((await s.call('memory_save', { book: 'notes', content: `教訓 ${i}` })).output.isError, undefined, `${i} 件目`);
  assert.equal((await s.call('memory_update', { id: 'n1', content: '教訓 1（直した）' })).output.isError, undefined);
  assert.equal((await s.call('memory_forget', { id: 'n2', reason: '要らない' })).output.isError, undefined);
  for (let i = 4; i <= 5; i++) assert.equal((await s.call('memory_save', { book: 'notes', content: `教訓 ${i}` })).output.isError, undefined, `書き直し・消す操作は数えないので、${i} 件目も保存できる`);
  assert.equal((await s.call('memory_save', { book: 'notes', content: '教訓 4' })).output.content.includes('already exists'), true, '重複は件数に数えない（保存されないので）');
  const sixth = await s.call('memory_save', { book: 'notes', content: '教訓 6' });
  assert.equal(sixth.output.isError, true);
  assert.equal(sixth.output.content, 'At most 5 memories can be saved in a single run. Save the rest in a later conversation');
  assert.equal(s.memory.list().length, 4, '5 件作って、1 件は消した。消した分も作った件数には数える');

  assert.equal((await s.call('memory_save', { book: 'notes', content: '別の実行の教訓' }, { ...s.ctx, runId: 'r2' })).output.isError, undefined, '件数は実行ごと');
  for (let i = 1; i <= 8; i++) s.memory.save({ book: 'user', content: `画面から ${i}`, actor: 'user' });
  assert.equal(s.memory.list('user').length, 8, '利用者が画面から足すのは数えない');

  const en = setup(t);
  for (let i = 1; i <= 5; i++) await en.call('memory_save', { book: 'notes', content: `Lesson ${i}` });
  const over = await en.call('memory_save', { book: 'notes', content: 'Lesson 6' });
  assert.equal(over.output.content, 'At most 5 memories can be saved in a single run. Save the rest in a later conversation');
});

test('MemoryStore.save: 実行（runId）ごとに、モデルが作れる記憶は 5 件まで。利用者（actor が user）は数えない', () => {
  const db = openDatabase(':memory:', MIGRATIONS);
  const memory = new MemoryStore(db);
  for (let i = 1; i <= 5; i++) memory.save({ book: 'user', content: `事実 ${i}`, actor: 'beat', runId: 'run-a' });
  assert.throws(() => memory.save({ book: 'user', content: '事実 6', actor: 'beat', runId: 'run-a' }), (e: unknown) => e instanceof MemoryError && e.code === 'memory.run_limit' && e.params.max === 5);
  assert.throws(() => memory.save({ book: 'user', content: '事実 7', actor: 'review', runId: 'run-a' }), (e: unknown) => e instanceof MemoryError && e.code === 'memory.run_limit', '振り返りの実行も同じ');
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '事実 6', actor: 'beat', runId: 'run-b' }));
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '事実 7', actor: 'user', runId: 'run-a' }), '利用者の操作は数えない');
  assert.doesNotThrow(() => memory.save({ book: 'user', content: '実行の無い保存', actor: 'beat' }));
});

test('memory_update / memory_forget（P3 で反転）: Web や添付を読んだ後も承認なし。振り返りは外を読んだあとなら断る', async t => {
  const s = setup(t);
  s.memory.save({ book: 'user', content: '元の記憶', actor: 'user' });
  const plain = await s.call('memory_update', { id: 'u1', content: 'ふつうの書き換え' });
  assert.equal(plain.decision, 'allow', '外を読んでいなければ承認なし');
  const updated = await s.call('memory_update', { id: 'u1', content: 'ページを読んだあとの書き換え' }, tainted(s.ctx));
  assert.deepEqual([updated.decision, updated.decidedBy], [plain.decision, plain.decidedBy], updated.output.content);
  assert.equal(s.memory.list()[0]!.content, 'ページを読んだあとの書き換え');
  const forgot = await s.call('memory_forget', { id: 'u1', reason: 'ページを読んだあと' }, tainted(s.ctx));
  assert.deepEqual([forgot.decision, forgot.decidedBy], ['allow', plain.decidedBy], forgot.output.content);
  assert.equal(s.memory.list().length, 0);
  assert.equal(s.waiting().length, 0);
  assert.equal(s.judge.calls, 0);

  const review = setup(t);
  review.memory.save({ book: 'notes', content: '古い教訓', actor: 'user' });
  const reviewCtx: ToolContext = { ...review.ctx, kind: 'review' };
  assert.equal((await review.call('memory_update', { id: 'n1', content: '整理した教訓' }, reviewCtx)).decision, 'allow', '外を読んでいない振り返りは、これまでどおり承認なし');
  for (const [name, args] of [['memory_save', { book: 'notes', content: 'x' }], ['memory_update', { id: 'n1', content: 'y' }], ['memory_forget', { id: 'n1', reason: 'z' }]] as const) {
    const denied = await review.call(name, args, tainted(reviewCtx));
    assert.equal(denied.decision, 'deny', `${name}: ${denied.output.content}`);
    assert.match(denied.output.content, /a review \(background work\) has nobody to approve it/u);
  }
  assert.equal(review.memory.list()[0]!.content, '整理した教訓');
});
