import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guardText } from '../src/shared/messages/guard.ts';
import { shellPreCheck, shellRun } from '../src/tools/builtin/shell.ts';
import { cardQuote, packageScriptName } from '../src/tools/hooks/code-guard.ts';
import { selfRunRig } from './helpers/self-run-rig.ts';

// UX-10: the "Will run" card of `npm run x` keeps the whole package.json (as before) and gets one extra card in front of it:
// the script lines that are likely to run. Nothing is hidden; the extra card is display only (no verdict, no bind, no rule, no judge key).
// L55: the shell tool description tells about PowerShell 5.1.

const PACKAGE = {
  name: 'demo',
  description: 'UNRELATED-MARKER',
  main: 'scripts/main.js',
  nodemonConfig: { exec: 'node scripts/watch-exec.js' },
  dependencies: { 'left-pad': '1.0.0' },
  scripts: {
    x: 'tsx src/cli.ts --flag',
    prex: 'node scripts/pre.js',
    postx: 'echo POST-X-HOOK',
    serve: 'node --watch src/server.ts',
    start: 'node src/server.ts',
    build: 'node scripts/build.mjs && npm run lint',
    lint: 'tsc --noEmit',
    check: 'npm run build && npm test',
    test: 'node --import ./tests/loader.mjs --test "tests/**/*.test.ts"',
    other: 'echo UNRELATED-SCRIPT',
    install: 'node scripts/install.js',
    bad: 'npm install && node scripts/pre.js',
    release: 'npm version patch',
    postversion: 'echo POSTVERSION-MARKER',
    ce2: 'cross-env A=1 npm install',
    postinstall: 'echo POSTINSTALL-MARKER',
    ros: 'run-script-os',
    'ros:win32': 'echo WIN32-MARKER',
    watch: 'nodemon',
    dot: 'node .',
    loop: 'npm run loop',
    keep: 'node secrets/helper.js',
    envfile: 'node .env.js',
    away: 'node ../outside.js',
    big: 'node big.js',
    dir: 'node scripts',
    missing: 'node nope.js',
    nul: `node a${String.fromCodePoint(0)}b.js`,
    bidi: `node a${String.fromCodePoint(0x202e)}b.js`,
    go: 'echo ROOT-GO-MARKER',
    cdrun: 'cd sub && npm run go',
    cdpush: 'pushd sub; npm run go',
    setloc: 'Set-Location sub; npm run go',
    both: 'npm run x && cd sub && npm run go',
    plainchain: 'npm run x && npm run go',
  },
};

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(PACKAGE, null, 2),
  'src/cli.ts': "console.log('cli');\n",
  'src/server.ts': "console.log('server');\n",
  'scripts/pre.js': "console.log('pre');\n",
  'scripts/build.mjs': "console.log('build');\n",
  'scripts/install.js': "console.log('install');\n",
  'scripts/main.js': "console.log('main');\n",
  'scripts/watch-exec.js': "console.log('watch');\n",
  'tests/loader.mjs': "console.log('loader');\n",
  'tests/a.test.ts': "console.log('a');\n",
  'secrets/helper.js': "console.log('SECRET-BODY');\n",
  '.env.js': "console.log('env');\n",
  'big.js': `// ${'b'.repeat(20_000)}\n`,
  'sub/package.json': JSON.stringify({ description: 'SUB-UNRELATED', scripts: { go: 'node run.js' } }),
  'sub/run.js': "console.log('sub run');\n",
  'packages/api/package.json': JSON.stringify({ description: 'API-UNRELATED', scripts: { test: 'node evil.js' } }),
  'packages/api/evil.js': "console.log('evil');\n",
};

const LIKELY = 'Some of the lines likely to run, from the scripts in package.json. Other lines can run too (install hooks, tools that pick a script, other folders). The file itself is the next card';
const SCRIPTS = '#scripts';
const rel = (path: string): string => path.replaceAll('\\', '/').replace(/^.*\/workspace\//u, '');
const cardOf = (pre: ReturnType<typeof shellPreCheck>) => (pre.preview ?? []).map(p => ({ abs: p.path, path: rel(p.path), text: p.text, truncated: p.truncated, chars: p.chars }));
const pathsOf = (pre: ReturnType<typeof shellPreCheck>) => cardOf(pre).map(p => p.path);
const line = (key: string): string => `${cardQuote(key)}: ${cardQuote((PACKAGE.scripts as Record<string, string>)[key]!)}`;
const likely = (...lines: string[]): string => [LIKELY, ...lines].join('\n');
const extraOf = (cards: ReturnType<typeof cardOf>) => cards.filter(p => p.path.endsWith(SCRIPTS));

// What the base code shows for a file: the file's own text, cut at 8000 characters
const baseText = (abs: string): string => (existsSync(abs) ? readFileSync(abs, 'utf8').slice(0, 8000) : guardText('en', 'code.preview_missing'));

// Every command below is read by the card code; "clean" ones also get the extra card with the listed script lines
const CLEAN: Array<[string, string[]]> = [
  ['npm run x', ['prex', 'x', 'postx']],
  ['npm test', ['test']],
  ['npm test -- --grep a', ['test']],
  ['npm run check', ['check', 'build', 'lint', 'test']],
  ['npm start', ['start']],
  ['pnpm run serve', ['serve']],
  ['yarn run serve', ['serve']],
  ['bun run serve', ['serve']],
  ['npm run loop', ['loop']],
  ['npm run release', ['release']],
  ['npm run bad', ['bad']],
  ['npm run cdrun', ['cdrun']],
  ['npm run cdpush', ['cdpush']],
  ['npm run setloc', ['setloc']],
  ['npm run both', ['both', 'prex', 'x', 'postx']],
  ['npm run plainchain', ['plainchain', 'prex', 'x', 'postx', 'go']],
  ['cd sub; npm install; cd ..; npm test', ['test']],
];
const UNCERTAIN = [
  'npm install', 'npm run nosuch', 'npm run -s x', 'npm --silent run x', 'bun test', 'npm run',
  'npm test -w packages/api', 'npm run go --prefix sub', 'npm run go -C sub', 'npm run x --workspaces', 'npm run x --if-present', 'npm test --workspace=packages/api',
  'npm_config_prefix=sub npm run go', 'FOO=1 npm run x', '$env:npm_config_prefix = "sub"; npm test', '$env:FOO = "1"; npm run x',
  'time npm run x', 'bash -c "npm run x"', 'timeout 5 npm test', 'npx foo', 'corepack npm install',
  // a call in the same folder whose script name cannot be read (install and its hooks, a flag, a variable) runs lines the card would not show
  'npm run x; npm install', 'npm install; npm test', 'npm.ps1 install; npm test', 'npm test; npm install', 'npm ci && npm test', 'npm test; npm i', 'npm test; pnpm install', 'npm test; yarn',
  'npm test; npm run x --if-present', 'npm test; npm run $NAME', 'npm run x; bash -c "npm install"', 'bash -c "npm install"; npm test', 'npm test; cd $D; npm install',
];
// The shapes the reviews found: a wrapper that runs install hooks, tools that pick their own script, a bare nodemon, `node .` with main
const REVIEWED: Array<[string, string]> = [
  ['npm run ce2', 'POSTINSTALL-MARKER'], ['npm run ros', 'WIN32-MARKER'], ['npm run watch', 'nodemonConfig'], ['npm run dot', '"main": "scripts/main.js"'], ['npm run release', 'POSTVERSION-MARKER'],
];

test('UX-10: for every command, every card of the base (package.json and the others) carries the file text exactly, and the card list keeps the base order', t => {
  const r = selfRunRig(t, undefined, FILES);
  const commands = [...CLEAN.map(([command]) => command), ...UNCERTAIN, ...REVIEWED.map(([command]) => command), 'cd sub; npm run go', 'npm run nul', 'npm run bidi', 'npm run keep', 'npm run big', 'node scripts/pre.js', 'tsx src/cli.ts'];
  let withPackage = 0;
  for (const command of new Set(commands)) {
    const cards = cardOf(shellPreCheck({ command }, r.ctx));
    for (const card of cards.filter(p => !p.path.endsWith(SCRIPTS))) {
      assert.equal(card.text, baseText(card.abs), `${command}: ${card.path} is the file itself`);
      assert.equal(card.truncated, existsSync(card.abs) && readFileSync(card.abs, 'utf8').length > 8000, `${command}: ${card.path}`);
    }
    cards.forEach((card, i) => {
      if (card.path.endsWith(SCRIPTS)) assert.equal(cards[i + 1]?.path, card.path.slice(0, -SCRIPTS.length), `${command}: the extra card is right in front of its package.json`);
    });
    if (cards.some(p => p.path.endsWith('package.json'))) withPackage++;
  }
  assert.ok(withPackage >= 30, `the check is not empty: ${withPackage} commands showed a package.json`);
});

test('UX-10: a clean `npm run x` / `npm test` / `npm start` gets one extra card in front of the whole package.json, with the lines that are likely to run (pre and post hooks, scripts it calls)', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const [command, keys] of CLEAN) {
    const cards = cardOf(shellPreCheck({ command }, r.ctx));
    const extras = extraOf(cards);
    assert.equal(extras.length, 1, command);
    assert.equal(extras[0]!.path, 'package.json#scripts', command);
    assert.equal(extras[0]!.text, likely(...keys.map(line)), command);
    const pkg = cards.find(p => p.path === 'package.json')!;
    assert.equal(pkg.text, baseText(pkg.abs), `${command}: the whole file stays`);
    assert.ok(pkg.text.includes('UNRELATED-MARKER') && pkg.text.includes('left-pad'), command);
  }
  const sub = cardOf(shellPreCheck({ command: 'cd sub; npm run go' }, r.ctx));
  assert.deepEqual(sub.map(p => p.path), ['sub/package.json#scripts', 'sub/package.json']);
  assert.equal(sub[0]!.text, likely('"go": "node run.js"'));
  assert.equal(sub[1]!.text, baseText(sub[1]!.abs));
});

test('UX-10: when the lines cannot be tied to what runs (a flag, a workspace, a prefix, an env var, an install, a wrapper, a missing script), there is no extra card and the whole package.json is there', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of UNCERTAIN) {
    const cards = cardOf(shellPreCheck({ command }, r.ctx));
    assert.deepEqual(extraOf(cards), [], command);
    for (const card of cards) assert.equal(card.text, baseText(card.abs), command);
  }
});

test('UX-10: the shapes the reviews found (a wrapper running install hooks, run-script-os, a bare nodemon, node . with main) show the whole package.json, so the owner can see what they pick', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const [command, marker] of REVIEWED) {
    const pkg = cardOf(shellPreCheck({ command }, r.ctx)).find(p => p.path === 'package.json');
    assert.ok(pkg, command);
    assert.equal(pkg.text, baseText(pkg.abs), command);
    assert.ok(pkg.text.includes(marker), `${command}: ${marker}`);
  }
});

test('UX-10: the extra card never carries a file of its own: no entry file is shown (it would not be pinned by the approval)', t => {
  const r = selfRunRig(t, undefined, FILES);
  assert.deepEqual(pathsOf(shellPreCheck({ command: 'npm run x' }, r.ctx)), ['package.json#scripts', 'package.json']);
  assert.deepEqual(pathsOf(shellPreCheck({ command: 'npm run keep' }, r.ctx)), ['package.json#scripts', 'package.json']);
  assert.deepEqual(pathsOf(shellPreCheck({ command: 'npm run big' }, r.ctx)), ['package.json#scripts', 'package.json']);
});

test('UX-10: a NUL in a script line does not make the call throw: the decision stays ask, the card is the whole file', t => {
  const r = selfRunRig(t, undefined, FILES);
  const pre = shellPreCheck({ command: 'npm run nul' }, r.ctx);
  assert.equal(pre.decision, 'ask');
  const cards = cardOf(pre);
  assert.equal(cards.find(p => p.path === 'package.json')!.text, baseText(cards.find(p => p.path === 'package.json')!.abs));
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

test('the label of the extra card does not say the lines are all of them, or sure', () => {
  assert.match(LIKELY, /^Some of the lines likely to run/u);
  assert.match(LIKELY, /Other lines can run too/u);
  assert.doesNotMatch(LIKELY, /whole file is below|^Will run|^Likely to run/u);
  assert.equal(guardText('en', 'card.likely'), LIKELY);
});

test('UX-10: the label of the extra card comes from the guard messages, not from text inside the card code', t => {
  const r = selfRunRig(t, undefined, FILES);
  const table = guardText.tables.en as Record<string, string>;
  const saved = table['card.likely']!;
  assert.equal(saved, LIKELY);
  table['card.likely'] = 'LIKELY-MARK';
  try {
    const card = cardOf(shellPreCheck({ command: 'npm run keep' }, r.ctx));
    assert.equal(card[0]!.text, ['LIKELY-MARK', line('keep')].join('\n'));
  } finally {
    table['card.likely'] = saved;
  }
});

test('UX-10: if building the extra card fails, the cards are exactly the base ones (the whole package.json only) and the decision is not touched', t => {
  const r = selfRunRig(t, undefined, FILES);
  const table = guardText.tables.en as Record<string, string>;
  const saved = table['card.likely']!;
  delete table['card.likely'];
  try {
    const pre = shellPreCheck({ command: 'npm run x' }, r.ctx);
    assert.equal(pre.decision, 'ask');
    const cards = cardOf(pre);
    assert.deepEqual(cards.map(p => p.path), ['package.json']);
    assert.equal(cards[0]!.text, baseText(cards[0]!.abs));
  } finally {
    table['card.likely'] = saved;
  }
});

test('UX-10: the bind is exactly the base one: package.json and the shown files only, so the entry file and the extra card do not change it (a rule such as "always allow npm start" keeps matching)', t => {
  const r = selfRunRig(t, undefined, FILES);
  const bind = (command: string) => shellPreCheck({ command }, r.ctx).bind;
  const pkgPath = cardOf(shellPreCheck({ command: 'npm start' }, r.ctx)).find(p => p.path === 'package.json')!.abs;
  const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
  const fingerprint = `${pkgPath}\0${sha(readFileSync(pkgPath))}`;
  const baseBind = sha([fingerprint, fingerprint].join('\n'));
  const before = bind('npm start');
  assert.equal(before, baseBind, 'the hash of the file fingerprints that the base code makes (the card file, then the shown file)');
  assert.equal(bind('npm run x'), baseBind, 'a command with an extra card of other lines has the same bind');
  assert.equal(bind('npm run x --if-present'), baseBind, 'and so does one with no extra card at all');
  writeFileSync(join(r.ws, 'src/server.ts'), "console.log('changed');\n");
  writeFileSync(join(r.ws, 'src/cli.ts'), "console.log('changed');\n");
  assert.equal(bind('npm start'), before, 'the entry file is not in the bind');
  writeFileSync(join(r.ws, 'package.json'), JSON.stringify({ ...PACKAGE, description: 'changed' }, null, 2));
  assert.notEqual(bind('npm start'), before, 'the whole package.json is pinned');
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

test('UX-10: through the pipeline, the waiting Pending row carries the extra card in front of the whole package.json', async t => {
  const r = selfRunRig(t, undefined, FILES);
  const out = await r.call('shell_run', { command: 'npm run x' }, { ...r.ctx, kind: 'chat', task: undefined, project: undefined });
  assert.equal(out.decidedBy, 'pending', out.output.content);
  const [row] = r.pending.list({ status: 'waiting' });
  assert.deepEqual(row!.preview.map(p => rel(p.path)), ['package.json#scripts', 'package.json']);
  assert.equal(row!.preview[0]!.text, likely(line('prex'), line('x'), line('postx')));
  assert.equal(row!.preview[1]!.text, baseText(row!.preview[1]!.path));
  assert.deepEqual(r.ran, []);
});

test('a script line that changes folder first (cd, pushd, Set-Location, sl, Push-Location, popd) is followed no further: the next npm run is another package.json, not this one', t => {
  const r = selfRunRig(t, undefined, FILES);
  for (const command of ['npm run cdrun', 'npm run cdpush', 'npm run setloc']) {
    const card = extraOf(cardOf(shellPreCheck({ command }, r.ctx)));
    assert.equal(card.length, 1, command);
    assert.ok(!card[0]!.text.includes('ROOT-GO-MARKER'), `${command}: the root go script is not what runs after the cd: ${card[0]!.text}`);
  }
  assert.deepEqual(extraOf(cardOf(shellPreCheck({ command: 'npm run both' }, r.ctx))).map(p => p.text), [likely(line('both'), line('prex'), line('x'), line('postx'))], 'what runs before the cd is still followed');
  assert.ok(extraOf(cardOf(shellPreCheck({ command: 'npm run plainchain' }, r.ctx)))[0]!.text.includes('ROOT-GO-MARKER'), 'without a cd, the chain is followed as before');
});

test('UX-10: a script that calls itself shows its line once', t => {
  const r = selfRunRig(t, undefined, FILES);
  const card = cardOf(shellPreCheck({ command: 'npm run loop' }, r.ctx));
  assert.deepEqual(extraOf(card).map(p => p.text), [likely('"loop": "npm run loop"')]);
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

test('L55 (S): the shell tool description tells that Windows PowerShell 5.1 has no && or || (and shows the form that stops on failure) and no rm -rf', () => {
  assert.match(shellRun.description, /PowerShell 5\.1[^.]*&&[^.]*\|\|[^.]*cmd1; if \(\$\?\) \{ cmd2 \}[^.]*rm -rf[^.]*Remove-Item -Recurse -Force/u);
});
