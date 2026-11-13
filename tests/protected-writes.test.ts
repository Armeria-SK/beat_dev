import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { webFetch } from '../src/tools/builtin/web.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { PendingStore } from '../src/pending/store.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }, options: { tainted?: boolean; mutate?: (c: AppConfig) => void; tools?: ToolDef[] } = {}) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun).register(webFetch);
  for (const tool of options.tools ?? []) registry.register(tool);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const makeCtx = (runId: string, tainted = options.tainted !== false): ToolContext => ({
    runId, conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: tainted ? { tainted: true, sources: ['web_fetch'] } : { tainted: false, sources: [] }, log: () => undefined,
  });
  const ctx = makeCtx('r1');
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: () => undefined,
      lastUserRequest: () => 'please write the notes', autoClassify: async () => { judge.calls++; return judge.answer; },
    });
  const judge = { answer: '{"decision":"ask","reason":"not sure"}', calls: 0 };
  const write = (path: string) => join(paths.workspace, path);
  return { paths, ctx, makeCtx, call, approvals, db, write, pending, judge };
}
type Setup = ReturnType<typeof setup>;

// 止まるはず: Pending に積まれ（決めたのは pending）、その行を返す
async function parked(s: Setup, name: string, args: unknown, c: ToolContext = s.ctx) {
  const outcome = await s.call(name, args, c);
  assert.equal(outcome.decidedBy, 'pending', `${name} ${JSON.stringify(args)}: ${outcome.output.content}`);
  return s.pending.list({ status: 'waiting' })[0]!;
}

test('外から読んだあとの書き込みのうち、保護された場所（人格・.git・道具の設定）は止まったまま、許可フォルダの外は断る。ほかの書き込み・シェル・次の実行は確かめなしに動く（R19）', async t => {
  const s = setup(t);
  for (const [path, kind] of [['SOUL.md', 'owner'], ['.git/config', 'owner'], ['.curlrc', 'owner']] as const) {
    const row = await parked(s, 'file_write', { path, content: 'x' });
    assert.equal(row.kind, kind, path);
    assert.equal(existsSync(s.write(path)), false, `${path}: 書かれていない`);
  }
  for (const path of ['sub/.gitattributes', '.bashrc', '.yarnrc']) {
    assert.equal((await s.call('file_write', { path, content: 'x' })).decidedBy, 'builtin', path);
    assert.equal(existsSync(s.write(path)), true, path);
  }
  assert.equal((await s.call('shell_run', { command: 'echo hello' })).decidedBy, 'builtin');
  const outside = await s.call('file_write', { path: '../outside.txt', content: 'x' });
  assert.deepEqual([outside.decision, outside.decidedBy], ['deny', 'builtin']);
  assert.equal(existsSync(join(s.paths.workspace, '..', 'outside.txt')), false);
  const next = s.makeCtx('r2');
  assert.equal((await s.call('file_write', { path: 'sub/y.txt', content: 'Y' }, next)).decidedBy, 'builtin');
  assert.equal(s.judge.calls, 0);
});

test('外から読んでいなくても止まる書き込み（人格・.git）は Pending に積まれ、ふつうの書き込みは止まらない。方針 ask は Pending、鍵らしい文字を含む通信は断る', async t => {
  const plain = setup(t, { tainted: false });
  plain.judge.answer = '{"decision":"allow","reason":"fits the request"}';
  assert.equal((await parked(plain, 'file_write', { path: 'SOUL.md', content: 'x' })).kind, 'owner');
  assert.equal(existsSync(plain.write('SOUL.md')), false);
  assert.equal((await parked(plain, 'file_write', { path: '.git/config', content: 'x' })).kind, 'owner');
  assert.equal((await fileWrite.preCheck!({ path: '.git/config', content: 'x' }, plain.ctx)).askKinds?.includes('code'), true);
  assert.equal(existsSync(plain.write('.git/config')), false);
  assert.equal(plain.judge.calls, 0, '判定役が許すと答える場合でも、判定役に回さない');
  assert.equal((await plain.call('file_write', { path: 'notes/a.txt', content: 'A' })).decidedBy, 'builtin');
  const policy = setup(t, { mutate: c => { c.tools.policies = { file_write: 'ask' }; } });
  assert.equal((await policy.call('file_write', { path: 'notes/a.txt', content: 'A' })).decidedBy, 'pending');
  assert.equal((await policy.call('file_write', { path: 'notes/b.txt', content: 'B' })).decidedBy, 'pending');
  assert.deepEqual(policy.pending.list({ status: 'waiting' }).map(row => row.kind), ['policy', 'policy']);
  assert.equal(existsSync(policy.write('notes/a.txt')), false);
  const web = setup(t);
  const fetched = await web.call('web_fetch', { url: 'https://example.com/?key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(fetched.decision, 'deny', fetched.output.content);
  assert.equal(web.pending.list({ status: 'waiting' }).length, 0);
});
