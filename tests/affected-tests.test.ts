import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ImportGraph, TEST_GLOB } from '../scripts/affected-tests.ts';
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
  'src/dyn.ts': "export const pick = (name: string) =>\n  import(name);\n",
  'src/scan/one.ts': 'export {};\n',
  'src/unrelated.ts': 'export const nobody = 1;\n',
  'web/src/A.tsx': "import { bee } from './B.ts';\nexport const A = () => bee;\n",
  'web/src/B.ts': 'export const bee = 1;\n',
  'tests/helpers/h.ts': 'export const h = 1;\n',
  'tests/helpers/tsx-loader.mjs': '',
  'tests/b.test.ts': "import { b } from '../src/b.ts';\nvoid b;\n",
  'tests/c.test.ts': "import { d } from '../src/c.ts';\nvoid d;\n",
  'tests/e.test.ts': "import { load } from '../src/e.ts';\nvoid load;\n",
  'tests/dyn.test.ts': "import { pick } from '../src/dyn.ts';\nvoid pick;\n",
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
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json', 'tests/helpers/h.ts', 'tests/helpers/tsx-loader.mjs', 'src/prompt.md', 'src/data.json', 'tests/fixtures/page.html', 'deploy/x.ts', 'README.md']) {
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

test('a non-literal import() in the picked tests is reported with its place', t => {
  const graph = new ImportGraph(tree(t));
  assert.deepEqual(graph.pick(['src/dyn.ts']).dynamic, ['src/dyn.ts:2']);
  assert.deepEqual(graph.pick(['src/a.ts']).dynamic, []);
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
