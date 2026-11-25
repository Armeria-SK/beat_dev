import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { changedFromGit, ImportGraph, TEST_GLOB } from '../scripts/affected-tests.ts';
import { tempDir } from './helpers.ts';

const FILES: Record<string, string> = {
  'package.json': '{}',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a.ts';\nexport const b = a;\n",
  'src/c.ts': "export { d } from './d';\nexport * from './dir';\n",
  'src/d.ts': 'export const d = 1;\n',
  'src/dir/index.ts': 'export const inDir = 1;\n',
  'src/e.ts': "export const load = async () => (await import('./lazy.ts')).x;\nexport const req = () => require('./req.js');\n",
  'src/lazy.ts': 'export const x = 1;\n',
  'src/req.ts': 'export const r = 1;\n',
  'src/scan/one.ts': 'export {};\n',
  'src/unrelated.ts': 'export const nobody = 1;\n',
  'web/src/A.tsx': "import { bee } from './B.ts';\nexport const A = () => bee;\n",
  'web/src/B.ts': 'export const bee = 1;\n',
  'tests/helpers/h.ts': 'export const h = 1;\n',
  'tests/helpers/tsx-loader.mjs': '',
  'tests/b.test.ts': "import { b } from '../src/b.ts';\nvoid b;\n",
  'tests/c.test.ts': "import { d } from '../src/c.ts';\nvoid d;\n",
  'tests/e.test.ts': "import { load } from '../src/e.ts';\nvoid load;\n",
  'tests/scan.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync(new URL('../src/scan/', import.meta.url));\n",
  'tests/ui.test.ts': "declare const loadTsx: (p: string, from: string) => Promise<unknown>;\nawait loadTsx('../web/src/A.tsx', import.meta.url);\n",
  'tests/gone.test.ts': "import '../src/gone.ts';\n",
};

function tree(t: Parameters<typeof tempDir>[0], extra: Record<string, string> = {}): string {
  const root = tempDir(t);
  for (const [file, text] of Object.entries({ ...FILES, ...extra })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

test('a change deep in the imports picks only the tests that reach it', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/a.ts']).tests, ['tests/b.test.ts']);
  assert.deepEqual(graph.pick(['src/b.ts']).tests, ['tests/b.test.ts']);
});

test('re-exports are followed, extensionless and through index files', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/d.ts']).tests, ['tests/c.test.ts']);
  assert.deepEqual(graph.pick(['src/dir/index.ts']).tests, ['tests/c.test.ts']);
});

test('import() and require() with a string literal are followed, .js resolving to .ts', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/lazy.ts']).tests, ['tests/e.test.ts']);
  assert.deepEqual(graph.pick(['src/req.ts']).tests, ['tests/e.test.ts']);
});

test('a changed test file picks itself', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['tests/c.test.ts']).tests, ['tests/c.test.ts']);
});

test('changes that cannot be placed in the graph pick every test, with the reason', t => {
  const graph = new ImportGraph(tree(t));
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'tests/helpers/h.ts', 'tests/helpers/tsx-loader.mjs', 'tests/helpers/notes.md', 'web/src/icon.svg', 'src/data.json', 'tests/fixtures/page.html', 'deploy/x.ts', 'README.md']) {
    const pick = graph.pick([file, 'src/unrelated.ts']);
    assert.deepEqual(pick.tests, graph.tests, file);
    assert.equal(pick.all.length, 1, file);
    assert.ok(pick.all[0]!.startsWith(`${file}: `), file);
  }
});

test('a change nothing reaches picks no test', t => {
  const graph = new ImportGraph(tree(t));
  const pick = graph.pick(['src/unrelated.ts']);
  assert.deepEqual(pick.tests, []);
  assert.deepEqual(pick.all, []);
  assert.deepEqual(graph.pick([]).tests, []);
});

// .css / .md は、コードから読まれていれば、その読み方（import・path の文字列・読むフォルダ）が分かるので、コードと同じにグラフで選ぶ。
// どのコードにも名前が出ない物は、どの試験も読まないので、選ぶ試験は無い。名前がグラフの追えない形で出る物だけ、全部を選ぶ。
test('どのコードにも名前が出ない .css / .md は、試験を 1 つも選ばない（全部を選ぶ理由にならない）', t => {
  const graph = new ImportGraph(tree(t, { 'web/src/ui/styles/lonely.css': 'a { color: red; }\n', 'src/notes.md': '# notes\n', 'scripts/guide.md': 'guide\n', 'tests/fixtures/note.md': 'x\n' }));
  for (const file of ['web/src/ui/styles/lonely.css', 'src/notes.md', 'scripts/guide.md', 'tests/fixtures/note.md']) {
    const pick = graph.pick([file, 'src/unrelated.ts']);
    assert.deepEqual(pick.all, [], file);
    assert.deepEqual(pick.tests, [], file);
  }
});

test('コードが import している .css は、それを読み込むモジュールに届く試験だけを選ぶ。消した .css でも同じ', t => {
  const graph = new ImportGraph(tree(t, {
    'web/src/style.css': 'a {}\n',
    'web/src/A.tsx': "import './style.css';\nimport './gone.css';\nimport { bee } from './B.ts';\nexport const A = () => bee;\n",
  }));
  for (const file of ['web/src/style.css', 'web/src/gone.css']) {
    const pick = graph.pick([file]);
    assert.deepEqual(pick.all, [], file);
    assert.deepEqual(pick.tests, ['tests/ui.test.ts'], file);
  }
});

test('試験が path の文字列や読むフォルダで読む .md は、その試験を選ぶ', t => {
  const graph = new ImportGraph(tree(t, {
    'src/docs/guide.md': 'x\n',
    'src/scan/note.md': 'x\n',
    'tests/lit.test.ts': "import { readFileSync } from 'node:fs';\nreadFileSync('src/docs/guide.md');\n",
  }));
  assert.deepEqual(graph.pick(['src/docs/guide.md']).tests, ['tests/lit.test.ts']);
  assert.deepEqual(graph.pick(['src/scan/note.md']).tests, ['tests/scan.test.ts']);
  assert.deepEqual(graph.pick(['src/scan/note.md']).all, []);
});

test('名前がグラフの追えない形で出る .css / .md は、全部を選び、どのコードかを理由に書く', t => {
  const graph = new ImportGraph(tree(t, {
    'src/notes.md': 'x\n',
    'src/reader.ts': "import { join } from 'node:path';\nexport const notes = (dir: string): string => join(dir, 'notes.md');\n",
    'tests/reader.test.ts': "import '../src/reader.ts';\n",
    'web/src/ui/other/dup.css': 'a {}\n',
    'web/src/ui/main.ts': "import './styles/dup.css';\n",
    'tests/main.test.ts': "import '../web/src/ui/main.ts';\n",
  }));
  const named = graph.pick(['src/notes.md', 'src/unrelated.ts']);
  assert.deepEqual(named.tests, graph.tests);
  assert.equal(named.all.length, 1);
  assert.match(named.all[0]!, /^src\/notes\.md: .*src\/reader\.ts/u);
  // 同じ名前の別の .css を読む import があっても、どちらの .css か決められないので全部を選ぶ
  const same = graph.pick(['web/src/ui/other/dup.css']);
  assert.deepEqual(same.tests, graph.tests);
  assert.match(same.all[0]!, /^web\/src\/ui\/other\/dup\.css: .*web\/src\/ui\/main\.ts/u);
});

const READER_TEST = "import '../src/reader.ts';\n";

function selects(graph: ImportGraph, file: string, test: string): { by: 'selected' | 'all'; all: string[] } {
  const pick = graph.pick([file]);
  assert.ok(pick.tests.includes(test), `${file} must pick ${test}`);
  return { by: pick.all.length > 0 ? 'all' : 'selected', all: pick.all };
}

test('a .md read by non-test code that scans a folder from APP_ROOT is picked up (selected or a full run)', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/prompts/system.md': '# system\n',
    'src/reader.ts': "import { readdirSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { APP_ROOT } from './paths.ts';\nexport const all = () => readdirSync(join(APP_ROOT, 'src', 'prompts')).filter(f => f.endsWith('.md'));\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(graph, 'src/prompts/system.md', 'tests/reader.test.ts');
  const variable = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/prompts/system.md': '# system\n',
    'src/reader.ts': "import { readdirSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { APP_ROOT } from './paths.ts';\nexport const all = (dir: string) => readdirSync(join(APP_ROOT, dir)).filter(f => f.endsWith('.md'));\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(variable, 'src/prompts/system.md', 'tests/reader.test.ts');
});

test('a .md whose name non-test code builds in a template literal under APP_ROOT is picked up', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/prompts/system.md': '# system\n',
    'src/reader.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { APP_ROOT } from './paths.ts';\nexport const one = (name: string) => readFileSync(join(APP_ROOT, 'src', 'prompts', `${name}.md`), 'utf8');\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(graph, 'src/prompts/system.md', 'tests/reader.test.ts');
});

test('a .md that non-test code reads by string concatenation from a cwd-relative path is picked up', t => {
  const graph = new ImportGraph(tree(t, {
    'src/prompts/system.md': '# system\n',
    'src/reader.ts': "import { readFileSync } from 'node:fs';\nexport const one = (name: string) => readFileSync('src/prompts/' + name + '.md', 'utf8');\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(graph, 'src/prompts/system.md', 'tests/reader.test.ts');
  const piecewise = new ImportGraph(tree(t, {
    'src/prompts/system.md': '# system\n',
    'src/reader.ts': "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport const one = (name: string) => readFileSync(join('src', 'prompts', name + '.md'), 'utf8');\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(piecewise, 'src/prompts/system.md', 'tests/reader.test.ts');
});

test('a .md next to a script that a test spawns, which finds its folder from APP_ROOT, is picked up', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'scripts/bench/NOTES.md': 'notes\n',
    'scripts/bench/README.md': 'readme\n',
    'scripts/bench/run.ts': "import { readdirSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { APP_ROOT } from '../../src/paths.ts';\nconst HERE = join(APP_ROOT, 'scripts', 'bench');\nexport const docs = readdirSync(HERE).filter(f => f.endsWith('.md'));\nexport const readme = () => readFileSync(join(HERE, 'README.md'), 'utf8');\n",
    'tests/bench.test.ts': "import { spawnSync } from 'node:child_process';\nspawnSync(process.execPath, ['scripts/bench/run.ts']);\n",
  }));
  selects(graph, 'scripts/bench/NOTES.md', 'tests/bench.test.ts');
  const named = selects(graph, 'scripts/bench/README.md', 'tests/bench.test.ts');
  assert.equal(named.by, 'all', 'a name the script spells out but cannot be followed is a full run');
});

test('a .css or .md that a non-code file names (CSS @import, .json, .html) is a full run, with that file in the reason', t => {
  const graph = new ImportGraph(tree(t, {
    'web/src/ui/styles/main.css': "@import './part.css';\n",
    'web/src/ui/styles/part.css': 'a {}\n',
    'web/src/ui/styles/page.css': 'a {}\n',
    'src/docs/guide.md': '# guide\n',
    'web/src/Main.tsx': "import './ui/styles/main.css';\nexport const Main = () => null;\n",
    'src/manifest.json': '{ "docs": ["docs/guide.md"] }\n',
    'web/index.html': '<link rel="stylesheet" href="/src/ui/styles/page.css">\n',
    'tests/main.test.ts': "import '../web/src/Main.tsx';\n",
  }));
  for (const [file, by] of [['web/src/ui/styles/part.css', 'web/src/ui/styles/main.css'], ['src/docs/guide.md', 'src/manifest.json'], ['web/src/ui/styles/page.css', 'web/index.html']] as const) {
    const pick = graph.pick([file]);
    assert.deepEqual(pick.tests, graph.tests, file);
    assert.equal(pick.all.length, 1, file);
    assert.ok(pick.all[0]!.startsWith(`${file}: `) && pick.all[0]!.includes(by), pick.all[0]);
  }
});

test('code that holds a repo root but never reads .css or .md does not widen the pick of an unreferenced .css', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/consumer.ts': "import { APP_ROOT } from './paths.ts';\nexport const where = () => ({ appRoot: APP_ROOT, cwd: process.cwd() });\n",
    'tests/consumer.test.ts': "import '../src/consumer.ts';\n",
    'web/src/ui/styles/lonely.css': 'a {}\n',
  }));
  const pick = graph.pick(['web/src/ui/styles/lonely.css']);
  assert.deepEqual(pick.all, []);
  assert.deepEqual(pick.tests, []);
});

test('a repo root handed as an argument to a function in another file that lists .md files picks the tests that reach it', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/prompts/system.md': '# system\n',
    'src/lib.ts': "import { readdirSync } from 'node:fs';\nexport const scan = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.md'));\n",
    'src/reader.ts': "import { APP_ROOT } from './paths.ts';\nimport { scan } from './lib.ts';\nexport const all = () => scan(APP_ROOT + '/src/prompts');\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  selects(graph, 'src/prompts/system.md', 'tests/reader.test.ts');
  const plain = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'src/prompts/system.md': '# system\n',
    'src/lib.ts': "export const show = (dir: string) => dir.length;\n",
    'src/reader.ts': "import { APP_ROOT } from './paths.ts';\nimport { show } from './lib.ts';\nexport const all = () => show(APP_ROOT);\n",
    'tests/reader.test.ts': READER_TEST,
  }));
  const pick = plain.pick(['src/prompts/system.md']);
  assert.deepEqual(pick.all, []);
  assert.deepEqual(pick.tests, []);
});

const DYN = {
  'src/dyn.ts': "export const pick = (name: string) =>\n  import(name);\n",
  'tests/dyn.test.ts': "import { pick } from '../src/dyn.ts';\nvoid pick;\n",
};

test('a non-literal import() is reported with its place and its tests are picked for any change', t => {
  const graph = new ImportGraph(tree(t, DYN));
  assert.deepEqual(graph.pick(['src/dyn.ts']).dynamic, ['src/dyn.ts:2']);
  assert.deepEqual(graph.everyChange(), ['tests/dyn.test.ts']);
  assert.deepEqual(graph.pick(['src/unrelated.ts']).tests, ['tests/dyn.test.ts']);
  assert.deepEqual(new ImportGraph(tree(t)).pick(['src/a.ts']).dynamic, []);
});

test('non-literal require() and import.meta.resolve() also fail closed', t => {
  const graph = new ImportGraph(tree(t, {
    'src/req-dyn.cjs': 'module.exports = name => require(name);\n',
    'src/res-dyn.ts': 'export const where = (name: string) => import.meta.resolve(name);\n',
    'tests/req-dyn.test.ts': "import '../src/req-dyn.cjs';\n",
    'tests/res-dyn.test.ts': "import '../src/res-dyn.ts';\n",
  }));
  assert.deepEqual(graph.everyChange(), ['tests/req-dyn.test.ts', 'tests/res-dyn.test.ts']);
});

test('a template-literal import() follows the folder its fixed head names', t => {
  const graph = new ImportGraph(tree(t, {
    'src/plugins.ts': 'export const plugin = (name: string) => import(`./plugins/${name}.ts`);\n',
    'src/plugins/foo.ts': 'export {};\n',
    'tests/plugins.test.ts': "import '../src/plugins.ts';\n",
  }));
  assert.deepEqual(graph.everyChange(), []);
  assert.deepEqual(graph.pick(['src/plugins/foo.ts']).tests, ['tests/plugins.test.ts']);
  assert.deepEqual(graph.pick(['src/plugins/new.ts']).tests, ['tests/plugins.test.ts']);
});

test('product code that builds a path from its own folder is followed, and an unresolvable one fails closed', t => {
  const graph = new ImportGraph(tree(t, {
    'src/forker.ts': "import { fork } from 'node:child_process';\nimport { join } from 'node:path';\nexport const go = () => fork(join(import.meta.dirname, 'child.ts'));\n",
    'src/child.ts': "import './grand.ts';\n",
    'src/grand.ts': 'export {};\n',
    'src/by-name.ts': 'export const at = (name: string) => new URL(name, import.meta.url);\n',
    'tests/forker.test.ts': "import '../src/forker.ts';\n",
    'tests/by-name.test.ts': "import '../src/by-name.ts';\n",
  }));
  assert.deepEqual(graph.pick(['src/grand.ts']).tests, ['tests/by-name.test.ts', 'tests/forker.test.ts']);
  assert.deepEqual(graph.everyChange(), ['tests/by-name.test.ts']);
});

test('the two known-safe computed paths do not pick their tests for every change', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': "import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n",
    'tests/helpers/dom.ts': 'export const loadTsx = <T>(path: string, from: string): Promise<T> => import(new URL(path, from).href) as Promise<T>;\n',
    'tests/paths.test.ts': "import '../src/paths.ts';\nimport './helpers/dom.ts';\n",
  }));
  assert.deepEqual(graph.everyChange(), []);
  assert.deepEqual(graph.pick(['src/paths.ts']).dynamic, []);
  assert.deepEqual(graph.pick(['src/unrelated.ts']).tests, []);
});

test('a repo path written as a plain string in a test is a place it reads', t => {
  const graph = new ImportGraph(tree(t, { 'tests/lit.test.ts': "import { readdirSync } from 'node:fs';\nreaddirSync('src/scan');\n" }));
  assert.deepEqual(graph.pick(['src/scan/new.ts']).tests, ['tests/lit.test.ts', 'tests/scan.test.ts']);
});

test('a path joined onto process.cwd() is a place the test reads', t => {
  const graph = new ImportGraph(tree(t, { 'tests/cwd.test.ts': "import { join } from 'node:path';\nvoid join(process.cwd(), './src', 'scan');\n" }));
  assert.deepEqual(graph.pick(['src/scan/new.ts']).tests, ['tests/cwd.test.ts', 'tests/scan.test.ts']);
});

test('a test that resolves the repo root is picked for any change', t => {
  const graph = new ImportGraph(tree(t, { 'tests/up.test.ts': "void new URL('..', import.meta.url);\n" }));
  assert.deepEqual(graph.everyChange(), ['tests/up.test.ts']);
});

test('paths a test resolves from import.meta.url are followed: a folder it reads, a module it loads', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/scan/one.ts']).tests, ['tests/scan.test.ts']);
  assert.deepEqual(graph.pick(['src/scan/new.ts']).tests, ['tests/scan.test.ts']);
  assert.deepEqual(graph.pick(['web/src/B.ts']).tests, ['tests/ui.test.ts']);
});

test('a test that locates repo files in a way that cannot be narrowed is picked for any change', t => {
  const graph = new ImportGraph(tree(t, { 'tests/root.test.ts': "import { join } from 'node:path';\nconst here = import.meta.dirname;\nvoid join(here, 'x');\n" }));
  assert.deepEqual(graph.everyChange(), ['tests/root.test.ts']);
  assert.deepEqual(graph.pick(['src/unrelated.ts']).tests, ['tests/root.test.ts']);
  assert.deepEqual(graph.pick(['src/a.ts']).tests, ['tests/b.test.ts', 'tests/root.test.ts']);
});

test('deleting a file still picks the tests that import it', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/gone.ts']).tests, ['tests/gone.test.ts']);
});

test('the command prints every test of this repo for a package.json change and says why', () => {
  const run = spawnSync(process.execPath, ['scripts/affected-tests.ts', 'package.json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const all = globSync(TEST_GLOB).map(file => file.replaceAll('\\', '/')).sort();
  assert.deepEqual(run.stdout.trim().split('\n'), all);
  assert.match(run.stderr, /package\.json: dependencies or npm scripts changed/u);
});

const SCRIPT = resolve('scripts/affected-tests.ts');
const { NODE_TEST_CONTEXT: _nested, ...CHILD_ENV } = process.env;

function gitRepo(t: Parameters<typeof tempDir>[0], files: Record<string, string>): { root: string; git: (...args: string[]) => void } {
  const root = tempDir(t);
  const git = (...args: string[]): void => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  git('init', '-q', '-b', 'base');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, git };
}

test('changes from git: both names of a rename, a delete, staged and unstaged edits, and a new file', t => {
  const { root, git } = gitRepo(t, { 'src/old.ts': 'export const o = 1;\n', 'src/gone.ts': '1;\n', 'src/staged.ts': '1;\n', 'src/unstaged.ts': '1;\n', 'src/same.ts': '1;\n' });
  git('switch', '-q', '-c', 'work');
  git('mv', 'src/old.ts', 'src/new.ts');
  git('rm', '-q', 'src/gone.ts');
  git('commit', '-q', '-m', 'work');
  writeFileSync(join(root, 'src/staged.ts'), '2;\n');
  git('add', 'src/staged.ts');
  writeFileSync(join(root, 'src/unstaged.ts'), '2;\n');
  writeFileSync(join(root, 'src/fresh.ts'), '1;\n');
  assert.deepEqual([...new Set(changedFromGit(root, 'base'))].sort(), ['src/fresh.ts', 'src/gone.ts', 'src/new.ts', 'src/old.ts', 'src/staged.ts', 'src/unstaged.ts']);
});

test('--run runs the picked tests through the test loader and returns their exit status', t => {
  const { root } = gitRepo(t, {
    'tests/helpers/tsx-loader.mjs': 'globalThis.loaderRan = true;\n',
    'tests/pass.test.ts': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('loader ran', () => { assert.equal((globalThis as { loaderRan?: boolean }).loaderRan, true); });\n",
    'tests/fail.test.ts': "import { test } from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n",
  });
  const run = (file: string) => spawnSync(process.execPath, [SCRIPT, '--run', file], { cwd: root, encoding: 'utf8', env: CHILD_ENV });
  const pass = run('tests/pass.test.ts');
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stderr, /picked 1 of 2 test files/u);
  assert.match(pass.stdout, /loader ran/u);
  const fail = run('tests/fail.test.ts');
  assert.equal(fail.status, 1, fail.stdout + fail.stderr);
});

test('a path argument that is neither on disk nor known to git picks every test', t => {
  const { root } = gitRepo(t, { 'src/real.ts': '1;\n', 'tests/a.test.ts': "import '../src/real.ts';\n" });
  const run = spawnSync(process.execPath, [SCRIPT, 'src/typo.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /src\/typo\.ts: neither on disk nor known to git/u);
  assert.deepEqual(run.stdout.trim().split('\n'), ['tests/a.test.ts']);
  if (process.platform === 'win32') {
    const cased = spawnSync(process.execPath, [SCRIPT, 'src/REAL.ts'], { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(cased.stderr, /ALL/u);
    assert.deepEqual(cased.stdout.trim().split('\n'), ['tests/a.test.ts']);
  }
});

const PATHS_TS = "import { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nexport const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');\n";

test('APP_ROOT joined with fixed parts in a test is followed from the repo root', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'scripts/tool.ts': "import '../src/deep.ts';\n",
    'src/deep.ts': 'export {};\n',
    'tests/approot.test.ts': "import { join } from 'node:path';\nimport { APP_ROOT } from '../src/paths.ts';\nvoid join(APP_ROOT, 'scripts', 'tool.ts');\n",
  }));
  assert.deepEqual(graph.everyChange(), []);
  assert.deepEqual(graph.pick(['src/deep.ts']).tests, ['tests/approot.test.ts']);
});

test('APP_ROOT used any other way in a test picks it for any change', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'tests/approot-bare.test.ts': "import { APP_ROOT } from '../src/paths.ts';\nvoid APP_ROOT.length;\n",
    'tests/approot-computed.test.ts': "import { join } from 'node:path';\nimport { APP_ROOT } from '../src/paths.ts';\ndeclare const name: string;\nvoid join(APP_ROOT, name);\n",
  }));
  assert.deepEqual(graph.everyChange(), ['tests/approot-bare.test.ts', 'tests/approot-computed.test.ts']);
});

test('a path joined from a folder with a non-literal part picks its tests for any change', t => {
  const graph = new ImportGraph(tree(t, {
    'src/tools/x.ts': "import { join } from 'node:path';\nexport const at = (name: string) => join(import.meta.dirname, name);\n",
    'src/tools/y.ts': "import { join } from 'node:path';\nexport const at = (name: string) => join(import.meta.dirname, 'plug', name);\n",
    'tests/x.test.ts': "import '../src/tools/x.ts';\n",
    'tests/y.test.ts': "import '../src/tools/y.ts';\n",
  }));
  assert.deepEqual(graph.everyChange(), ['tests/x.test.ts', 'tests/y.test.ts']);
});

test('APP_ROOT imported under another name follows the same rules', t => {
  const graph = new ImportGraph(tree(t, {
    'src/paths.ts': PATHS_TS,
    'scripts/tool.ts': "import '../src/deep.ts';\n",
    'src/deep.ts': 'export {};\n',
    'tests/alias-join.test.ts': "import { join } from 'node:path';\nimport { APP_ROOT as ROOT } from '../src/paths.ts';\nvoid join(ROOT, 'scripts', 'tool.ts');\n",
    'tests/alias-bare.test.ts': "import { APP_ROOT as ROOT } from '../src/paths.ts';\nvoid ROOT.length;\n",
  }));
  assert.deepEqual(graph.everyChange(), ['tests/alias-bare.test.ts']);
  assert.deepEqual(graph.pick(['src/deep.ts']).tests, ['tests/alias-bare.test.ts', 'tests/alias-join.test.ts']);
});
