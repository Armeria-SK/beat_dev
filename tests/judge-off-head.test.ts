import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
import { placePath } from '../src/tools/hooks/scope.ts';
import { buildPolicy, dataHoldsInstall, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// J-4 の段の頭の確かめ: AI のファイルの道具とシェルから beat の設定・DB のファイルを書き換えられないこと、AI の道から判定なしのモードを切り替えられないこと

function setup(t: { after: (fn: () => void) => void }, judgeMode: 'on' | 'off', options: { data?: string; writeRoots?: string[]; stubShell?: boolean } = {}) {
  const paths = resolvePaths(options.data ?? tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  const config: AppConfig = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, ...(options.writeRoots ?? []).map(path => ({ path, mode: 'write' as const }))];
  config.routing.judgeMode = judgeMode;
  config.server.port = 4898;
  const parsed = parseConfig(config);
  writeFileSync(paths.config, JSON.stringify(parsed));
  writeFileSync(paths.database, 'db');
  const db = openDatabase(':memory:', MIGRATIONS);
  const ran: string[] = [];
  const shell: ToolDef = options.stubShell ? { ...(shellRun as unknown as ToolDef), execute: async (input: unknown) => { ran.push((input as { command: string }).command); return { content: 'stub' }; } } : shellRun as unknown as ToolDef;
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(shell);
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
  return { paths, call, judge, pending, ran, config: slash(paths.config), database: slash(paths.database) };
}

test('J-4 段の頭: 判定なしのモードでも、ファイルの道具とシェルの書き込みは beat の設定・DB のファイルに届かず、判定役にも回らずに断る', async t => {
  const s = setup(t, 'off');
  const before = readFileSync(s.paths.config, 'utf8');
  const tries: Array<[string, unknown]> = [
    ['file_write', { path: s.paths.config, content: '{}' }],
    ['file_write', { path: '../config.json', content: '{}' }],
    ['file_edit', { path: s.paths.config, old: '"version"', new: '"v"' }],
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

test('J-4 段の頭: beat の置き場（src・web・templates・package.json・start.* など）には、判定なしのモードで、置き場を許可フォルダに入れていても、ファイルの道具とシェルから書けない（順 1 で断る）', async t => {
  const s = setup(t, 'off', { writeRoots: [APP_ROOT] });
  const root = APP_ROOT.replaceAll('\\', '/');
  const probes = ['src/zz-j4-probe.txt', 'web/zz-j4-probe.txt', 'templates/zz-j4-probe.txt', 'scripts/zz-j4-probe.txt', 'zz-j4-probe.ps1', 'zz-j4-probe-edit.txt'];
  t.after(() => { for (const p of probes) rmSync(join(APP_ROOT, p), { force: true }); });
  for (const p of probes) assert.equal(existsSync(join(APP_ROOT, p)), false, `${p} はまだ無い`);
  const tries: Array<[string, unknown]> = [
    ['file_write', { path: join(APP_ROOT, probes[0]!), content: 'x' }],
    ['file_write', { path: join(APP_ROOT, probes[1]!), content: 'x' }],
    ['file_write', { path: join(APP_ROOT, probes[2]!), content: 'x' }],
    ['file_edit', { path: join(APP_ROOT, probes[5]!), old: 'a', new: 'b' }],
    ['file_read', { path: join(APP_ROOT, 'package.json') }],
    ['shell_run', { command: `Set-Content -Path '${root}/${probes[0]}' -Value x` }],
    ['shell_run', { command: `Set-Content -Path '${root}/${probes[3]}' -Value x` }],
    ['shell_run', { command: `echo x > '${root}/${probes[4]}'` }],
  ];
  for (const [name, args] of tries) {
    const out = await s.call(name, args);
    assert.deepEqual([out.decision, out.decidedBy], ['deny', 'builtin'], `${name} ${JSON.stringify(args)} → ${out.decidedBy}: ${out.output.content.slice(0, 200)}`);
  }
  for (const p of probes) assert.equal(existsSync(join(APP_ROOT, p)), false, p);
  assert.equal(s.judge.calls, 0);
  const policy = buildPolicy(parseConfig(testConfig()), s.paths);
  for (const name of ['src', 'web', 'templates', 'node_modules', 'package.json', 'package-lock.json', 'start.ps1', 'start.sh', '.git', '.npmrc', 'npm-shrinkwrap.json', 'postcss.config.mjs']) {
    assert.equal(placePath(join(APP_ROOT, name), policy).kind, 'deny', `${name} は断る`);
  }
});

test('J-4 段の頭: コードやスクリプトにそのまま書いた beat の置き場のパス（絶対・作業フォルダからの相対）は、判定なしのモードでは持ち主の Pending に積む。On では判定役が見る', async t => {
  const data = join(APP_ROOT, `zz-j4-data-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const s = setup(t, 'off', { data, stubShell: true });
  const root = APP_ROOT.replaceAll('\\', '/');
  const rel = relative(s.paths.workspace, APP_ROOT).replaceAll('\\', '/');
  writeFileSync(join(s.paths.workspace, 'put2.js'), `require('node:fs').writeFileSync('${root}/src/zz-j4-probe.ts', 'x');\n`);
  const tries = [
    `node -e "require('fs').writeFileSync('${root}/src/zz-j4-probe.ts','x')"`,
    `node -e "require('fs').writeFileSync('${rel}/src/zz-j4-probe.ts','x')"`,
    `node -e "require('fs').cpSync('a','${root}/web/zz-j4-probe')"`,
    `node -e "require('fs').writeFileSync('${root}/node_modules/zz-j4-probe.js','x')"`,
    `node -e "require('fs').writeFileSync('${root}/package.json','{}')"`,
    `node -e "require('fs').writeFileSync('${root}/start.ps1','x')"`,
    'node put2.js',
  ];
  for (const command of tries) {
    const out = await s.call('shell_run', { command });
    assert.equal(out.decidedBy, 'pending', `${command} → ${out.decidedBy}: ${out.output.content.slice(0, 200)}`);
  }
  const rows = s.pending.list({ status: 'waiting' });
  assert.equal(rows.length, tries.length);
  assert.ok(rows.every(r => r.kind === 'owner'), JSON.stringify(rows.map(r => r.kind)));
  assert.deepEqual(s.ran, []);
  assert.equal(s.judge.calls, 0);
  const on = setup(t, 'on', { data: join(data, 'on'), stubShell: true });
  const judged = await on.call('shell_run', { command: tries[0]! });
  assert.equal(on.judge.calls, 1, `On では判定役が見る: ${judged.decidedBy}`);
  const plain = await s.call('shell_run', { command: `node -e "require('fs').writeFileSync('notes.txt','x')"` });
  assert.notEqual(plain.decidedBy, 'pending', '置き場を指さないコードは今までどおり');
});

test('J-4 段の頭: 守らずに残すのは data のフォルダそのものだけ。data が置き場の中のどこにあっても、置き場のほかは断る。data の名前の大文字小文字が違っても同じ', () => {
  for (const name of ['npm-shrinkwrap.json', 'postcss.config.mjs', '.postcssrc.json', 'zz-new-folder']) assert.equal(existsSync(join(APP_ROOT, name)), false, `${name} はまだ無い`);
  for (const dataName of ['data', 'DATA', 'Data', 'src/zzdata', 'node_modules/zzdata', 'web/data']) {
    const inside = resolvePaths(join(APP_ROOT, dataName));
    const config = testConfig();
    config.tools.roots = [{ path: 'workspace', mode: 'write' }];
    const local = buildPolicy(parseConfig(config), inside);
    for (const name of ['npm-shrinkwrap.json', 'postcss.config.mjs', '.postcssrc.json', 'vite.config.ts', 'zz-new-folder/x.js', 'src', 'src/app.ts', 'web', 'web/vite.config.mjs', 'templates', 'node_modules', 'node_modules/vite/x.js', 'package.json', 'start.ps1', '.npmrc']) {
      assert.equal(placePath(join(APP_ROOT, name), local).kind, 'deny', `data=${dataName}: ${name}`);
    }
    const lower = (p: string) => (process.platform === 'win32' ? p.replace(join(APP_ROOT, dataName), join(APP_ROOT, dataName.toLowerCase())) : p);
    for (const target of [join(inside.workspace, 'notes.md'), lower(join(inside.workspace, 'notes.md'))]) {
      assert.equal(placePath(target, local).kind, 'inside', `data=${dataName}: 作業場は使える ${target}`);
    }
    assert.notEqual(placePath(join(inside.data, 'other.txt'), local).kind, 'deny', `data=${dataName}: data の中は置き場の守りに入らない`);
    assert.equal(dataHoldsInstall(inside), false);
  }
  assert.equal(dataHoldsInstall(resolvePaths(APP_ROOT)), true, 'data が置き場そのもの');
  assert.equal(dataHoldsInstall(resolvePaths(dirname(APP_ROOT))), true, 'data が置き場を含む');
});

test('J-4 段の頭: リンク越しでも守る（作業場の中のジャンクションが置き場を指す・置き場そのものがリンクの先）', t => {
  const base = tempDir(t);
  const fake = join(base, 'install');
  mkdirSync(join(fake, 'src'), { recursive: true });
  cpSync(join(APP_ROOT, 'templates'), join(fake, 'templates'), { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  const paths = { ...resolvePaths(join(base, 'data')), templates: join(fake, 'templates') };
  mkdirSync(paths.workspace, { recursive: true });
  try { symlinkSync(join(fake, 'src'), join(paths.workspace, 'lnk'), 'junction'); } catch { t.skip('ジャンクションを作れない'); return; }
  const policy = buildPolicy(parseConfig(config), paths);
  assert.equal(placePath(join(paths.workspace, 'lnk', 'x.ts'), policy).kind, 'deny', '作業場のジャンクションの先が置き場');
  assert.equal(placePath(join(paths.workspace, 'notes.md'), policy).kind, 'inside');
  symlinkSync(fake, join(base, 'install-link'), 'junction');
  const linked = { ...resolvePaths(join(base, 'data2')), templates: join(base, 'install-link', 'templates') };
  mkdirSync(linked.workspace, { recursive: true });
  const viaLink = buildPolicy(parseConfig(config), linked);
  assert.equal(placePath(join(fake, 'src', 'x.ts'), viaLink).kind, 'deny', 'リンクの先の本当の置き場');
  assert.equal(placePath(join(base, 'install-link', 'src', 'x.ts'), viaLink).kind, 'deny', 'リンクの置き場');
  const dataLinked = { ...resolvePaths(join(base, 'install-link', 'data')), templates: join(fake, 'templates') };
  mkdirSync(dataLinked.workspace, { recursive: true });
  const viaData = buildPolicy(parseConfig(config), dataLinked);
  assert.equal(placePath(join(fake, 'data', 'workspace', 'notes.md'), viaData).kind, 'inside', 'リンク越しの data は本当の場所でも使える');
  assert.equal(placePath(join(fake, 'src', 'x.ts'), viaData).kind, 'deny');
});
