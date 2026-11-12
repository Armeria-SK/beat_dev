import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Type } from '@sinclair/typebox';
import { builtinTools } from '../src/app.ts';
import { parseConfig } from '../src/config/store.ts';
import type { StopReason, ToolCall } from '../src/engine/types.ts';
import { resolvePaths } from '../src/paths.ts';
import { webDownload } from '../src/tools/builtin/download.ts';
import { checkFilePath } from '../src/tools/builtin/files.ts';
import type { DownloadNetwork } from '../src/tools/web/public-page.ts';
import { shellPreCheck } from '../src/tools/builtin/shell.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { findExecutable, scrubEnv } from '../src/tools/shell/runner.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import type { ToolContext, ToolDef } from '../src/tools/types.ts';
import { fakeModel, settled, startApp, uuid } from './app-setup.ts';
import { reply, tempDir, testConfig, type Script } from './helpers.ts';

const WINDOWS = process.platform === 'win32';
type Config = ReturnType<typeof testConfig>;
type Options = NonNullable<Parameters<typeof startApp>[1]>;

const call = (name: string, args: unknown): Script => async function* () {
  const toolCall: ToolCall = { id: `call_${Math.random().toString(36).slice(2)}`, name, arguments: args };
  yield { type: 'tool_call', call: toolCall };
  yield { type: 'done', stop: 'tool_use' as StopReason };
};

// ── 許可フォルダと指示ファイル（道具の事前の判定だけ） ──

function unit(t: { after: (fn: () => void) => void }, mutate?: (config: Config, root: string) => void) {
  const base = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(base, 'data'));
  mkdirSync(paths.workspace, { recursive: true });
  const root = join(base, 'shop');
  mkdirSync(join(root, 'sub'), { recursive: true });
  const outside = join(base, 'elsewhere');
  mkdirSync(outside);
  const config = testConfig();
  mutate?.(config, root);
  const parsed = parseConfig(config);
  const plain = buildPolicy(parsed, paths);
  const policy = buildPolicy(parsed, paths, { root });
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy, workspace: root,
    home: defaultWorkspace(plain, paths), project: { id: 'p1', root }, taint: { tainted: false, sources: [] }, log: () => undefined, ...over,
  });
  const write = (path: string, c: ToolContext = ctx()) => checkFilePath(path, 'write', c).check;
  return { base, paths, root, outside, parsed, plain, policy, ctx, write };
}

test('製品の実行の許可フォルダ: 作業フォルダが書ける許可フォルダとして 1 つ足される。設定の許可フォルダはそのまま', t => {
  const u = unit(t);
  assert.deepEqual(u.policy.roots, [...u.plain.roots, { path: u.root, mode: 'write' }]);
  assert.equal(u.write('hello.txt').decision, 'allow', '相対パスは作業フォルダの中');
  assert.equal(u.write(join(u.root, 'sub', 'deep.txt')).decision, 'allow');
  assert.equal(defaultWorkspace(u.policy, u.paths), u.paths.workspace, 'Clive の置き場（home）は製品のフォルダに替わらない');
});

test('製品の実行の許可フォルダ: 外・..・秘密・Clive のデータは今までどおり。.git の中は今回だけの確かめ。中のジャンクションが外を指せば外', t => {
  const u = unit(t);
  assert.equal(u.write(join(u.outside, 'x.txt')).decision, 'deny', '外');
  assert.equal(u.write(`..${WINDOWS ? '\\' : '/'}elsewhere${WINDOWS ? '\\' : '/'}x.txt`).decision, 'deny', '..で外');
  assert.equal(u.write('.env').decision, 'deny', '.env');
  assert.equal(u.write(u.paths.database).decision, 'deny', 'Clive の DB');
  assert.equal(u.write(join(u.paths.projects, 'p1', 'x.md')).decision, 'deny', 'data/projects');
  const git = u.write('.git/hooks/pre-commit');
  assert.deepEqual([git.decision, git.onceOnly], ['ask', true]);
  symlinkSync(u.outside, join(u.root, 'link'), WINDOWS ? 'junction' : 'dir');
  assert.equal(u.write(join('link', 'x.txt')).decision, 'deny', 'ジャンクション越しは外');
  const shell = shellPreCheck({ command: WINDOWS ? 'echo x > link\\x.txt' : 'echo x > link/x.txt' }, u.ctx());
  assert.ok(shell.decision !== 'allow' && /outside the allowed folders/u.test(shell.reasons.join('\n')), shell.reasons.join('\n'));
});

test('製品の実行の許可フォルダ: 製品に属さない実行と、別の製品の実行からは、その作業フォルダへ確かめなしに書けない', t => {
  const u = unit(t);
  assert.equal(u.write(join(u.root, 'x.txt'), u.ctx({ policy: u.plain, workspace: u.paths.workspace, project: undefined })).decision, 'deny');
  const other = join(u.base, 'other');
  mkdirSync(other);
  const otherPolicy = buildPolicy(u.parsed, u.paths, { root: other });
  assert.equal(u.write(join(u.root, 'x.txt'), u.ctx({ policy: otherPolicy, workspace: other, project: { id: 'p2', root: other } })).decision, 'deny');
});

test('設定の「読むだけ」: 同じフォルダが読むだけなら製品のフォルダを書ける許可フォルダに足さない（書き込みは断られる）。製品の中の読むだけのフォルダは読むだけのまま', t => {
  const same = unit(t, (c, root) => { c.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: root, mode: 'read' }]; });
  assert.deepEqual(same.policy.roots, same.plain.roots);
  assert.equal(same.write('x.txt').decision, 'deny');
  assert.match(checkFilePath('x.txt', 'write', same.ctx()).check.reasons.join('\n'), /read only/u);
  const inner = unit(t, (c, root) => { mkdirSync(join(root, 'vendor'), { recursive: true }); c.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: join(root, 'vendor'), mode: 'read' }]; });
  assert.equal(inner.write(join('vendor', 'x.txt')).decision, 'deny', '中の読むだけ');
  assert.equal(inner.write('x.txt').decision, 'allow');
});

test('指示ファイル: 作業フォルダ直下の AGENTS.md・CLAUDE.md を書くと、ファイルの道具でもシェルでも確かめになる。下の階・ほかのファイルは確かめなし', t => {
  const u = unit(t);
  const names = ['AGENTS.md', 'CLAUDE.md', 'agents.md', ...(WINDOWS ? ['Claude.MD', 'AGENTS.md.', 'AGENTS.md '] : [])];
  for (const name of names) {
    const check = u.write(name);
    assert.equal(check.decision, 'ask', name);
    assert.match(check.reasons.join('\n'), /instruction file/u, name);
    assert.deepEqual(check.askKinds, ['persona'], `${name}: 判定役に回らない種類`);
  }
  for (const name of ['README.md', join('sub', 'AGENTS.md'), join('sub', 'CLAUDE.md')]) assert.equal(u.write(name).decision, 'allow', name);
  writeFileSync(join(u.root, 'draft.txt'), 'x');
  const shellWrites = WINDOWS
    ? ['echo x > AGENTS.md', 'Set-Content -Path CLAUDE.md -Value x', 'Move-Item -Path draft.txt -Destination AGENTS.md', 'Copy-Item draft.txt claude.md']
    : ['echo x > AGENTS.md', 'mv draft.txt AGENTS.md', 'cp draft.txt CLAUDE.md'];
  for (const command of shellWrites) {
    const check = shellPreCheck({ command }, u.ctx());
    assert.equal(check.decision, 'ask', command);
    assert.match(check.reasons.join('\n'), /instruction file/u, command);
  }
  const deeper = shellPreCheck({ command: WINDOWS ? 'Set-Content -Path sub\\AGENTS.md -Value x' : 'echo x > sub/AGENTS.md' }, u.ctx());
  assert.doesNotMatch(deeper.reasons.join('\n'), /instruction file/u);
  assert.equal(u.write(join(u.root, 'AGENTS.md'), u.ctx({ policy: u.plain, workspace: u.paths.workspace, project: undefined })).decision, 'deny', '製品に属さない実行からは、そもそも外');
});

test('指示ファイル（指摘 4）: 登録したすべての製品の AGENTS.md・CLAUDE.md は、どの実行から書いても確かめになる（許可フォルダの中に入れ子の製品・設定の許可フォルダの中の製品）', t => {
  const u = unit(t, (config, root) => { config.tools.roots = [{ path: join(root, '..'), mode: 'write' }]; });
  const nested = join(u.root, 'sub');
  const sibling = join(u.base, 'shop2');
  mkdirSync(sibling);
  const plain = buildPolicy(u.parsed, u.paths, undefined, [u.root, nested, sibling]);
  const inShop = buildPolicy(u.parsed, u.paths, { root: u.root }, [u.root, nested, sibling]);
  for (const [label, c] of [['製品なし', u.ctx({ policy: plain, workspace: u.base, project: undefined })], ['製品 shop', u.ctx({ policy: inShop })]] as const) {
    for (const file of [join(sibling, 'AGENTS.md'), join(nested, 'CLAUDE.md'), join(u.root, 'AGENTS.md')]) {
      const check = u.write(file, c);
      assert.equal(check.decision, 'ask', `${label}: ${file}`);
      assert.match(check.reasons.join('\n'), /instruction file/u, `${label}: ${file}`);
    }
    assert.equal(u.write(join(sibling, 'README.md'), c).decision, 'allow', label);
  }
});

test('シェルの実行ファイルの探し方（指摘 13）: 名前だけのコマンドは、作業フォルダに置いた npm.cmd・git.exe などを拾わない（子の PATH は絶対パスの項目だけ）', t => {
  const u = unit(t);
  for (const name of ['npm.cmd', 'git.exe', 'node.exe', 'npm', 'git']) writeFileSync(join(u.root, name), '');
  const env = scrubEnv([], { ...process.env, PATH: `.${WINDOWS ? ';' : ':'}${process.env.PATH ?? ''}${WINDOWS ? ';' : ':'}` });
  for (const name of ['npm', 'git', 'node']) {
    const found = findExecutable(name, env, u.root, { powershell: WINDOWS });
    assert.ok(found === undefined || !found.startsWith(u.root), `${name}: ${found}`);
  }
});

test('npm の作業フォルダの .npmrc（指摘 1）: npm が起動のときに読む場所に .npmrc があれば、npm はどの形も確かめなしでは動かない', t => {
  const u = unit(t);
  const forms = ['npm -v', 'npm --version', 'npm ls', 'npm view left-pad', 'npm outdated'];
  for (const command of forms) assert.equal(shellPreCheck({ command }, u.ctx()).decision, 'allow', `.npmrc が無ければこれまでどおり: ${command}`);
  for (const command of ['npx -v', 'npx --version', 'pnpm -v', 'pnpm --version', 'yarn -v', 'yarn --version', 'pnpm ls', 'yarn list']) assert.notEqual(shellPreCheck({ command }, u.ctx()).decision, 'allow', `前から確かめなしでは動かない: ${command}`);
  writeFileSync(join(u.root, '.npmrc'), 'prefix=.\n');
  for (const command of forms) {
    const check = shellPreCheck({ command }, u.ctx());
    assert.equal(check.decision, 'ask', command);
    assert.equal(check.onceOnly, true, command);
  }
  const sub = u.ctx({ workspace: join(u.root, 'sub') });
  assert.equal(shellPreCheck({ command: 'npm -v' }, sub).decision, 'ask', '上の階の .npmrc も数える（npm はワークスペースの根までさかのぼりうる）');
  mkdirSync(join(u.root, 'packages', 'a'), { recursive: true });
  writeFileSync(join(u.root, 'packages', 'a', 'package.json'), '{}');
  mkdirSync(join(u.root, 'packages', 'a', 'node_modules'));
  assert.equal(shellPreCheck({ command: 'npm -v', cwd: join('packages', 'a') }, u.ctx()).decision, 'ask', 'cwd が package.json のある下の階でも、上の .npmrc を数える');
  mkdirSync(join(u.root, 'sub', 'package.json'));
  assert.equal(shellPreCheck({ command: 'npm -v' }, sub).decision, 'ask', 'package.json という名前のフォルダで止まらない');
  rmSync(join(u.root, '.npmrc'));
  writeFileSync(join(u.root, '.npmrc'), `${'#'.repeat(1_100_000)}\nprefix=.\n`);
  assert.equal(shellPreCheck({ command: 'npm -v' }, u.ctx()).decision, 'ask', '上限より大きい .npmrc は、中身を読み切らずに数える');
  rmSync(join(u.root, '.npmrc'));
  assert.equal(shellPreCheck({ command: 'npm -v' }, sub).decision, 'allow');
  const bash = (command: string) => checkShellCommand(command, join(u.root, 'sub'), { policy: u.policy, outsideRoots: 'ask', shell: 'bash', windows: WINDOWS }).decision;
  assert.equal(bash('echo x > ../package.json'), 'allow');
  assert.equal(bash('npm -v'), 'allow');
  assert.notEqual(bash('echo x > ../package.json; npm -v'), 'allow', '同じコマンドの前の文で書いてから npm');
});

// ── 製品の実行（本物の App） ──

function probeTool(seen: ToolContext[]): ToolDef {
  return { name: 'probe_ctx', description: 'probe', input: Type.Object({}), effect: 'read', allowedIn: ['chat', 'task', 'agent'], execute: async (_input, ctx) => { seen.push(ctx); return { content: 'ok' }; } };
}

async function setup(t: Parameters<typeof startApp>[0], options: Options = {}) {
  const products = realpathSync.native(tempDir(t as never));
  const seen: ToolContext[] = [];
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: [...builtinTools(), probeTool(seen)], ...options });
  const folder = (name: string) => { const dir = join(products, name); mkdirSync(dir, { recursive: true }); return dir; };
  const product = async (name: string) => {
    const made = await s.json('/api/projects', 'POST', { root: folder(name) });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.project as { id: string; name: string; root: string; remotes: unknown };
  };
  const send = async (id: string, body: Record<string, unknown>) => {
    const sent = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    if (sent.status === 202) await settled(s.app, sent.body.runId);
    return sent;
  };
  return { ...s, products, seen, folder, product, send };
}

test('製品の会話: 相対パスの file_write は作業フォルダに確かめなしで書かれる。作業フォルダ・home・ctx.project が入り、設定の許可フォルダは変わらない。製品に属さない会話は書けない', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const rootsBefore = structuredClone(s.app.config().tools.roots);
  s.adapter().scripts = [call('probe_ctx', {}), call('file_write', { path: 'hello.txt', content: 'hi' }), reply('done')];
  assert.equal((await s.send(uuid(1), { text: 'make a file', projectId: shop.id })).status, 202);
  assert.equal(readFileSync(join(shop.root, 'hello.txt'), 'utf8'), 'hi');
  assert.equal(s.app.approvals.pending().length, 0);
  const ctx = s.seen[0]!;
  assert.deepEqual([ctx.workspace, ctx.home, ctx.project], [shop.root, s.paths.workspace, { id: shop.id, root: shop.root }]);
  assert.deepEqual(s.app.config().tools.roots, rootsBefore);

  s.adapter().scripts = [call('probe_ctx', {}), call('file_write', { path: join(shop.root, 'plain.txt'), content: 'x' }), reply('done')];
  await s.send(uuid(2), { text: 'write there' });
  assert.equal(existsSync(join(shop.root, 'plain.txt')), false);
  assert.deepEqual([s.seen[1]!.workspace, s.seen[1]!.project], [s.paths.workspace, undefined]);
});

test('指示ファイル（指摘 4）: 会話の実行は、しまった製品も含めてすべての製品の AGENTS.md・CLAUDE.md を指示ファイルとして持つ', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const other = await s.product('other');
  const old = await s.product('old');
  assert.equal((await s.json(`/api/projects/${old.id}`, 'PATCH', { archived: true })).status, 200);
  const expected = [shop.root, other.root, old.root].flatMap(root => ['AGENTS.md', 'CLAUDE.md'].map(name => join(root, name))).sort();
  s.adapter().scripts = [call('probe_ctx', {}), reply('done')];
  await s.send(uuid(1), { text: 'plain' });
  s.adapter().scripts = [call('probe_ctx', {}), reply('done')];
  await s.send(uuid(2), { text: 'in shop', projectId: shop.id });
  for (const ctx of s.seen) assert.deepEqual([...(ctx.policy.instructions ?? [])].sort(), expected);
  assert.equal(s.seen.length, 2);
});

test('製品の会話の子の担当:親の作業フォルダ・許可フォルダ・home・製品をそのまま使う', async t => {
  const s = await setup(t, { configure: (c: Config) => { c.tools.agent.enabled = true; c.tools.policies = { agent_run: 'allow' }; } });
  const shop = await s.product('shop');
  s.adapter().scripts = [call('agent_run', { task: 'look', tools: ['probe_ctx'] }), call('probe_ctx', {}), reply('child'), reply('parent')];
  await s.send(uuid(1), { text: 'delegate', projectId: shop.id });
  const child = s.seen[0]!;
  assert.equal(child.kind, 'agent');
  assert.deepEqual([child.workspace, child.home, child.project?.id], [shop.root, s.paths.workspace, shop.id]);
  assert.ok(child.policy.roots.some(r => r.path === shop.root && r.mode === 'write'));
});

test('製品の会話の web_download: Clive の置き場の downloads/ を確かめて書き、その絶対パスを返す。製品のフォルダの downloads は使わない', async t => {
  const network: DownloadNetwork = {
    resolve: async () => ['93.184.216.34'],
    open: async () => ({ status: 200, contentType: 'application/pdf', body: (async function* () { yield Buffer.from('pdf'); })(), close: () => undefined }),
  };
  const s = await setup(t, { downloadNetwork: network });
  const shop = await s.product('shop');
  const outside = s.folder('elsewhere');
  symlinkSync(outside, join(shop.root, 'downloads'), WINDOWS ? 'junction' : 'dir');
  s.adapter().scripts = [call('web_download', { url: 'https://files.example.com/report.pdf' }), reply('done')];
  await s.send(uuid(1), { text: 'get it', projectId: shop.id });
  const saved = join(s.paths.workspace, 'downloads', 'report.pdf');
  assert.equal(readFileSync(saved, 'utf8'), 'pdf');
  assert.equal(existsSync(join(outside, 'report.pdf')), false);
  const result = s.app.conversations.messages(uuid(1)).find(m => m.role === 'tool')!;
  assert.ok(result.text.includes(saved), result.text);
  assert.match(webDownload.description, /downloads folder of Clive/u);
});

test('製品の会話でダウンロードの置き場（data/workspace/downloads）を読むと、ファイル・探す道具で外を読んだ印が付く', async t => {
  const s = await setup(t, { models: [fakeModel('m1', { vision: true })] });
  const shop = await s.product('shop');
  const downloads = join(s.paths.workspace, 'downloads');
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, 'page.txt'), 'fetched text');
  writeFileSync(join(downloads, 'pic.gif'), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03, 0x00, 0x05, 0x00]));
  const cases: Array<[string, unknown]> = [
    ['file_read', { path: join(downloads, 'page.txt') }], ['file_search', { path: s.paths.workspace, name: 'page*' }], ['file_list', { path: downloads }],
    ['file_search', { path: s.paths.workspace, text: 'fetched' }], ['image_view', { path: join(downloads, 'pic.gif') }],
  ];
  for (const [index, [name, args]] of cases.entries()) {
    s.adapter().scripts = [call(name, args), reply('read')];
    const sent = await s.send(uuid(10 + index), { text: 'read it', projectId: shop.id });
    assert.equal(s.app.runs.get(sent.body.runId)!.tainted, 1, `${name} ${JSON.stringify(args)}`);
  }
  const imageResult = s.app.conversations.messages(uuid(14)).find(m => m.role === 'tool')!;
  assert.match(imageResult.text, /came from the web or a downloaded file/u);
  s.adapter().scripts = [call('file_read', { path: 'notes.txt' }), reply('read')];
  writeFileSync(join(shop.root, 'notes.txt'), 'mine');
  const own = await s.send(uuid(20), { text: 'read mine', projectId: shop.id });
  assert.equal(s.app.runs.get(own.body.runId)!.tainted, 0, '製品のフォルダのファイルは外ではない');
});

test('作業フォルダが消えた・ジャンクションにすり替わった: 発言とやり直しは 409 project.folder_missing で受け付けず保存しない。戻すと動く', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('first')];
  assert.equal((await s.send(uuid(1), { text: 'hello', projectId: shop.id })).status, 202);
  const saved = () => s.app.conversations.messages(uuid(1)).length;
  const before = saved();
  const away = `${shop.root}-away`;
  renameSync(shop.root, away);
  for (const [id, body] of [[uuid(1), { text: 'again' }], [uuid(1), { text: 'again', projectId: shop.id }], [uuid(2), { text: 'new', projectId: shop.id }]] as const) {
    const refused = await s.json(`/api/conversations/${id}/messages`, 'POST', body);
    assert.deepEqual([refused.status, refused.body.code], [409, 'project.folder_missing'], JSON.stringify(body));
  }
  assert.equal(saved(), before, '発言は保存しない');
  assert.equal(s.app.conversations.get(uuid(2)), undefined, '新しい会話もできない');
  assert.deepEqual([(await s.json(`/api/conversations/${uuid(1)}/retry`, 'POST', {})).body.code], ['project.folder_missing']);
  assert.equal((await s.json('/api/projects', 'GET')).body.projects[0].folder_missing, true);

  const decoy = s.folder('decoy');
  symlinkSync(decoy, shop.root, WINDOWS ? 'junction' : 'dir');
  const swapped = await s.json(`/api/conversations/${uuid(1)}/messages`, 'POST', { text: 'swapped' });
  assert.deepEqual([swapped.status, swapped.body.code], [409, 'project.folder_missing'], 'すり替えたジャンクションは追わない');
  rmSync(shop.root, { recursive: false, force: true });
  renameSync(away, shop.root);
  s.adapter().scripts = [reply('back')];
  assert.equal((await s.send(uuid(1), { text: 'back again' })).status, 202);
});

test('#execute の念のための守り: 確かめを通っていない製品の実行には作業フォルダを足さない（製品なしと同じ許可フォルダで動く）', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  s.adapter().scripts = [reply('first')];
  await s.send(uuid(1), { text: 'hello', projectId: shop.id });
  renameSync(shop.root, `${shop.root}-away`);
  s.adapter().scripts = [call('probe_ctx', {}), call('file_write', { path: 'stray.txt', content: 'x' }), reply('done')];
  const sent = s.app.engine.send(uuid(1), 'direct');
  assert.ok(sent.ok);
  await settled(s.app, sent.runId);
  const ctx = s.seen[0]!;
  assert.deepEqual([ctx.workspace, ctx.project], [shop.root, { id: shop.id }], '作業フォルダは控えた場所のまま（Clive の置き場に替えない）');
  assert.ok(!ctx.policy.roots.some(r => r.path === shop.root));
  assert.ok(s.logs.some(line => line.includes(`product ${shop.id}`)), s.logs.join('\n'));
  assert.equal(existsSync(join(s.paths.workspace, 'stray.txt')), false, '相対パスの書き込みが Clive の置き場に落ちない');
  assert.equal(existsSync(join(shop.root, 'stray.txt')), false);
  const refused = s.app.conversations.messages(uuid(1)).filter(m => m.role === 'tool').at(-1)!;
  assert.match(refused.text, /outside the allowed folders/u);
  const u = s.seen[0]!;
  const shell = shellPreCheck({ command: WINDOWS ? 'Get-ChildItem' : 'ls' }, u);
  assert.equal(shell.decision, 'deny', '作業フォルダを確かめられないときはシェルを始めない（すり替わった先で読まない）');
  assert.match(shell.reasons.join('\n'), /cwd must be inside the allowed folders/u);
});

test('製品のタスク: フォルダが無いあいだは始めず 10 分後へ回し、失敗の回数を数えない。経過に 1 行、通知は 1 つ。戻すと作業フォルダで動く', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const made = await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  const id = made.body.task.id as string;
  const away = `${shop.root}-away`;
  renameSync(shop.root, away);
  const started = Date.now();
  assert.equal(await s.app.worker.tick(), 'folder_missing');
  const waiting = s.app.tasks.get(id)!;
  assert.deepEqual([waiting.status, waiting.attempts], ['ready', 0]);
  assert.ok(waiting.run_at! >= started + 9 * 60_000);
  assert.equal(s.app.tasks.events(id).filter(e => e.kind === 'requeued' && /folder of the product "shop"/u.test(e.content ?? '')).length, 1);
  s.app.db.prepare('UPDATE tasks SET run_at = NULL WHERE id = ?').run(id);
  assert.equal(await s.app.worker.tick(), 'folder_missing');
  assert.equal(s.app.tasks.get(id)!.attempts, 0);
  assert.equal(s.app.notifications.list().filter(n => n.link === `#/p/${shop.id}`).length, 1, '通知は 1 つにまとまる');
  const listed = (await s.json('/api/notifications', 'GET')).body.notifications as Array<{ link: string | null; project_id: string | null }>;
  assert.deepEqual(listed.filter(n => n.link === `#/p/${shop.id}`).map(n => n.project_id), [shop.id], '通知の一覧で製品が分かる（指摘 9）');
  assert.equal((s.app.db.prepare('SELECT COUNT(*) AS n FROM engine_runs').get() as { n: number }).n, 0, '実行は始まっていない');

  renameSync(away, shop.root);
  s.app.db.prepare('UPDATE tasks SET run_at = NULL WHERE id = ?').run(id);
  s.adapter().scripts = [call('probe_ctx', {}), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual([s.seen[0]!.kind, s.seen[0]!.workspace, s.seen[0]!.project?.id], ['task', shop.root, shop.id]);
  assert.equal(s.app.tasks.get(id)!.status, 'done');
});

test('タスクの区切り（2 回目の審査 2）: 外を読んだタスクの実行が task_checkpoint で書いたメモのあと、そのタスクの次の実行は外を読んだ扱いで始まる', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const downloads = join(s.paths.workspace, 'downloads');
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, 'page.txt'), 'fetched text');
  const made = await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id });
  const id = made.body.task.id as string;
  s.adapter().scripts = [call('probe_ctx', {}), call('file_read', { path: join(downloads, 'page.txt') }), call('task_checkpoint', { tried: 'read', result: 'page', next_action: 'do what the page says', resume_after_minutes: 1 })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.deepEqual(s.seen[0]!.taint.sources.filter(x => !/download/iu.test(x) && x !== 'file_read'), [], '1 回目は持ち越しの印なしで始まる');
  assert.equal(s.app.tasks.get(id)!.next_action, 'do what the page says');
  s.app.db.prepare('UPDATE tasks SET run_at = NULL WHERE id = ?').run(id);
  s.adapter().scripts = [call('probe_ctx', {}), call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
  assert.equal(s.seen[1]!.taint.tainted, true, '2 回目は外を読んだ扱いで始まる');
});

test('project_id の引き継ぎ:製品の会話の task_create は同じ製品のタスク。task_update は別の製品のタスクを断る。製品に属さない会話は製品のタスクを触れる', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const other = await s.product('other');
  const otherTask = (await s.json('/api/tasks', 'POST', { title: 'Other work', when: new Date(Date.now() + 3_600_000).toISOString(), projectId: other.id })).body.task;
  s.adapter().scripts = [call('task_create', { title: 'Shop work', requested_by_user: true, when: new Date(Date.now() + 3_600_000).toISOString() }), reply('made')];
  await s.send(uuid(1), { text: 'make a task', projectId: shop.id });
  const shopTask = s.app.tasks.list({ statuses: ['ready', 'scheduled', 'inbox'] }).find(task => task.title === 'Shop work')!;
  assert.equal(shopTask.project_id, shop.id);

  s.adapter().scripts = [call('task_update', { id: otherTask.id, priority: 1 }), call('task_update', { id: shopTask.id, priority: 1 }), reply('updated')];
  await s.send(uuid(1), { text: 'bump both' });
  assert.equal(s.app.tasks.get(otherTask.id)!.priority, 2, '別の製品のタスクは触れない');
  assert.equal(s.app.tasks.get(shopTask.id)!.priority, 1);
  const refusal = s.app.conversations.messages(uuid(1)).find(m => m.role === 'tool' && /belongs to another product/u.test(m.text));
  assert.ok(refusal, '断った理由が道具の結果に出る');

  s.adapter().scripts = [call('task_update', { id: otherTask.id, priority: 3, note: 'from the owner chat' }), reply('ok')];
  await s.send(uuid(2), { text: 'bump other' });
  assert.equal(s.app.tasks.get(otherTask.id)!.priority, 3, '製品に属さない会話は触れる');
});

test('会話の経過の引き渡し（#handOver）は、製品が同じタスクにだけ書く', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const later = new Date(Date.now() + 3_600_000).toISOString();
  const shopTask = (await s.json('/api/tasks', 'POST', { title: 'Shop work', when: later, projectId: shop.id })).body.task;
  const plainTask = (await s.json('/api/tasks', 'POST', { title: 'Plain work', when: later })).body.task;
  s.adapter().scripts = [call('task_update', { id: shopTask.id, priority: 1 }), call('task_update', { id: plainTask.id, priority: 1 }), call('probe_ctx', {}), reply('Summary of the talk')];
  await s.send(uuid(1), { text: 'touch both' });
  const notes = (id: string) => s.app.tasks.events(id).filter(e => /Summary of the talk/u.test(e.content ?? '')).length;
  assert.deepEqual([notes(shopTask.id), notes(plainTask.id)], [0, 1]);
});

test('しまった製品の待ちのタスクはワーカーが選ばない。戻すと動く', async t => {
  const s = await setup(t);
  const shop = await s.product('shop');
  const id = (await s.json('/api/tasks', 'POST', { title: 'Tidy', when: new Date(Date.now() - 1000).toISOString(), projectId: shop.id })).body.task.id as string;
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { archived: true });
  assert.equal(await s.app.worker.tick(), 'idle');
  assert.equal(s.app.tasks.get(id)!.status, 'ready');
  await s.json(`/api/projects/${shop.id}`, 'PATCH', { archived: false });
  s.adapter().scripts = [call('task_complete', { summary: 'done' })];
  assert.equal(await s.app.worker.tick(), 'ran');
});

test('push してよい宛先の控え: git のフォルダは作るときに remote を控え（パスワードは控えない）、git でなければ []。refreshRemotes で取り直す', async t => {
  const s = await setup(t);
  const repo = s.folder('repo');
  mkdirSync(join(repo, '.git', 'objects'), { recursive: true });
  mkdirSync(join(repo, '.git', 'refs'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const config = (extra: string) => writeFileSync(join(repo, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://me:s3cret@github.com/me/app.git\n\tpushurl = git@github.com:me/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n${extra}`);
  config('');
  const made = await s.json('/api/projects', 'POST', { root: repo });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.project.remotes, [{ name: 'origin', url: 'https://github.com/me/app.git', push_url: 'git@github.com:me/app.git' }]);
  assert.ok(!JSON.stringify(s.app.projects.get(made.body.project.id)).includes('s3cret'));
  config('[remote "backup"]\n\turl = D:/backup/app\n[remote "tok"]\n\turl = https://ghp_tokenvalue@github.com/me/app.git\n[remote "at"]\n\turl = https://me:pa@ss@host.example/a.git\n[remote "q"]\n\turl = https://host.example/a.git?token=qsecret#frag\n');
  const refreshed = await s.json(`/api/projects/${made.body.project.id}`, 'PATCH', { refreshRemotes: true });
  assert.deepEqual(refreshed.body.project.remotes.map((r: { name: string; url: string }) => [r.name, r.url]), [
    ['origin', 'https://github.com/me/app.git'], ['backup', 'D:/backup/app'], ['tok', 'https://github.com/me/app.git'], ['at', 'https://host.example/a.git'], ['q', 'https://host.example/a.git'],
  ]);
  for (const secret of ['ghp_tokenvalue', 'pa@ss', 'ss@host', 'qsecret']) assert.ok(!JSON.stringify(s.app.projects.get(made.body.project.id)).includes(secret), secret);
  const plain = await s.product('plain');
  assert.deepEqual(plain.remotes, []);
});
