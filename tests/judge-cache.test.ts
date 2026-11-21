import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { PendingStore } from '../src/pending/store.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import type { PermissionMode } from '../src/shared/permission-mode.ts';
import { ApprovalBroker, type ApprovalPath } from '../src/tools/approvals.ts';
import type { ClassifierPrompt } from '../src/tools/auto-approve.ts';
import { involvedSnapshot, REMEMBERED_MAX, rememberAllow, rememberedAllow } from '../src/tools/judge-cache.ts';
import { judgeStats } from '../src/tools/judge-stats.ts';
import type { Outbound } from '../src/tools/hooks/outbound.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { AskKind, PreCheck, ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// J-3: 判定役の「許す」を、1 回の実行（runId）の中だけ覚えて、まったく同じ呼び出しに使い回す。使い回すのは判定役の答えだけで、ほかの確かめは毎回通る

const ALLOW = '{"decision":"allow","reason":"in scope"}';
const ASK = '{"decision":"ask","reason":"not sure"}';

interface World {
  reasons: string[]; askKinds: AskKind[]; keys: string[]; cwd: string; reads: string[] | undefined; writes: string[]; paths: ApprovalPath[]; pathsMore: number;
  title: string; body: string; redo: ((check: PreCheck) => PreCheck) | undefined; outbound?: Outbound | undefined; shownCwd?: string | undefined;
  pushes?: Array<{ dir: string | null }> | undefined; places?: string[] | undefined; bind?: string | undefined;
}

function setup(t: { after: (fn: () => void) => void }, mutate?: (c: AppConfig) => void) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  mutate?.(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db);
  const policy = buildPolicy(parsed, paths);
  const workspace = defaultWorkspace(policy, paths);
  const world: World = {
    reasons: ['reads outside'], askKinds: ['outside_read'], keys: ['guard.touches_outside'], cwd: workspace, reads: [], writes: [], paths: [], pathsMore: 0,
    title: 'probe', body: 'probe body', redo: undefined,
  };
  let checks = 0;
  let ran = 0;
  const probe = (name: string, effect: ToolDef['effect'] = 'exec'): ToolDef => ({
    name, description: name, input: Type.Object({ v: Type.String() }), effect, allowedIn: ['chat', 'task'],
    summarize: () => ({ title: world.title, body: world.body, ...(world.shownCwd ? { cwd: world.shownCwd } : {}) }),
    preCheck: () => {
      checks++;
      const check: PreCheck = {
        decision: 'ask', reasons: [...world.reasons], askKinds: [...world.askKinds], reasonKeys: [...world.keys], cwd: world.cwd, writes: [...world.writes],
        paths: [...world.paths], ...(world.pathsMore ? { pathsMore: world.pathsMore } : {}), ...(world.reads ? { readPaths: [...world.reads] } : {}), sends: false, removes: false, ...(world.outbound ? { outbound: world.outbound } : {}),
        ...(world.pushes ? { pushes: world.pushes } : {}), ...(world.places ? { places: world.places } : {}), ...(world.bind ? { bind: world.bind } : {}),
      };
      return checks % 2 === 0 && world.redo ? world.redo(check) : check;
    },
    execute: async () => { ran++; return { content: 'ran' }; },
  });
  const registry = new ToolRegistry().register(probe('probe')).register(probe('probe_twin')).register(shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const prompts: ClassifierPrompt[] = [];
  const state = { classify: (() => ALLOW) as () => string, request: 'run the tests', conversationTainted: false, modes: [] as PermissionMode[], mode: 'auto' as PermissionMode, config: undefined as AppConfig | undefined };
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace, taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const call = (args: unknown = { v: 'a' }, c: ToolContext = ctx, name = 'probe') =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: e => events.push(e), lastUserRequest: () => state.request, productRoots: () => [workspace],
      permissionMode: () => state.modes.shift() ?? state.mode,
      conversationTainted: () => state.conversationTainted,
      config: () => state.config ?? parsed,
      autoClassify: async (prompt: ClassifierPrompt) => { prompts.push(prompt); return state.classify(); },
    });
  // 判定のあとの 2 回目の確かめは「偶数回目の preCheck」。1 回目の呼び出しで 2 回呼ばれるので、2 回目の呼び出しの 2 回目（4 回目）から redo が効く
  const fromNextRedo = (redo: (check: PreCheck) => PreCheck) => { const start = checks; world.redo = check => (checks > start + 1 ? redo(check) : check); };
  return { parsed, paths, ctx, call, world, prompts, state, events, db, pending, workspace, ran: () => ran, fromNextRedo };
}

const judgeRows = (db: ReturnType<typeof setup>['db']): number => Number((db.prepare('SELECT COUNT(*) AS n FROM judge_calls').get() as { n: number }).n);

test('J-3: 同じ実行で同じ呼び出しを 3 回 → 判定役は 1 回。2 回目からは judge-reuse で、道具の行に「同じ答えを使った呼び出しの番号」が出る。判定役の数え方（judge_calls）は 1 件', async t => {
  const s = setup(t);
  const warmup = await s.call({ v: 1 });
  assert.equal(warmup.decidedBy, 'validation', '1 回目の呼び出しは引数の誤りで止まる（番号を進めるだけ）');
  const first = await s.call();
  const second = await s.call();
  const third = await s.call();
  assert.deepEqual([first.decidedBy, second.decidedBy, third.decidedBy], ['auto-mode', 'judge-reuse', 'judge-reuse']);
  assert.deepEqual([first.decision, second.decision, third.decision], ['allow', 'allow', 'allow']);
  assert.equal(s.ran(), 3, '3 回とも動いた');
  assert.equal(s.prompts.length, 1, '判定役は 1 回だけ');
  assert.equal(judgeRows(s.db), 1, '使い回した答えは判定役の呼び出しとして数えない');
  assert.equal(judgeStats(s.db, { since: 0 }).totals.calls, 1);
  assert.deepEqual(first.gate, { by: 'judge', reason: 'in scope' });
  assert.deepEqual(second.gate, { by: 'judge', reason: 'in scope', same: 2 }, '判定役が答えたのは、この実行の 2 番目の呼び出し');
  assert.deepEqual(third.gate, { by: 'judge', reason: 'in scope', same: 2 });
  const results = s.events.filter(e => e.type === 'tool.result').map(e => (e as { gate?: unknown }).gate);
  assert.deepEqual(results.slice(-2), [{ by: 'judge', reason: 'in scope', same: 2 }, { by: 'judge', reason: 'in scope', same: 2 }]);
  assert.deepEqual(s.events.filter(e => e.type === 'tool.auto').map(e => (e as { state: string }).state), ['checking', 'allowed', 'allowed', 'allowed'], '使い回しでは checking を出さない');
  const rows = s.db.prepare("SELECT decided_by FROM tool_calls WHERE decision = 'allow' ORDER BY created_at, rowid").all() as Array<{ decided_by: string }>;
  assert.deepEqual(rows.map(r => r.decided_by), ['auto-mode', 'judge-reuse', 'judge-reuse']);
  assert.equal(s.pending.judged(0).allowed, 3, '持ち主に見せる「判定役が通した」の数には、使い回した分も入る');
  assert.equal(s.pending.counts(0).judgedToday.allowed, 3);
  const audit = s.db.prepare("SELECT reasons FROM approvals WHERE scope = 'auto' ORDER BY created_at, rowid").all() as Array<{ reasons: string }>;
  assert.equal(audit.length, 3, '使い回しも自動の承認として記録に残る');
  assert.match(audit[2]!.reasons, /Allowed \(same as an earlier call in this run\): in scope/u);
});

const variations: Array<[string, (s: ReturnType<typeof setup>) => { args?: unknown; ctx?: ToolContext; name?: string } | void]> = [
  ['入力が 1 文字違う', () => ({ args: { v: 'b' } })],
  ['道具の名前が違う', () => ({ name: 'probe_twin' })],
  ['作業フォルダ（cwd）が違う', s => { const sub = join(s.workspace, 'sub'); mkdirSync(sub, { recursive: true }); s.world.cwd = sub; }],
  ['実行の作業場所（workspace）が違う', s => ({ ctx: Object.assign(s.ctx, { workspace: join(s.workspace, 'other') }) })],
  ['判定役に渡す頼みが違う', s => { s.state.request = 'run the tests again'; }],
  ['外を読んだ（この実行の印）', s => { s.ctx.taint.tainted = true; s.ctx.taint.sources.push('web_fetch'); }],
  ['外を読んだ（会話の印）', s => { s.state.conversationTainted = true; }],
  ['外を読んだあとに、もう一度外を読んだ', s => { s.ctx.taint.tainted = true; s.ctx.taint.sources.push('web_fetch'); }],
  ['理由のキーが違う（理由の文は同じ）', s => { s.world.keys = ['guard.cd_outside']; }],
  ['確かめの種類が違う', s => { s.world.askKinds = ['outside_read', 'code']; }],
  ['理由の文が違う', s => { s.world.reasons = ['reads outside', 'and more']; }],
  ['判定役に見せる題が違う', s => { s.world.title = 'probe 2'; }],
  ['判定役に見せる本文が違う', s => { s.world.body = 'probe body 2'; }],
  ['判定役に見せる作業フォルダの文字が違う', s => { s.world.shownCwd = 'sub'; }],
  ['見つけたパスが違う', s => { s.world.paths = [{ input: 'x', path: join(s.workspace, 'x'), verdict: 'out' }]; }],
  ['信用する宛先が違う', s => ({ ctx: Object.assign(s.ctx, { project: { id: 'p1' }, services: { projects: { get: () => ({ remotes: JSON.stringify([{ name: 'origin', url: 'https://example.com/a.git' }]) }) } } }) })],
  ['関わるファイル（読む）の中身が変わった', s => { writeFileSync(join(s.workspace, 'read.txt'), 'two'); }],
  ['関わるファイル（書く）の中身が変わった', s => { writeFileSync(join(s.workspace, 'out.txt'), 'changed'); }],
  ['別の実行（runId）', s => ({ ctx: Object.assign(s.ctx, { runId: 'r2' }) })],
  ['別の実行（同じ runId の別の実行の文脈）', s => ({ ctx: { ...s.ctx, taint: { tainted: s.ctx.taint.tainted, sources: [...s.ctx.taint.sources] } } })],
];

for (const [name, change] of variations) {
  test(`J-3: ${name} → 判定役がもう一度呼ばれる`, async t => {
    const s = setup(t);
    writeFileSync(join(s.workspace, 'read.txt'), 'one');
    writeFileSync(join(s.workspace, 'out.txt'), 'before');
    s.world.reads = [join(s.workspace, 'read.txt')];
    s.world.writes = [join(s.workspace, 'out.txt')];
    if (name.includes('もう一度外を読んだ')) { s.ctx.taint.tainted = true; s.ctx.taint.sources.push('doc_read'); }
    assert.equal((await s.call()).decidedBy, 'auto-mode');
    assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準: 何も変えなければ使い回す');
    const over = change(s) ?? {};
    const again = await s.call(over.args ?? { v: 'a' }, over.ctx ?? s.ctx, over.name ?? 'probe');
    assert.equal(again.decidedBy, 'auto-mode', again.output.content);
    assert.equal(s.prompts.length, 2);
    assert.equal(judgeRows(s.db), 2);
  });
}

test('J-3: 関わるファイルを同じ中身で書き直した（時刻だけ変わった）ときは、控えは同じなので使い回す', async t => {
  const s = setup(t);
  const file = join(s.workspace, 'read.txt');
  writeFileSync(file, 'one');
  s.world.reads = [file];
  await s.call();
  writeFileSync(file, 'one');
  utimesSync(file, new Date(2001, 1, 1), new Date(2001, 1, 1));
  assert.equal((await s.call()).decidedBy, 'judge-reuse');
  assert.equal(s.prompts.length, 1);
});

test('J-3: 関わるファイルを控えに取り切れない（数え切れない・ネットワークの場所）ときは覚えず、毎回判定役に回す', async t => {
  const s = setup(t);
  s.world.reads = undefined;
  s.world.paths = [{ input: 'a', path: join(s.workspace, 'a'), verdict: 'out' }];
  s.world.pathsMore = 3;
  await s.call();
  assert.equal((await s.call()).decidedBy, 'auto-mode', '見つけたパスの残りがある');
  s.world.pathsMore = 0;
  s.world.paths = [];
  s.world.reads = ['\\\\server\\share\\x.txt'];
  await s.call();
  assert.equal((await s.call()).decidedBy, 'auto-mode', 'ネットワークの場所は確かめられない');
  assert.equal(s.prompts.length, 4);
});

test('J-3: 判定役の「聞きたい」「答えられない」は覚えない。そのあとの allow から覚える', async t => {
  const s = setup(t);
  s.state.classify = () => ASK;
  assert.equal((await s.call()).decidedBy, 'pending');
  assert.equal((await s.call()).decidedBy, 'pending', '聞きたいは覚えない: もう一度判定役に回って積まれる');
  s.state.classify = () => 'not json';
  assert.equal((await s.call()).decidedBy, 'pending');
  assert.equal(s.prompts.length, 4, 'AP-1d: an unreadable answer is asked once more');
  s.state.classify = () => ALLOW;
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  s.state.classify = () => ASK;
  assert.equal((await s.call()).decidedBy, 'judge-reuse');
  assert.equal(s.prompts.length, 5);
  assert.equal(s.pending.list({ status: 'waiting' }).length, 3);
});

test('J-3: 判定役が allow でも、判定のあとの確かめで止めた呼び出しの答えは覚えない', async t => {
  const s = setup(t);
  s.world.redo = check => ({ ...check, decision: 'deny', reasons: ['now refused'] });
  const refused = await s.call();
  assert.equal(refused.decision, 'deny');
  assert.match(refused.output.content, /changed while it was being judged/u);
  s.world.redo = undefined;
  assert.equal((await s.call()).decidedBy, 'auto-mode', 'もう一度判定役に回る');
  assert.equal(s.prompts.length, 2);
});

test('J-3: 覚えた allow があっても、判定のあとの 2 回目の確かめ（事前の判定のやり直し）は毎回通る', async t => {
  const s = setup(t);
  await s.call();
  s.fromNextRedo(check => ({ ...check, reasons: [...check.reasons, 'a new check'] }));
  const changed = await s.call();
  assert.deepEqual([changed.decision, s.prompts.length], ['deny', 1]);
  assert.match(changed.output.content, /changed while it was being judged[\s\S]*a new check/u);
  assert.equal(s.ran(), 1);
});

test('J-3: 覚えた allow があっても、判定のあとに送る / 消すの形になっていたら Pending に積む（使い回しの道でも）', async t => {
  for (const kind of ['send', 'delete'] as const) {
    const s = setup(t);
    await s.call();
    s.fromNextRedo(check => ({ ...check, outbound: { kind, reason: `This ${kind}s`, targets: [] } }) as PreCheck);
    const parked = await s.call();
    assert.deepEqual([parked.decidedBy, s.prompts.length, s.ran()], ['pending', 1, 1], kind);
    assert.equal(s.pending.list({ status: 'waiting' })[0]!.kind, kind);
  }
});

test('J-3: 覚えた allow があっても、判定の前の送る / 消すの形（順 3）は Pending に積む', async t => {
  for (const kind of ['send', 'delete'] as const) {
    const s = setup(t);
    await s.call();
    s.world.outbound = { kind, reason: `This ${kind}s`, targets: [] } as Outbound;
    const parked = await s.call();
    assert.deepEqual([parked.decidedBy, s.prompts.length, s.ran()], ['pending', 1, 1], kind);
    assert.equal(s.pending.list({ status: 'waiting' })[0]!.kind, kind);
  }
});

test('J-3: 覚えた allow があっても、判定のあとに持ち主の決めのキー（守る場所）が出たら owner の Pending に積む', async t => {
  const s = setup(t);
  await s.call();
  s.fromNextRedo(check => ({ ...check, reasonKeys: [...(check.reasonKeys ?? []), 'file.git'] }));
  const parked = await s.call();
  assert.deepEqual([parked.decidedBy, s.prompts.length], ['pending', 1]);
  assert.equal(s.pending.list({ status: 'waiting' })[0]!.kind, 'owner');
});

test('J-3: 覚えた allow があっても、守るファイル（protect-files のフック）は判定の前に止める', async t => {
  const s = setup(t);
  const guarded = join(s.workspace, 'guarded.txt');
  s.world.writes = [guarded];
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準');
  const config = structuredClone(s.ctx.config);
  config.tools.hooks.preToolUse = [{ matcher: '.*', builtin: 'protect-files', always: ['guarded.txt'] }];
  s.ctx.config = config;
  const parked = await s.call();
  assert.deepEqual([parked.decidedBy, s.prompts.length], ['pending', 1], parked.output.content);
  assert.equal(s.pending.list({ status: 'waiting' })[0]!.kind, 'hook');
});

test('J-3: 覚えた allow があっても、断る決まり（順 1）は断る', async t => {
  const s = setup(t);
  await s.call();
  s.world.keys = ['guard.self_port'];
  const refused = await s.call();
  assert.deepEqual([refused.decision, s.prompts.length, s.ran()], ['deny', 1, 1]);
});

test('J-3: 覚えた allow があっても、計画モードでは動かない（判定の前の断りも、判定のあとの断りも）', async t => {
  const s = setup(t);
  await s.call();
  s.state.mode = 'plan';
  const before = await s.call();
  assert.deepEqual([before.decision, before.decidedBy], ['deny', 'mode']);
  s.state.mode = 'auto';
  s.state.modes = ['auto', 'plan'];
  const after = await s.call();
  assert.deepEqual([after.decision, after.decidedBy, s.prompts.length, s.ran()], ['deny', 'mode', 1, 1], after.output.content);
});

test('J-3: 文脈の違う前の呼び出しの答えは、別の文脈の同じ呼び出しに効かない（外を読む前の allow を、読んだあとに使わない）', async t => {
  const s = setup(t);
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  s.ctx.taint.tainted = true;
  s.ctx.taint.sources.push('web_fetch');
  s.state.classify = () => ASK;
  assert.equal((await s.call()).decidedBy, 'pending', '読んだあとは判定役が決める');
  assert.equal((await s.call()).decidedBy, 'pending', '読んだあとの「聞きたい」は覚えないので、前の allow にも戻らない');
  assert.equal(s.prompts.length, 3);
});

test('J-3: 覚える数には上限があり、超えた分は覚えない（古いものは消さない）。実行が変われば空から', () => {
  const ctx = { runId: 'cap' } as ToolContext;
  for (let i = 0; i < REMEMBERED_MAX + 5; i++) rememberAllow(ctx, `k${i}`, { call: i, reason: '', snapshot: '' });
  assert.ok(rememberedAllow(ctx, 'k0'));
  assert.ok(rememberedAllow(ctx, `k${REMEMBERED_MAX - 1}`));
  assert.equal(rememberedAllow(ctx, `k${REMEMBERED_MAX}`), undefined);
  ctx.runId = 'cap-2';
  assert.equal(rememberedAllow(ctx, 'k0'), undefined, '同じ文脈の物でも runId が変われば忘れる');
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

test('J-3: 動かすファイルの指紋（bind）が変わったら、判定役がもう一度呼ばれる', async t => {
  const s = setup(t);
  s.world.bind = 'one';
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準');
  s.world.bind = 'two';
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  assert.equal(s.prompts.length, 2);
});

test('J-3: shell_run の npm test は、package.json の test の文を書き換えたら、判定役がもう一度呼ばれる（パスの引数が無くても）', async t => {
  const s = setup(t);
  const pkg = join(s.workspace, 'package.json');
  writeFileSync(pkg, JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node -e "console.log(1)"' } }));
  const first = await s.call({ command: 'npm test' }, s.ctx, 'shell_run');
  assert.equal(first.decidedBy, 'auto-mode', first.output.content);
  assert.equal((await s.call({ command: 'npm test' }, s.ctx, 'shell_run')).decidedBy, 'judge-reuse', '比べる基準: 何も変えなければ使い回す');
  writeFileSync(pkg, JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'node -e "console.log(2)"' } }));
  const again = await s.call({ command: 'npm test' }, s.ctx, 'shell_run');
  assert.equal(again.decidedBy, 'auto-mode', again.output.content);
  assert.equal(s.prompts.length, 2);
});

test('J-3: 判定役のモデルの設定が変わったら、判定役がもう一度呼ばれる', async t => {
  const s = setup(t);
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse');
  const next = structuredClone(s.parsed);
  next.routing.judge = [next.models[0]!.id];
  s.state.config = next;
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  assert.equal(s.prompts.length, 2);
});

test('J-3: push の先のリポジトリが動いたら、判定役がもう一度呼ばれる。確かめられない push（dir が分からない）は覚えない', async t => {
  const s = setup(t);
  const repo = join(s.workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  s.world.pushes = [{ dir: repo }];
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準');
  writeFileSync(join(repo, 'a.txt'), 'b');
  git(repo, 'commit', '-q', '-am', 'b');
  assert.equal((await s.call()).decidedBy, 'auto-mode', 'HEAD が動いた');
  s.world.pushes = [{ dir: null }];
  await s.call();
  assert.equal((await s.call()).decidedBy, 'auto-mode', '確かめられない push は覚えない');
  assert.equal(s.prompts.length, 4);
});

test('J-3: 送り先の設定（.npmrc など）が変わったら、判定役がもう一度呼ばれる', async t => {
  const s = setup(t);
  s.world.places = [s.workspace];
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準');
  writeFileSync(join(s.workspace, '.npmrc'), 'registry=https://example.com/\n');
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  assert.equal(s.prompts.length, 2);
});

test('J-3: 使い回したあとに道具の方針を Ask にしたら、判定役も覚えた答えも使わずに policy の Pending に積む', async t => {
  const s = setup(t);
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse');
  const next = structuredClone(s.parsed);
  next.tools.policies = { probe: 'ask' };
  s.state.config = next;
  const parked = await s.call();
  assert.deepEqual([parked.decidedBy, s.prompts.length, s.ran()], ['pending', 1, 2]);
  assert.equal(s.pending.list({ status: 'waiting' })[0]!.kind, 'policy');
});

test('J-3: 取り消された実行では、覚えた allow があっても動かない', async t => {
  const s = setup(t);
  await s.call();
  const controller = new AbortController();
  controller.abort();
  s.ctx.signal = controller.signal;
  const cancelled = await s.call();
  assert.deepEqual([cancelled.decision, cancelled.decidedBy, s.ran(), s.prompts.length], ['ask', 'user', 1, 1], cancelled.output.content);
});

test('J-3: 控えの git の問い合わせは実行の取り消しに従い、取り消されたら控えなし（覚えない）になる', async t => {
  const s = setup(t);
  const repo = join(s.workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  const involved = { files: [], filesMore: false, pushes: [{ dir: repo }], places: undefined, dataDir: s.paths.data };
  assert.equal(typeof await involvedSnapshot(repo, involved), 'string', '比べる基準: 取り消しが無ければ控えが取れる');
  const controller = new AbortController();
  controller.abort();
  assert.equal(await involvedSnapshot(repo, involved, controller.signal), undefined);
});

function pushRepo(s: ReturnType<typeof setup>): string {
  const repo = join(s.workspace, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  return repo;
}

test('J-3: 覚えるための控えは、判定のあとの確かめの前に取る。控えを取るあいだに計画モードになった・取り消されたら、動かない', async t => {
  for (const flip of ['plan', 'abort'] as const) {
    const s = setup(t);
    s.world.pushes = [{ dir: pushRepo(s) }];
    const controller = new AbortController();
    s.ctx.signal = controller.signal;
    s.state.classify = () => {
      setImmediate(() => { if (flip === 'plan') s.state.mode = 'plan'; else controller.abort(); });
      return ALLOW;
    };
    const outcome = await s.call();
    assert.equal(s.ran(), 0, `${flip}: ${outcome.decidedBy} ${outcome.output.content}`);
    assert.deepEqual([outcome.decidedBy, s.prompts.length], [flip === 'plan' ? 'mode' : 'user', 1], flip);
  }
});

test('J-3: 覚えた allow があっても控えが変わって判定役が「聞きたい」と答えたら、覚えた allow は捨てる（ファイルを戻しても使わない）', async t => {
  const s = setup(t);
  const file = join(s.workspace, 'read.txt');
  writeFileSync(file, 'one');
  s.world.reads = [file];
  await s.call();
  writeFileSync(file, 'two');
  s.state.classify = () => ASK;
  assert.equal((await s.call()).decidedBy, 'pending');
  writeFileSync(file, 'one');
  s.state.classify = () => ALLOW;
  assert.equal((await s.call()).decidedBy, 'auto-mode', '捨てたので、もう一度判定役に回る');
  assert.equal(s.prompts.length, 3);
});

test('J-3: 判定役のモデルを決めていないとき（いまのモデルが判定役）、いまのモデルが替わったら判定役がもう一度呼ばれる', async t => {
  const s = setup(t);
  s.ctx.model = { id: 'm1', vision: false };
  await s.call();
  assert.equal((await s.call()).decidedBy, 'judge-reuse', '比べる基準');
  s.ctx.model = { id: 'm2', vision: false };
  assert.equal((await s.call()).decidedBy, 'auto-mode');
  assert.equal(s.prompts.length, 2);
});
