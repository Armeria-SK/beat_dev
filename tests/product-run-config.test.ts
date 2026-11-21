import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { productEnvNames, productEnvPath, productEnvReader } from '../src/tools/hooks/product-env.ts';
import { DEFAULT_PROTECT_FILES } from '../src/tools/hooks/protect-files.ts';
import { productRunOf } from '../src/tools/hooks/product-run.ts';
import { realish, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { productEnvOk } from '../src/tools/hooks/allowlist-core.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

function product(t: { after: (fn: () => void) => void }, files: Record<string, string>) {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'test_a.py'), '');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(base, 'skills') };
  return (command: string): string | undefined => {
    const verdict = checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
    if (verdict.decision !== 'ask') return undefined;
    const result = productRunOf({ root, verdict, which: () => undefined, ownerHooks: () => false, git: () => undefined });
    return result && 'run' in result ? result.run : undefined;
  };
}

test('pytest・tox: 製品のフォルダにその実行役の設定（節）があるときだけ順 4。節の無い設定や conftest.py だけでは、上のフォルダの設定を拾いうるので順 4 にしない', t => {
  const cases: Array<[Record<string, string>, string, string | undefined]> = [
    [{ 'pytest.ini': '' }, 'pytest tests', 'product-code'],
    [{ '.pytest.ini': '' }, 'pytest tests', 'product-code'],
    [{ 'pyproject.toml': '[project]\r\nname = "x"\r\n\r\n[tool.pytest.ini_options]\r\naddopts = "-q"\r\n' }, 'pytest tests', 'product-code'],
    [{ 'tox.ini': '[tox]\nenvlist = py\n\n[pytest]\naddopts = -q\n' }, 'pytest tests', 'product-code'],
    [{ 'setup.cfg': '[metadata]\nname = x\n[tool:pytest]\n' }, 'pytest tests', 'product-code'],
    [{ 'conftest.py': '' }, 'pytest tests', undefined],
    [{ 'pyproject.toml': '[project]\nname = "x"\n# [tool.pytest.ini_options]\n' }, 'pytest tests', undefined],
    [{ 'tox.ini': '[tox]\nenvlist = py\n' }, 'pytest tests', undefined],
    [{ 'setup.cfg': '[metadata]\nname = x\n' }, 'pytest tests', undefined],
    [{ 'tox.ini': '[tox]\nenvlist = py\n' }, 'tox', 'product-code'],
    [{ 'pyproject.toml': '[tool.tox]\nlegacy_tox_ini = ""\n' }, 'tox', 'product-code'],
    [{ 'setup.cfg': '[tox:tox]\nenvlist = py\n' }, 'tox', 'product-code'],
    [{ 'pyproject.toml': '[project]\nname = "x"\n' }, 'tox', undefined],
    [{ 'setup.cfg': '[tool:pytest]\n' }, 'tox', undefined],
  ];
  const wrong = cases.flatMap(([files, command, want]) => {
    const got = product(t, files)(command);
    return got === want ? [] : [`${Object.keys(files).join(',')} / ${command}: ${got} (want ${want})`];
  });
  assert.deepEqual(wrong, []);
});

function productRun(t: { after: (fn: () => void) => void }, files: Record<string, string>, shell: 'bash' | 'powershell') {
  const base = tempDir(t);
  const root = realish(join(base, 'prod'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(base, 'skills') };
  return (command: string): string | undefined => {
    const verdict = checkShellCommand(command, root, { policy, outsideRoots: 'ask', shell, windows: shell === 'powershell', productEnv: productEnvReader(root) });
    if (verdict.decision !== 'ask') return undefined;
    const result = productRunOf({ root, verdict, which: () => undefined, ownerHooks: () => false, git: () => undefined });
    return result && 'run' in result ? result.run : undefined;
  };
}

test('self-run P1 1a: node の決まった旗のあとのファイルが製品の中なら順 4。製品の外・決まっていない旗は順 4 にしない', t => {
  const run = productRun(t, { 'package.json': '{}', 'scripts/e2e.ts': '' }, 'bash');
  for (const c of ['node --disable-warning=ExperimentalWarning scripts/e2e.ts', 'node --no-warnings --enable-source-maps scripts/e2e.ts', 'node scripts/e2e.ts']) assert.equal(run(c), 'product-code', c);
  for (const c of ['node --no-warnings ../x.ts', 'node --watch scripts/e2e.ts', 'node --require ./scripts/e2e.ts scripts/e2e.ts', 'node --import ./scripts/e2e.ts scripts/e2e.ts']) assert.equal(run(c), undefined, c);
});

test('self-run P1 1b: $env: への文字の代入（通してよい名前・製品のコードが読む名前）のあとの npm start は順 4。道具の読む名前・値の形が外れるものは順 4 にしない', t => {
  const run = productRun(t, { 'package.json': '{"scripts":{"start":"node scripts/server.ts"}}', 'scripts/server.ts': "const db = process.env['ROOMS_DB'];\nconst p = process.env.PORT;\n" }, 'powershell');
  for (const c of ['$env:ROOMS_DB=".tmp/start-check.db"; $env:PORT="3999"; npm start', "$env:NODE_ENV='test'; npm test", "$env:rooms_db='x.db'; npm start"]) assert.equal(run(c), 'product-code', c);
  for (const c of ["$env:OTHER_DB='x.db'; npm start", "$env:npm_config_userconfig='x'; npm start", "$env:NODE_OPTIONS='--require ./x.js'; npm start", "$env:BROWSER='x'; npm start",
    "$env:ROOMS_DB='C:\\x.db'; npm start", "$env:ROOMS_DB='../x.db'; npm start", '$env:ROOMS_DB="$x"; npm start', "$env:ROOMS_DB='http://e.example/'; npm start"]) {
    assert.equal(run(c), undefined, c);
  }
});

test('self-run P1 1b: 製品のコードが読む env の名前を拾う（process.env.X・process.env[X]・os.environ[X]・os.getenv(X)・Deno.env.get(X)）。node_modules・.git の中は見ない', t => {
  const root = realish(join(tempDir(t), 'prod'));
  for (const dir of ['src', 'node_modules/dep', '.git']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), "process.env.A_ONE; process.env['A_TWO']; process.env[`A_THREE`]; Deno.env.get('A_FOUR');\n");
  writeFileSync(join(root, 'src', 'b.py'), "os.environ['B_ONE']\nos.getenv(\"B_TWO\", 'x')\n");
  writeFileSync(join(root, 'src', 'c.md'), 'process.env.NOT_CODE\n');
  writeFileSync(join(root, 'node_modules', 'dep', 'i.js'), 'process.env.IN_DEP;\n');
  writeFileSync(join(root, '.git', 'h.js'), 'process.env.IN_GIT;\n');
  assert.deepEqual([...productEnvNames(root)].sort(), ['A_FOUR', 'A_ONE', 'A_THREE', 'A_TWO', 'B_ONE', 'B_TWO']);
});

test('再審査 P1: 製品のコードが読んでいても、道具・OS の動きを変える名前（*_PROXY・SSL_CERT_*・*_CA_BUNDLE・SystemRoot・windir・TEMP・TMP・COREPACK_*・CC・CXX・LD）は通さない', () => {
  const word = (text: string) => ({ text, dynamic: false, glob: false, quoted: true, home: false, kind: 'plain' as const });
  for (const name of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'COREPACK_HOME', 'CC', 'CXX', 'LD']) {
    assert.equal(productEnvOk(name, word('x'), () => true), false, name);
  }
  assert.equal(productEnvOk('ROOMS_DB', word('x.db'), () => true), true, 'a plain product name still passes');
});

test('再審査 P1: 製品のコードが読む名前の走査は、同じ製品なら 30 秒は使い回す（あとから足した名前は、その間は通さない）', t => {
  const root = realish(join(tempDir(t), 'prod'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'process.env.FIRST_NAME;\n');
  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(productEnvReader(root, now)('FIRST_NAME'), true);
  writeFileSync(join(root, 'src', 'b.ts'), 'process.env.LATER_NAME;\n');
  assert.equal(productEnvReader(root, now)('LATER_NAME'), false, 'cached: not scanned again');
  clock += 31_000;
  assert.equal(productEnvReader(root, now)('LATER_NAME'), true, 'scanned again after 30 s');
});

test('v3 P3 productEnvPath: env の絶対パスの値は、製品の外の守っていないフォルダと製品の中なら通す。beat のデータのフォルダ（製品の中は除く）・秘密・守る場所・決まりで断る場所・ドライブの根・UNC・..・相対・~ は断る', t => {
  const base = realish(tempDir(t));
  const data = join(base, 'data');
  const root = join(data, 'projects', 'p');
  const install = join(base, 'beat');
  mkdirSync(root, { recursive: true });
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [join(base, 'denied')], askOnWrite: [join(data, 'SOUL.md')], skillsDir: join(data, 'skills'), guarded: { roots: [install] } };
  const ok = productEnvPath({ root, dataDir: data, policy, protect: [DEFAULT_PROTECT_FILES] });
  const drive = /^[A-Za-z]:/u.test(base) ? base.slice(0, 3) : '/';
  const yes = [join(base, 'study-demo-data'), join(root, 'data'), join(root, 'data', 'study.sqlite')];
  const no = [data, join(data, 'backups'), join(data, 'projects', 'other'), join(base, '.ssh', 'x'), join(base, 'denied', 'x'), join(data, 'skills', 'x'), join(root, '.git', 'hooks'),
    join(root, '.github', 'workflows'), join(root, '.github'), join(install, 'x'), drive, '\\\\server\\share\\x', '//server/share/x', `${root}${sep}..${sep}x`, 'data', '~/x', 'C:data'];
  assert.deepEqual(yes.filter(v => !ok(v)), [], 'passes');
  assert.deepEqual(no.filter(ok), [], 'refused');
  const bare = productEnvPath({ root, dataDir: data, policy, protect: [] });
  assert.equal(bare(drive), false, 'the drive root is refused without the protect-files hook too');
  assert.equal(bare(join(root, '.github')), true, 'without the hook, nothing is protected there');
  const word = (text: string) => ({ text, dynamic: false, glob: false, quoted: true, home: false, kind: 'plain' as const });
  assert.equal(productEnvOk('DATA_DIR', word(yes[0]!), () => true, ok), true);
  assert.equal(productEnvOk('DATA_DIR', word(yes[0]!), () => true), false, 'without the path check an absolute value is refused as before');
  assert.equal(productEnvOk('NODE_OPTIONS', word(yes[0]!), () => true, ok), false);
  assert.equal(productEnvOk('npm_config_userconfig', word(yes[0]!), () => true, ok), false);
  assert.equal(productEnvOk('OTHER_DIR', word(yes[0]!), () => false, ok), false, 'a name the product does not read');
  assert.equal(productEnvOk('DATA_DIR', word('https://e.example/x'), () => true, () => true), false);
});
