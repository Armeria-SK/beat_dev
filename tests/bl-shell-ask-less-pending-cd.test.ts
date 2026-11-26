import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { replayAction } from '../src/pending/replay.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function rig(t: { after: (fn: () => void | Promise<void>) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  raw.tools.shell.shell = 'bash';
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(config, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  const sub = join(ctx.workspace, 'sub');
  mkdirSync(sub);
  git(sub, 'init', '-q', '-b', 'main');
  writeFileSync(join(sub, 'a.txt'), 'x');
  git(sub, 'add', '-A');
  git(sub, 'commit', '-q', '-m', 'init');
  const bare = join(paths.data, 'remote.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(sub, 'remote', 'add', 'origin', bare);
  const deps = { db, store: pending, registry, config: () => config, paths, projects: undefined, conversationExists: () => true, conversationTainted: () => false, signal: new AbortController().signal, log: () => undefined, services: () => undefined } as never;
  return { ctx, sub, pending, deps, git, call: (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, {
    registry, approvals, pending, db, emit: () => undefined, lastUserRequest: () => 'push my work', autoClassify: async () => ({ text: '{"decision":"ask","reason":"not sure"}' }) as never,
  } as never) };
}

test('L94 の今の線: cd sub && git push は製品の外の push として Pending に積まれる', { skip: !gitAvailable && 'git が無い' }, async t => {
  const r = rig(t);
  const out = await r.call('cd sub && git push origin main');
  assert.equal(out.decidedBy, 'pending', out.output.content);
  assert.match(out.output.content, /It has NOT run/u);
  assert.equal(r.pending.list({ status: 'waiting' }).length, 1);
});

test('L94: cd の行き先は読むファイルに数えず、Pending に積んだあとで行き先に新しいファイルができても「変わった」で止めない（実行は進む）', { skip: !gitAvailable && 'git が無い' }, async t => {
  const r = rig(t);
  await r.call('cd sub && git push origin main');
  const [row] = r.pending.list({ status: 'waiting' });
  assert.ok(row);
  writeFileSync(join(r.sub, 'b.txt'), 'new work');
  const res = await replayAction(r.pending.claim(row.id), r.deps);
  assert.notEqual(res.status, 'stale', res.output);
  assert.equal(res.status, 'ran', res.output);
});

test('L94 の対照: 行き先の中の git の状態（commit・送り先）が積んだときと変わったら、cd sub && git push は今も「変わった」で止まる', { skip: !gitAvailable && 'git が無い' }, async t => {
  const moves: Record<string, (r: ReturnType<typeof rig>) => void> = {
    'new commit': r => { r.git(r.sub, 'commit', '-q', '--allow-empty', '-m', 'more'); },
    'remote url': r => { r.git(r.sub, 'remote', 'set-url', 'origin', join(r.sub, '..', 'other.git')); },
  };
  for (const [name, move] of Object.entries(moves)) {
    const r = rig(t);
    await r.call('cd sub && git push origin main');
    const [row] = r.pending.list({ status: 'waiting' });
    assert.ok(row, name);
    move(r);
    const res = await replayAction(r.pending.claim(row.id), r.deps);
    assert.equal(res.status, 'stale', `${name}: ${res.output}`);
  }
});

test('L94 の対照: cd のあとの文が自分のパスで読むファイルは、今も束縛に残り、積んだあとで書き換えられたら止まる', { skip: !gitAvailable && 'git が無い' }, async t => {
  const r = rig(t);
  const notes = join(r.ctx.workspace, 'notes.txt');
  writeFileSync(notes, 'before');
  await r.call('cd sub && cat ../notes.txt && git push origin main');
  const [row] = r.pending.list({ status: 'waiting' });
  assert.ok(row);
  writeFileSync(notes, 'edited after parking');
  const res = await replayAction(r.pending.claim(row.id), r.deps);
  assert.equal(res.status, 'stale', res.output);
  assert.match(res.output ?? '', /notes\.txt/u);
});

test('L94: 読むパスの一覧 — 外れるのは「行き先が 1 つの素直な語」の cd・pushd・chdir の行き先だけ。別の文が読む分・行き先が決められない cd・approval の paths は変わらない', { skip: !gitAvailable && 'git が無い' }, t => {
  const r = rig(t);
  const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
  const sub = norm(r.sub);
  const ws = norm(r.ctx.workspace);
  const pre = (command: string) => {
    const out = shellPreCheck({ command }, r.ctx);
    assert.equal(out.decision, 'ask', command);
    return { read: (out.readPaths ?? []).map(norm), paths: (out.paths ?? []).map(p => norm(p.path ?? '')) };
  };
  for (const command of ['cd sub && git push origin main', 'cd ./sub && git push origin main', 'chdir sub && git push origin main', 'pushd sub && git push origin main', 'cd sub; cd sub; git push', 'cd sub && cd .. && git push origin main']) {
    const v = pre(command);
    assert.deepEqual(v.read, [], command);
    assert.ok(v.paths.includes(sub), `${command}: 許可の判断に使う paths には今も残る`);
  }
  assert.deepEqual(pre('cd sub && cat a.txt && git push origin main').read, [`${sub}/a.txt`]);
  assert.deepEqual(pre('cat sub && cd sub && git push origin main').read, [sub], '別の文が同じ場所を読むなら、その分は残る');
  assert.deepEqual(pre('ls sub && cd sub && git push origin main').read, [sub]);
  assert.deepEqual(pre('cd sub; cat ../sub; git push origin main').read, [sub]);
  assert.deepEqual(pre('cd su* && git push origin main').read, [ws], 'ワイルドカードの行き先は決められないので残す');
  assert.equal(pre('cd ~ && git push origin main').read.length, 1, '~ の行き先は決められないので残す');
});
