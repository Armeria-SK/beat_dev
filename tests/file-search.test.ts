import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { openDatabase } from '../src/db/database.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import type { RunEvent } from '../src/engine/types.ts';
import { resolvePaths, type AppPaths } from '../src/paths.ts';
import { PendingStore } from '../src/pending/store.ts';
import { ApprovalBroker } from '../src/tools/approvals.ts';
import { fileEdit, fileList, fileRead, fileWrite } from '../src/tools/builtin/files.ts';
import { fileSearch } from '../src/tools/builtin/file-search.ts';
import { shellRun } from '../src/tools/builtin/shell.ts';
import { runToolCall } from '../src/tools/pipeline.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// tests/tools.test.ts の setup を写したもの。registry に fileSearch を足す
function setup(t: { after: (fn: () => void) => void }, mutate: (c: AppConfig) => void = () => undefined) {
  const paths: AppPaths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  writeFileSync(join(paths.data, 'reference', 'doc.md'), '参照用の文書');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  mutate(config);
  const parsed = parseConfig(config);
  const db = openDatabase(':memory:', MIGRATIONS);
  const events: RunEvent[] = [];
  const approvals = new ApprovalBroker(db);
  const registry = new ToolRegistry().register(fileRead).register(fileWrite).register(fileEdit).register(fileList).register(shellRun).register(fileSearch);
  const pending = new PendingStore(db, { tools: registry, dataDir: paths.data });
  const policy = buildPolicy(parsed, paths);
  const controller = new AbortController();
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: controller.signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const call = (name: string, args: unknown, c: ToolContext = ctx) =>
    runToolCall({ id: `call-${Math.random()}`, name, arguments: args }, c, {
      registry, approvals, pending, db, emit: e => events.push(e),
      lastUserRequest: () => 'please look through the files', autoClassify: async () => '{"decision":"ask","reason":"not sure"}',
    });
  return { paths, ctx, call, approvals, events, db, controller };
}

// 秘密・大きなフォルダ・バイナリを混ぜた作業フォルダを作る
function makeFixtures(s: ReturnType<typeof setup>): void {
  const ws = s.paths.workspace;
  mkdirSync(join(ws, 'notes'), { recursive: true });
  mkdirSync(join(ws, 'secrets'), { recursive: true });
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'notes', 'a.md'), 'りんご');
  writeFileSync(join(ws, 'notes', 'b.txt'), 'バナナ\nりんごジュース');
  writeFileSync(join(ws, '.env'), 'りんご=1');
  writeFileSync(join(ws, 'secrets', 'key.txt'), 'りんご');
  writeFileSync(join(ws, 'node_modules', 'pkg', 'readme.md'), 'りんご');
  writeFileSync(join(ws, 'bin.dat'), Buffer.concat([Buffer.from([0]), Buffer.from('りんご')]));
}

test('ファイル検索: 名前のワイルドカードで探す。大きなフォルダの中は探さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { name: '*.md' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.md/u);
  assert.doesNotMatch(out.output.content, /node_modules\/pkg\/readme\.md/u);
  assert.match(out.output.content, /node_modules/u); // search.heavy の印
});

test('ファイル検索: 中身の文字で探す。秘密・大きなフォルダ・バイナリは出さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /notes\/a\.md:1: りんご/u);
  assert.match(out.output.content, /notes\/b\.txt:2: りんごジュース/u);
  assert.doesNotMatch(out.output.content, /secrets\/key\.txt/u);
  assert.doesNotMatch(out.output.content, /bin\.dat/u);
  assert.doesNotMatch(out.output.content, /node_modules\/pkg\/readme\.md/u);
  assert.doesNotMatch(out.output.content, /\.env/u);
});

test('ファイル検索: path に大きなフォルダを指定すると中を探す', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { path: 'node_modules', text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /node_modules\/pkg\/readme\.md:1: りんご/u);
});

test('ファイル検索: 名前と中身の両方に合うものだけ返す', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { name: '*.md', text: 'バナナ' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /Nothing was found/u);
});

test('ファイル検索: 名前も中身も無ければ直させる', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', {});
  assert.equal(out.output.isError, true);
  assert.match(out.output.content, /at least one/u);
});

test('ファイル検索: 作業フォルダの外は拒否する', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { path: '../', name: '*.md' });
  assert.equal(out.decision, 'deny');
});

test('ファイル検索: 結果が max_results に達したら打ち切る', async t => {
  const s = setup(t);
  makeFixtures(s);
  const ws = s.paths.workspace;
  for (let i = 1; i <= 21; i++) writeFileSync(join(ws, `f${String(i).padStart(2, '0')}.txt`), `ファイル ${i}`);
  const out = await s.call('file_search', { name: '*.txt', max_results: 20 });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /Stopped at 20 results/u);
});

test('ファイル検索: シンボリックリンクの先（外のフォルダ）は探さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const outside = join(s.paths.data, 'outside-dir');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret-fruit.txt'), 'りんご');
  try { symlinkSync(outside, join(s.paths.workspace, 'link'), 'junction'); } catch { t.skip('シンボリックリンクを作れない環境'); return; }
  const out = await s.call('file_search', { text: 'りんご' });
  assert.equal(out.decision, 'allow');
  assert.doesNotMatch(out.output.content, /secret-fruit/u);
});

test('ファイル検索: 名前ワイルドカードは指数回帰しない（*?*?… は 100ms 以内で false）', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a'.repeat(44)), 'x');
  const start = Date.now();
  const out = await s.call('file_search', { name: '*?*?*?*?*?*?*?*?*?*?Z' });
  const ms = Date.now() - start;
  assert.equal(out.decision, 'allow');
  assert.ok(ms < 100, `ワイルドカードの照合が ${ms}ms かかった`);
  assert.match(out.output.content, /Nothing was found/u);
});

test('ファイル検索: 名前ワイルドカードは大文字小文字を区別できる', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, 'a.MD'), 'x');
  const insensitive = await s.call('file_search', { name: '*.md' });
  assert.match(insensitive.output.content, /a\.MD/u);
  const sensitive = await s.call('file_search', { name: '*.md', case_sensitive: true });
  assert.match(sensitive.output.content, /Nothing was found/u);
});

test('ファイル検索: [ ] は正規表現ではなくそのままの文字', async t => {
  const s = setup(t);
  writeFileSync(join(s.paths.workspace, '[z-a].txt'), 'x');
  const out = await s.call('file_search', { name: '[z-a].txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /\[z-a\]\.txt/u);
});

test('ファイル検索: 中止済みのシグナルなら素早く止まり、例外を投げない', async t => {
  const s = setup(t);
  for (let i = 1; i <= 300; i++) writeFileSync(join(s.paths.workspace, `f${String(i).padStart(3, '0')}.txt`), 'x');
  s.controller.abort();
  const out = await s.call('file_search', { name: '*.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /Nothing was found/u);
});

test('ファイル検索: 上限を超えたら全体で止まる（内側のループだけではない）', async t => {
  const s = setup(t);
  const ws = s.paths.workspace;
  writeFileSync(join(ws, 'a.txt'), 'x');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  writeFileSync(join(ws, 'sub', 'b.txt'), 'x');
  for (let i = 1; i <= 20_000; i++) writeFileSync(join(ws, `z${String(i).padStart(5, '0')}.dat`), 'x');
  const out = await s.call('file_search', { name: '*.txt' });
  assert.equal(out.decision, 'allow');
  assert.match(out.output.content, /stopped after looking at 20000\]/u);
  assert.doesNotMatch(out.output.content, /looking at 20001/u);
  assert.doesNotMatch(out.output.content, /sub\/b\.txt/u);
});

test('ファイル検索: 名前の検索でも秘密・禁止リストは出さない', async t => {
  const s = setup(t, c => { c.tools.deny = ['workspace/locked']; });
  makeFixtures(s);
  const ws = s.paths.workspace;
  mkdirSync(join(ws, 'locked'), { recursive: true });
  writeFileSync(join(ws, 'locked', 'secret.txt'), 'x');
  const star = await s.call('file_search', { name: '*' });
  assert.equal(star.decision, 'allow');
  assert.doesNotMatch(star.output.content, /\.env/u);
  assert.doesNotMatch(star.output.content, /secrets\/key\.txt/u);
  assert.doesNotMatch(star.output.content, /locked\/secret\.txt/u);
  const env = await s.call('file_search', { name: '*.env' });
  assert.doesNotMatch(env.output.content, /\.env/u);
});

test('ファイル検索: path にファイルを渡すと、そのファイルの中を探す（「フォルダが無い」とは言わない）', async t => {
  const s = setup(t);
  makeFixtures(s);
  const hit = await s.call('file_search', { path: 'notes/b.txt', text: 'りんご' });
  assert.equal(hit.decision, 'allow');
  assert.notEqual(hit.output.isError, true, hit.output.content);
  assert.match(hit.output.content, /notes\/b\.txt:2: りんごジュース/u);
  assert.doesNotMatch(hit.output.content, /does not exist/u);
  assert.doesNotMatch(hit.output.content, /notes\/a\.md/u, '同じフォルダの別のファイルは探さない');
  const miss = await s.call('file_search', { path: 'notes/b.txt', text: 'みかん' });
  assert.match(miss.output.content, /Nothing was found: notes\/b\.txt/u);
  assert.notEqual(miss.output.isError, true);
  const byName = await s.call('file_search', { path: 'notes/b.txt', name: '*.md' });
  assert.match(byName.output.content, /Nothing was found/u, 'name はそのファイルの名前に当てる');
  const sameName = await s.call('file_search', { path: 'notes/b.txt', name: 'B.TXT' });
  assert.match(sameName.output.content, /notes\/b\.txt/u);
  const missing = await s.call('file_search', { path: 'notes/none.txt', text: 'りんご' });
  assert.equal(missing.output.isError, true);
  assert.match(missing.output.content, /The folder does not exist: notes\/none\.txt/u);
});

test('ファイル検索: path に渡したファイルが秘密なら、中を探さない', async t => {
  const s = setup(t);
  makeFixtures(s);
  const out = await s.call('file_search', { path: '.env', text: 'りんご' });
  assert.equal(out.decision, 'deny');
  assert.doesNotMatch(out.output.content, /りんご=1/u);
});

test('ファイル検索: name はフォルダの名前にも当たり、フォルダは末尾の / で分かる', async t => {
  const s = setup(t);
  makeFixtures(s);
  mkdirSync(join(s.paths.workspace, 'docs', 'ux-trial'), { recursive: true });
  writeFileSync(join(s.paths.workspace, 'docs', 'ux-trial', 'r.md'), 'x');
  writeFileSync(join(s.paths.workspace, 'docs', 'ux-trial.md'), 'x');
  const out = await s.call('file_search', { name: '*ux-trial*' });
  assert.equal(out.decision, 'allow');
  const lines = out.output.content.split('\n');
  assert.ok(lines.includes('docs/ux-trial/'), out.output.content);
  assert.ok(lines.includes('docs/ux-trial.md'), 'ファイルは今までどおり（末尾の / 無し）');
  assert.ok(!lines.includes('docs/ux-trial/r.md'), '名前に合わないファイルは出さない');
  const caseSensitive = await s.call('file_search', { name: '*UX-TRIAL*', case_sensitive: true });
  assert.match(caseSensitive.output.content, /Nothing was found/u);
});

test('ファイル検索: text があるときは、中身を持たないフォルダを名前の結果に出さない。秘密・禁止のフォルダの名前も出さない', async t => {
  const s = setup(t, c => { c.tools.deny = ['workspace/locked']; });
  makeFixtures(s);
  mkdirSync(join(s.paths.workspace, 'locked'), { recursive: true });
  const withText = await s.call('file_search', { name: '*', text: 'りんご' });
  assert.doesNotMatch(withText.output.content, /^notes\/$/mu);
  assert.match(withText.output.content, /notes\/a\.md:1: りんご/u);
  const star = await s.call('file_search', { name: '*' });
  assert.doesNotMatch(star.output.content, /locked/u);
  assert.match(star.output.content, /^notes\/$/mu);
});
