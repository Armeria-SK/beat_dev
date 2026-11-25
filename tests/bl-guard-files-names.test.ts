import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSecretPath, placePath, writeApprovalKind, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { tempDir } from './helpers.ts';

const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const PROTECT_FILES = pathToFileURL(fileURLToPath(new URL('../src/tools/hooks/protect-files.ts', import.meta.url))).href;
const SCOPE = pathToFileURL(fileURLToPath(new URL('../src/tools/hooks/scope.ts', import.meta.url))).href;

// 168: Files の欄が隠している名前（files-routes.test.ts の 8-5a の一覧から、credentials.json・service-account*.json を除く）は、道具からも秘密として断る。
// credentials.json は decision-order.test.ts が「git add は持ち主へ」と決めているので、ここでは足さない（断るか聞くかの決めが要る）
const FILES_VIEW_SECRETS = [
  '_netrc', '.envrc', 'key.ppk', 'id_ed25519_sk', 'id_ecdsa_sk.pub',
  '.pgpass', '.yarnrc.yml', 'terraform.tfvars', 'prod.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup', '.vault-token', '.s3cfg', '.boto', '.config/gh/hosts.yml',
];

test('168: isSecretPath は、Files の欄で隠している名前（_netrc・.envrc・*.ppk・*.tfvars・*.tfstate など）も秘密として扱う', () => {
  for (const name of FILES_VIEW_SECRETS) {
    assert.equal(isSecretPath(`/work/p/${name}`), true, name);
    assert.equal(isSecretPath(`C:\\work\\p\\${name.replaceAll('/', '\\')}`), true, `${name} (Windows)`);
    assert.equal(isSecretPath(`/work/p/${name}`, 'files'), true, `${name} (files)`);
    assert.equal(isSecretPath(`/work/p/${name}`, 'none'), false, `${name} (none)`);
  }
});

test('168: 名前が似ているだけのふつうのファイルは、秘密にしない', () => {
  for (const name of ['src/credentials.ts', 'docs/service-account.md', 'credentials.json.md', 'key.ppk.txt', 'ppk.ts', 'a.tfvars.example', 'terraform.tfstate.d/readme.md', 'hosts.yml', '.config/gh/config.yml', '.config/gh/hosts.yml.md', 'id_ed25519_sk.txt', 'my.envrc.md', 'netrc.ts']) {
    assert.equal(isSecretPath(`/work/p/${name}`), false, name);
  }
});

test('168: 読み書きの置き場の判定（placePath）も、足した名前を secret の理由で断る', t => {
  const root = tempDir(t);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [] };
  for (const name of ['key.ppk', 'terraform.tfvars', '.envrc', '.config/gh/hosts.yml']) {
    const placed = placePath(join(root, name), policy);
    assert.equal(placed.kind, 'deny', name);
  }
  assert.equal(placePath(join(root, 'notes.txt'), policy).kind, 'inside');
});

// 161: macOS の APFS（大文字小文字を区別しない）を想定して、Windows 以外でも守る一覧を大文字小文字を畳んで照らす。
// 試験は Windows でも動くように、子のプロセスで process.platform を linux に見せてから読み込む
function runAsLinux(root: string, always: string[], paths: string[]): Array<string | null> {
  const script = [
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    `const { runProtectFiles } = await import(${JSON.stringify(PROTECT_FILES)});`,
    'const input = JSON.parse(process.env.BL_CASE);',
    "const hook = { matcher: '.*', builtin: 'protect-files', always: input.always };",
    'const out = input.paths.map(path => runProtectFiles(hook, { hook_event_name: \'PreToolUse\', tool_name: \'file_write\', tool_input: {}, cwd: input.root, run_id: \'r\', conversation_id: \'c\', paths: [{ path, write: true }], project_root: input.root }).decision ?? null);',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, BL_CASE: JSON.stringify({ root, always, paths }) },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Array<string | null>;
}

// ワイルドカードの残りの段の照らし合わせ。試験機が Windows でも（node:path の比べ方が元から畳むので、ここは畳みの有無がそのまま出る）赤くなる
test('161: Windows 以外でも、守る一覧のワイルドカードの残りの段は大文字小文字を畳んで照らす', t => {
  const root = join(tempDir(t), 'prod');
  mkdirSync(join(root, 'src'), { recursive: true });
  const got = runAsLinux(root, ['ci/*.yml', '**/AGENTS.md', 'docs/*.MD'], [
    join(root, 'ci', 'Deploy.YML'),
    join(root, 'sub', 'Agents.md'),
    join(root, 'docs', 'readme.md'),
  ]);
  assert.deepEqual(got, ['ask', 'ask', 'ask']);
});

// 名前そのもの・フォルダの段の照らし合わせ。macOS・Linux では isInside が畳まないことで外れていた部分（Windows の試験機では元から当たるので、ここは赤くならない）
test('161: Windows 以外でも、守る一覧の名前・フォルダは大文字小文字を畳んで照らす（まだ無い名前でも、別の書き方で外せない）', t => {
  const root = join(tempDir(t), 'prod');
  mkdirSync(join(root, 'src'), { recursive: true });
  const got = runAsLinux(root, ['.github/workflows/**', 'AGENTS.md'], [
    join(root, '.GitHub', 'WorkFlows', 'CI.yml'),
    join(root, 'agents.md'),
    join(root, 'Agents.MD'),
    join(root, '.GITHUB'),
  ]);
  assert.deepEqual(got, ['ask', 'ask', 'ask', 'ask']);
});

test('161: 畳むのは守る側へだけ。一覧に当たらない名前は、大文字小文字を畳んでも当たらないまま', t => {
  const root = join(tempDir(t), 'prod');
  mkdirSync(join(root, 'src'), { recursive: true });
  const got = runAsLinux(root, ['.github/workflows/**', 'AGENTS.md', 'ci/*.yml'], [
    join(root, 'src', 'A.ts'),
    join(root, 'AGENTS.md.bak'),
    join(root, 'cicd', 'x.yml'),
    join(root, '.github', 'other.yml'),
  ]);
  assert.deepEqual(got, [null, null, null, null]);
});

// 161（レビューの指摘）: 指示ファイル・スキル・人格の書き込みの守り（writeApprovalKind）も、macOS の APFS では大文字小文字を畳んで照らす。
// POSIX の見た目を子のプロセスで模す: process.platform を linux にし、node:path を posix の関数に替え、fs は「何も無い」を返す（Windows の node:path は元から畳むので、そのままでは赤くならない）
function simulatedPosix(module: string, body: string): unknown {
  const script = [
    "import path from 'node:path';",
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    `const mod = await import(${JSON.stringify(module)});`,
    "for (const k of ['resolve', 'relative', 'join', 'dirname', 'basename', 'isAbsolute', 'normalize', 'parse', 'sep', 'delimiter']) path[k] = path.posix[k];",
    'fs.existsSync = () => false;',
    "fs.lstatSync = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };",
    'syncBuiltinESMExports();',
    body,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', LOADER, '--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('161（POSIX を模す）: 指示ファイル・スキルのフォルダ・人格の書き込みの守りは、大文字小文字を畳んで照らす', () => {
  const got = simulatedPosix(SCOPE, [
    "const policy = { roots: [{ path: '/p', mode: 'write' }], deny: [], instructions: ['/p/AGENTS.md'], skillsDir: '/p/Skills', askOnWrite: ['/p/SOUL.md', '/p/AGENTS.md'] };",
    "const kinds = ['/p/agents.md', '/p/AGENTS.md', '/p/Agents.MD', '/p/skills/x.md', '/p/soul.md', '/p/AGENTS.md.bak', '/p/agentsx.md', '/p/other.md'].map(p => mod.writeApprovalKind(p, policy) ?? null);",
    'process.stdout.write(JSON.stringify(kinds));',
  ].join('\n'));
  assert.deepEqual(got, ['instructions', 'instructions', 'instructions', 'skill', 'persona', null, null, null]);
});

test('161（POSIX を模す）: 守る一覧（protect-files）の名前・フォルダも、大文字小文字を畳んで照らす', () => {
  const got = simulatedPosix(PROTECT_FILES, [
    "const hook = { matcher: '.*', builtin: 'protect-files', always: ['.github/workflows/**', 'AGENTS.md'] };",
    "const decide = path => mod.runProtectFiles(hook, { hook_event_name: 'PreToolUse', tool_name: 'file_write', tool_input: {}, cwd: '/p', run_id: 'r', conversation_id: 'c', paths: [{ path, write: true }], project_root: '/p' }).decision ?? null;",
    "process.stdout.write(JSON.stringify(['/p/.GitHub/WorkFlows/CI.yml', '/p/agents.md', '/p/.GITHUB', '/p/src/a.ts', '/p/AGENTS.md.bak'].map(decide)));",
  ].join('\n'));
  assert.deepEqual(got, ['ask', 'ask', 'ask', null, null]);
});

test('161: （実機の POSIX のみ）指示ファイルの書き込みの守りは、まだ無い小文字の名前にも効く', { skip: process.platform === 'win32' && 'Windows では node:path が元から畳む（上の「模す」試験が見る）' }, t => {
  const root = tempDir(t);
  const policy: ScopePolicy = { roots: [{ path: root, mode: 'write' }], deny: [], instructions: [join(root, 'AGENTS.md')] };
  assert.equal(writeApprovalKind(join(root, 'agents.md'), policy), 'instructions');
  assert.equal(writeApprovalKind(join(root, 'notes.md'), policy), undefined);
});

// 161（レビューの指摘）: toLowerCase は文字数を変えうる（İ U+0130 は i と結合の点の 2 文字）。? が 1 文字に当たらなくなって、畳む前より緩んではいけない
test('161: 畳んで長さが変わる文字（İ）にも、? は 1 文字として当たる。畳む前に当たったものは、畳んでも当たる', t => {
  const root = join(tempDir(t), 'prod');
  mkdirSync(join(root, 'docs'), { recursive: true });
  assert.deepEqual(runAsLinux(root, ['docs/?.md'], [join(root, 'docs', 'İ.md')]), ['ask']);
  assert.deepEqual(runAsLinux(root, ['k/??'], [join(root, 'k', 'İx')]), ['ask']);
  assert.deepEqual(runAsLinux(root, ['docs/?.md'], [join(root, 'docs', 'A.md'), join(root, 'docs', 'İ.md'), join(root, 'docs', 'İİ.md')]), ['ask', 'ask', null], '? は 1 文字だけ');
  assert.deepEqual(runAsLinux(root, ['docs/*.md'], [join(root, 'docs', 'İ.md'), join(root, 'docs', 'İİ.md')]), ['ask', 'ask'], '* は何文字でも');
  assert.deepEqual(runAsLinux(root, ['docs/İ*.md'], [join(root, 'docs', 'İx.md'), join(root, 'docs', 'ix.md')]), ['ask', null], '一覧に İ を書いても、畳む前と同じに当たる');
});
