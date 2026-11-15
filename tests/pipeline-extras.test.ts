import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { StopReason } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import type { ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { PLAN_EFFECTS, planAllows, REVIEW_FORBIDDEN, reviewAllows, runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef, ToolEffect } from '../src/tools/types.ts';
import { CONVERSATION, settled, startApp } from './app-setup.ts';
import { tempDir, testConfig, type Script, offered } from './helpers.ts';

// 段 4-3: パイプラインの足し分。X1 ToolOutput.fetched（結果が外の中身を持ち込んだ印）、X2 ToolDef.writesFiles（計画モード・外を読んだあとの確かめで書き込みと同じ）、
// X6 ToolDef.networkCall（この呼び出しが外へ出るなら、外を読んだ印と、自動承認で外を読んだ会話の毎回の確かめを network と同じに）。
// どれも守りを緩めない: 今までの道具（足した項目を持たない道具）の動きは変わらないことも、ここで対にして確かめる

const EFFECTS: ToolEffect[] = ['read', 'write', 'exec', 'network', 'meta'];
const ALLOW = '{"decision":"allow","reason":"依頼の範囲です"}';
const ASK = '{"decision":"ask","reason":"持ち主に聞く"}';

function tool(ran: string[], name: string, effect: ToolEffect, over: Partial<ToolDef> = {}): ToolDef {
  return {
    name, description: name, effect, allowedIn: ['chat', 'task', 'review'],
    input: Type.Object({ url: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute() { ran.push(name); return { content: `ran ${name}` }; },
    ...over,
  };
}

type Setup = ReturnType<typeof setup>;

function setup(t: { after: (fn: () => void) => void }, tools: ToolDef[], options: {
  mode?: PermissionMode; tainted?: boolean; mutate?: (c: AppConfig) => void; classify?: (prompt: ClassifierPrompt) => Promise<string> | string;
} = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry();
  for (const def of tools) registry.register(def);
  const policy = buildPolicy(parsed, paths);
  const state = { mode: options.mode ?? 'auto' as PermissionMode };
  const makeCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: options.tainted ? { tainted: true, sources: ['web_fetch'] } : { tainted: false, sources: [] },
    log: () => undefined, permissionMode: state.mode, ...over,
  });
  const ctx = makeCtx();
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const judge = { answer: ASK, calls: 0 };
  const classify = options.classify ?? (() => judge.answer);
  const call = (name: string, args: unknown, c: ToolContext = ctx) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
    registry, approvals, pending, db, emit: () => undefined, permissionMode: () => state.mode,
    autoClassify: async (prompt: ClassifierPrompt) => { judge.calls++; return classify(prompt); }, lastUserRequest: () => 'x を読んで', conversationTainted: () => false,
  });
  return { ctx, makeCtx, call, approvals, db, state, pending, judge };
}

// 呼んでみて、Pending に積まれたか（積まれたら種類・理由を控えて、断る）、積まれずに終わったかを返す
async function observe(s: Setup, name: string, args: unknown, c: ToolContext = s.ctx) {
  const before = s.judge.calls;
  const outcome = await s.call(name, args, c);
  const judged = s.judge.calls > before;
  if (outcome.decidedBy !== 'pending') return { asked: false as const, judged, outcome };
  const row = s.pending.list({ status: 'waiting' })[0];
  assert.ok(row, `${name}: Pending に行が無い`);
  s.pending.reject(row.id);
  return { asked: true as const, judged, kind: row.kind, checks: row.checks, outcome };
}

const toolRows = (s: Setup) => s.db.prepare('SELECT tool, decision, decided_by FROM tool_calls ORDER BY created_at').all().map(r => ({ ...r }));

// ── X2: writesFiles ──

test('planAllows: 計画モードで使えるのは読む道具と network だけ。writesFiles を持つ道具は、効果が何でも使えない', () => {
  assert.deepEqual(EFFECTS.filter(effect => planAllows({ effect })), ['read', 'network'], '足した項目が無い道具は、今までの PLAN_EFFECTS と同じ');
  assert.deepEqual(EFFECTS.filter(effect => PLAN_EFFECTS.has(effect)), ['read', 'network']);
  assert.deepEqual(EFFECTS.filter(effect => planAllows({ effect, writesFiles: true })), [], 'writesFiles があれば、効果が read や network でも使えない');
});

test('X2 計画モード（パイプライン）: 効果 network + writesFiles の道具は断る（決めたのは mode・実行しない）。writesFiles の無い network の道具は今までどおり動く。自動承認のモードでは動く', async t => {
  const ran: string[] = [];
  const tools = [tool(ran, 'net_plain', 'network'), tool(ran, 'net_writer', 'network', { writesFiles: true }), tool(ran, 'reader', 'read'), tool(ran, 'plain_write', 'write')];
  const plan = setup(t, tools, { mode: 'plan' });
  const writer = await plan.call('net_writer', {});
  assert.equal(writer.decision, 'deny');
  assert.equal(writer.decidedBy, 'mode');
  assert.match(writer.output.content, /plan mode/u);
  assert.equal(writer.output.isError, true);
  for (const name of ['net_plain', 'reader']) assert.equal((await plan.call(name, {})).decision, 'allow', `${name}: 計画モードでも動く（今までどおり）`);
  assert.equal((await plan.call('plain_write', {})).decidedBy, 'mode', '比べる基準: 書き込みの道具は今までどおり断る');
  assert.deepEqual(ran, ['net_plain', 'reader']);
  assert.deepEqual(toolRows(plan).filter(r => r.decided_by === 'mode'), [
    { tool: 'net_writer', decision: 'deny', decided_by: 'mode' }, { tool: 'plain_write', decision: 'deny', decided_by: 'mode' },
  ]);

  const ranNormal: string[] = [];
  const normal = setup(t, [tool(ranNormal, 'net_writer', 'network', { writesFiles: true })]);
  assert.equal((await normal.call('net_writer', {})).decision, 'allow', '自動承認のモードでは動く');
  assert.deepEqual(ranNormal, ['net_writer']);
});

test('X2 計画モード（途中でモードが替わる）: 自動承認の判定役を待つあいだに計画モードに替わったら、writesFiles の道具は Pending にも積まず断る。writesFiles の無い道具は判定役の答えに従う。外へ出る道具（network）も判定役に回る', async t => {
  const preCheck: ToolDef['preCheck'] = () => ({ decision: 'ask', reasons: ['フォルダの外を読みます'], askKinds: ['outside_read'] });
  const ran: string[] = [];
  let classified = 0;
  // 判定役が答えるまでのあいだに、持ち主が計画モードに替える（外へ出る道具は送る側なので判定役に回らないため、読む道具で確かめる）
  const writerSide = setup(t, [tool(ran, 'net_writer', 'read', { writesFiles: true, preCheck })], {
    mode: 'auto', classify: () => { classified++; writerSide.state.mode = 'plan'; return ALLOW; },
  });
  const writer = await observe(writerSide, 'net_writer', {});
  assert.equal(classified, 1, '判定役には回った（モードが替わったのは判定役を待つあいだ）');
  assert.equal(writer.asked, false, 'Pending にも積まない');
  assert.equal(writer.outcome.decision, 'deny');
  assert.equal(writer.outcome.decidedBy, 'mode');
  assert.deepEqual(ran, []);
  assert.equal(writerSide.pending.list({ status: 'waiting' }).length, 0);

  const plainSide = setup(t, [tool(ran, 'net_plain', 'read', { preCheck })], {
    mode: 'auto', classify: () => { plainSide.state.mode = 'plan'; return ALLOW; },
  });
  const plain = await observe(plainSide, 'net_plain', {});
  assert.equal(plain.asked, false, '比べる基準: 計画モードで使える道具は断らず、判定役の答えに従う');
  assert.deepEqual([plain.outcome.decision, plain.outcome.decidedBy], ['allow', 'auto-mode']);
  assert.deepEqual(ran, ['net_plain']);

  let networkClassified = 0;
  const netSide = setup(t, [tool(ran, 'net_real', 'network', { preCheck })], { mode: 'auto', classify: () => { networkClassified++; return ASK; } });
  const net = await observe(netSide, 'net_real', {});
  assert.equal(net.asked, true);
  assert.equal(net.asked && net.kind, 'judge');
  assert.ok(net.asked && net.checks.includes('フォルダの外を読みます'), JSON.stringify(net));
  assert.equal(networkClassified, 1, '効果が network の道具も判定役に回る');
  assert.deepEqual(ran, ['net_plain']);
});

test('X2 モデルに渡す道具の一覧（エンジンの #toolsFor）: 計画モードでは writesFiles の道具を外し、読む道具と writesFiles の無い network の道具は残す。自動承認のモードでは全部渡す', async t => {
  const s = await startApp(t);
  const ran: string[] = [];
  s.app.tools.register(tool(ran, 'net_plain', 'network'));
  s.app.tools.register(tool(ran, 'net_writer', 'network', { writesFiles: true }));
  const say = (text: string): Script => async function* () { yield { type: 'text', delta: text }; yield { type: 'done', stop: 'end_turn' as StopReason }; };
  s.adapter().scripts = [say('計画です'), say('ふつうです')];
  const names = (index: number) => offered(s.adapter().calls[index]!);
  const plan = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: '計画して', permissionMode: 'plan' });
  await settled(s.app, plan.body.runId);
  assert.ok(names(0).includes('file_read') && names(0).includes('web_fetch') && names(0).includes('net_plain'), '読む道具と writesFiles の無い network の道具は残る');
  assert.ok(!names(0).includes('net_writer'), 'writesFiles の道具は計画モードの一覧に無い');
  const normal = await s.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'ふつうに', permissionMode: 'auto' });
  await settled(s.app, normal.body.runId);
  assert.ok(names(1).includes('net_writer') && names(1).includes('net_plain'), '自動承認のモードは全部');
});

test('X2 外から読んだ内容のあと: network + writesFiles の道具も、書き込みの道具も、writesFiles の無い network の道具も、読む道具も確かめずに動く（R19）', async t => {
  const ran: string[] = [];
  const tools = [tool(ran, 'net_plain', 'network'), tool(ran, 'net_writer', 'network', { writesFiles: true }), tool(ran, 'plain_write', 'write'), tool(ran, 'reader', 'read')];
  const tainted = setup(t, tools, { tainted: true });
  for (const name of ['net_writer', 'plain_write', 'net_plain', 'reader']) {
    const seen = await observe(tainted, name, {});
    assert.deepEqual([seen.asked, seen.judged, seen.outcome.decidedBy], [false, false, 'builtin'], name);
  }
  assert.deepEqual(ran, ['net_writer', 'plain_write', 'net_plain', 'reader']);
});

test('X2 振り返り: network + writesFiles の道具も、writesFiles の無い network の道具も、書き込みも断る（REVIEW_FORBIDDEN に network がある）。読む道具は動く', async t => {
  assert.ok(REVIEW_FORBIDDEN.has('network') && REVIEW_FORBIDDEN.has('write') && REVIEW_FORBIDDEN.has('exec'));
  const ran: string[] = [];
  const s = setup(t, [tool(ran, 'net_plain', 'network'), tool(ran, 'net_writer', 'network', { writesFiles: true }), tool(ran, 'plain_write', 'write'), tool(ran, 'reader', 'read')]);
  const review = s.makeCtx({ kind: 'review', conversationId: 'review-conv' });
  for (const name of ['net_plain', 'net_writer', 'plain_write']) {
    const outcome = await s.call(name, {}, review);
    assert.equal(outcome.decision, 'deny', name);
    assert.equal(outcome.decidedBy, 'registry', name);
    assert.match(outcome.output.content, /during a review/u, name);
  }
  assert.equal((await s.call('reader', {}, review)).decision, 'allow');
  assert.deepEqual(ran, ['reader']);
});

test('X2 振り返りの締め付け: 効果が read・meta でも writesFiles の道具は、パイプラインが断り、モデルに渡す一覧（エンジンの #toolsFor）にも入らない。writesFiles の無い道具・会話の実行は今までどおり', async t => {
  assert.deepEqual(EFFECTS.filter(effect => reviewAllows({ effect })), ['read', 'meta'], '足した項目が無い道具は、今までの REVIEW_FORBIDDEN と同じ');
  assert.deepEqual(EFFECTS.filter(effect => reviewAllows({ effect, writesFiles: true })), [], 'writesFiles があれば、効果が何でも使えない');

  const ran: string[] = [];
  const s = setup(t, [tool(ran, 'read_writer', 'read', { writesFiles: true }), tool(ran, 'meta_writer', 'meta', { writesFiles: true }), tool(ran, 'reader', 'read')]);
  const review = s.makeCtx({ kind: 'review', conversationId: 'review-conv' });
  for (const name of ['read_writer', 'meta_writer']) {
    const outcome = await s.call(name, {}, review);
    assert.equal(outcome.decision, 'deny', name);
    assert.equal(outcome.decidedBy, 'registry', name);
    assert.match(outcome.output.content, /during a review/u, name);
  }
  assert.equal((await s.call('reader', {}, review)).decision, 'allow');
  assert.equal((await s.call('read_writer', {})).decision, 'allow', '比べる基準: 会話の実行では動く（締め付けは振り返りだけ）');
  assert.deepEqual(ran, ['reader', 'read_writer']);

  const app = await startApp(t, { tools: [tool([], 'read_writer', 'read', { writesFiles: true }), tool([], 'meta_writer', 'meta', { writesFiles: true }), tool([], 'reader', 'read')] });
  const started = app.app.engine.runReview(app.app.conversations.create({ kind: 'task' }).id, '[振り返り] テスト');
  assert.ok(started.ok);
  await started.done;
  assert.deepEqual(app.adapter().calls[0]!.tools.map(x => x.name), ['reader'], '振り返りのモデルに渡す一覧に、writesFiles の道具は無い');
  const chat = await app.json(`/api/conversations/${CONVERSATION}/messages`, 'POST', { text: 'ふつうに' });
  await settled(app.app, chat.body.runId);
  assert.deepEqual(app.adapter().calls[1]!.tools.map(x => x.name).sort(), ['meta_writer', 'read_writer', 'reader'], '比べる基準: 会話の実行には全部渡す');
});

// ── X6: networkCall ──

const urlTool = (ran: string[], over: Partial<ToolDef> = {}) => tool(ran, 'img_view', 'read', { networkCall: (input: { url?: string }) => input.url !== undefined, ...over });
const REMOTE = { url: 'https://example.com/a.png' };

test('X6 外を読んだ印: networkCall が true の呼び出しは、効果が read でも、動かしたら印が付く。false の呼び出しには付かない', async t => {
  const ran: string[] = [];
  const s = setup(t, [urlTool(ran)]);
  const local = s.makeCtx();
  assert.equal((await s.call('img_view', {}, local)).decision, 'allow');
  assert.equal(local.taint.tainted, false, 'url が無ければ付かない');
  assert.deepEqual(local.taint.sources, []);
  const remote = s.makeCtx();
  assert.equal((await s.call('img_view', REMOTE, remote)).decision, 'allow');
  assert.equal(remote.taint.tainted, true, 'url があれば付く');
  assert.deepEqual(remote.taint.sources, ['img_view']);
  assert.deepEqual(ran, ['img_view', 'img_view']);
  const plain = setup(t, [tool([], 'plain_read', 'read')]);
  await plain.call('plain_read', REMOTE);
  assert.equal(plain.ctx.taint.tainted, false, '比べる基準: networkCall を持たない read の道具は、url を渡されても付かない');
});

test('X6 外を読んだ印: 札で断った呼び出しは動かないので付かない。結果が noRemoteContent の失敗は、network の道具と同じに付かない', async t => {
  const ran: string[] = [];
  const failing = urlTool(ran, { execute: async () => ({ content: 'こちらの失敗', isError: true, noRemoteContent: true }) });
  const failingNet = tool(ran, 'net_fail', 'network', { execute: async () => ({ content: 'こちらの失敗', isError: true, noRemoteContent: true }) });
  const failingPlain = urlTool(ran, { name: 'img_fail', execute: async () => ({ content: '相手の文字が入る失敗', isError: true }) });
  const s = setup(t, [failing, failingNet, failingPlain]);
  const a = s.makeCtx(); await s.call('img_view', REMOTE, a);
  const b = s.makeCtx(); await s.call('net_fail', {}, b);
  const c = s.makeCtx(); await s.call('img_fail', REMOTE, c);
  assert.equal(a.taint.tainted, false, 'noRemoteContent の失敗には付かない');
  assert.equal(b.taint.tainted, false, '比べる基準: network の道具も同じ');
  assert.equal(c.taint.tainted, true, 'noRemoteContent でない失敗には付く（失敗の文にも相手の文字は入りうる）');

  const asked = setup(t, [urlTool(ran, { name: 'img_ask', preCheck: () => ({ decision: 'ask', reasons: ['確かめ'] }) })]);
  const declined = await observe(asked, 'img_ask', REMOTE);
  assert.equal(declined.asked, true);
  assert.equal(asked.ctx.taint.tainted, false, '断った呼び出しは動かないので付かない');
});

test('X6 外から読んだあとでも、networkCall が true の呼び出し・false の呼び出し・networkCall の無い read の道具・効果 network の道具は確かめない', async t => {
  const ran: string[] = [];
  const tools = [urlTool(ran), tool(ran, 'plain_read', 'read'), tool(ran, 'net_plain', 'network')];
  const s = setup(t, tools, { tainted: true });
  for (const [name, args] of [['img_view', REMOTE], ['img_view', {}], ['plain_read', REMOTE], ['net_plain', {}]] as const) {
    const seen = await observe(s, name, args);
    assert.deepEqual([seen.asked, seen.judged, seen.outcome.decision], [false, false, 'allow'], `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(ran.length, 4);
});

test('X6 networkCall が投げる・boolean でない値を返す呼び出しは、外へ出るとみなす（印が付く）。false だけが外へ出ない', async t => {
  const ran: string[] = [];
  const throwing = urlTool(ran, { name: 'img_throw', networkCall: () => { throw new Error('判定できない'); } });
  const junk = urlTool(ran, { name: 'img_junk', networkCall: (() => undefined) as unknown as (input: unknown) => boolean });
  const falsy = urlTool(ran, { name: 'img_false', networkCall: () => false });
  const s = setup(t, [throwing, junk, falsy]);
  for (const name of ['img_throw', 'img_junk']) {
    const c = s.makeCtx();
    assert.equal((await s.call(name, REMOTE, c)).decision, 'allow', name);
    assert.equal(c.taint.tainted, true, `${name}: 迷ったら外へ出るとみなす`);
  }
  const c = s.makeCtx();
  await s.call('img_false', REMOTE, c);
  assert.equal(c.taint.tainted, false, 'false なら外へ出ない');
});

test('X6 networkCall は、引数の確かめ（既定値を入れたあと）を通った引数で、実行する呼び出しごとに 1 回だけ呼ぶ。引数が合わない呼び出しでは呼ばない', async t => {
  const seen: unknown[] = [];
  const counted = urlTool([], {
    input: Type.Object({ url: Type.Optional(Type.String()), kind: Type.String({ default: 'remote' }) }, { additionalProperties: false }),
    networkCall: (input: { url?: string; kind?: string }) => { seen.push(input); return input.kind === 'remote'; },
  });
  const s = setup(t, [counted]);
  const invalid = await s.call('img_view', { url: 5 });
  assert.equal(invalid.decision, 'deny');
  assert.equal(invalid.invalidArguments, true);
  assert.deepEqual(seen, [], '引数が合わなければ呼ばない');
  const ran = await observe(s, 'img_view', {});
  assert.deepEqual([ran.judged, ran.outcome.decision, ran.outcome.decidedBy], [false, 'allow', 'builtin']);
  assert.deepEqual(seen, [{ kind: 'remote' }], '1 回だけ');
  assert.equal(s.ctx.taint.tainted, true, '既定値（kind: remote）を入れた引数で答えるので、外へ出る呼び出しとして印が付く');
});

test('X6 効果は変えない: 効果 read の networkCall の道具は、計画モードで動き、振り返りでも read として扱う（network の道具のように断らない）', async t => {
  const ran: string[] = [];
  const plan = setup(t, [urlTool(ran)], { mode: 'plan' });
  assert.equal((await plan.call('img_view', REMOTE)).decision, 'allow', '計画モード');
  assert.equal(planAllows({ effect: 'read' }), true);
  const review = await plan.call('img_view', REMOTE, plan.makeCtx({ kind: 'review', conversationId: 'review-conv' }));
  assert.equal(review.decision, 'allow', '振り返り（効果は read のまま）');
  assert.deepEqual(ran, ['img_view', 'img_view']);
});

// ── X1: ToolOutput.fetched ──

const fetchedTool = (ran: string[], name: string, fetched: boolean | undefined, over: Partial<ToolDef> = {}) => tool(ran, name, 'read', {
  async execute() { ran.push(name); return { content: `ran ${name}`, ...(fetched === undefined ? {} : { fetched }) }; },
  ...over,
});

test('X1 結果が fetched: true の道具は、効果が read でも印が付く（材料は道具の名前）。fetched: false・無しは付かない', async t => {
  const ran: string[] = [];
  const s = setup(t, [fetchedTool(ran, 'yes', true), fetchedTool(ran, 'no', false), fetchedTool(ran, 'unset', undefined)]);
  const yes = s.makeCtx(); await s.call('yes', {}, yes);
  assert.equal(yes.taint.tainted, true);
  assert.deepEqual(yes.taint.sources, ['yes']);
  for (const name of ['no', 'unset']) {
    const c = s.makeCtx();
    assert.equal((await s.call(name, {}, c)).decision, 'allow', name);
    assert.equal(c.taint.tainted, false, name);
    assert.deepEqual(c.taint.sources, [], name);
  }
});

test('X1 fetched は印を付ける向きにしか働かない: 失敗の結果でも付く。付いている印を fetched: false は外さない。実行されなかった呼び出しには付かない。付いたあとも書き込みは確かめない（R19）', async t => {
  const ran: string[] = [];
  const failing = fetchedTool(ran, 'yes_error', true, { async execute() { return { content: '失敗', isError: true, noRemoteContent: true, fetched: true }; } });
  const denied = fetchedTool(ran, 'denied', true, { preCheck: () => ({ decision: 'deny', reasons: ['だめ'] }) });
  const s = setup(t, [failing, denied, fetchedTool(ran, 'no', false), fetchedTool(ran, 'yes', true), tool(ran, 'plain_write', 'write')]);
  const errored = s.makeCtx(); await s.call('yes_error', {}, errored);
  assert.equal(errored.taint.tainted, true, '失敗（noRemoteContent つき）でも、fetched: true と言ったら付く');
  const refused = s.makeCtx();
  assert.equal((await s.call('denied', {}, refused)).decision, 'deny');
  assert.equal(refused.taint.tainted, false, '事前の判定で断った呼び出しは動かない');
  const already = s.makeCtx({ taint: { tainted: true, sources: ['web_fetch'] } });
  await s.call('no', {}, already);
  assert.equal(already.taint.tainted, true, 'fetched: false は、付いている印を外さない');
  assert.deepEqual(already.taint.sources, ['web_fetch']);

  const chain = s.makeCtx();
  assert.equal((await observe(s, 'plain_write', {}, chain)).asked, false, '比べる基準: 外を読む前の書き込みは確かめない');
  await s.call('yes', {}, chain);
  assert.equal(chain.taint.tainted, true);
  const after = await observe(s, 'plain_write', {}, chain);
  assert.deepEqual([after.asked, after.judged], [false, false], 'fetched で印が付いたあとの書き込みも確かめない');
});
