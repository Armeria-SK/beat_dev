import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { cardQuote, packageScriptName } from '../src/tools/hooks/code-guard.ts';
import { selfRunRig } from './helpers/self-run-rig.ts';

// UX-10: the "Will run" card of `npm run x` shows the script line that runs and the file it points to, not the whole package.json.
// The verdict (decision, reason keys, ask kinds) is the same as before; only what the card shows and what the bind pins changed.
// Any shape that the card cannot tie to the lines that really run shows the whole package.json, as before.

const PACKAGE = {
  name: 'demo',
  description: 'UNRELATED-MARKER',
  dependencies: { 'left-pad': '1.0.0' },
  scripts: {
    x: 'tsx src/cli.ts --flag',
    prex: 'node scripts/pre.js',
    serve: 'node --watch src/server.ts',
    start: 'node src/server.ts',
    build: 'node scripts/build.mjs && npm run lint',
    lint: 'tsc --noEmit',
    'lint:css': 'echo CSS-UNRELATED',
    check: 'npm run build && npm test',
    test: 'node --import ./tests/loader.mjs --test "tests/**/*.test.ts"',
    other: 'echo UNRELATED-SCRIPT',
    install: 'node scripts/install.js',
    bad: 'npm install && node scripts/pre.js',
    bad2: 'npm add left-pad && node scripts/pre.js',
    loop: 'npm run loop',
    keep: 'node secrets/helper.js',
    envfile: 'node .env.js',
    away: 'node ../outside.js',
    big: 'node big.js',
    dir: 'node scripts',
    missing: 'node nope.js',
    more: 'node f1.js f2.js f3.js f4.js && node f5.js f6.js',
    client: 'npm start --prefix sub',
    client2: 'cd sub && npm run go',
    cdsame: 'cd sub && npm run serve',
    cdfile: 'cd sub && node f1.js',
    ci: 'run-s lint other',
    dev: 'concurrently "npm:serve" "npm:other"',
    ce: 'cross-env A=1 npm run other',
    hash: 'node scripts/pre.js # && npm run other',
    sq: "echo 'a & npm run other & echo b'",
    glob: 'run-p "lint:*"',
    nul: `node a${String.fromCodePoint(0)}b.js`,
    bidi: `node a${String.fromCodePoint(0x202e)}b.js`,
    long: `node scripts/pre.js # ${'zz '.repeat(2200)}`,
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
  'secrets/helper.js': "console.log('SECRET-BODY');\n",
  '.env.js': "console.log('env');\n",
  'big.js': `// ${'b'.repeat(20_000)}\n`,
  'f1.js': '1', 'f2.js': '2', 'f3.js': '3', 'f4.js': '4', 'f5.js': '5', 'f6.js': '6',
  'sub/package.json': JSON.stringify({ description: 'SUB-UNRELATED', scripts: { go: 'node run.js', up: 'node ../f1.js' } }),
  'sub/run.js': "console.log('sub run');\n",
  'packages/api/package.json': JSON.stringify({ description: 'API-UNRELATED', scripts: { test: 'node evil.js' } }),
  'packages/api/evil.js': "console.log('evil');\n",
};

const EXCERPT = '(excerpt of package.json: only the scripts that run)';
const rel = (path: string): string => path.replaceAll('\\', '/').replace(/^.*\/workspace\//u, '');
const cardOf = (pre: ReturnType<typeof shellPreCheck>) => (pre.preview ?? []).map(p => ({ path: rel(p.path), text: p.text, truncated: p.truncated, chars: p.chars }));
const pathsOf = (pre: ReturnType<typeof shellPreCheck>) => cardOf(pre).map(p => p.path);
const excerpt = (...lines: string[]): string => [EXCERPT, ...lines].join('\n');
const line = (key: string): string => `${cardQuote(key)}: ${cardQuote((PACKAGE.scripts as Record<string, string>)[key]!)}`;
const whole = (card: ReturnType<typeof cardOf>, why: string): void => {
  assert.ok(card.length >= 1, why);
  assert.equal(card[0]!.path, 'package.json', why);
  assert.ok(card[0]!.text.includes('UNRELATED-MARKER') && card[0]!.text.includes('left-pad') && !card[0]!.text.startsWith(EXCERPT), `${why}: the whole file`);
};

test('UX-10: npm run x shows the script line (and its pre hook) and the files they run, not the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  const pre = shellPreCheck({ command: 'npm run x' }, r.ctx);
  assert.equal(pre.decision, 'ask');
  const [pkg, ...entries] = cardOf(pre);
  assert.equal(pkg!.path, 'package.json');
  assert.equal(pkg!.text, excerpt(line('prex'), line('x')));
  assert.deepEqual(entries.map(e => e.path), ['scripts/pre.js', 'src/cli.ts']);
  assert.equal(entries[1]!.text, "console.log('cli');\n");
});

test('UX-10: npm test and npm run of a script that calls other scripts show every line that runs, and the loader file (a glob is not a file)', t => {
  const r = selfRunRig(t, undefined, FILES);
  const test_ = cardOf(shellPreCheck({ command: 'npm test' }, r.ctx));
  assert.deepEqual(test_.map(p => p.path), ['package.json', 'tests/loader.mjs']);
  assert.equal(test_[0]!.text, excerpt(line('test'), '(not shown: "tests")'));
  const check = cardOf(shellPreCheck({ command: 'npm run check' }, r.ctx));
  assert.deepEqual(check.map(p => p.path), ['package.json', 'scripts/build.mjs', 'tests/loader.mjs']);
  assert.equal(check[0]!.text, excerpt(line('check'), line('build'), line('lint'), line('test'), '(not shown: "tests")'));
  const passed = cardOf(shellPreCheck({ command: 'npm test -- --grep a' }, r.ctx));
  assert.equal(passed[0]!.text, excerpt(line('test'), '(not shown: "tests")'), 'arguments after -- go to the script');
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
    assert.equal(card[0]!.text, excerpt(line('serve')), command);
  }
  const sub = cardOf(shellPreCheck({ command: 'cd sub; npm run go' }, r.ctx));
  assert.deepEqual(sub.map(p => p.path), ['sub/package.json', 'sub/run.js']);
  assert.equal(sub[0]!.text, excerpt('"go": "node run.js"'));
});

test('UX-10: every form that cannot be tied to the script lines still shows the whole package.json (as before)', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['npm install', 'npm run nosuch', 'npm run -s x', 'npm --silent run x', 'npm run x; npm install', 'npm run bad', 'npm run bad2', 'bun test', 'npm run']) {
    whole(cardOf(shellPreCheck({ command }, r.ctx)), command);
  }
});

test('UX-10: a flag after the name, a workspace, a prefix or an env var that picks another package shows the whole package.json, not the root script lines', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of [
    'npm test -w packages/api', 'npm run go --prefix sub', 'npm run go -C sub', 'npm run x --workspaces', 'npm run x --if-present', 'npm test --workspace=packages/api',
    'npm_config_prefix=sub npm run go', 'export npm_config_prefix=sub; npm test', 'FOO=1 npm run x', '$env:npm_config_prefix = "sub"; npm test', '$env:FOO = "1"; npm run x',
  ]) whole(cardOf(shellPreCheck({ command }, r.ctx)), command);
});

test('UX-10: a wrapper, an npx / corepack call, or a folder that cannot be worked out shows the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['npm test; npx npm install', 'npm test; corepack npm install', 'time npm run x', 'bash -c "npm run x"', 'timeout 5 npm test', 'npm run x; bash -c "npm run serve"', 'npm run x; & $p run serve', 'npm run x; corepack pnpm@9 run serve', 'npm run x; npx pnpm@9 run serve']) {
    whole(cardOf(shellPreCheck({ command }, r.ctx)), command);
  }
});

test('UX-10: a script that moves to another folder or passes flags to a package tool shows the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const name of ['client', 'client2', 'cdsame', 'cdfile']) whole(cardOf(shellPreCheck({ command: `npm run ${name}` }, r.ctx)), name);
});

test('UX-10: a script line that hands work to a runner beat does not read (run-s, concurrently, cross-env, a comment, a quoted string, a glob) shows the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const name of ['ci', 'dev', 'ce', 'hash', 'sq', 'glob']) {
    const card = cardOf(shellPreCheck({ command: `npm run ${name}` }, r.ctx));
    whole(card, name);
    assert.ok(card[0]!.text.includes('UNRELATED-SCRIPT') || name === 'glob', `${name}: the script that may run is on the card`);
  }
  assert.ok(cardOf(shellPreCheck({ command: 'npm run glob' }, r.ctx))[0]!.text.includes('CSS-UNRELATED'));
});

test('UX-10: a script text longer than the limit shows the whole package.json', t => {
  const r = selfRunRig(t, undefined, FILES);
  whole(cardOf(shellPreCheck({ command: 'npm run long' }, r.ctx)), 'long');
});

test('UX-10: a NUL in a path inside a script does not make the call throw: the decision stays ask and the card is the whole file', t => {
  const r = selfRunRig(t, undefined, FILES);
  const pre = shellPreCheck({ command: 'npm run nul' }, r.ctx);
  assert.equal(pre.decision, 'ask');
  whole(cardOf(pre), 'nul');
});

test('UX-10: control, format and line-separator characters in a script line are written as \\u escapes on the card', t => {
  const r = selfRunRig(t, undefined, FILES);
  const text = cardOf(shellPreCheck({ command: 'npm run bidi' }, r.ctx))[0]!.text;
  assert.ok(text.includes('node a\\u202eb.js'), text);
  assert.ok(!text.includes(String.fromCodePoint(0x202e)));
  for (const code of [0x85, 0x200b, 0x2028, 0x2029, 0x7f, 0xe0041]) { const raw = String.fromCodePoint(code); assert.ok(!cardQuote(`a${raw}b`).includes(raw), String(code)); }
  assert.equal(cardQuote(`a${String.fromCodePoint(0x85)}b`), '"a\\u0085b"');
  assert.equal(cardQuote(`a${String.fromCodePoint(0xe0041)}b`), '"a\\udb40\\udc41b"');
  assert.equal(cardQuote('a"b\n'), '"a\\"b\\n"');
});

test('UX-10: a file named by a script but not shown (outside the product, secret, missing, a folder, over the limit of 4) is named on the card, never read', t => {
  const r = selfRunRig(t, undefined, FILES);
  const keep = cardOf(shellPreCheck({ command: 'npm run keep' }, r.ctx));
  assert.deepEqual(keep.map(p => p.path), ['package.json']);
  assert.equal(keep[0]!.text, excerpt(line('keep'), '(not shown: "secrets/helper.js")'));
  assert.ok(!JSON.stringify(keep).includes('SECRET-BODY'));
  const cases: Array<[string, string]> = [['envfile', '".env.js"'], ['away', '"../outside.js"'], ['missing', '"nope.js"']];
  for (const [name, shown] of cases) {
    const card = cardOf(shellPreCheck({ command: `npm run ${name}` }, r.ctx));
    assert.deepEqual(card.map(p => p.path), ['package.json'], name);
    assert.equal(card[0]!.text, excerpt(line(name), `(not shown: ${shown})`), name);
  }
  assert.equal(cardOf(shellPreCheck({ command: 'npm run dir' }, r.ctx))[0]!.text, excerpt(line('dir')), 'a bare folder name is not read as a file');
  const more = cardOf(shellPreCheck({ command: 'npm run more' }, r.ctx));
  assert.deepEqual(more.map(p => p.path), ['package.json', 'f1.js', 'f2.js', 'f3.js', 'f4.js']);
  assert.equal(more[0]!.text, excerpt(line('more'), '(not shown: "f5.js", "f6.js")'));
});

test('UX-10: a file outside the product folder is not shown even when the policy allows its place', t => {
  const r = selfRunRig(t, undefined, FILES);
  const card = cardOf(shellPreCheck({ command: 'cd sub; npm run up' }, { ...r.ctx, project: { id: 'p1', root: join(r.ws, 'sub') } }));
  assert.deepEqual(card.map(p => p.path), ['sub/package.json']);
  assert.equal(card[0]!.text, excerpt('"up": "node ../f1.js"', '(not shown: "../f1.js")'));
});

test('UX-10: a long entry file is clipped', t => {
  const r = selfRunRig(t, undefined, FILES);
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

// Captured from the code before this change (same commands; the fixture only gained scripts that carry no marker): [decision, reason keys, ask kinds, number of reasons]
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
  assert.equal(row!.preview[0]!.text, excerpt(line('prex'), line('x')));
  assert.deepEqual(r.ran, []);
});

test('UX-10: a script that calls itself shows its line once', t => {
  const r = selfRunRig(t, undefined, FILES);
  const card = cardOf(shellPreCheck({ command: 'npm run loop' }, r.ctx));
  assert.deepEqual(card.map(p => [p.path, p.text]), [['package.json', excerpt('"loop": "npm run loop"')]]);
});

test('UX-10: packageScriptName reads only the forms that run one named script, with nothing after the name but -- arguments', () => {
  assert.equal(packageScriptName('npm', ['run', 'x', '--', '--flag']), 'x');
  assert.equal(packageScriptName('pnpm', ['run-script', 'x']), 'x');
  assert.equal(packageScriptName('yarn', ['test']), 'test');
  assert.equal(packageScriptName('npm', ['start']), 'start');
  assert.equal(packageScriptName('npm', ['test', '--', '--grep', 'a']), 'test');
  for (const [cmd, args] of [
    ['npm', ['install']], ['npm', ['run']], ['npm', ['run', '-w', 'a', 'x']], ['npm', ['-C', 'sub', 'run', 'x']], ['bun', ['test']], ['npx', ['run', 'x']], ['yarn', ['x']],
    ['npm', ['run', 'x', '--prefix', 'sub']], ['npm', ['test', '-w', 'a']], ['npm', ['run', 'x', '--workspaces']], ['npm', ['start', '--prefix', 'client']], ['npm', ['run', 'x', 'y']],
  ] as const) {
    assert.equal(packageScriptName(cmd, args), undefined, `${cmd} ${args.join(' ')}`);
  }
});

test('L55 (S): the shell tool description tells that Windows PowerShell 5.1 has no && or || and no rm -rf', () => {
  assert.match(shellRun.description, /PowerShell 5\.1[^.]*&&[^.]*\|\|[^.]*;[^.]*rm -rf[^.]*Remove-Item -Recurse -Force/u);
});
