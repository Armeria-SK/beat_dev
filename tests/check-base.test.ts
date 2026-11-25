import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  DIRTY_FILE_MAX, DIRTY_PATH_MAX, SCRIPTS_MAX, captureBase, compareBase, isBasePrint,
  type BaseComparison, type BasePrint, type CheckBase,
} from '../src/projects/check-base.ts';
import { SNAPSHOT_TIMEOUT_MS } from '../src/projects/snapshot-before.ts';
import { removeDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'p', scripts, ...extra }, null, 2);

function scratch(t: TestContext): string {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'tmp', 'check-base-'));
  t.after(() => removeDir(dir));
  return realpathSync.native(dir);
}

interface Repo { dir: string; data: string; git: (...args: string[]) => string; write: (rel: string, body: string | Buffer) => void; read: (rel: string) => string; remove: (rel: string) => void }

function folder(t: TestContext, init: boolean, files: Record<string, string> = {}): Repo {
  const dir = scratch(t);
  const data = scratch(t);
  const git = (...args: string[]): string => {
    const out = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
    return out.stdout.trim();
  };
  const write = (rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };
  const repo: Repo = { dir, data, git, write, read: rel => readFileSync(join(dir, rel), 'utf8'), remove: rel => rmSync(join(dir, rel), { recursive: true, force: true }) };
  if (init) git('init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) write(rel, body);
  return repo;
}

const PRODUCT = { 'package.json': pkg({ test: 'node --test tests/', build: 'tsc' }), 'tsconfig.json': '{}\n', '.npmrc': 'a=b\n', '.gitignore': 'node_modules/\nignored.log\n', 'tests/a.test.ts': 'a\n', 'tests/b.test.ts': 'b\n', 'src/a.ts': 'x\n' };

function product(t: TestContext, files: Record<string, string> = {}): Repo {
  const repo = folder(t, true, { ...PRODUCT, ...files });
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'init');
  return repo;
}

async function base(repo: Repo): Promise<BasePrint> {
  const print = await captureBase(repo.dir, repo.data);
  assert.ok(isBasePrint(print), JSON.stringify(print));
  return print as BasePrint;
}

const compare = (print: CheckBase, repo: Repo): Promise<BaseComparison> => compareBase(print, repo.dir, repo.data);

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { out[`${relative(root, abs)}/`] = String(statSync(abs).mtimeMs); walk(abs); }
      else out[relative(root, abs)] = `${statSync(abs).size}:${statSync(abs).mtimeMs}:${sha(readFileSync(abs))}`;
    }
  };
  walk(root);
  return out;
}

test('base 中身: 見つけた確かめ・scripts・guards のハッシュ・HEAD・dirty・時刻を控える。package.json は guards のハッシュに入れない', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  const head = repo.git('rev-parse', 'HEAD');
  assert.deepEqual(print.checks.commands.map(c => c.command), ['npm run build', 'npm run test']);
  assert.deepEqual(print.scripts, { test: 'node --test tests/', build: 'tsc' });
  assert.deepEqual(print.guards, { '.npmrc': sha('a=b\n'), 'tsconfig.json': sha('{}\n') });
  assert.deepEqual(print.git, { head, dirty: {} });
  assert.equal(typeof print.at, 'number');
  assert.ok(Math.abs(Date.now() - print.at) < 60_000);
});

test('base 中身: JSON に書いて読み戻しても同じ。壊れた形は isBasePrint が断る', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  repo.write('new.txt', 'n');
  const print = await base(repo);
  const again = JSON.parse(JSON.stringify(print)) as unknown;
  assert.deepEqual(again, print);
  assert.ok(isBasePrint(again));
  assert.equal(isBasePrint({ unavailable: true }), false);
  for (const bad of [null, undefined, 'x', 5, [], {}, { ...print, git: 3 }, { ...print, guards: [] }, { ...print, checks: null }, { ...print, at: 'now' }, { ...print, scripts: 3 }, { ...print, git: { head: 1, dirty: {} } }]) {
    assert.equal(isBasePrint(bad), false, JSON.stringify(bad));
  }
});

test('base git でない製品: git は null。scripts と guards は控える', async t => {
  const repo = folder(t, false, { 'package.json': pkg({ test: 'x' }), 'tsconfig.json': '{}' });
  const print = await base(repo);
  assert.equal(print.git, null);
  assert.deepEqual(print.scripts, { test: 'x' });
  assert.deepEqual(print.guards, { 'tsconfig.json': sha('{}') });
  assert.equal((await base(folder(t, false))).scripts, null);
});

test('base コミットの無い git: head は null で、追っていない物が dirty に入る', { skip: !gitAvailable }, async t => {
  const repo = folder(t, true, { 'package.json': pkg({ test: 'x' }), 'a.txt': 'a' });
  const print = await base(repo);
  assert.equal(print.git?.head, null);
  assert.deepEqual(print.git?.dirty, { 'a.txt': sha('a'), 'package.json': sha(pkg({ test: 'x' })) });
});

test('base dirty: 変えた・消した・追っていない・段に上げただけ・入れ子・無視した物の扱い。値は中身の sha256 か deleted', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  repo.write('src/a.ts', 'changed\n');
  repo.remove('tests/b.test.ts');
  repo.write('new/deep/c.ts', 'c\n');
  repo.write('staged.txt', 's\n');
  repo.git('add', 'staged.txt');
  repo.write('ignored.log', 'ignored\n');
  mkdirSync(join(repo.dir, 'node_modules'), { recursive: true });
  repo.write('node_modules/x.js', 'x');
  const print = await base(repo);
  assert.deepEqual(print.git?.dirty, {
    'new/deep/c.ts': sha('c\n'),
    'src/a.ts': sha('changed\n'),
    'staged.txt': sha('s\n'),
    'tests/b.test.ts': 'deleted',
  });
});

test('base dirty: git mv の改名は、新しい名前の中身と古い名前の deleted の 2 つで控える', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  repo.git('mv', 'src/a.ts', 'src/moved.ts');
  assert.deepEqual((await base(repo)).git?.dirty, { 'src/a.ts': 'deleted', 'src/moved.ts': sha('x\n') });
});

test('base dirty: __proto__ という名前のファイルも落とさず、変えれば変わったと分かる', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  repo.write('__proto__', 'one');
  const print = await base(repo);
  assert.ok(Object.hasOwn(print.git!.dirty as Record<string, string>, '__proto__'));
  assert.equal((print.git!.dirty as Record<string, string>)['__proto__'], sha('one'));
  const parsed = JSON.parse(JSON.stringify(print)) as BasePrint;
  assert.equal((await compare(parsed, repo)).unchanged, true);
  repo.write('__proto__', 'two');
  assert.equal((await compare(parsed, repo)).unchanged, false);
});

test('base 上限: dirty は 2000 パスまで・1 ファイル 1MB まで。超えたら dirty: over', { skip: !gitAvailable }, async t => {
  assert.equal(DIRTY_PATH_MAX, 2000);
  assert.equal(DIRTY_FILE_MAX, 1024 * 1024);
  const repo = product(t);
  for (let i = 0; i < DIRTY_PATH_MAX; i++) repo.write(`many/${String(i).padStart(4, '0')}.txt`, `${i}`);
  const exact = await base(repo);
  assert.equal(Object.keys(exact.git!.dirty as Record<string, string>).length, DIRTY_PATH_MAX);
  repo.write('many/extra.txt', 'x');
  assert.equal((await base(repo)).git?.dirty, 'over');
  repo.remove('many');
  repo.write('big.bin', Buffer.alloc(DIRTY_FILE_MAX, 1));
  const edge = await base(repo);
  assert.equal((edge.git!.dirty as Record<string, string>)['big.bin'], sha(Buffer.alloc(DIRTY_FILE_MAX, 1)));
  repo.write('big.bin', Buffer.alloc(DIRTY_FILE_MAX + 1, 1));
  assert.equal((await base(repo)).git?.dirty, 'over');
});

test('base 上限: package.json の scripts が 64KB を超えたら scripts: over', { skip: !gitAvailable }, async t => {
  assert.equal(SCRIPTS_MAX, 64 * 1024);
  const small = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, 'x'.repeat(100)]));
  assert.deepEqual((await base(product(t, { 'package.json': pkg({ test: 'x', ...small }) }))).scripts, { test: 'x', ...small });
  const huge = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`s${i}`, 'x'.repeat(100)]));
  assert.equal((await base(product(t, { 'package.json': pkg({ test: 'x', ...huge }) }))).scripts, 'over');
});

test('base 控えられない: 時間切れ・git が使えない・フォルダが無いときは unavailable を返し、投げない', { skip: !gitAvailable }, async t => {
  assert.equal(SNAPSHOT_TIMEOUT_MS, 30_000);
  const repo = product(t);
  assert.deepEqual(await captureBase(repo.dir, repo.data, { timeoutMs: 0 }), { unavailable: true });
  assert.deepEqual(await captureBase(join(repo.dir, 'missing'), repo.data), { unavailable: true });
  const broken = folder(t, false, { 'package.json': pkg({ test: 'x' }) });
  mkdirSync(join(broken.dir, '.git'));
  assert.deepEqual(await captureBase(broken.dir, broken.data), { unavailable: true });
});

test('base 製品の .git に何も書かない: 控えも比べも、index が古くても .git の中身・更新時刻が変わらない', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const stale = new Date(Date.now() + 10_000);
  for (const rel of ['src/a.ts', 'package.json', 'tests/a.test.ts']) utimesSync(join(repo.dir, rel), stale, stale);
  repo.write('untracked.txt', 'u');
  const before = tree(join(repo.dir, '.git'));
  const print = await captureBase(repo.dir, repo.data);
  assert.ok(isBasePrint(print));
  repo.remove('tests/b.test.ts');
  await compare(print, repo);
  const after = tree(join(repo.dir, '.git'));
  assert.deepEqual(after, before);
  const index = readFileSync(join(repo.dir, '.git', 'index'));
  repo.git('status');
  assert.notDeepEqual(readFileSync(join(repo.dir, '.git', 'index')), index, 'precondition: a plain git status rewrites the stale index, so the assertion above can fail');
});

test('base リンクをたどらない: 製品の外を指すリンクの先の中身は読まず、先が変わっても控えは変わらない', { skip: !gitAvailable }, async t => {
  const outside = scratch(t);
  writeFileSync(join(outside, 'secret.txt'), 'outside-one');
  const repo = product(t);
  symlinkSync(outside, join(repo.dir, 'link'), 'junction');
  symlinkSync(outside, join(repo.dir, 'vite.config.ts'), 'junction');
  const first = await base(repo);
  const seen = JSON.stringify(first);
  assert.ok(!seen.includes(sha('outside-one')), 'the outside file was hashed');
  assert.match(first.guards['vite.config.ts'] ?? '', /^link:/u);
  writeFileSync(join(outside, 'secret.txt'), 'outside-two');
  const second = await base(repo);
  assert.deepEqual({ ...second, at: 0 }, { ...first, at: 0 });
  const result = await compare(first, repo);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.tampering, []);
});

test('compare 何も変えない: unchanged は true、改ざんなし、確かめられた。更新時刻・同じ中身の書き直しは変更に数えない', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo.dir, 'src/a.ts'), later, later);
  repo.write('tsconfig.json', '{}\n');
  repo.write('tests/a.test.ts', 'a\n');
  const result = await compare(print, repo);
  assert.deepEqual(result, { unchanged: true, tampering: [], tamperingMore: 0, verified: true });
});

test('compare V2: 始めから未コミットの変更（package.json の scripts.test など）は、中身が同じなら数えない。別のファイルを変えると unchanged は false', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  repo.write('package.json', pkg({ test: 'node --test', build: 'tsc', extra: 'x' }));
  repo.write('tsconfig.json', '{"strict":true}\n');
  repo.write('tests/a.test.ts', 'edited before the task\n');
  repo.write('untracked-config.ini', 'x');
  const print = await base(repo);
  const none = await compare(print, repo);
  assert.deepEqual(none, { unchanged: true, tampering: [], tamperingMore: 0, verified: true });
  repo.write('src/feature.ts', 'new feature\n');
  repo.write('src/a.ts', 'changed by the task\n');
  const result = await compare(print, repo);
  assert.equal(result.unchanged, false);
  assert.deepEqual(result.tampering, []);
  assert.equal(result.verified, true);
});

test('compare unchanged は時刻でなく中身で決める: 中身を変えて更新時刻を戻しても changed。追加・削除・コミットも changed', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  const original = statSync(join(repo.dir, 'src/a.ts'));
  repo.write('src/a.ts', 'yy\n');
  utimesSync(join(repo.dir, 'src/a.ts'), original.atime, original.mtime);
  assert.equal((await compare(print, repo)).unchanged, false);
  repo.write('src/a.ts', 'x\n');
  assert.equal((await compare(print, repo)).unchanged, true);
  repo.write('added.txt', 'a');
  assert.equal((await compare(print, repo)).unchanged, false);
  repo.remove('added.txt');
  repo.remove('src/a.ts');
  assert.equal((await compare(print, repo)).unchanged, false);
  repo.write('src/a.ts', 'x\n');
  assert.equal((await compare(print, repo)).unchanged, true);
  repo.git('commit', '-q', '--allow-empty', '-m', 'empty');
  assert.equal((await compare(print, repo)).unchanged, false, 'HEAD moved');
});

test('compare unchanged: git が無視するファイルだけの変更は、変更に数えない（R6）', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  repo.write('ignored.log', 'noise');
  repo.write('node_modules/x/index.js', 'x');
  assert.equal((await compare(print, repo)).unchanged, true);
});

test('compare unchanged: 控えが git でない・dirty が over・今が over のときは判断せず（null / false）、確かめは verified: false', { skip: !gitAvailable }, async t => {
  const plain = folder(t, false, { 'package.json': pkg({ test: 'x' }) });
  const plainPrint = await base(plain);
  assert.equal((await compare(plainPrint, plain)).unchanged, null);
  const repo = product(t);
  const print = await base(repo);
  const over: BasePrint = { ...print, git: { head: print.git!.head, dirty: 'over' } };
  const overResult = await compare(over, repo);
  assert.equal(overResult.unchanged, null);
  assert.equal(overResult.verified, false);
  assert.equal(overResult.unverified, 'over');
  repo.write('big.bin', Buffer.alloc(DIRTY_FILE_MAX + 1, 1));
  assert.equal((await compare(print, repo)).unchanged, false);
});

test('compare V5: scripts の変更（親玉の script を足す・test を書き換える・test が呼ぶ script を書き換える）を、命令の列と script 名で返す', { skip: !gitAvailable }, async t => {
  const onlyTest = product(t, { 'package.json': pkg({ test: 'node --test' }) });
  const print = await base(onlyTest);
  onlyTest.write('package.json', pkg({ test: 'node --test', check: 'exit 0' }));
  const added = await compare(print, onlyTest);
  assert.deepEqual(added.tampering, [
    { kind: 'commands', before: ['npm run test'], after: ['npm run check'] },
    { kind: 'script', name: 'check' },
  ]);
  assert.equal(added.verified, true);

  const rewrite = product(t, { 'package.json': pkg({ test: 'node --test', build: 'tsc' }) });
  const rewritePrint = await base(rewrite);
  rewrite.write('package.json', pkg({ test: 'exit 0', build: 'tsc' }));
  assert.deepEqual((await compare(rewritePrint, rewrite)).tampering, [{ kind: 'script', name: 'test' }]);

  const nested = product(t, { 'package.json': pkg({ test: 'npm run unit', unit: 'node --test' }) });
  const nestedPrint = await base(nested);
  nested.write('package.json', pkg({ test: 'npm run unit', unit: 'exit 0' }));
  assert.deepEqual((await compare(nestedPrint, nested)).tampering, [{ kind: 'script', name: 'unit' }]);

  const pre = product(t, { 'package.json': pkg({ test: 'node --test' }) });
  const prePrint = await base(pre);
  pre.write('package.json', pkg({ test: 'node --test', pretest: 'exit 0' }));
  assert.deepEqual((await compare(prePrint, pre)).tampering, [{ kind: 'script', name: 'pretest' }]);
});

test('compare scripts: 確かめに届かない script・dependencies だけの変更は改ざんに数えない', { skip: !gitAvailable }, async t => {
  const repo = product(t, { 'package.json': pkg({ test: 'node --test', dev: 'vite' }) });
  mkdirSync(join(repo.dir, 'node_modules'));
  const print = await base(repo);
  repo.write('package.json', pkg({ test: 'node --test', dev: 'vite --host' }, { dependencies: { left: '1' } }));
  const result = await compare(print, repo);
  assert.deepEqual(result.tampering, []);
  assert.equal(result.unchanged, false);
});

test('compare V3: guards の変更（設定を書き換える・追っていない新しい設定を作る・消す）を返す。中身が同じなら返さない', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  repo.write('tsconfig.json', '{"compilerOptions":{"noCheck":true}}\n');
  repo.write('vitest.config.ts', 'export default {};\n');
  repo.remove('.npmrc');
  const result = await compare(print, repo);
  assert.deepEqual(result.tampering, [
    { kind: 'guard', path: '.npmrc' },
    { kind: 'guard', path: 'tsconfig.json' },
    { kind: 'guard', path: 'vitest.config.ts' },
  ]);
  assert.equal(result.verified, true);
});

test('compare guards: 控えのあとで足した設定が git に追われていなくても見つける（git add しない新しいファイル）', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  repo.write('eslint.config.mjs', 'export default [];\n');
  assert.deepEqual((await compare(print, repo)).tampering, [{ kind: 'guard', path: 'eslint.config.mjs' }]);
  assert.equal(repo.git('status', '--porcelain', '--', 'eslint.config.mjs'), '?? eslint.config.mjs');
});

test('compare V4: 試験のファイルの消去（消しただけ・コミットした・日付を偽ってコミットした・試験の外へ改名）を、控えの HEAD からの差で見つける', { skip: !gitAvailable }, async t => {
  const plain = product(t);
  const plainPrint = await base(plain);
  plain.remove('tests/a.test.ts');
  assert.deepEqual((await compare(plainPrint, plain)).tampering, [{ kind: 'test_removed', path: 'tests/a.test.ts' }]);

  const committed = product(t);
  const committedPrint = await base(committed);
  committed.remove('tests/a.test.ts');
  committed.git('add', '-A');
  const old = '2000-01-01T00:00:00';
  const out = spawnSync('git', ['commit', '-q', '-m', 'old'], { cwd: committed.dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  assert.equal(out.status, 0, out.stderr);
  assert.notEqual(committed.git('rev-parse', 'HEAD'), (committedPrint.git as { head: string }).head);
  assert.deepEqual((await compare(committedPrint, committed)).tampering, [{ kind: 'test_removed', path: 'tests/a.test.ts' }]);

  const moved = product(t);
  const movedPrint = await base(moved);
  moved.git('mv', 'tests/a.test.ts', 'src/a-renamed.ts');
  assert.deepEqual((await compare(movedPrint, moved)).tampering, [{ kind: 'test_removed', path: 'tests/a.test.ts' }]);

  const within = product(t);
  const withinPrint = await base(within);
  within.git('mv', 'tests/a.test.ts', 'tests/renamed.test.ts');
  assert.deepEqual((await compare(withinPrint, within)).tampering, []);
});

test('compare 試験の消去: 始めに消えていた物・試験でない物・追加は数えない。始めに追っていなかった試験が今無いのは数える', { skip: !gitAvailable }, async t => {
  const goneAtStart = product(t);
  goneAtStart.remove('tests/b.test.ts');
  const startPrint = await base(goneAtStart);
  goneAtStart.write('src/other.ts', 'o');
  assert.deepEqual((await compare(startPrint, goneAtStart)).tampering, []);

  const nonTest = product(t);
  const nonTestPrint = await base(nonTest);
  nonTest.remove('src/a.ts');
  nonTest.write('tests/c.test.ts', 'c');
  assert.deepEqual((await compare(nonTestPrint, nonTest)).tampering, []);

  const untracked = product(t, {});
  untracked.write('tests/draft.test.ts', 'draft');
  const draftPrint = await base(untracked);
  assert.equal((draftPrint.git!.dirty as Record<string, string>)['tests/draft.test.ts'], sha('draft'));
  untracked.remove('tests/draft.test.ts');
  assert.deepEqual((await compare(draftPrint, untracked)).tampering, [{ kind: 'test_removed', path: 'tests/draft.test.ts' }]);
});

test('compare 始めに依存が無かった（blocked）作業コピー: 依存を入れたあとの命令の列の違いは改ざんに数えない。scripts の書き換えは数える', { skip: !gitAvailable }, async t => {
  const repo = product(t, { 'package.json': pkg({ test: 'node --test' }, { dependencies: { left: '1' } }) });
  const print = await base(repo);
  assert.ok(print.checks.blocked);
  assert.deepEqual(print.checks.commands, []);
  mkdirSync(join(repo.dir, 'node_modules'));
  repo.write('node_modules/left.js', 'x');
  assert.deepEqual((await compare(print, repo)).tampering, []);
  repo.write('package.json', pkg({ test: 'exit 0' }, { dependencies: { left: '1' } }));
  assert.deepEqual((await compare(print, repo)).tampering, [{ kind: 'script', name: 'test' }]);
});

test('compare 始めに確かめが何も無かった製品: 命令が新しく現れたら（package.json を作る）改ざんとして返す', { skip: !gitAvailable }, async t => {
  const repo = folder(t, true, { 'index.html': '<p>hi</p>' });
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'init');
  const print = await base(repo);
  assert.deepEqual(print.checks.commands, []);
  repo.write('package.json', pkg({ test: 'exit 0' }));
  const result = await compare(print, repo);
  assert.deepEqual(result.tampering, [
    { kind: 'commands', before: [], after: ['npm run test'] },
    { kind: 'script', name: 'test' },
  ]);
});

test('compare V6 前半: git でない製品でも scripts・guards の書き換えは返す。unchanged は null', async t => {
  const repo = folder(t, false, { 'package.json': pkg({ test: 'node --test' }), 'tsconfig.json': '{}' });
  const print = await base(repo);
  assert.deepEqual(await compare(print, repo), { unchanged: null, tampering: [], tamperingMore: 0, verified: true });
  repo.write('package.json', pkg({ test: 'exit 0' }));
  repo.write('tsconfig.json', '{"a":1}');
  const result = await compare(print, repo);
  assert.equal(result.unchanged, null);
  assert.deepEqual(result.tampering, [{ kind: 'script', name: 'test' }, { kind: 'guard', path: 'tsconfig.json' }]);
});

test('compare 控えが無い・壊れている・unavailable・今の控えが取れない: 何も断定せず verified: false と理由', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  const expect = async (given: unknown, why: string): Promise<void> => {
    const result = await compare(given as CheckBase, repo);
    assert.deepEqual(result, { unchanged: null, tampering: [], tamperingMore: 0, verified: false, unverified: why });
  };
  await expect(null, 'no_base');
  await expect(undefined, 'no_base');
  await expect({}, 'no_base');
  await expect({ ...print, git: 'x' }, 'no_base');
  await expect({ unavailable: true }, 'unavailable');
  const stale = await compareBase(print, repo.dir, repo.data, { timeoutMs: 0 });
  assert.deepEqual(stale, { unchanged: null, tampering: [], tamperingMore: 0, verified: false, unverified: 'now_unavailable' });
  const scriptsOver: BasePrint = { ...print, scripts: 'over' };
  const over = await compare(scriptsOver, repo);
  assert.equal(over.verified, false);
  assert.equal(over.unverified, 'over');
});

test('compare 控えの HEAD が消えている・.git が無くなった: 試験の消去を確かめられず verified: false（git）', { skip: !gitAvailable }, async t => {
  const repo = product(t);
  const print = await base(repo);
  const lost: BasePrint = { ...print, git: { head: '0'.repeat(40), dirty: {} } };
  const result = await compare(lost, repo);
  assert.equal(result.verified, false);
  assert.equal(result.unverified, 'git');
  const gone = product(t);
  const gonePrint = await base(gone);
  gone.remove('.git');
  const noGit = await compare(gonePrint, gone);
  assert.equal(noGit.verified, false);
  assert.equal(noGit.unverified, 'git');
  assert.equal(noGit.unchanged, null);
});

test('compare 改ざんの一覧は 50 件まで。超えた分は tamperingMore に数える', { skip: !gitAvailable }, async t => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) files[`tests/t${String(i).padStart(2, '0')}.test.ts`] = `${i}`;
  const repo = product(t, files);
  const print = await base(repo);
  for (let i = 0; i < 60; i++) repo.remove(`tests/t${String(i).padStart(2, '0')}.test.ts`);
  const result = await compare(print, repo);
  assert.equal(result.tampering.length, 50);
  assert.equal(result.tamperingMore, 10);
});
