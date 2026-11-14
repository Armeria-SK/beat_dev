import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { TAINTED_NOTE, type ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { checkFilePath, fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { PendingStore } from '../src/pending/store.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SKILL_AUTO_PER_DAY } from '../src/tools/skills/store.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// 段 8（A3）: 道具ごとの方針は、今の判定に「厳しさを足す」ことしかできない。
// allow は何も緩めない / ask は毎回（会話の許可を越えて）承認を求める / block は使わせない

type Policy = 'allow' | 'ask' | 'block';

function stub(name: string, allowedIn: ToolDef['allowedIn'], ran: string[]): ToolDef {
  return { name, description: name, input: Type.Object({}, { additionalProperties: false }), effect: 'meta', allowedIn, async execute() { ran.push(name); return { content: `ran ${name}` }; } };
}

function setup(t: { after: (fn: () => void) => void }, policies: Record<string, Policy> = {}, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  config.tools.policies = policies;
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db);
  const ran: string[] = [];
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun)
    .register(stub('memory_save', ['chat', 'task', 'review'], ran))
    .register(stub('task_complete', ['task'], ran)).register(stub('task_checkpoint', ['task'], ran)).register(stub('ask_user', ['task'], ran));
  const policy = buildPolicy(parsed, paths);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const judge = { answer: '{"decision":"ask","reason":"not sure"}', calls: [] as ClassifierPrompt[] };
  const call = (name: string, args: unknown, c: ToolContext = ctx, live?: () => AppConfig) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: e => events.push(e), conversationTainted: () => false, ...(live ? { config: live } : {}),
      lastUserRequest: () => 'please do the work', autoClassify: async prompt => { judge.calls.push(prompt); return judge.answer; },
    });
  const waiting = () => pending.list({ status: 'waiting' });
  return { paths, ctx, call, approvals, events, db, ran, parsed, controller, registry, pending, waiting, judge };
}

const withPolicy = (s: ReturnType<typeof setup>, policies: Record<string, Policy>): AppConfig => ({ ...s.parsed, tools: { ...s.parsed.tools, policies } });

test('A3: 設定の既定は空（書かなければ全部 allow）。知らない値・道具の名前でない鍵は設定を読む段階で断る', () => {
  assert.deepEqual(parseConfig(testConfig()).tools.policies, {});
  assert.deepEqual(parseConfig({ ...testConfig(), tools: { ...testConfig().tools, policies: { shell_run: 'ask', file_write: 'block' } } }).tools.policies, { shell_run: 'ask', file_write: 'block' });
  const bad = (policies: unknown) => parseConfig({ ...testConfig(), tools: { ...testConfig().tools, policies } } as never);
  assert.throws(() => bad({ shell_run: 'never' }), /policies/u);
  assert.throws(() => bad({ 'Not A Tool': 'ask' }), /policies/u);
  assert.throws(() => bad({ shell_run: 'ask', ['x'.repeat(65)]: 'ask' }), /policies/u);
});

// 判定の結果を並べた表。allow（既定でも明示でも）で、方針なしと一字も変わらないことを確かめる
async function decisions(s: ReturnType<typeof setup>): Promise<Array<[string, string]>> {
  writeFileSync(join(s.paths.workspace, '.env'), 'SECRET=xyz');
  const rows: Array<[string, string]> = [];
  const note = async (label: string, name: string, args: unknown, c: ToolContext = s.ctx) => {
    const outcome = await s.call(name, args, c);
    rows.push([label, `${outcome.decision}/${outcome.decidedBy}/${outcome.output.isError ? 'error' : 'ok'}`]);
  };
  await note('禁止のファイルに書く', 'file_write', { path: '.env', content: 'x' });
  await note('許可フォルダの外に書く', 'file_write', { path: '../outside.txt', content: 'x' });
  await note('読むだけのフォルダに書く', 'file_write', { path: join(s.paths.data, 'reference', 'doc.md'), content: 'x' });
  await note('設定を読む', 'file_read', { path: s.paths.config });
  await note('秘密を読む（シェル）', 'shell_run', { command: 'cat .env' });
  await note('強い禁止のコマンド', 'shell_run', { command: 'sudo rm -rf /' });
  await note('ふつうに読む', 'file_read', { path: join(s.paths.data, 'reference', 'doc.md') });
  await note('振り返りでは書けない', 'file_write', { path: 'a.md', content: 'x' }, { ...s.ctx, kind: 'review' });
  const tainted = { ...s.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  const written = await s.call('file_write', { path: 'tainted.md', content: 'x' }, tainted);
  rows.push(['外を読んだあと', `${written.decision}/${written.decidedBy}`]);
  return rows;
}

test('A3: allow（既定でも、明示しても）は判定を緩めない: 拒否・秘密・読むだけ・振り返りの禁止・外を読んだあとの書き込みは、方針なしと同じ', async t => {
  const plain = await decisions(setup(t));
  const explicit = await decisions(setup(t, { file_write: 'allow', file_read: 'allow', file_edit: 'allow', file_list: 'allow', shell_run: 'allow' }));
  assert.deepEqual(explicit, plain);
  assert.deepEqual(plain.filter(([, d]) => d.startsWith('deny')).map(([label]) => label), ['禁止のファイルに書く', '許可フォルダの外に書く', '読むだけのフォルダに書く', '設定を読む', '秘密を読む（シェル）', '強い禁止のコマンド', '振り返りでは書けない'], 'この表の拒否が、方針なしでも拒否のまま（比べる基準が壊れていない）');
});

test('A3: ask は、ふだん確かめなしの呼び出しも札を出さずに Pending に積む（kind policy）。実行しない。同じ入力でも次はまた積む', async t => {
  const s = setup(t, { file_write: 'ask' });
  const first = await s.call('file_write', { path: 'a.md', content: '1' });
  assert.equal(first.decision, 'ask');
  assert.equal(first.decidedBy, 'pending');
  assert.equal(first.output.isError, undefined, '失敗と読んでやり直さないよう、エラーにしない');
  assert.match(first.output.content, /Parked as #\d+ in Pending\. It has NOT run/u);
  assert.equal(s.judge.calls.length, 0, '判定役は呼ばない');
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false, '積んだだけで動かない');
  const rows = s.waiting();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, 'policy');
  assert.match(rows[0]!.reason, /file_write/u);
  assert.deepEqual(s.db.prepare("SELECT decision, decided_by, approval_id FROM tool_calls WHERE tool = 'file_write'").all().map(r => ({ ...r })), [{ decision: 'ask', decided_by: 'pending', approval_id: `pending:${rows[0]!.id}` }]);

  const second = await s.call('file_write', { path: 'a.md', content: '1' });
  assert.equal(second.decidedBy, 'pending');
  assert.equal(s.waiting().length, 2, '同じ入力でも、また積む');
});


test('A3: ask は拒否を承認に変えない（拒否は承認を求める前に拒否のまま。承認の依頼も出さない）', async t => {
  const s = setup(t, { file_write: 'ask', shell_run: 'ask', file_read: 'ask' });
  writeFileSync(join(s.paths.workspace, '.env'), 'SECRET=xyz');
  for (const [name, args] of [['file_write', { path: '.env', content: 'x' }], ['file_read', { path: s.paths.config }], ['shell_run', { command: 'cat .env' }], ['shell_run', { command: 'sudo rm -rf /' }]] as Array<[string, unknown]>) {
    const outcome = await s.call(name, args);
    assert.equal(outcome.decision, 'deny', JSON.stringify(args));
    assert.equal(s.waiting().length, 0, `${JSON.stringify(args)}: Pending にも積まない`);
  }
});

test('A3: block は実行せず拒否する。承認の依頼も出さず、道具の記録には「決めたのは policy」で残る。引数が不正でも、会話の許可・フックの allow があっても越えられない', async t => {
  const dir = tempDir(t);
  const allow = join(dir, 'allow.mjs');
  writeFileSync(allow, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('{"decision":"allow"}')})`);
  const s = setup(t, { file_write: 'block', shell_run: 'block' }, c => {
    c.tools.hooks.preToolUse = [{ matcher: 'file_.*', command: [process.execPath, allow], timeoutMs: 10_000, onError: 'deny' }];
    c.tools.shell.ask = ['echo needs-approval'];
  });
  const blocked = await s.call('file_write', { path: 'a.md', content: 'x' });
  assert.equal(blocked.decision, 'deny');
  assert.equal(blocked.decidedBy, 'policy');
  assert.match(blocked.output.content, /file_write/u);
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);
  assert.equal(s.waiting().length, 0);
  assert.equal((await s.call('file_write', { path: 'a.md' })).decidedBy, 'policy', '引数が不正でも、ほかの理由より先に止まる');
  assert.deepEqual(s.db.prepare("SELECT tool, decision, decided_by FROM tool_calls WHERE tool = 'file_write' ORDER BY created_at").all().map(r => ({ ...r })), [
    { tool: 'file_write', decision: 'deny', decided_by: 'policy' }, { tool: 'file_write', decision: 'deny', decided_by: 'policy' },
  ]);
  assert.equal((await s.call('file_read', { path: join(s.paths.data, 'reference', 'doc.md') })).decision, 'allow', '方針が無い道具は今までどおり');
});

test('A3: 振り返りでは ask は拒否として扱う（承認する人がいない裏の作業なので待たない）。会話では Pending に積む', async t => {
  const s = setup(t, { memory_save: 'ask' });
  const review = await s.call('memory_save', {}, { ...s.ctx, kind: 'review', conversationId: 'review-conv' });
  assert.equal(review.decision, 'deny');
  assert.equal(review.decidedBy, 'policy');
  assert.match(review.output.content, /a review \(background work\)/u);

  assert.deepEqual(s.ran, []);
  assert.equal(s.waiting().length, 0, '振り返りは積まない');
  const chat = await s.call('memory_save', {});
  assert.equal(chat.decision, 'ask');
  assert.equal(chat.decidedBy, 'pending');
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.waiting().map(r => r.kind), ['policy']);

  const plain = setup(t);
  assert.equal((await plain.call('memory_save', {}, { ...plain.ctx, kind: 'review' })).decision, 'allow', '方針が無ければ振り返りで使える（比べる基準）');
});

test('スキルのフォルダへの書き込みの確かめの文は、聞かずに登録する設定のときは「画面で承認して登録」と言わない', t => {
  const ask = setup(t);
  const asked = checkFilePath('skills/memo/SKILL.md', 'write', ask.ctx).check;
  assert.deepEqual([asked.decision, asked.askKinds], ['ask', ['persona']]);
  assert.match(asked.reasons[0]!, /skill_draft to approve and register it on screen/u);

  const auto = setup(t, {}, c => { c.skills = { askBeforeRegister: false }; });
  const unasked = checkFilePath('skills/memo/SKILL.md', 'write', auto.ctx).check;
  assert.deepEqual([unasked.decision, unasked.askKinds], ['ask', ['persona']], '確かめそのものは変わらない');
  assert.match(unasked.reasons[0]!, /skill_draft instead: under the current setting it is registered without the user's review/u);
  assert.doesNotMatch(unasked.reasons[0]!, /on screen/u);
  assert.ok(unasked.reasons[0]!.includes(`or ${SKILL_AUTO_PER_DAY} skills were already registered that way in the last 24 hours; in those cases it waits as a draft`), '1 日の上限に達したら下書きで待つことも言う');
});

test('振り返りでは、外から読んだ内容のあとの書き込みの確かめ（ask）も拒否にする（承認する人がいないので待たない）。会話では今までどおり承認を求める', async t => {
  const s = setup(t);
  s.registry.register({ ...stub('memory_forget', ['chat', 'review'], s.ran), escalateOnTaint: true });
  const taint = { tainted: true, sources: ['history_read: c9'] };
  const started = Date.now();
  const review = await s.call('memory_forget', {}, { ...s.ctx, kind: 'review', conversationId: 'review-conv', taint });
  assert.equal(review.decision, 'deny');
  assert.match(review.output.content, /history_read: c9.*a review \(background work\) has nobody to approve it/u);
  assert.equal(s.waiting().length, 0, '積まない');
  assert.equal(s.judge.calls.length, 0, '判定役も呼ばない');
  assert.ok(Date.now() - started < 5000, '待たない');
  assert.deepEqual(s.ran, []);
  assert.equal((await s.call('memory_forget', {}, { ...s.ctx, kind: 'review', conversationId: 'review-conv' })).decision, 'allow', '外を読んでいない振り返りは今までどおり使える');
  assert.equal((await s.call('memory_save', {}, { ...s.ctx, kind: 'review', conversationId: 'review-conv', taint })).decision, 'allow', '外を読んだあとでも、確かめの対象でない道具は変わらない');

  // escalateOnTaint: 4-3b-2 後も判定役
  const chat = await s.call('memory_forget', {}, { ...s.ctx, taint });
  assert.equal(chat.decidedBy, 'pending');
  assert.deepEqual(s.ran, ['memory_forget', 'memory_save'], '判定役が確かめると答えたら動かない');
  assert.deepEqual(s.waiting().map(r => r.kind), ['judge']);
  assert.match(s.waiting()[0]!.checks.join(' '), /history_read: c9/u);
  s.judge.answer = '{"decision":"allow","reason":"fits the request"}';
  assert.equal((await s.call('memory_forget', {}, { ...s.ctx, taint })).decidedBy, 'auto-mode');
  assert.deepEqual(s.ran, ['memory_forget', 'memory_save', 'memory_forget']);
});

test('A3: タスクの実行で ask になったら、札を待たずに Pending に積み、すぐ戻る', async t => {
  const s = setup(t, { file_write: 'ask' });
  const outcome = await s.call('file_write', { path: 'a.md', content: 'x' }, { ...s.ctx, kind: 'task', conversationId: 'task-conv' });
  assert.equal(outcome.decision, 'ask');
  assert.equal(outcome.decidedBy, 'pending');
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);

  const rows = s.waiting();
  assert.deepEqual(rows.map(r => [r.kind, r.conversation_id, r.run_kind]), [['policy', 'task-conv', 'task']]);
});

test('A3: 方針を持てない道具（task_complete・task_checkpoint・ask_user）は、設定に block・ask と書いてあっても無視する（止めるとワーカーが終われなくなる）', async t => {
  const s = setup(t, { task_complete: 'block', task_checkpoint: 'ask', ask_user: 'block' });
  const task = { ...s.ctx, kind: 'task' as const, conversationId: 'task-conv' };
  for (const [i, name] of ['task_complete', 'task_checkpoint', 'ask_user'].entries()) {
    const outcome = await s.call(name, {}, task);
    assert.equal(outcome.decision, 'allow', name);
    assert.equal(outcome.output.content, `ran ${name}\n[E-${i + 1}]`);
  }
  assert.equal(s.waiting().length, 0);
});

test('A3: 実行の途中で設定が厳しくなったら、その場から効く。緩くなったときは、次の実行から（途中では緩めない）', async t => {
  const s = setup(t);
  const stricter = withPolicy(s, { file_write: 'block' });
  assert.equal((await s.call('file_write', { path: 'a.md', content: 'x' }, s.ctx, () => stricter)).decidedBy, 'policy', '開いたときは方針なし → いまは block');
  assert.equal(existsSync(join(s.paths.workspace, 'a.md')), false);

  const started = setup(t, { file_write: 'block' });
  const looser = withPolicy(started, {});
  const outcome = await started.call('file_write', { path: 'a.md', content: 'x' }, started.ctx, () => looser);
  assert.equal(outcome.decision, 'deny', '実行を始めたときの方針が block なら、途中で緩めても、その実行では使えない');

  const asked = setup(t, {});
  const live = withPolicy(asked, { file_write: 'ask' });
  const parked = await asked.call('file_write', { path: 'b.md', content: 'x' }, asked.ctx, () => live);
  assert.equal(parked.decidedBy, 'pending', '途中で ask にしても効く');
  assert.equal(existsSync(join(asked.paths.workspace, 'b.md')), false);
});

test('A3: ask の理由には種類が付く（外を読む outside_read・外から読んだ内容 taint・方針 policy・フック hook・コードを動かす code。細かい種類が無い事前の判定は precheck）。付かない理由を自動で通さないための土台', async t => {
  const dir = tempDir(t);
  const askHook = join(dir, 'ask.mjs');
  writeFileSync(askHook, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'ask',permissionDecisionReason:'念のため確認'}}))})`);
  const kindsOf = async (s: ReturnType<typeof setup>, command: string) => [...((await shellRun.preCheck!({ command }, s.ctx)).askKinds ?? [])].sort();

  const plain = setup(t);
  const outside = join(plain.paths.data, 'outside.txt');
  writeFileSync(outside, 'x');
  assert.deepEqual(await kindsOf(plain, process.platform === 'win32' ? `Get-Content "${outside}"` : `cat "${outside}"`), ['outside_read'], '許可フォルダの外を読む');
  writeFileSync(join(plain.paths.workspace, 'put.js'), "console.log('x');\n");
  assert.ok((await kindsOf(plain, 'node put.js')).includes('code'), 'コードを動かす');
  const readOutside = { ...plain.ctx, taint: { tainted: true, sources: ['web_fetch'] } };
  plain.registry.register({ ...stub('t_escalate', ['chat'], plain.ran), escalateOnTaint: true });
  const taintedCall = await plain.call('t_escalate', {}, readOutside);
  assert.equal(taintedCall.decidedBy, 'pending');
  assert.equal(plain.judge.calls.length, 1, '外から読んだあとの escalateOnTaint の道具は判定役に回る');
  assert.ok(plain.judge.calls[0]!.user.includes(TAINTED_NOTE));
  assert.deepEqual(plain.waiting().map(r => [r.kind, r.tainted]), [['judge', true]]);
  assert.match(plain.waiting()[0]!.checks.join(' '), /web_fetch/u);
  plain.pending.reject(plain.waiting()[0]!.id);
  assert.equal((await plain.call('file_write', { path: 'a.md', content: 'x' }, readOutside)).decidedBy, 'builtin', '外から読んだあとの書き込みは確かめない（R19）');
  assert.equal(plain.judge.calls.length, 1);
  assert.equal(existsSync(join(plain.paths.workspace, 'a.md')), true);

  const parkedKind = async (s: ReturnType<typeof setup>, c: ToolContext = s.ctx) => {
    const outcome = await s.call('file_write', { path: 'a.md', content: 'x' }, c);
    assert.equal(outcome.decidedBy, 'pending');
    assert.equal(s.judge.calls.length, 0, '判定役は呼ばない');
    return s.waiting()[0]!.kind;
  };
  const policy = setup(t, { file_write: 'ask' });
  assert.equal(await parkedKind(policy), 'policy');
  const tainted = setup(t, { file_write: 'ask' });
  assert.equal(await parkedKind(tainted, { ...tainted.ctx, taint: { tainted: true, sources: ['web_fetch'] } }), 'policy');
  assert.equal(tainted.waiting()[0]!.tainted, true);

  const hooked = setup(t, {}, c => { c.tools.hooks.preToolUse = [{ matcher: 'file_write', command: [process.execPath, askHook], timeoutMs: 10_000, onError: 'deny' }]; });
  assert.equal(await parkedKind(hooked), 'hook');
});
