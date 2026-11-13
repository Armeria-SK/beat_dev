import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction, type ReplayDeps } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { fileRead } from '../src/tools/builtin/files.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, options: { conversationGone?: boolean } = {}) {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  let config: AppConfig = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const ran: unknown[] = [];
  const counter: ToolDef<{ text: string }> = {
    name: 'fake_count', description: 'count', input: Type.Object({ text: Type.String() }), effect: 'exec', allowedIn: ['chat', 'task'],
    summarize: input => ({ title: 'Count', body: input.text }),
    execute: async (input, _ctx, info) => { ran.push({ input, approvedOnce: info?.approvedOnce }); return { content: input.text, exitCode: 0 }; },
  };
  const remover: ToolDef<{ path: string }> = {
    name: 'fake_delete', description: 'delete', input: Type.Object({ path: Type.String() }), effect: 'write', allowedIn: ['chat', 'task'],
    summarize: input => ({ title: 'Delete', body: `rm -r ${input.path}` }),
    execute: async input => { ran.push(input); rmSync(input.path, { recursive: true, force: true }); return { content: 'deleted', exitCode: 0 }; },
  };
  const registry = new ToolRegistry().register(counter).register(remover).register(fileRead).register(shellRun);
  const store = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const live = new Set(['conv-1']);
  if (options.conversationGone) live.clear();
  const deps: ReplayDeps = {
    db, store, registry, config: () => config, paths, conversationExists: id => live.has(id),
  };
  const park = (over: Partial<Parameters<PendingStore['park']>[0]>) => store.park({
    tool: 'fake_count', input: { text: 'hello' }, cwd: paths.workspace, kind: 'judge', reason: 'Judge unsure', runId: 'run-1', runKind: 'chat', conversationId: 'conv-1', ...over,
  });
  const approve = (id: number) => replayAction(store.claim(id), deps);
  return { dir, paths, db, store, deps, park, approve, ran, live, setConfig: (next: AppConfig) => { config = next; }, config: () => config };
}

test('Approve で 1 回だけ動く: tool_calls に owner-pending の行、結果の末尾と終了コードが行に入る', async t => {
  const s = setup(t);
  const long = `${'a'.repeat(2500)}END`;
  const row = s.park({ input: { text: long } });
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
  const calls = s.db.prepare("SELECT run_id, conversation_id, tool, decision, decided_by, approval_id, ok FROM tool_calls WHERE decided_by = 'owner-pending'").all();
  assert.deepEqual(calls.map(c => ({ ...c })), [{ run_id: 'run-1', conversation_id: 'conv-1', tool: 'fake_count', decision: 'allow', decided_by: 'owner-pending', approval_id: `pending:${row.id}`, ok: 1 }]);
});

test('承認の時点でパスが禁止になっていた（tools.deny を足した）→ 動かず failed', async t => {
  const s = setup(t);
  const secretDir = join(s.paths.workspace, 'private');
  mkdirSync(secretDir);
  writeFileSync(join(secretDir, 'a.txt'), 'x');
  const row = s.park({ tool: 'file_read', input: { path: join(secretDir, 'a.txt') } });
  const next = structuredClone(s.config());
  next.tools.deny = [...next.tools.deny, secretDir];
  s.setConfig(next);
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'failed');
  const after = s.store.view(row.id)!;
  assert.equal(after.status, 'failed');
  assert.match(after.output_preview ?? '', /Not run/u);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE decided_by = 'owner-pending'").get()!.n, 0);
});

test('作業フォルダが消えていた → failed', async t => {
  const s = setup(t);
  const gone = join(s.paths.workspace, 'gone');
  mkdirSync(gone);
  const row = s.park({ cwd: gone });
  rmSync(gone, { recursive: true });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'failed');
  assert.equal(s.ran.length, 0);
  assert.match(s.store.view(row.id)!.output_preview ?? '', /no longer exists/u);
});

test('元の会話を消した → cancelled（動かない）', async t => {
  const s = setup(t, { conversationGone: true });
  const row = s.park({});
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(s.ran.length, 0);
  assert.equal(s.store.view(row.id)!.status, 'cancelled');
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
  const row = s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
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
  const row = s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  writeFileSync(join(target, 'b.log'), 'b');
  assert.equal((await s.approve(row.id)).status, 'stale');
  assert.ok(existsSync(join(target, 'a.log')));
});

test('消すの行: 積んだあとに HEAD が変わった → stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  git(root, 'commit', '-q', '--allow-empty', '-m', 'second');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(outcome.changes!.some(c => c.what === 'HEAD'));
});

test('消すの行: 作業ツリーが変わった（追っているファイルを書き換えた）→ stale', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  writeFileSync(join(root, 'kept.txt'), 'changed');
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'stale');
  assert.ok(outcome.changes!.some(c => c.what === 'git status'));
});

test('消すの行: 変わっていなければ動く', async t => {
  const s = setup(t);
  const root = repo(s);
  const target = join(root, 'notes.md');
  const row = s.park({ tool: 'fake_delete', input: { path: target }, cwd: root, kind: 'delete', targets: [target] });
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran');
  assert.ok(!existsSync(target));
});

function scriptCheck(s: ReturnType<typeof setup>, command: string) {
  const ctx: ToolContext = {
    runId: 'run-1', conversationId: 'conv-1', kind: 'chat', signal: new AbortController().signal, config: s.config(), paths: s.paths,
    policy: buildPolicy(s.config(), s.paths), workspace: s.paths.workspace, taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  return shellPreCheck({ command }, ctx);
}

test('スクリプトを動かす行: 積んだあとに中身を書き換えた → 動かず stale（bind が違う）', async t => {
  const s = setup(t);
  const outside = join(s.dir, 'elsewhere');
  mkdirSync(outside);
  const script = join(outside, 'job.js');
  writeFileSync(script, "console.log('first version')");
  const command = `node "${script}"`;
  const check = scriptCheck(s, command);
  assert.ok(check.bind, '前提: 事前の判定がスクリプトの指紋を付ける');
  const row = s.park({ tool: 'shell_run', input: { command }, bind: check.bind, preview: check.preview });
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
  const command = `node "${script}"`;
  const check = scriptCheck(s, command);
  const row = s.park({ tool: 'shell_run', input: { command }, bind: check.bind, preview: check.preview });
  assert.equal(s.store.view(row.id)!.preview[0]!.text, "console.log('ran-from-pending')");
  const outcome = await s.approve(row.id);
  assert.equal(outcome.status, 'ran', s.store.view(row.id)!.output_preview ?? '');
  const after = s.store.view(row.id)!;
  assert.equal(after.exit_code, 0);
  assert.match(after.output_preview ?? '', /ran-from-pending/u);
  unlinkSync(script);
});
