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
import { shellRun } from '../src/tools/builtin/shell.ts';
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
  return { ctx, sub, pending, deps, call: (command: string) => runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command } }, ctx, {
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

test('L94 の目標（未着手: 根は src/tools/builtin/shell.ts の readPaths と src/tools/pipeline.ts の readFilesOf で、B5 の持ち場の外）: cd の行き先は読むファイルに数えず、Pending に積んだあとで行き先に新しいファイルができても「変わった」で止めない', { todo: 'B5 の持ち場の外: cd の行き先が読むパスとして Pending の束縛（boundFacts）に入る' }, async t => {
  const r = rig(t);
  await r.call('cd sub && git push origin main');
  const [row] = r.pending.list({ status: 'waiting' });
  assert.ok(row);
  writeFileSync(join(r.sub, 'b.txt'), 'new work');
  const res = await replayAction(r.pending.claim(row.id), r.deps);
  assert.notEqual(res.status, 'stale', res.output);
});
