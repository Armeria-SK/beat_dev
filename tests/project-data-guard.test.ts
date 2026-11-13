import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { resolvePaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileSearch } from '../src/tools/builtin/file-search.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { checkShellCommand, type ShellGuardOptions } from '../src/tools/hooks/shell-guard.ts';
import { placePath, realish } from '../src/tools/hooks/scope.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { PS_WRITER_ALLOW, tempDir, testConfig } from './helpers.ts';

const ALLOW = '{"decision":"allow","reason":"ok"}';
const ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function fixture(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  const dir = join(paths.projects, ID);
  mkdirSync(dir, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(dir, 'context.md'), 'product knowledge\n');
  const config = parseConfig(testConfig());
  const policy = buildPolicy(config, paths);
  const ws = realish(defaultWorkspace(policy, paths));
  const opts = (extra: Partial<ShellGuardOptions> = {}): ShellGuardOptions => ({ policy, outsideRoots: 'ask', ...extra });
  const bash = (command: string) => checkShellCommand(command, ws, opts({ shell: 'bash', windows: false }));
  const ps = (command: string) => checkShellCommand(command, ws, opts({ shell: 'powershell', windows: true, allow: PS_WRITER_ALLOW }));
  return { paths, dir, config, policy, bash, ps };
}

test('製品の知識の置き場所（data/projects/）は禁止の場所。フォルダそのもの・製品ごとのフォルダ・中のファイルのどれも', t => {
  const f = fixture(t);
  for (const path of [f.paths.projects, f.dir, join(f.dir, 'context.md'), join(f.dir, 'new.md'), join(f.paths.projects, 'other', 'deep', 'x.md')]) {
    assert.equal(placePath(path, f.policy).kind, 'deny', path);
  }
});

test('ファイルの道具（読む・書く・書き換える・一覧・検索）は、判定役が何でも許しても data/projects/<id>/ に届かない', async t => {
  const f = fixture(t);
  const db = openDatabase(':memory:', MIGRATIONS);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(fileSearch).register(shellRun);
  const approvals = new ApprovalBroker(db, () => undefined);
  const pending = new PendingStore(db, { tools: registry, dataDir: f.paths.data });
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: f.config, paths: f.paths, policy: f.policy,
    workspace: defaultWorkspace(f.policy, f.paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  let judged = 0;
  const call = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals, pending, db, judgeAll: true, emit: () => undefined, permissionMode: () => 'auto', lastUserRequest: () => 'read the product knowledge', conversationTainted: () => false, conversationAutoRead: () => false,
    autoClassify: async () => { judged++; return ALLOW; },
  });
  const file = join(f.dir, 'context.md');
  for (const [name, args] of [
    ['file_read', { path: file }], ['file_write', { path: file, content: 'changed\n' }], ['file_write', { path: join(f.dir, 'new.md'), content: 'x' }],
    ['file_edit', { path: file, old: 'product', new: 'changed' }], ['file_list', { path: f.dir }], ['file_list', { path: f.paths.projects }],
    ['file_search', { path: f.dir, text: 'knowledge' }], ['file_search', { path: f.paths.projects, name: '*.md' }],
  ] as const) {
    const result = await call(name, args);
    assert.equal(result.decision, 'deny', `${name} ${JSON.stringify(args)}`);
    assert.doesNotMatch(result.output.content, /product knowledge|context\.md/u, name);
  }
  for (const command of [`cat "${file.replaceAll('\\', '/')}"`, `echo x > "${file.replaceAll('\\', '/')}"`]) {
    const result = await call('shell_run', { command });
    assert.equal(result.decision, 'deny', command);
  }
  assert.equal(judged, 0, '禁止の場所は、判定役に聞く前に止まる');
  assert.equal(readFileSync(file, 'utf8'), 'product knowledge\n');
  assert.equal(existsSync(join(f.dir, 'new.md')), false);
});

test('シェルからの読み書き: data/projects/<id>/ の中は止める（bash も PowerShell も）', t => {
  const f = fixture(t);
  const file = join(f.dir, 'context.md').replaceAll('\\', '/');
  const dir = f.dir.replaceAll('\\', '/');
  for (const command of [`cat "${file}"`, `echo x > "${file}"`, `echo x >> ${file}`, `cp notes.txt "${dir}/new.md"`, `rm "${file}"`, `sed -i s/a/b/ "${file}"`, `ls "${dir}"`]) {
    assert.equal(f.bash(command).decision, 'deny', `bash: ${command}`);
  }
  for (const command of [`Get-Content "${file}"`, `type "${file}"`, `cat "${file}"`, `echo x > "${file}"`, `Set-Content -Path "${file}" -Value x`, `Remove-Item "${file}"`, `Get-ChildItem "${dir}"`]) {
    assert.equal(f.ps(command).decision, 'deny', `powershell: ${command}`);
  }
});
