import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../../src/config/store.ts';
import { openDatabase } from '../../src/db/database.ts';
import { MIGRATIONS } from '../../src/db/migrations.ts';
import { resolvePaths } from '../../src/paths.ts';
import { PendingStore } from '../../src/pending/store.ts';
import { ApprovalBroker } from '../../src/tools/approvals.ts';
import { fileEdit, fileRead, fileWrite } from '../../src/tools/builtin/files.ts';
import { shellRun } from '../../src/tools/builtin/shell.ts';
import { runToolCall } from '../../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../../src/tools/policy.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import type { ToolContext } from '../../src/tools/types.ts';
import { tempDir, testConfig } from '../helpers.ts';

export async function assertProjectFileGuarded(t: { after: (fn: () => void) => void }, o: { project: string; name: string; body: string; leak: RegExp; request: string }): Promise<void> {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const dir = join(paths.projects, o.project);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, o.name);
  writeFileSync(file, o.body);
  const config = parseConfig(testConfig());
  const db = openDatabase(':memory:', MIGRATIONS);
  const policy = buildPolicy(config, paths);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto', project: { id: o.project },
  };
  const run = (name: string, args: unknown) => runToolCall({ id: `c-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending: new PendingStore(db, { tools: registry, dataDir: paths.data }), db, emit: () => undefined, permissionMode: () => 'auto', lastUserRequest: () => o.request,
    conversationTainted: () => false, autoClassify: async () => '{"decision":"allow","reason":"ok"}',
  });
  for (const [name, args] of [['file_read', { path: file }], ['file_write', { path: file, content: 'x' }], ['file_edit', { path: file, old: 'secret', new: 'x' }], ['shell_run', { command: `cat "${file.replaceAll('\\', '/')}"` }]] as const) {
    const result = await run(name, args);
    assert.equal(result.decision, 'deny', name);
    assert.doesNotMatch(result.output.content, o.leak, name);
  }
  assert.equal(readFileSync(file, 'utf8'), o.body);
}
