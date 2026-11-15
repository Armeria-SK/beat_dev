import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { PendingStore } from '../src/pending/store.ts';
import { APP_ROOT, resolvePaths } from '../src/paths.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// J-4 の段の頭の確かめ: AI のファイルの道具とシェルから beat の設定・DB のファイルを書き換えられないこと、AI の道から判定なしのモードを切り替えられないこと

function setup(t: { after: (fn: () => void) => void }, judgeMode: 'on' | 'off') {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config: AppConfig = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  config.routing.judgeMode = judgeMode;
  config.server.port = 4898;
  const parsed = parseConfig(config);
  writeFileSync(paths.config, JSON.stringify(parsed));
  writeFileSync(paths.database, 'db');
  const db = openDatabase(':memory:', MIGRATIONS);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shellRun);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined, permissionMode: 'auto',
  };
  const judge = { calls: 0 };
  const call = (name: string, args: unknown) => runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, ctx, {
    registry, approvals: new ApprovalBroker(db), pending, db, emit: () => undefined, lastUserRequest: () => 'tidy up', config: () => parsed,
    autoClassify: async () => { judge.calls++; return '{"decision":"allow","reason":"ok"}'; },
  });
  const slash = (path: string) => path.replaceAll('\\', '/');
  return { paths, call, judge, pending, config: slash(paths.config), database: slash(paths.database) };
}

test('J-4 段の頭: 判定なしのモードでも、ファイルの道具とシェルの書き込みは beat の設定・DB のファイルに届かず、判定役にも回らずに断る', async t => {
  const s = setup(t, 'off');
  const before = readFileSync(s.paths.config, 'utf8');
  const tries: Array<[string, unknown]> = [
    ['file_write', { path: s.paths.config, content: '{}' }],
    ['file_write', { path: '../config.json', content: '{}' }],
    ['file_edit', { path: s.paths.config, old_string: '"version"', new_string: '"v"' }],
    ['file_write', { path: s.paths.database, content: 'x' }],
    ['file_write', { path: `${s.paths.config}.bak`, content: '{}' }],
    ['shell_run', { command: `echo {} > "${s.config}"` }],
    ['shell_run', { command: 'echo {} > ../config.json' }],
    ['shell_run', { command: `cp notes.txt "${s.config}"` }],
    ['shell_run', { command: `pwsh -c "Set-Content ${s.config} x"` }],
    ['shell_run', { command: `curl -X PUT http://127.0.0.1:4898/api/settings` }],
  ];
  for (const [name, args] of tries) {
    const out = await s.call(name, args);
    assert.equal(out.decision, 'deny', `${name} ${JSON.stringify(args)} → ${out.decidedBy}: ${out.output.content.slice(0, 200)}`);
  }
  assert.equal(s.judge.calls, 0);
  assert.equal(s.pending.list({ status: 'waiting' }).length, 0);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before);
  assert.equal(existsSync(`${s.paths.config}.bak`), false);
});

test('J-4 段の頭: 判定なしのモードで、コードの中から beat の設定・DB を書く形（node -e・PowerShell・書いたスクリプト）は、判定役の代わりに持ち主の Pending に積む', async t => {
  const s = setup(t, 'off');
  const before = readFileSync(s.paths.config, 'utf8');
  writeFileSync(join(s.paths.workspace, 'put.js'), `require('node:fs').writeFileSync('${s.config}', '{}');\n`);
  const tries = [
    `node -e "require('fs').writeFileSync('${s.config}', '{}')"`,
    `node -e "require('fs').writeFileSync(require('path').join('..','beat.db'),'')"`,
    `powershell -Command "[IO.File]::WriteAllText('${s.config}','x')"`,
    'node put.js',
  ];
  for (const command of tries) {
    const out = await s.call('shell_run', { command });
    assert.equal(out.decidedBy, 'pending', `${command} → ${out.decidedBy}: ${out.output.content.slice(0, 200)}`);
  }
  const rows = s.pending.list({ status: 'waiting' });
  assert.equal(rows.length, tries.length);
  assert.ok(rows.every(r => r.kind === 'owner'), JSON.stringify(rows.map(r => r.kind)));
  assert.equal(s.judge.calls, 0);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before, '設定ファイルは書き換わっていない');
});

test('J-4 段の頭: 判定なしのモードを変えられる口は、持ち主の画面の口（src/web）と組み立て（src/app.ts）だけ。道具・エンジン・ワーカーから設定を保存する道は無い', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
  const writers = files('src').filter(path => /\bapp\.applyConfig\(|\bthis\.applyConfig\(|\bconfigStore\.save\(|\bnew ConfigStore\(/u.test(readFileSync(path, 'utf8')));
  const outside = writers.map(path => path.replaceAll('\\', '/')).filter(path => path !== 'src/app.ts' && !path.startsWith('src/web/'));
  assert.deepEqual(outside, []);
  assert.ok(writers.length > 0, '探し方が当たっている');
});

test('J-4 段の頭: beat の置き場（src・web・templates・package.json・start.* など）にも、判定なしのモードで、ファイルの道具とシェルから書けない（順 1 で断る）', async t => {
  const s = setup(t, 'off');
  const root = APP_ROOT.replaceAll('\\', '/');
  const probes = ['src/zz-j4-probe.txt', 'web/zz-j4-probe.txt', 'templates/zz-j4-probe.txt', 'scripts/zz-j4-probe.txt', 'zz-j4-probe.txt'];
  t.after(() => { for (const p of probes) rmSync(join(APP_ROOT, p), { force: true }); });
  const tries: Array<[string, unknown]> = [
    ['file_write', { path: join(APP_ROOT, probes[0]!), content: 'x' }],
    ['file_write', { path: join(APP_ROOT, probes[1]!), content: 'x' }],
    ['file_write', { path: join(APP_ROOT, probes[2]!), content: 'x' }],
    ['file_edit', { path: join(APP_ROOT, 'package.json'), old_string: '"name"', new_string: '"name"' }],
    ['shell_run', { command: `Set-Content -Path '${root}/${probes[0]}' -Value x` }],
    ['shell_run', { command: `Set-Content -Path '${root}/${probes[3]}' -Value x` }],
    ['shell_run', { command: `echo x > '${root}/start.ps1'` }],
  ];
  for (const [name, args] of tries) {
    const out = await s.call(name, args);
    assert.equal(out.decision, 'deny', `${name} ${JSON.stringify(args)} → ${out.decidedBy}: ${out.output.content.slice(0, 200)}`);
  }
  for (const p of probes) assert.equal(existsSync(join(APP_ROOT, p)), false, p);
  assert.equal(s.judge.calls, 0);
  const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
  const policy = buildPolicy(parseConfig(testConfig()), s.paths);
  for (const name of ['src', 'web', 'templates', 'node_modules', 'package.json', 'package-lock.json', 'start.ps1', 'start.sh', '.git', '.npmrc']) {
    assert.ok(policy.deny.some(d => d === join(APP_ROOT, name) || d === APP_ROOT || d === real(APP_ROOT)), `${name} は守る一覧に入る`);
  }
  const inside = resolvePaths(join(APP_ROOT, 'data'));
  const local = buildPolicy(parseConfig(testConfig()), inside);
  for (const name of ['src', 'web', 'templates', 'node_modules', 'package.json', 'start.ps1', '.npmrc']) assert.ok([join(APP_ROOT, name), real(join(APP_ROOT, name))].some(p => local.deny.includes(p)), `data が置き場の中のとき: ${name}`);
  assert.equal(local.deny.includes(APP_ROOT), false, '置き場まるごとは守らない（data と作業場が中にある）');
  assert.equal(local.deny.some(d => d === inside.data || inside.workspace.startsWith(`${d}\\`) || inside.workspace.startsWith(`${d}/`)), false, '作業場は守る一覧に入らない');
});
