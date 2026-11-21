import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { ConfigError, parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { PendingStore } from '../src/pending/store.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import type { ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { judgeStats } from '../src/tools/judge-stats.ts';
import type { Outbound } from '../src/tools/hooks/outbound.ts';
import { judgeOff, runToolCall, type PipelineDeps } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { AskKind, PreCheck, ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// J-4: 判定なしで動かすモード（routing.judgeMode: 'off'）。判定役に回るはずの呼び出しだけを、判定役なしに通す。ほかの止まる決まりは今までどおり

const ALLOW = '{"decision":"allow","reason":"in scope"}';

interface World {
  reasons: string[]; askKinds: AskKind[]; keys: string[]; writes: string[]; outbound?: Outbound | undefined; ownerReason?: string | undefined;
  redo: ((check: PreCheck) => PreCheck) | undefined;
}

const off = (c: AppConfig) => { c.routing.judgeMode = 'off'; };
const keepOn = (): void => undefined;

function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = off, options: { judge?: boolean } = {}) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const policy = buildPolicy(parsed, paths);
  const workspace = defaultWorkspace(policy, paths);
  const world: World = { reasons: ['reads outside'], askKinds: ['outside_read'], keys: ['guard.touches_outside'], writes: [], redo: undefined };
  let checks = 0;
  let ran = 0;
  const probe = (name: string, extra: Partial<ToolDef> = {}): ToolDef => ({
    name, description: name, input: Type.Object({ v: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task', 'agent'],
    summarize: () => ({ title: 'probe', body: 'probe body' }),
    preCheck: () => {
      checks++;
      const check: PreCheck = {
        decision: 'ask', reasons: [...world.reasons], askKinds: [...world.askKinds], reasonKeys: [...world.keys], cwd: workspace, writes: [...world.writes],
        paths: [], readPaths: [], sends: false, removes: false, ...(world.outbound ? { outbound: world.outbound } : {}), ...(world.ownerReason ? { ownerReason: world.ownerReason } : {}),
      };
      return checks % 2 === 0 && world.redo ? world.redo(check) : check;
    },
    execute: async () => { ran++; return { content: 'ran' }; },
    ...extra,
  });
  const registry = new ToolRegistry().register(probe('probe'))
    .register(probe('mcp__s1__put', { effect: 'write', mcp: { server: 's1', tool: 'put' } })).register(probe('mcp__s1__get', { effect: 'network', mcp: { server: 's1', tool: 'get' } }));
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const prompts: ClassifierPrompt[] = [];
  const state = { request: 'run the tests', mode: 'auto' as PermissionMode, modes: [] as PermissionMode[], config: undefined as AppConfig | undefined, broken: false };
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace, taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const deps: PipelineDeps = {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: e => events.push(e), lastUserRequest: () => state.request, productRoots: () => [workspace],
    permissionMode: () => state.modes.shift() ?? state.mode, conversationTainted: () => false, config: () => { if (state.broken) throw new Error('x'); return state.config ?? parsed; },
    ...(options.judge === false ? {} : { autoClassify: async (prompt: ClassifierPrompt) => { prompts.push(prompt); return ALLOW; } }),
  };
  const call = (c: ToolContext = ctx, name = 'probe') => runToolCall({ id: `call-${Math.random()}`, name, arguments: { v: 'a' } }, c, deps);
  const fromNextRedo = (redo: (check: PreCheck) => PreCheck) => { const start = checks; world.redo = check => (checks > start + 1 ? redo(check) : check); };
  return { parsed, paths, ctx, call, world, prompts, state, events, db, pending, workspace, ran: () => ran, fromNextRedo };
}

type Setup = ReturnType<typeof setup>;
const judgeRows = (s: Setup): number => Number((s.db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n);
const waitingKind = (s: Setup): string | undefined => s.pending.list({ status: 'waiting' })[0]?.kind;

test('J-4: 鍵が無い古い設定は On。値は on / off だけ', () => {
  const plain = parseConfig(testConfig());
  assert.equal(plain.routing.judgeMode, undefined);
  assert.equal(judgeOff(plain), false);
  const config = testConfig();
  config.routing.judgeMode = 'on';
  assert.equal(judgeOff(parseConfig(config)), false);
  config.routing.judgeMode = 'off';
  assert.equal(judgeOff(parseConfig(config)), true);
  assert.throws(() => parseConfig({ ...testConfig(), routing: { ...testConfig().routing, judgeMode: 'skip' } }), ConfigError);
});

test('J-4: Off では、判定役に回るはずの呼び出しが判定役を呼ばずに動く。記録は no-judge、判定役の数（judge_calls）は 0、「判定役が通した」の数は増えない。判定役に渡るはずだった理由は残す', async t => {
  const s = setup(t);
  const out = await s.call();
  assert.deepEqual([out.decision, out.decidedBy], ['allow', 'no-judge'], out.output.content);
  assert.equal(s.ran(), 1);
  assert.equal(s.prompts.length, 0, '判定役は呼ばれない');
  assert.equal(judgeRows(s), 0);
  assert.equal(judgeStats(s.db, { since: 0 }).totals.calls, 0);
  assert.deepEqual(out.gate, { by: 'no-judge' });
  const result = s.events.find(e => e.type === 'tool.result') as { gate?: unknown } | undefined;
  assert.deepEqual(result?.gate, { by: 'no-judge' }, '道具の行に No judge を出す印');
  assert.equal(s.events.filter(e => e.type === 'tool.auto').length, 0, '判定中の印も出さない');
  const row = s.db.prepare('SELECT decided_by, decision, approval_id FROM tool_calls').get() as { decided_by: string; decision: string; approval_id: string | null };
  assert.deepEqual([row.decided_by, row.decision], ['no-judge', 'allow']);
  const kept = s.db.prepare('SELECT reasons FROM approvals WHERE id = ?').get(row.approval_id) as { reasons: string } | undefined;
  assert.deepEqual(JSON.parse(kept?.reasons ?? '[]'), ['reads outside', 'Ran without the judge (judge turned off in Settings)'], '判定役に渡るはずだった理由を残す');
  assert.equal(s.pending.judged(0).allowed, 0);
  assert.equal(s.pending.list({ status: 'waiting' }).length, 0);
});

test('J-4: Off では、判定役が無いとき（judge_failed_no_judge）も Pending に積まずに動く。On では今までどおり積む', async t => {
  const s = setup(t, off, { judge: false });
  assert.equal((await s.call()).decidedBy, 'no-judge');
  assert.equal(judgeRows(s), 0);
  const on = setup(t, keepOn, { judge: false });
  assert.equal((await on.call()).decidedBy, 'pending');
  assert.equal(waitingKind(on), 'judge_failed');
  assert.match(on.pending.list({ status: 'waiting' })[0]!.reason, /no judge model/u);
  assert.equal(judgeRows(on), 1);
});

test('J-4: Off では J-3 の覚えた答えを引かず、覚えもしない。同じ実行の途中で On に戻すと、その場から判定役が呼ばれる', async t => {
  const s = setup(t);
  assert.equal((await s.call()).decidedBy, 'no-judge');
  assert.equal((await s.call()).decidedBy, 'no-judge');
  const on = structuredClone(s.parsed);
  delete on.routing.judgeMode;
  s.state.config = on;
  const first = await s.call();
  assert.equal(first.decidedBy, 'auto-mode', 'Off のあいだに覚えたものは無いので、判定役に回る');
  assert.equal((await s.call()).decidedBy, 'judge-reuse', 'On のあいだに覚えた');
  assert.equal(s.prompts.length, 1);
  s.state.config = s.parsed;
  assert.equal((await s.call()).decidedBy, 'no-judge', 'Off に戻すと、覚えた答えがあっても引かない');
  assert.equal(s.prompts.length, 1);
});

test('J-4: Off に切り替えても、始めた実行は On のまま（緩める向きは次の実行から）。Off で始めた実行を On にすると、その場から On', async t => {
  const s = setup(t, keepOn);
  const offNow = structuredClone(s.parsed);
  offNow.routing.judgeMode = 'off';
  s.state.config = offNow;
  assert.equal((await s.call()).decidedBy, 'auto-mode', '始めたときの設定が On');
  assert.equal(s.prompts.length, 1);
  const next = { ...s.ctx, runId: 'r2', config: offNow };
  assert.equal((await s.call(next)).decidedBy, 'no-judge', '次の実行から Off');
});

test('J-4: Off でも、断る決まり（順 1）は断る', async t => {
  const s = setup(t);
  s.world.keys = ['guard.self_port'];
  const refused = await s.call();
  assert.deepEqual([refused.decision, s.ran(), s.prompts.length], ['deny', 0, 0]);
});

test('J-4: Off でも、送る・消すは Pending に積む（判定の前も、判定のあとの見分けのやり直しでも）', async t => {
  for (const kind of ['send', 'delete'] as const) {
    const s = setup(t);
    s.world.outbound = { kind, reason: `This ${kind}s`, targets: [] } as Outbound;
    assert.equal((await s.call()).decidedBy, 'pending', kind);
    assert.equal(waitingKind(s), kind);
    const late = setup(t);
    late.fromNextRedo(check => ({ ...check, outbound: { kind, reason: `This ${kind}s`, targets: [] } }) as PreCheck);
    assert.equal((await late.call()).decidedBy, 'pending', `${kind} (late)`);
    assert.equal(waitingKind(late), kind);
    assert.equal(late.events.filter(e => e.type === 'tool.auto').length, 0, '判定中・判定のあとの印は出さない');
    assert.deepEqual([s.ran(), late.ran(), s.prompts.length + late.prompts.length], [0, 0, 0]);
  }
});

test('J-4: Off でも、守るファイルのフック・道具の方針の Ask・持ち主の決めのキーは Pending に積む', async t => {
  const hook = setup(t, c => { off(c); c.tools.hooks.preToolUse = [{ matcher: '.*', builtin: 'protect-files', always: ['guarded.txt'] }]; });
  hook.world.writes = [join(hook.workspace, 'guarded.txt')];
  assert.equal((await hook.call()).decidedBy, 'pending');
  assert.equal(waitingKind(hook), 'hook');
  const policy = setup(t, c => { off(c); c.tools.policies = { probe: 'ask' }; });
  assert.equal((await policy.call()).decidedBy, 'pending');
  assert.equal(waitingKind(policy), 'policy');
  const ownerKey = setup(t);
  ownerKey.world.keys = ['file.git'];
  assert.equal((await ownerKey.call()).decidedBy, 'pending');
  assert.equal(waitingKind(ownerKey), 'owner');
  const needs = setup(t);
  needs.world.keys = ['guard.needs_approval'];
  assert.equal((await needs.call()).decidedBy, 'pending');
  assert.equal(waitingKind(needs), 'policy');
  const reason = setup(t);
  reason.world.ownerReason = 'owner only';
  assert.equal((await reason.call()).decidedBy, 'pending');
  assert.equal(waitingKind(reason), 'owner');
  const late = setup(t);
  late.fromNextRedo(check => ({ ...check, reasonKeys: [...(check.reasonKeys ?? []), 'file.git'] }));
  assert.equal((await late.call()).decidedBy, 'pending', '判定のあとの確かめで出た持ち主の決めのキー');
  assert.equal(waitingKind(late), 'owner');
  for (const s of [hook, policy, ownerKey, needs, reason, late]) assert.deepEqual([s.ran(), s.prompts.length], [0, 0]);
});

test('J-4（P3 で反転）: Off で、外を読んだタスク・タスクの子の担当・会話の子の担当の行き先は、外を読んでいない同じ実行と同じ', async t => {
  const parents = [
    (c: ToolContext): ToolContext => ({ ...c, kind: 'task' }),
    (c: ToolContext): ToolContext => ({ ...c, kind: 'agent', parent: { runId: 'r0', conversationId: c.conversationId, kind: 'task', title: 'parent task', taskId: 't1' } }),
    (c: ToolContext): ToolContext => ({ ...c, kind: 'agent', parent: { runId: 'r0', conversationId: c.conversationId, kind: 'chat', title: 'parent chat' } }),
  ];
  for (const [i, shape] of parents.entries()) {
    const seen: unknown[] = [];
    for (const tainted of [false, true]) {
      const s = setup(t);
      const out = await s.call({ ...shape(s.ctx), taint: { tainted, sources: tainted ? ['web_fetch'] : [] } }, 'probe');
      seen.push([out.decidedBy, out.decidedBy === 'pending' ? waitingKind(s) : null, s.ran(), s.prompts.length]);
    }
    assert.deepEqual(seen[1], seen[0], `${i}: ${JSON.stringify(seen)}`);
  }
});

test('J-4: Off でも、beat 自身に触れるコード（code.self_touch）は判定役の代わりに持ち主の Pending に積む。On では今までどおり判定役が見る', async t => {
  const s = setup(t);
  s.world.keys = ['code.self_touch', 'list.form'];
  s.world.askKinds = ['code'];
  assert.equal((await s.call()).decidedBy, 'pending');
  assert.equal(waitingKind(s), 'owner');
  assert.match(s.pending.list({ status: 'waiting' })[0]!.reason, /touches beat itself and the judge is off/u);
  assert.deepEqual([s.ran(), s.prompts.length], [0, 0]);
  const on = setup(t, keepOn);
  on.world.keys = ['code.self_touch', 'list.form'];
  assert.equal((await on.call()).decidedBy, 'auto-mode');
  assert.equal(on.prompts.length, 1);
});

test('J-4: Off でも、計画モードでは書けない（判定の前の断りも、判定のあとの断りも）', async t => {
  const s = setup(t);
  s.state.mode = 'plan';
  const before = await s.call();
  assert.deepEqual([before.decision, before.decidedBy], ['deny', 'mode']);
  s.state.mode = 'auto';
  s.state.modes = ['auto', 'plan'];
  const after = await s.call();
  assert.deepEqual([after.decision, after.decidedBy, s.ran()], ['deny', 'mode', 0], after.output.content);
});

test('J-4: Off でも、判定のあとの 2 回目の確かめ（事前の判定のやり直し）は通る: 断りに変わった・新しい確かめが出たら動かさない', async t => {
  const s = setup(t);
  s.world.redo = check => ({ ...check, decision: 'deny', reasons: ['now refused'] });
  const refused = await s.call();
  assert.equal(refused.decision, 'deny');
  assert.match(refused.output.content, /changed while it was being judged/u);
  const fresh = setup(t);
  fresh.fromNextRedo(check => ({ ...check, reasons: [...check.reasons, 'a new check'] }));
  const changed = await fresh.call();
  assert.equal(changed.decision, 'deny');
  assert.match(changed.output.content, /a new check/u);
  assert.deepEqual([s.ran(), fresh.ran()], [0, 0]);
});

test('J-4: On に戻すと前と同じ（判定役が呼ばれ、auto-mode で記録し、数に入る）', async t => {
  const s = setup(t, c => { c.routing.judgeMode = 'on'; });
  const out = await s.call();
  assert.deepEqual([out.decidedBy, s.prompts.length, judgeRows(s)], ['auto-mode', 1, 1]);
  assert.deepEqual(out.gate, { by: 'judge', reason: 'in scope' });
  assert.equal(s.pending.judged(0).allowed, 1);
});

test('J-4: Off でも、持ち主の頼みが無い実行（beat が自分で決めたタスク・よそから来た文から作ったタスクなど）は、判定役に回るはずの呼び出しを持ち主の Pending に積む', async t => {
  const s = setup(t);
  s.state.request = '  ';
  assert.equal((await s.call()).decidedBy, 'pending');
  assert.equal(waitingKind(s), 'owner');
  assert.match(s.pending.list({ status: 'waiting' })[0]!.reason, /no request from you/u);
  assert.deepEqual([s.ran(), s.prompts.length, judgeRows(s)], [0, 0, 0]);
});

test('J-4: 今の設定が読めないときは、判定なしにしない（Off で始めた実行でも判定役が呼ばれる）', async t => {
  const s = setup(t);
  s.state.broken = true;
  const out = await s.call();
  assert.equal(s.prompts.length, 1, '判定役が呼ばれる');
  assert.equal(out.decidedBy, 'auto-mode');
  assert.notEqual(out.decidedBy, 'no-judge');
});

test('J-4: Off でも、MCP のサーバーの書く道具（effect: write）は判定役の代わりに持ち主の Pending に積む。書かない MCP の道具は判定なしで動く。On では判定役が見る', async t => {
  const s = setup(t);
  const out = await s.call(s.ctx, 'mcp__s1__put');
  assert.equal(out.decidedBy, 'pending', out.output.content);
  assert.equal(waitingKind(s), 'owner');
  assert.equal(s.prompts.length, 0);
  assert.equal(s.ran(), 0);
  const read = await s.call(s.ctx, 'mcp__s1__get');
  assert.equal(read.decidedBy, 'no-judge');
  const on = setup(t, keepOn);
  const judged = await on.call(on.ctx, 'mcp__s1__put');
  assert.equal(on.prompts.length, 1, judged.decidedBy);
});

test('control-bodies: Off でも、beat が中を読めない PowerShell の制御の形（shape.control_opaque）は判定役の代わりに持ち主の Pending に積む。On では今までどおり判定役が見る', async t => {
  const s = setup(t);
  s.world.keys = ['shape.control_opaque', 'shape.control'];
  s.world.askKinds = ['code'];
  assert.equal((await s.call()).decidedBy, 'pending');
  assert.equal(waitingKind(s), 'owner');
  assert.match(s.pending.list({ status: 'waiting' })[0]!.reason, /cannot read inside/u);
  assert.deepEqual([s.ran(), s.prompts.length], [0, 0]);
  const readable = setup(t);
  readable.world.keys = ['shape.control'];
  assert.equal((await readable.call()).decidedBy, 'no-judge', '読めた制御の形は今までどおり判定なしで動く');
  const on = setup(t, keepOn);
  on.world.keys = ['shape.control_opaque', 'shape.control'];
  assert.equal((await on.call()).decidedBy, 'auto-mode');
  assert.equal(on.prompts.length, 1);
});
