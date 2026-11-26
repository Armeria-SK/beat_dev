import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { packageScriptName } from '../src/tools/hooks/code-guard.ts';
import { selfRunRig } from './helpers/self-run-rig.ts';

// UX-10: the "Will run" card of `npm run x` shows the script line that runs and the file it points to, not the whole package.json.
// The verdict (decision, reason keys, ask kinds) is the same as before; only what the card shows and what the bind pins changed.

const PACKAGE = {
  name: 'demo',
  description: 'UNRELATED-MARKER',
  dependencies: { 'left-pad': '1.0.0' },
  scripts: {
    x: 'tsx src/cli.ts --flag',
    prex: 'node scripts/pre.js',
    serve: 'node --watch src/server.ts',
    build: 'node scripts/build.mjs && npm run lint',
    lint: 'tsc --noEmit',
    check: 'npm run build && npm test',
    test: 'node --import ./tests/loader.mjs --test "tests/**/*.test.ts"',
    other: 'echo UNRELATED-SCRIPT',
    install: 'node scripts/install.js',
    bad: 'npm install && node scripts/pre.js',
    loop: 'npm run loop',
    keep: 'node secrets/helper.js',
    envfile: 'node .env.js',
    away: 'node ../outside.js',
    big: 'node big.js',
    dir: 'node scripts',
    missing: 'node nope.js',
  },
};

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(PACKAGE, null, 2),
  'src/cli.ts': "console.log('cli');\n",
  'src/server.ts': "console.log('server');\n",
  'scripts/pre.js': "console.log('pre');\n",
  'scripts/build.mjs': "console.log('build');\n",
  'scripts/install.js': "console.log('install');\n",
  'tests/loader.mjs': "console.log('loader');\n",
  'tests/a.test.ts': "console.log('a');\n",
  'secrets/helper.js': "console.log('secret');\n",
  '.env.js': "console.log('env');\n",
  'big.js': `// ${'b'.repeat(20_000)}\n`,
  'sub/package.json': JSON.stringify({ description: 'SUB-UNRELATED', scripts: { go: 'node run.js' } }),
  'sub/run.js': "console.log('sub run');\n",
};

const rel = (path: string): string => path.replaceAll('\\', '/').replace(/^.*\/workspace\//u, '');
const cardOf = (pre: ReturnType<typeof shellPreCheck>) => (pre.preview ?? []).map(p => ({ path: rel(p.path), text: p.text, truncated: p.truncated, chars: p.chars }));
const pathsOf = (pre: ReturnType<typeof shellPreCheck>) => cardOf(pre).map(p => p.path);

test('UX-10: npm run x shows the script line (and its pre hook) and the files they run, not the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  const pre = shellPreCheck({ command: 'npm run x' }, r.ctx);
  assert.equal(pre.decision, 'ask');
  const [pkg, ...entries] = cardOf(pre);
  assert.equal(pkg!.path, 'package.json');
  assert.equal(pkg!.text, '"prex": "node scripts/pre.js"\n"x": "tsx src/cli.ts --flag"');
  assert.deepEqual(entries.map(e => e.path), ['scripts/pre.js', 'src/cli.ts']);
  assert.equal(entries[1]!.text, "console.log('cli');\n");
});

test('UX-10: npm test and npm run of a script that calls other scripts show every line that runs, and the loader file (a glob is not a file)', t => {
  const r = selfRunRig(t, undefined, FILES);
  const test_ = cardOf(shellPreCheck({ command: 'npm test' }, r.ctx));
  assert.deepEqual(test_.map(p => p.path), ['package.json', 'tests/loader.mjs']);
  assert.equal(test_[0]!.text, `"test": ${JSON.stringify(PACKAGE.scripts.test)}`);
  const check = cardOf(shellPreCheck({ command: 'npm run check' }, r.ctx));
  assert.deepEqual(check.map(p => p.path), ['package.json', 'scripts/build.mjs', 'tests/loader.mjs']);
  assert.equal(check[0]!.text, [
    `"check": ${JSON.stringify(PACKAGE.scripts.check)}`, `"build": ${JSON.stringify(PACKAGE.scripts.build)}`, `"lint": ${JSON.stringify(PACKAGE.scripts.lint)}`, `"test": ${JSON.stringify(PACKAGE.scripts.test)}`,
  ].join('\n'));
});

test('UX-10: an unrelated line of package.json (description, dependencies, other scripts) is not on the card', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['npm run x', 'npm test', 'npm run check', 'npm run serve']) {
    const text = cardOf(shellPreCheck({ command }, r.ctx))[0]!.text;
    for (const noise of ['UNRELATED-MARKER', 'left-pad', 'UNRELATED-SCRIPT', '"name"']) assert.ok(!text.includes(noise), `${command}: ${noise}`);
  }
});

test('UX-10: pnpm, yarn and bun run <name> are read the same way; a cd before it picks that folder\'s package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['pnpm run serve', 'yarn run serve', 'bun run serve']) {
    const card = cardOf(shellPreCheck({ command }, r.ctx));
    assert.deepEqual(card.map(p => p.path), ['package.json', 'src/server.ts'], command);
    assert.equal(card[0]!.text, '"serve": "node --watch src/server.ts"', command);
  }
  const sub = cardOf(shellPreCheck({ command: 'cd sub; npm run go' }, r.ctx));
  assert.deepEqual(sub.map(p => p.path), ['sub/package.json', 'sub/run.js']);
  assert.equal(sub[0]!.text, '"go": "node run.js"');
});

test('UX-10: every form that cannot be tied to the script lines still shows the whole package.json (as before)', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['npm install', 'npm run nosuch', 'npm run -s x', 'npm --silent run x', 'npm run x; npm install', 'npm run bad', 'bun test', 'npm run']) {
    const card = cardOf(shellPreCheck({ command }, r.ctx));
    assert.ok(card.length >= 1, command);
    assert.equal(card[0]!.path, 'package.json', command);
    assert.ok(card[0]!.text.includes('UNRELATED-MARKER') && card[0]!.text.includes('left-pad'), `${command}: the whole file`);
  }
});

test('UX-10: a file outside the product, at a secret path, a missing file and a folder are not added to the card; a long file is clipped', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const name of ['keep', 'envfile', 'away', 'dir', 'missing']) {
    const card = cardOf(shellPreCheck({ command: `npm run ${name}` }, r.ctx));
    assert.deepEqual(card.map(p => p.path), ['package.json'], name);
    assert.equal(card[0]!.text, `"${name}": ${JSON.stringify((PACKAGE.scripts as Record<string, string>)[name])}`, name);
  }
  const big = cardOf(shellPreCheck({ command: 'npm run big' }, r.ctx));
  assert.deepEqual(big.map(p => p.path), ['package.json', 'big.js']);
  assert.equal(big[1]!.truncated, true);
  assert.ok(big[1]!.text.length <= 8000 && (big[1]!.chars ?? 0) > 20_000);
});

test('UX-10: the bind pins the whole package.json and the files shown, so a change after the card was drawn makes the approval stale', t => {
  const r = selfRunRig(t, undefined, FILES);
  const bind = (command: string) => shellPreCheck({ command }, r.ctx).bind;
  const before = bind('npm run x');
  assert.equal(bind('npm run x'), before);
  writeFileSync(join(r.ws, 'src/cli.ts'), "console.log('changed');\n");
  const afterEntry = bind('npm run x');
  assert.notEqual(afterEntry, before, 'the entry file is pinned');
  writeFileSync(join(r.ws, 'package.json'), JSON.stringify({ ...PACKAGE, description: 'changed' }, null, 2));
  assert.notEqual(bind('npm run x'), afterEntry, 'the whole package.json is pinned, not only the lines on the card');
});

// Captured from the code before this change (same fixture): [decision, reason keys, ask kinds, number of reasons]
const BEFORE: Record<string, [string, string[], string[] | undefined, number]> = {
  'npm run x': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm test': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run check': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm install': ['ask', ['list.install', 'code.project_tool'], ['code'], 4],
  'npm run nosuch': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'node scripts/pre.js': ['ask', ['list.lang_run', 'code.file_run'], ['code'], 3],
  'tsx src/cli.ts': ['ask', ['list.command', 'code.file_run'], ['code'], 3],
  'pnpm run serve': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'yarn run serve': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'bun run serve': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'cd sub; npm run go': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 3],
  'npm run -s x': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'npm --silent run x': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'npm run x; npm install': ['ask', ['list.npm_script', 'list.install', 'code.project_tool'], ['code'], 5],
  'npm run x; npm run $NAME': ['deny', ['list.npm_script', 'list.form', 'list.winargs'], undefined, 3],
  'npm run bad': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run loop': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'bun test': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'npm': ['ask', ['list.form'], ['code'], 1],
  'npm run': ['ask', ['list.form', 'code.project_tool'], ['code'], 4],
  'npm run keep': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run envfile': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run away': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run dir': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run missing': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run big': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
  'npm run serve': ['ask', ['list.npm_script', 'code.project_tool'], ['code'], 4],
};

test('UX-10 counter-test: the verdict of every package script call and file run is the same as before the card change (decision, reason keys, ask kinds, reasons)', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const [command, expected] of Object.entries(BEFORE)) {
    const pre = shellPreCheck({ command }, r.ctx);
    assert.deepEqual([pre.decision, pre.reasonKeys, pre.askKinds, pre.reasons.length], expected, command);
  }
});

test('UX-10: node and tsx files still show the file itself', t => {
  const r = selfRunRig(t, undefined, FILES);
  assert.deepEqual(pathsOf(shellPreCheck({ command: 'node scripts/pre.js' }, r.ctx)), ['scripts/pre.js']);
  assert.deepEqual(pathsOf(shellPreCheck({ command: 'tsx src/cli.ts' }, r.ctx)), ['src/cli.ts']);
});

test('UX-10: through the pipeline, the waiting Pending row carries the narrowed card (the script line and the file it runs)', async t => {
  const r = selfRunRig(t, undefined, FILES);
  const out = await r.call('shell_run', { command: 'npm run x' }, { ...r.ctx, kind: 'chat', task: undefined, project: undefined });
  assert.equal(out.decidedBy, 'pending', out.output.content);
  const [row] = r.pending.list({ status: 'waiting' });
  assert.deepEqual(row!.preview.map(p => rel(p.path)), ['package.json', 'scripts/pre.js', 'src/cli.ts']);
  assert.equal(row!.preview[0]!.text, '"prex": "node scripts/pre.js"\n"x": "tsx src/cli.ts --flag"');
  assert.deepEqual(r.ran, []);
});

test('UX-10: a script that calls itself shows its line once', t => {
  const r = selfRunRig(t, undefined, FILES);
  const card = cardOf(shellPreCheck({ command: 'npm run loop' }, r.ctx));
  assert.deepEqual(card.map(p => [p.path, p.text]), [['package.json', '"loop": "npm run loop"']]);
});

test('UX-10: packageScriptName reads only the forms that run one named script', () => {
  assert.equal(packageScriptName('npm', ['run', 'x', '--', '--flag']), 'x');
  assert.equal(packageScriptName('pnpm', ['run-script', 'x']), 'x');
  assert.equal(packageScriptName('yarn', ['test']), 'test');
  assert.equal(packageScriptName('npm', ['start']), 'start');
  for (const [cmd, args] of [['npm', ['install']], ['npm', ['run']], ['npm', ['run', '-w', 'a', 'x']], ['npm', ['-C', 'sub', 'run', 'x']], ['bun', ['test']], ['npx', ['run', 'x']], ['yarn', ['x']]] as const) {
    assert.equal(packageScriptName(cmd, args), undefined, `${cmd} ${args.join(' ')}`);
  }
});

test('L55 (S): the shell tool description tells that Windows PowerShell 5.1 has no && or || and no rm -rf', () => {
  assert.match(shellRun.description, /PowerShell 5\.1[^.]*&&[^.]*\|\|[^.]*;[^.]*rm -rf[^.]*Remove-Item -Recurse -Force/u);
});
