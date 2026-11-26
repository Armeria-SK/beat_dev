import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { AppConfig, RuntimeKind } from '../src/config/schema.ts';
import { parseConfig } from '../src/config/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { mapApproval, REFUSALS, type MapContext, type Mapped, type RefusalCode } from '../src/runtimes/approval-map.ts';
import { checkFilePath } from '../src/tools/builtin/files.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { buildPolicy } from '../src/tools/policy.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

// AR-8a: 実行役の承認の求めを beat の検査の形に写し、モデルを呼ばない守りだけを当てる（src/runtimes/approval-map.ts）。
// 断る守りは閉じた一覧（REFUSALS）。写せない・知らないものは、断らず持ち主に回す

type Ask = Extract<Mapped, { decision: 'ask' }>;

function world(t: Parameters<typeof tempDir>[0], options: { kind?: RuntimeKind; mutate?: (config: AppConfig) => void } = {}) {
  const base = realpathSync.native(tempDir(t));
  const paths = resolvePaths(join(base, 'data-home'));
  mkdirSync(paths.workspace, { recursive: true });
  mkdirSync(join(paths.data, 'reference'), { recursive: true });
  const products = join(base, 'products');
  const root = join(products, 'prod');
  mkdirSync(root, { recursive: true });
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: 'reference', mode: 'read' }];
  options.mutate?.(config);
  const parsed = parseConfig(config);
  const ctx: MapContext = { kind: options.kind ?? 'claude-code', config: parsed, paths, root, productRoots: [root], runId: 'run-1', conversationId: 'conv-1' };
  return { base, paths, products, root, config: parsed, ctx };
}

const asked = (mapped: Mapped): Ask => { assert.equal(mapped.decision, 'ask', JSON.stringify(mapped)); return mapped as Ask; };
const refusedWith = (mapped: Mapped): RefusalCode | undefined => (mapped.decision === 'refuse' ? mapped.code : undefined);
const write = (ctx: MapContext, file: string, content = 'x'): Mapped => mapApproval(ctx, { tool: 'Write', input: { file_path: file, content } });

// 同じ面（junction）を使う: 管理者でなくても作れる。リンクの先が製品の外か中かで、守る理由が変わる
function link(target: string, at: string): void {
  mkdirSync(target, { recursive: true });
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, 'junction');
}

test('断る理由は閉じた一覧で、画面の文・試験はそこから作られる', () => {
  assert.deepEqual([...REFUSALS], ['secret', 'outside_write', 'readonly_root', 'link_write', 'protect_files', 'outside_cwd', 'self_target']);
});

test('書く先の守りは files.ts の checkFilePath と食い違わない: 断る所は断り、聞く所（git・設定ファイル）は持ち主に聞き、「聞かない」を出さない', t => {
  const w = world(t);
  link(join(w.root, 'real-dir'), join(w.root, 'link-dir'));
  link(join(w.base, 'elsewhere'), join(w.root, 'out-link'));
  const policy = buildPolicy(w.config, w.paths, { root: w.root }, [w.root]);
  const toolCtx: ToolContext = {
    runId: 'r', conversationId: 'c', kind: 'chat', signal: new AbortController().signal, config: w.config, paths: w.paths, policy,
    workspace: w.root, taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  const files: string[] = [
    join(w.root, 'a.txt'), join(w.root, 'src', 'deep', 'b.ts'), join(w.root, 'notes with space.md'),
    join(w.root, '.env'), join(w.root, 'sub', '.env.local'), join(w.paths.data, 'beat.db'), join(w.paths.data, 'config.json'),
    join(w.products, 'other', 'x.txt'), join(w.base, 'outside.txt'), join(w.paths.data, 'reference', 'doc.md'),
    join(w.root, 'link-dir'), join(w.root, 'out-link', 'x.txt'),
    join(w.root, '.git', 'config'), join(w.root, '.git', 'hooks', 'pre-commit'), join(w.root, '.curlrc'), join(w.root, 'sitecustomize.py'),
    join(w.root, 'CLAUDE.md'), join(w.paths.workspace, 'SOUL.md'), join(w.paths.workspace, 'skills', 'x', 'SKILL.md'),
  ];
  const seen = { deny: 0, ask: 0, allow: 0 };
  for (const file of files) {
    const decision = checkFilePath(file, 'write', toolCtx).check.decision;
    const mapped = write(w.ctx, file);
    seen[decision] += 1;
    if (decision === 'deny') assert.equal(mapped.decision, 'refuse', `${file}: checkFilePath denies it, so beat must refuse it without asking (${JSON.stringify(mapped)})`);
    else {
      const card = asked(mapped);
      if (decision === 'ask') assert.deepEqual([card.reply, card.checks.length > 0, card.checked], [false, true, true], `${file}: a request checkFilePath would ask about is never offered as "do not ask again" (${JSON.stringify(card.checks)})`);
      else assert.deepEqual([card.reply, card.checks.length, card.checked], [true, 0, true], file);
    }
  }
  assert.ok(seen.deny >= 8 && seen.ask >= 4 && seen.allow >= 3, `the matrix covers all three answers: ${JSON.stringify(seen)}`);
});

test('書く先の守りの断る理由: .env・beat のデータ・製品の外・読むだけのフォルダ・リンク・リンクの先が外', t => {
  const w = world(t);
  link(join(w.root, 'real-dir'), join(w.root, 'link-dir'));
  link(join(w.base, 'elsewhere'), join(w.root, 'out-link'));
  const expected: Array<[string, RefusalCode]> = [
    [join(w.root, '.env'), 'secret'], [join(w.root, 'sub', '.env.production'), 'secret'], [join(w.paths.data, 'beat.db'), 'secret'],
    [join(w.products, 'other', 'x.txt'), 'outside_write'], [join(w.base, 'outside.txt'), 'outside_write'],
    [join(w.paths.data, 'reference', 'doc.md'), 'readonly_root'],
    [join(w.root, 'link-dir'), 'link_write'], [join(w.root, 'out-link', 'x.txt'), 'outside_write'],
  ];
  for (const [file, code] of expected) {
    for (const tool of ['Write', 'Edit', 'NotebookEdit']) {
      const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      assert.equal(refusedWith(mapApproval(w.ctx, { tool, input: { [field]: file } })), code, `${tool} ${file}`);
    }
  }
  const inside = asked(write(w.ctx, join(w.root, 'ok.txt')));
  assert.deepEqual([inside.checks, inside.reply, inside.checked], [[], true, true]);
  assert.equal(inside.card.title, 'Write ok.txt');
});

test('相対パスは製品のフォルダから読み、実行役が ~ や環境変数を展開しない形も、展開した形も両方に守りを当てる', t => {
  const w = world(t);
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '.env', content: 'x' } })), 'secret');
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '../other/x.txt', content: 'x' } })), 'outside_write');
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: 'sub/../../outside.txt', content: 'x' } })), 'outside_write');
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '~/.ssh/id_rsa', content: 'x' } })), 'secret');
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '~/outside-of-the-product.txt', content: 'x' } })), 'outside_write', 'the ~ form lands outside the product, though the form beat does not expand sits inside it');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = join(w.root, 'a', 'b');
  try {
    assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '~/../../x.txt', content: 'x' } })), 'outside_write', 'the form beat does not expand lands outside the product, though the expanded form sits inside it');
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  const unresolved = asked(mapApproval(w.ctx, { tool: 'Write', input: { file_path: '$BEAT_NO_SUCH_VARIABLE_8a/x.txt', content: 'x' } }));
  assert.deepEqual([unresolved.reply, unresolved.checks.length > 0], [false, true], 'a path beat cannot resolve is asked about, and never offered as "do not ask again"');
});

test('持ち主の守るファイルの一覧（protect-files）に当たる書き込みは、聞かずに断る。一覧が空なら当たらない', t => {
  const withList = world(t, { mutate: config => { config.tools.hooks.preToolUse = [structuredClone(DEFAULT_PROTECT_FILES)]; } });
  assert.equal(refusedWith(write(withList.ctx, join(withList.root, '.github', 'workflows', 'ci.yml'))), 'protect_files');
  assert.equal(refusedWith(mapApproval(withList.ctx, { tool: 'Bash', input: { command: 'echo x > .github/workflows/ci.yml' } })), 'protect_files');
  assert.equal(asked(write(withList.ctx, join(withList.root, 'ok.txt'))).reply, true);
  const without = world(t);
  assert.equal(asked(write(without.ctx, join(without.root, '.github', 'workflows', 'ci.yml'))).checked, true);
});

test('読む道具（Read・Glob・Grep）: 秘密の場所は断り、製品の外は札に添えて聞く。パスの無い Glob・Grep は製品のフォルダ', t => {
  const w = world(t);
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Read', input: { file_path: join(w.root, '.env') } })), 'secret');
  assert.equal(refusedWith(mapApproval(w.ctx, { tool: 'Grep', input: { pattern: 'x', path: join(w.paths.data, 'beat.db') } })), 'secret');
  const listsData = asked(mapApproval(w.ctx, { tool: 'Glob', input: { pattern: '*', path: w.paths.data } }));
  assert.ok(listsData.checks.some(line => line.includes(w.paths.data)), 'the data folder itself is only outside the allowed folders; the files in it are secret');
  const outside = asked(mapApproval(w.ctx, { tool: 'Read', input: { file_path: join(w.base, 'outside.txt'), limit: 5 } }));
  assert.ok(outside.checks.some(line => line.includes(join(w.base, 'outside.txt'))), JSON.stringify(outside.checks));
  assert.match(outside.card.title, /^Read /u);
  assert.match(outside.card.body ?? '', /limit/u);
  const grep = asked(mapApproval(w.ctx, { tool: 'Grep', input: { pattern: 'x' } }));
  assert.deepEqual([grep.checks, grep.checked, grep.card.title], [[], true, `Search in ${w.root}`]);
  const unreadable = asked(mapApproval(w.ctx, { tool: 'Read', input: {} }));
  assert.equal(unreadable.checked, false);
});

test('シェルの求め: 秘密を読む・製品の外へ書く・beat 自身へ話しかけるものは断り、ふつうのコマンドは持ち主に聞く（札にコマンドと作業フォルダ）', t => {
  const w = world(t);
  const run = (command: string, tool = 'Bash') => mapApproval(w.ctx, { tool, input: { command } });
  assert.equal(refusedWith(run('cat .env')), 'secret');
  assert.equal(refusedWith(run('echo hi > ../outside.txt')), 'outside_write');
  assert.equal(refusedWith(run(`curl http://127.0.0.1:${w.config.server.port}/api/pending`)), 'self_target');
  assert.equal(refusedWith(run(`Invoke-WebRequest http://localhost:${w.config.server.port}/api/pending`, 'PowerShell')), 'self_target');
  const ok = asked(run('ls -la'));
  assert.deepEqual([ok.card.title, ok.card.body, ok.card.cwd, ok.checked], ['Run a command (Bash)', 'ls -la', w.root, true]);
  assert.equal(asked(run('Get-ChildItem', 'PowerShell')).card.title, 'Run a command (PowerShell)');
  const extra = asked(mapApproval(w.ctx, { tool: 'Bash', input: { command: 'ls', description: 'list the files', timeout: 5000 } }));
  assert.match(extra.card.extra ?? '', /list the files/u);
  assert.ok(!(extra.card.body ?? '').includes('list the files'), 'the command itself is the body');
  assert.equal(asked(mapApproval(w.ctx, { tool: 'Bash', input: { command: 42 } })).checked, false, 'a command that is not text goes to the owner, unchecked');
  (w.ctx.config.server as { origins: unknown }).origins = null;
  const broken = asked(run('cat .env'));
  assert.deepEqual([broken.checked, broken.reply, broken.card.body, broken.card.cwd], [false, false, 'cat .env', w.root], 'a check that fails while it runs is asked about, never declined or allowed silently');
  assert.ok(broken.checks.length > 0);
});

test('写せない・知らない求めは、断らず必ず持ち主に回す（beat が検査していない旨を札に添える）', t => {
  const w = world(t);
  const cases: Array<[string, unknown]> = [
    ['mcp__server__tool', { anything: 'goes' }], ['WebFetch', { url: 'https://example.com' }], ['Task', { prompt: 'x' }], ['', {}],
    ['Write', null], ['Write', 'text'], ['Write', ['a']], ['Write', {}], ['Write', { file_path: 5 }], ['Edit', { file_path: '' }], ['Bash', null], ['Bash', {}], ['Read', {}],
  ];
  for (const [tool, input] of cases) {
    const card = asked(mapApproval(w.ctx, { tool, input }));
    assert.equal(card.checked, false, `${tool} ${JSON.stringify(input)}`);
    assert.equal(card.reply, false, `${tool} ${JSON.stringify(input)}`);
    assert.ok(card.checks.length > 0 && card.card.title !== '', `${tool}: the card says beat did not check it`);
  }
  const hostile = { get file_path(): string { throw new Error('boom'); }, content: 'x' };
  const thrown = asked(mapApproval(w.ctx, { tool: 'Write', input: hostile }));
  assert.deepEqual([thrown.checked, thrown.reply], [false, false], 'a request beat fails to read is asked about, never declined or allowed silently');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(asked(mapApproval(w.ctx, { tool: 'mcp__x__y', input: cyclic })).checked, false);
});

test('札に出す文は、向きを変える文字・制御文字を消し、長いものは切って何文字を出さなかったかを添える', t => {
  const w = world(t);
  const card = asked(mapApproval(w.ctx, { tool: 'Write', input: { file_path: join(w.root, 'a.txt'), content: `${'a'.repeat(9000)}‮\u0007tail` } })).card;
  assert.ok((card.body ?? '').length < 8100, String((card.body ?? '').length));
  assert.match(card.body ?? '', /\[\d+ more characters not shown\]$/u);
  const dirty = asked(mapApproval(w.ctx, { tool: 'Bash', input: { command: 'echo ‮hi\u0007\u001b[31m there' } })).card;
  assert.ok(!/[‮\u0007\u001b]/u.test(dirty.body ?? ''), JSON.stringify(dirty.body));
  const title = asked(mapApproval(w.ctx, { tool: 'Write', input: { file_path: join(w.root, `x${'y'.repeat(800)}.txt`) } })).card.title;
  assert.ok(title.length <= 350 && !title.includes('\n') && /more characters not shown/u.test(title), String(title.length));
});

test('Edit・NotebookEdit・Write の札: 何をどこへ書くかが見える', t => {
  const w = world(t);
  const edit = asked(mapApproval(w.ctx, { tool: 'Edit', input: { file_path: join(w.root, 'a.ts'), old_string: 'before', new_string: 'after', replace_all: true } })).card;
  assert.equal(edit.title, 'Edit a.ts');
  assert.match(edit.body ?? '', /--- old\nbefore\n--- new\nafter/u);
  assert.match(edit.extra ?? '', /replace_all/u);
  const created = asked(mapApproval(w.ctx, { tool: 'Write', input: { file_path: join(w.root, 'n.txt'), content: 'hello' } })).card;
  assert.deepEqual([created.title, created.body], ['Write n.txt', 'hello']);
  const notebook = asked(mapApproval(w.ctx, { tool: 'NotebookEdit', input: { notebook_path: join(w.root, 'n.ipynb'), new_source: 'print(1)', cell_id: 'c1' } })).card;
  assert.equal(notebook.title, 'Edit notebook n.ipynb');
  assert.match(notebook.body ?? '', /print\(1\)/u);
});

// ---- Codex ----

const command = (over: Record<string, unknown> = {}) => ({ kind: 'command', itemId: 'c1', command: 'ls -la', cwd: null as string | null, reason: null, network: null, actions: [], ...over });

test('Codex の求め: 作業フォルダが製品の外・beat 自身へ話しかける・書く先が守りに当たるものは断り、それ以外は持ち主に聞く', t => {
  const w = world(t, { kind: 'codex' });
  const run = (input: unknown, tool = 'commandExecution') => mapApproval(w.ctx, { tool, input });
  assert.equal(refusedWith(run(command({ cwd: w.base }))), 'outside_cwd');
  assert.equal(refusedWith(run(command({ cwd: join(w.root, '..', 'prod2') }))), 'outside_cwd');
  assert.equal(refusedWith(run(command({ cwd: w.root, command: `curl http://127.0.0.1:${w.config.server.port}/api/pending` }))), 'self_target');
  const inside = asked(run(command({ cwd: join(w.root, 'sub'), actions: [{ type: 'listFiles', command: 'ls' }], reason: 'to look' })));
  assert.deepEqual([inside.card.title, inside.card.body, inside.checked, inside.reply], ['Run a command (Codex)', 'ls -la', true, true]);
  assert.match(inside.card.extra ?? '', /to look/u);
  assert.match(inside.card.extra ?? '', /listFiles ls/u);
  assert.equal(asked(run(command({ cwd: null }))).checked, false, 'no working folder: only the owner decides');

  const net = asked(run(command({ cwd: w.root, network: { host: 'example.com', protocol: 'https' } })));
  assert.deepEqual([net.checked, net.reply], [false, false]);
  assert.match(net.card.title, /example\.com/u);
  const stdin = asked(run(command({ kind: 'writeStdin', cwd: w.root })));
  assert.deepEqual([stdin.checked, stdin.reply], [false, false]);

  const change = (path: string, kind = 'update', movePath?: string) => ({ path, kind, ...(movePath ? { movePath } : {}) });
  const files = (changes: unknown, over: Record<string, unknown> = {}) => ({ itemId: 'f1', reason: null, grantRoot: null, changes, ...over });
  assert.equal(refusedWith(run(files([change(join(w.root, '.env'))]), 'fileChange')), 'secret');
  assert.equal(refusedWith(run(files([change(join(w.base, 'out.txt'), 'add')]), 'fileChange')), 'outside_write');
  assert.equal(refusedWith(run(files([change(join(w.root, 'a.txt'), 'update', join(w.base, 'moved.txt'))]), 'fileChange')), 'outside_write', 'the new place of a move is checked too');
  const okFiles = asked(run(files([change('src/a.ts'), change(join(w.root, 'n.ts'), 'add')]), 'fileChange'));
  assert.deepEqual([okFiles.card.title, okFiles.reply, okFiles.checked], ['Change files (Codex)', true, true]);
  assert.match(okFiles.card.body ?? '', /update src\/a\.ts\nadd /u);
  const wide = asked(run(files([change('src/a.ts')], { grantRoot: w.root }), 'fileChange'));
  assert.deepEqual([wide.reply, wide.checked], [false, true], 'a request for a whole folder is never offered as "do not ask again"');
  assert.match(wide.card.extra ?? '', /anywhere under/u);
  assert.equal(refusedWith(run(files([change('src/a.ts')], { grantRoot: w.base }), 'fileChange')), 'outside_write');
  assert.equal(refusedWith(run(files([change('src/a.ts')], { grantRoot: join(w.root, '.ssh') }), 'fileChange')), 'secret');
  assert.equal(refusedWith(run(files([change('src/a.ts')], { grantRoot: w.paths.data }), 'fileChange')), 'outside_write');
  assert.equal(refusedWith(run(files([change('src/a.ts')], { grantRoot: join(w.paths.data, 'reference') }), 'fileChange')), 'readonly_root');
  assert.equal(asked(run(files(null), 'fileChange')).checked, false, 'paths unknown: the owner decides');

  const perm = asked(run({ permissions: { network: { enabled: true } }, cwd: w.root, reason: 'need net' }, 'permissions'));
  assert.deepEqual([perm.checked, perm.reply], [false, false]);
  assert.match(perm.card.body ?? '', /network/u);
  assert.equal(asked(run({ anything: 1 }, 'somethingNew')).checked, false);
  assert.equal(asked(run('text', 'commandExecution')).checked, false);
});
