import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { App } from '../src/app.ts';
import { defaultConfig, parseConfig } from '../src/config/store.ts';
import type { HookConfig } from '../src/config/schema.ts';
import { resolvePaths } from '../src/paths.ts';
import { runCommandHook, type HookPayload } from '../src/tools/hooks/command-hook.ts';
import { DEFAULT_PROTECT_FILES, PROTECT_FILES_OFFERED } from '../src/tools/hooks/protect-files.ts';
import { accessWidening } from '../web/src/settings/access.ts';
import type { Config } from '../web/src/settings/model.ts';
import { tempDir, testConfig } from './helpers.ts';

const hook = (over: Partial<Record<string, unknown>> = {}) => ({ matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**', 'package.json'], ...over }) as HookConfig;

function product(t: { after: (fn: () => void) => void }): string {
  const root = join(tempDir(t), 'prod');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  return root;
}

const payload = (root: string | undefined, paths: Array<{ path: string; write: boolean }>, tainted = false): HookPayload => ({
  hook_event_name: 'PreToolUse', tool_name: 'file_write', tool_input: {}, cwd: root ?? process.cwd(), run_id: 'r1', conversation_id: 'c1',
  paths, tainted, run_kind: 'chat', ...(root ? { project_root: root } : {}),
});

const run = (h: HookConfig, p: HookPayload) => runCommandHook(h, p, new AbortController().signal);

test('protect-files: .github/workflows/ci.yml への書き込みは ask で、理由にパスが出る', async t => {
  const root = product(t);
  const result = await run(hook(), payload(root, [{ path: join(root, '.github', 'workflows', 'ci.yml'), write: true }]));
  assert.equal(result.decision, 'ask');
  assert.equal(result.hook, 'protect-files');
  assert.match(result.reason, /ci\.yml is on your protected list/u);
});

test('protect-files（P3c）: 外を読んだかで守るファイルは変わらない。既定の一覧に package.json は無く、一覧に書けば外を読む前も ask', async t => {
  const root = product(t);
  const paths = [{ path: join(root, 'package.json'), write: true }];
  for (const tainted of [false, true]) {
    assert.equal((await run(DEFAULT_PROTECT_FILES as unknown as HookConfig, payload(root, paths, tainted))).decision, undefined, `default, ${tainted}`);
    assert.equal((await run(hook(), payload(root, paths, tainted))).decision, 'ask', `listed, ${tainted}`);
  }
});

test('protect-files: 読むだけのパス・製品の中のほかのファイル・製品の外のパスは当たらない', async t => {
  const root = product(t);
  const outside = join(root, '..', 'other', '.github', 'workflows', 'ci.yml');
  assert.equal((await run(hook(), payload(root, [{ path: join(root, '.github', 'workflows', 'ci.yml'), write: false }], true))).decision, undefined);
  assert.equal((await run(hook(), payload(root, [{ path: join(root, 'src', 'a.ts'), write: true }], true))).decision, undefined);
  assert.equal((await run(hook(), payload(root, [{ path: outside, write: true }], true))).decision, undefined);
  assert.equal((await run(hook(), payload(root, [{ path: join(root, '..', 'package.json'), write: true }], true))).decision, undefined);
});

test('protect-files: .. ・大文字小文字・ドライブ文字・リンクで一覧をすり抜けない', async t => {
  const root = product(t);
  const ask = async (path: string) => (await run(hook(), payload(root, [{ path, write: true }]))).decision;
  assert.equal(await ask(join(root, 'src', '..', '.github', 'workflows', 'ci.yml')), 'ask');
  assert.equal(await ask(`${root}/src/../.github/workflows/x.yml`), 'ask');
  assert.equal(await ask(join(root, '.github', 'workflows', '.hidden.yml')), 'ask', 'ドットで始まる名前も ** に入る');
  assert.equal(await ask(join(root, '.github', 'workflows', 'sub', 'deep.yaml')), 'ask');
  assert.equal(await ask(join(root, '.github', 'workflows')), 'ask', '守るフォルダそのものへの書き込み');
  assert.equal(await ask(join(root, '.github')), 'ask', '守るフォルダを含むフォルダごとの書き込み');
  assert.equal(await ask('.github/workflows/rel.yml'), 'ask', '相対のパスは作業フォルダから解く');
  if (process.platform === 'win32') {
    assert.equal(await ask(join(root, '.GitHub', 'WorkFlows', 'CI.yml')), 'ask');
    const folded = await run(hook({ always: ['ci/*.yml'] }), payload(root, [{ path: join(root, 'CI', 'Deploy.YML'), write: true }]));
    assert.equal(folded.decision, 'ask', 'まだ無いフォルダでも大文字小文字を区別しない');
    const flipped = root.replace(/^([A-Za-z]):/u, (_, d: string) => `${d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()}:`);
    assert.equal(await ask(join(flipped, '.github', 'workflows', 'ci.yml')), 'ask');
  }
  const link = join(root, 'gh');
  symlinkSync(join(root, '.github'), link, 'junction');
  assert.equal(await ask(join(link, 'workflows', 'ci.yml')), 'ask', 'リンクの先が守る場所');
  const outsideReal = join(root, '..', 'elsewhere');
  mkdirSync(outsideReal, { recursive: true });
  symlinkSync(outsideReal, join(root, '.github', 'workflows', 'out'), 'junction');
  assert.equal(await ask(join(root, '.github', 'workflows', 'out', 'ci.yml')), 'ask', '見た目のパスが守る場所');
  const rootLink = join(root, '..', 'prod-link');
  symlinkSync(root, rootLink, 'junction');
  const viaLink = await run(hook(), payload(rootLink, [{ path: join(root, '.github', 'workflows', 'ci.yml'), write: true }]));
  assert.equal(viaLink.decision, 'ask', '製品のフォルダがリンクで渡されても、実際の場所で照らす');
});

test('protect-files: 製品に属さない実行は、相対の一覧を当てず、絶対パスの一覧だけを見る', async t => {
  const root = product(t);
  const target = join(root, '.github', 'workflows', 'ci.yml');
  assert.equal((await run(hook(), payload(undefined, [{ path: target, write: true }], true))).decision, undefined);
  const abs = hook({ always: [`${root.replaceAll('\\', '/')}/.github/workflows/**`] });
  assert.equal((await run(abs, payload(undefined, [{ path: target, write: true }]))).decision, 'ask');
  assert.equal((await run(abs, payload(undefined, [{ path: join(root, 'src', 'a.ts'), write: true }]))).decision, undefined);
});

test('protect-files: paths が無い・空のときは何も言わない', async t => {
  const root = product(t);
  const bare: HookPayload = { hook_event_name: 'PreToolUse', tool_name: 'file_write', tool_input: {}, cwd: root, run_id: 'r', conversation_id: 'c' };
  assert.equal((await run(hook(), bare)).decision, undefined);
  assert.equal((await run(hook(), payload(root, []))).decision, undefined);
});

test('protect-files: プロセスを起こさない（子プロセスを作る口が呼ばれない）', async t => {
  const root = product(t);
  const calls: string[] = [];
  const spawn = t.mock.method(childProcess, 'spawn', (...args: unknown[]) => { calls.push(String(args[0])); throw new Error('spawned'); });
  syncBuiltinESMExports();
  try {
    const result = await run(hook(), payload(root, [{ path: join(root, '.github', 'workflows', 'ci.yml'), write: true }]));
    assert.equal(result.decision, 'ask');
    const external = await run({ matcher: '.*', command: ['node', '-e', '0'], timeoutMs: 1000, onError: 'deny' } as HookConfig, payload(root, []));
    assert.equal(external.decision, 'deny', '外のフックは今までどおりプロセスを起こそうとする（ここでは起こせずに onError）');
    assert.deepEqual(calls, ['node']);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

test('protect-files: 外のフック（command）は今までどおり', async t => {
  const root = product(t);
  const result = await run({ matcher: '.*', command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({decision:"ask",reason:"x"}))'], timeoutMs: 10_000, onError: 'deny' } as HookConfig, payload(root, []));
  assert.equal(result.decision, 'ask');
  assert.equal(result.reason, 'x');
});

test('設定: 組み込みのフックの行が読め、command と builtin を混ぜた行や知らない組み込みは断る', () => {
  const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
  raw.tools.hooks.preToolUse = [hook(), { matcher: 'a', command: ['x'] }];
  const parsed = parseConfig(raw);
  assert.equal(parsed.tools.hooks.preToolUse.length, 2);
  assert.equal((parsed.tools.hooks.preToolUse[1] as { timeoutMs: number }).timeoutMs, 30_000);
  assert.equal('timeoutMs' in parsed.tools.hooks.preToolUse[0]!, false);
  raw.tools.hooks.preToolUse = [{ ...hook(), command: ['x'] }];
  assert.throws(() => parseConfig(raw));
  raw.tools.hooks.preToolUse = [{ ...hook(), builtin: 'other' }];
  assert.throws(() => parseConfig(raw));
  raw.tools.hooks.preToolUse = [];
  raw.tools.hooks.postToolUse = [hook()];
  assert.throws(() => parseConfig(raw), '使ったあとのフックに組み込みは置けない');
});

function boot(dir: string, logs: string[]): App {
  const paths = resolvePaths(dir);
  return new App({ paths, databasePath: join(dir, 'test.db'), log: line => { logs.push(line); }, workerTimers: false });
}

test('一度だけの追加: 起動で既定の行を 1 つ足し、ログに 1 行、印を書く。消すと次の起動でも戻らない', t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(testConfig()));
  const logs: string[] = [];
  const first = boot(dir, logs);
  const seeded = first.configStore.current().tools.hooks.preToolUse;
  assert.deepEqual(seeded, [{ matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'] }]);
  assert.equal(logs.filter(l => /protect-files/u.test(l)).length, 1);
  assert.ok(first.kv.get(PROTECT_FILES_OFFERED));
  const config = first.configStore.current();
  config.tools.hooks.preToolUse = [];
  first.configStore.save(config);
  first.close();

  const again: string[] = [];
  const second = boot(dir, again);
  assert.deepEqual(second.configStore.current().tools.hooks.preToolUse, []);
  assert.equal(again.filter(l => /protect-files/u.test(l)).length, 0);
  second.close();
});

test('一度だけの追加: 持ち主が既に組み込みの行を書いていれば、足さずに印だけ書く', t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const config = testConfig();
  config.tools.hooks.preToolUse = [hook({ always: ['infra/**'] })];
  writeFileSync(paths.config, JSON.stringify(config));
  const logs: string[] = [];
  const app = boot(dir, logs);
  const hooks = app.configStore.current().tools.hooks.preToolUse;
  assert.equal(hooks.length, 1);
  assert.deepEqual((hooks[0] as { always: string[] }).always, ['infra/**']);
  assert.ok(app.kv.get(PROTECT_FILES_OFFERED));
  app.close();
});

test('画面の確かめ: 組み込みのフックを消す・止めるのは広がりとして並び、名前で出る', () => {
  const builtin = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'] };
  const config = (pre: unknown[]): Config => ({ tools: { hooks: { preToolUse: pre, postToolUse: [] } } });
  assert.deepEqual(accessWidening(config([builtin]), config([])), [{ kind: 'hook-removed', stage: 'preToolUse', hook: { matcher: '.*', command: ['protect-files'] } }]);
  assert.deepEqual(accessWidening(config([builtin]), config([{ ...builtin, enabled: false }])).map(a => a.kind), ['hook-disabled']);
});

test('一度だけの追加: 古い鍵や持ち主の書いた項目はファイルに残し、行を足すだけ。前の中身は .bak に控える', t => {
  const dir = tempDir(t);
  const paths = resolvePaths(dir);
  mkdirSync(paths.data, { recursive: true });
  const raw = testConfig() as unknown as Record<string, any>;
  raw.language = 'ja';
  raw.tools.maxIterations = 0;
  raw.tools.hooks = { preToolUse: [{ matcher: 'shell_run', command: ['node', 'mine.js'] }] };
  const before = `${JSON.stringify(raw, null, 2)}\n`;
  writeFileSync(paths.config, before);
  const logs: string[] = [];
  const app = boot(dir, logs);
  app.close();
  const written = JSON.parse(readFileSync(paths.config, 'utf8')) as Record<string, any>;
  assert.equal(written.language, 'ja');
  assert.equal(written.tools.maxIterations, 0);
  assert.deepEqual(written.tools.hooks.preToolUse, [{ matcher: 'shell_run', command: ['node', 'mine.js'] }, DEFAULT_PROTECT_FILES]);
  assert.deepEqual({ ...written, tools: { ...written.tools, hooks: raw.tools.hooks } }, raw);
  assert.equal(readFileSync(`${paths.config}.bak`, 'utf8'), before);
  assert.equal(logs.filter(l => l.includes('no longer used')).length, 1);
});
