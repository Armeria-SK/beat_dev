import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSecretPath, placePath, type ScopePolicy } from '../src/tools/hooks/scope.ts';
import { tempDir } from './helpers.ts';

const LOADER = new URL('./helpers/tsx-loader.mjs', import.meta.url).href;
const PROTECT_FILES = pathToFileURL(fileURLToPath(new URL('../src/tools/hooks/protect-files.ts', import.meta.url))).href;

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
