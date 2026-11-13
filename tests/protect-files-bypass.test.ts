import assert from 'node:assert/strict';
import nodeFs, { linkSync, mkdirSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, parse } from 'node:path';
import { test } from 'node:test';
import type { HookConfig } from '../src/config/schema.ts';
import { ConfigError, defaultConfig, parseConfig, resetConfig } from '../src/config/store.ts';
import { runCommandHook, type HookPayload } from '../src/tools/hooks/command-hook.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { isInside, realish, writeApprovalKind } from '../src/tools/hooks/scope.ts';
import { tempDir } from './helpers.ts';

const WIN = process.platform === 'win32';
const hook = (over: Partial<Record<string, unknown>> = {}) => ({ matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**'], afterOutside: ['package.json'], ...over }) as HookConfig;

function product(t: { after: (fn: () => void) => void }, name = 'prod'): string {
  const root = join(tempDir(t), name);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'on: push');
  return root;
}

type Entry = { path: string; write: boolean; dir?: boolean };
const payload = (over: { root?: string; roots?: string[]; paths: Entry[]; tainted?: boolean; cwd?: string }): HookPayload => ({
  hook_event_name: 'PreToolUse', tool_name: 'shell_run', tool_input: {}, cwd: over.cwd ?? over.root ?? process.cwd(), run_id: 'r', conversation_id: 'c',
  paths: over.paths, tainted: over.tainted ?? false, run_kind: 'chat',
  ...(over.root ? { project_root: over.root } : {}), ...(over.roots ? { product_roots: over.roots } : {}),
});
const run = (h: HookConfig, p: HookPayload) => runCommandHook(h, p, new AbortController().signal);
const w = (path: string, dir?: boolean): Entry => ({ path, write: true, ...(dir === undefined ? {} : { dir }) });

test('製品のフォルダすべて: 製品に属さない会話でも、登録された製品のフォルダの中の守る場所への書き込みは ask', async t => {
  const a = product(t, 'a');
  const b = product(t, 'b');
  assert.equal((await run(hook(), payload({ roots: [a, b], paths: [w(join(b, '.github', 'workflows', 'x.yml'))], tainted: true }))).decision, 'ask');
  assert.equal((await run(hook(), payload({ root: a, roots: [a, b], paths: [w(join(b, 'package.json'))], tainted: true }))).decision, 'ask', 'ほかの製品のフォルダ');
  assert.equal((await run(hook(), payload({ root: a, roots: [a, b], paths: [w(join(b, 'src', 'x.ts'))], tainted: true }))).decision, undefined);
  assert.equal((await run(hook(), payload({ paths: [w(join(b, '.github', 'workflows', 'x.yml'))] }))).decision, undefined, '製品の一覧も無ければ相対の一覧は当てない');
});

test('ハードリンク: 守るファイルとつながったファイルへの書き込みは ask', async t => {
  const root = product(t);
  linkSync(join(root, 'package.json'), join(root, 'notes.txt'));
  linkSync(join(root, '.github', 'workflows', 'ci.yml'), join(root, 'src', 'x.yml'));
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'notes.txt'))], tainted: true }))).decision, 'ask');
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'notes.txt'))], tainted: false }))).decision, undefined, 'package.json は外を読んだあとだけ');
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'src', 'x.yml'))] }))).decision, 'ask');
  writeFileSync(join(root, 'src', 'plain.txt'), 'x');
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'src', 'plain.txt'))], tainted: true }))).decision, undefined);
});

test('先の無いリンク: 指す先がまだ無くても、リンクの先で照らす', async t => {
  const root = product(t);
  const target = join(root, '.github', 'workflows', 'later');
  mkdirSync(target);
  symlinkSync(target, join(root, 'lnk'), 'junction');
  rmdirSync(target);
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'lnk', 'ci.yml'))] }))).decision, 'ask');
});

test('Windows の末尾の . と空白: 各段で落としてから照らす', { skip: !WIN }, async t => {
  const root = product(t);
  assert.equal((await run(hook(), payload({ root, paths: [w(`${root}\\.github.\\workflows.\\ci.yml`)] }))).decision, 'ask');
  assert.equal((await run(hook(), payload({ root, paths: [w(`${root}\\package.json.`)], tainted: true }))).decision, 'ask');
  assert.equal((await run(hook(), payload({ root, paths: [w(`${root}\\package.json  `)], tainted: true }))).decision, 'ask');
  const instructions = join(root, 'sub', 'AGENTS.md');
  assert.equal(writeApprovalKind(`${root}\\sub.\\AGENTS.md`, { roots: [], deny: [], instructions: [instructions] }), 'instructions');
  assert.equal(writeApprovalKind(`${root}\\sub \\AGENTS.md.`, { roots: [], deny: [], instructions: [instructions] }), 'instructions');
});

test('照らし方: ワイルドカードの無い一覧はその中すべて。フォルダへの書き込みは、その下に当たりうれば ask', async t => {
  const root = product(t);
  mkdirSync(join(root, 'packages', 'a'), { recursive: true });
  const ask = async (h: HookConfig, entry: Entry) => (await run(h, payload({ root, paths: [entry] }))).decision;
  assert.equal(await ask(hook({ always: ['infra'] }), w(join(root, 'infra', 'deploy.sh'))), 'ask');
  const deep = hook({ always: ['**/package.json'] });
  assert.equal(await ask(deep, w(join(root, 'packages', 'a'))), 'ask', '今あるフォルダ');
  assert.equal(await ask(deep, w(join(root, 'packages', 'b'), true)), 'ask', 'フォルダと渡されたもの');
  assert.equal(await ask(deep, w(join(root, 'packages', 'a', 'index.ts'))), undefined);
  assert.equal(await ask(deep, w(join(root, 'packages', 'a', 'package.json'))), 'ask');
  assert.equal(await ask(hook({ always: ['.github/*/ci.yml'] }), w(join(root, '.github', 'workflows'))), 'ask');
  assert.equal(await ask(hook({ always: ['.github/*/ci.yml'] }), w(join(root, '.github', 'workflows', 'other.yml'))), undefined);
});

test('ドライブだけの一覧（X:/**）は、そのドライブの根から', { skip: !WIN }, async () => {
  const drive = parse(process.cwd()).root.slice(0, 2);
  const result = await run(hook({ always: [`${drive}/**`], afterOutside: [] }), payload({ paths: [w(`${drive}\\zz-not-here\\x.yml`)] }));
  assert.equal(result.decision, 'ask');
});

test('** が続いても固まらない', async t => {
  const root = product(t);
  const start = performance.now();
  const many = hook({ always: [`q/${'**/a/'.repeat(12)}b`], afterOutside: [] });
  const result = await run(many, payload({ root, paths: [w(join(root, 'q', ...Array.from({ length: 40 }, () => 'a'), 'c'))] }));
  assert.equal(result.decision, undefined);
  assert.ok(performance.now() - start < 500, `${performance.now() - start} ms`);
});

test('理由: 実際のパスが違うときは、それも出す', async t => {
  const root = product(t);
  symlinkSync(join(root, '.github'), join(root, 'gh'), 'junction');
  const result = await run(hook(), payload({ root, paths: [w(join(root, 'gh', 'workflows', 'ci.yml'))] }));
  assert.equal(result.decision, 'ask');
  assert.ok(result.reason.includes(join(root, '.github', 'workflows', 'ci.yml')), result.reason);
});

test('設定の誤り: フックの行の誤りは、行の形に合わせて項目ごとに出る', () => {
  const issues = (row: unknown) => {
    const raw = JSON.parse(JSON.stringify(defaultConfig())) as Record<string, any>;
    raw.tools.hooks.preToolUse = [row];
    try { parseConfig(raw); } catch (error) { return (error as ConfigError).issues; }
    return [];
  };
  const command = issues({ matcher: '', command: ['x'] });
  assert.deepEqual(command.map(i => i.path), ['tools.hooks.preToolUse.0.matcher']);
  assert.notEqual(command[0]!.code, 'config.type.union');
  const builtin = issues({ matcher: 'a', builtin: 'protect-files', always: [''], afterOutside: [] });
  assert.deepEqual(builtin.map(i => i.path), ['tools.hooks.preToolUse.0.always.0']);
  assert.deepEqual(issues({ matcher: 'a', command: ['x'], timeoutMs: 5 }).map(i => i.path), ['tools.hooks.preToolUse.0.timeoutMs']);
});

test('Reset: 戻したあとの設定にも、既定の protect-files の行がある', () => {
  const current = defaultConfig();
  current.tools.hooks.preToolUse = [{ matcher: 'x', command: ['node', 'x.js'], timeoutMs: 1000, onError: 'deny' }];
  assert.deepEqual(resetConfig(current).tools.hooks.preToolUse, [DEFAULT_PROTECT_FILES]);
});

test('ワイルドカードの一覧がフォルダに当たれば、その中のファイルも守る', async t => {
  const root = product(t);
  mkdirSync(join(root, 'src', 'tools', 'hooks'), { recursive: true });
  const ask = async (pattern: string, path: string) => (await run(hook({ always: [pattern], afterOutside: [] }), payload({ root, paths: [w(path)] }))).decision;
  assert.equal(await ask('**/hooks', join(root, 'src', 'tools', 'hooks', 'scope.ts')), 'ask');
  assert.equal(await ask('s*', join(root, 'src', 'app.ts')), 'ask');
  assert.equal(await ask('**/hooks', join(root, 'src', 'tools', 'other.ts')), undefined);
});

test('一覧の下を歩ききれないときは、その旨の理由で ask', async t => {
  const root = product(t);
  const many = join(root, '.github', 'workflows', 'many');
  mkdirSync(many);
  for (let i = 0; i <= 20_000; i++) writeFileSync(join(many, String(i)), '');
  linkSync(join(root, 'package.json'), join(root, 'notes.txt'));
  const result = await run(hook(), payload({ root, paths: [w(join(root, 'notes.txt'))] }));
  assert.equal(result.decision, 'ask');
  assert.match(result.reason, /could not check all protected files/u);
  assert.doesNotMatch(result.reason, /the same file as/u);
});

test('先の無いリンクが深すぎる・解けないときは、閉じる向き（フックは ask、実際のパスは製品の中にしない）', { skip: !WIN }, async t => {
  const root = product(t);
  const hops = Array.from({ length: 45 }, (_, i) => join(root, `j${i}`));
  for (let i = hops.length - 1; i >= 0; i--) {
    const target = i === hops.length - 1 ? join(root, 'missing') : hops[i + 1]!;
    symlinkSync(target, hops[i]!, 'junction');
  }
  const path = join(hops[0]!, 'ci.yml');
  const result = await run(hook(), payload({ root, paths: [w(path)] }));
  assert.equal(result.decision, 'ask');
  assert.equal(isInside(root, realish(path)), false);
});

test('UNC の一覧は UNC のまま（今のドライブに読み替えない）', { skip: !WIN }, async () => {
  const drive = parse(process.cwd()).root.slice(0, 2);
  const unc = hook({ always: ['//server/share/**'], afterOutside: [] });
  assert.equal((await run(unc, payload({ paths: [w('\\\\server\\share\\x.yml')] }))).decision, 'ask');
  assert.equal((await run(unc, payload({ paths: [w(`${drive}\\server\\share\\x.yml`)] }))).decision, undefined);
});

test('フォルダごとの書き込みで、中に守るファイルとハードリンクでつながったファイルがあれば ask', async t => {
  const root = product(t);
  mkdirSync(join(root, 'dist', 'deep'), { recursive: true });
  linkSync(join(root, 'package.json'), join(root, 'dist', 'deep', 'p.json'));
  writeFileSync(join(root, 'dist', 'plain.txt'), 'x');
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'dist'))], tainted: true }))).decision, 'ask');
  assert.equal((await run(hook(), payload({ root, paths: [w(join(root, 'src'))], tainted: true }))).decision, undefined);
});

test('大きなフォルダへの書き込み: 守るファイルにハードリンクが 1 つも無ければ、歩かずに何も言わない', async t => {
  const root = product(t);
  const dist = join(root, 'dist');
  mkdirSync(dist);
  for (let i = 0; i <= 21_000; i++) writeFileSync(join(dist, String(i)), '');
  const walked: string[] = [];
  const original = nodeFs.readdirSync;
  const spy = t.mock.method(nodeFs, 'readdirSync', ((path: string, ...rest: unknown[]) => { if (isInside(dist, String(path))) walked.push(String(path)); return (original as (...a: unknown[]) => unknown)(path, ...rest); }) as typeof nodeFs.readdirSync);
  syncBuiltinESMExports();
  try {
    const result = await run(hook(), payload({ root, paths: [w(dist)], tainted: true }));
    assert.equal(result.decision, undefined, result.reason);
    assert.deepEqual(walked, [], '書き込み先のフォルダは歩かない');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('歩く上限は 1 回の呼び出しで分け合う: 守るファイルにハードリンクがあるとき、合わせて上限を超えれば ask', async t => {
  const root = product(t);
  linkSync(join(root, 'package.json'), join(root, 'elsewhere.json'));
  for (const name of ['a', 'b']) {
    mkdirSync(join(root, name));
    for (let i = 0; i < 11_000; i++) writeFileSync(join(root, name, String(i)), '');
  }
  const result = await run(hook(), payload({ root, paths: [w(join(root, 'a')), w(join(root, 'b'))], tainted: true }));
  assert.equal(result.decision, 'ask');
  assert.match(result.reason, /could not check all protected files/u);
});
