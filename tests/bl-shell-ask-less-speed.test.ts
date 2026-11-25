import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

const LIMIT_MS = 3000;

test('L389: 製品の中の node scripts/smoke-test.js の振り分け（読む・指紋・判定）は 3 秒以内で、判定役を呼ばずに製品のコードの段で決まる（実行はしない）', { skip: !gitAvailable && 'git が無い' }, async t => {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const raw = testConfig();
  raw.tools.roots = [{ path: 'workspace', mode: 'write' }];
  raw.tools.shell.shell = 'bash';
  const config = parseConfig(raw);
  const db = openDatabase(':memory:', MIGRATIONS);
  t.after(() => db.close());
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register({ ...shellRun, execute: async () => ({ content: 'ok', exitCode: 0 }) } as typeof shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const prod = join(paths.workspace, 'prod');
  mkdirSync(join(prod, 'scripts'), { recursive: true });
  for (let i = 0; i < 300; i++) {
    const dir = join(prod, 'src', `g${i % 10}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`.repeat(40));
  }
  writeFileSync(join(prod, 'scripts', 'smoke-test.js'), `const a = require('../src/g0/f0.ts');\nconsole.log('ok');\n`);
  writeFileSync(join(prod, 'package.json'), '{"name":"p"}');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: prod, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const policy = buildPolicy(config, paths, { id: 'p1', root: prod } as never, [prod]);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'task', task: { id: 't1', control: { outcome: 'none' } } as never, project: { id: 'p1', root: prod } as never,
    signal: new AbortController().signal, config, paths, policy, workspace: prod, taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  let judgeCalls = 0;
  const route = async () => {
    const started = performance.now();
    const out = await runToolCall({ id: `call-${Math.random()}`, name: 'shell_run', arguments: { command: 'node scripts/smoke-test.js' } }, ctx, {
      registry, approvals, pending, db, emit: () => undefined, lastUserRequest: () => 'run the smoke test', productRoots: () => [prod],
      autoClassify: async () => { judgeCalls++; return '{"decision":"allow","reason":"ok"}' as never; },
    } as never);
    return { out, ms: performance.now() - started };
  };
  const first = await route();
  const second = await route();
  t.diagnostic(`routing: first ${first.ms.toFixed(0)} ms, second ${second.ms.toFixed(0)} ms (limit ${LIMIT_MS} ms)`);
  assert.equal(first.out.decidedBy, 'product-code', first.out.output.content);
  assert.equal(second.out.decidedBy, 'product-code', second.out.output.content);
  assert.equal(judgeCalls, 0);
  assert.ok(first.ms < LIMIT_MS, `first routing took ${first.ms.toFixed(0)} ms`);
  assert.ok(second.ms < LIMIT_MS, `second routing took ${second.ms.toFixed(0)} ms`);
});
