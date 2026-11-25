import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { productRunOf, type ProductRunResult } from '../src/tools/hooks/product-run.ts';
import type { ScopePolicy } from '../src/tools/hooks/scope.ts';
import { checkShellCommand } from '../src/tools/hooks/shell-guard.ts';
import { tempDir } from './helpers.ts';

// L164: 名前の一部に secret / credential があるだけのソースコードの git add で、持ち主へ回さない。鍵らしい形（データの形・.env）は今までどおり

const gitAvailable = spawnSync('git', ['--version']).status === 0;

function git(cwd: string, args: string[]): string | undefined {
  const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  return done.status === 0 ? done.stdout : undefined;
}

function product(t: Parameters<typeof tempDir>[0]) {
  const product = join(realpathSync.native(tempDir(t)), 'product');
  mkdirSync(product);
  assert.notEqual(git(product, ['init', '-q', '-b', 'main']), undefined);
  assert.notEqual(git(product, ['commit', '-q', '--allow-empty', '-m', 'first']), undefined);
  const policy: ScopePolicy = { roots: [{ path: product, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(dirname(product), 'skills') };
  const put = (name: string): void => { mkdirSync(dirname(join(product, name)), { recursive: true }); writeFileSync(join(product, name), 'x'); };
  const stepFour = (command: string): ProductRunResult => {
    const verdict = checkShellCommand(command, product, { policy, outsideRoots: 'ask', shell: 'bash', windows: false });
    assert.equal(verdict.decision, 'ask', `${command}: 前提（順 4 まで届く）`);
    return productRunOf({ root: product, verdict, which: () => undefined, ownerHooks: () => false, git: (dir, args) => git(dir, args) });
  };
  return { product, put, stepFour };
}

const EVERYDAY = ['secret-manager.ts', 'credentials-form.tsx', 'src/secrets-loader.py', 'lib/secret_store.go', 'web/Credential.vue', 'docs/credentials.md', 'ui/secrets.css', 'SecretService.java', 'app/credentials_helper.rb'];
const DATA_SHAPES = ['secrets.json', 'credentials.yml', 'credentials.yaml', 'prod.env', 'my-secret.txt', 'credentials', 'deploy-credentials.json', 'secret-manager.ts.bak', 'secrets.ts.env', 'config/secrets.toml', 'SECRET.JSON'];

test('L164: 名前の一部に secret / credential があるソースコード（.ts .tsx .py .go .vue .md .css など）の git add は、判定役を飛ばす順 4 のまま通る', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  for (const name of EVERYDAY) {
    p.put(name);
    assert.deepEqual(p.stepFour(`git add ${name}`), { run: 'product-git' }, `${name}: 名前を書いた add`);
  }
  assert.deepEqual(p.stepFour('git add -A'), { run: 'product-git' }, '名前を挙げない add -A も、ソースだけなら通る');
  assert.deepEqual(p.stepFour('git add .'), { run: 'product-git' }, 'add . も同じ');
  assert.deepEqual(p.stepFour('git add secret-manager.ts credentials-form.tsx && git commit -m "add the secret manager"'), { run: 'product-git' }, '続けた commit も通る');
});

test('L164 対照: データの形（.json .yml .yaml .toml・拡張子なし）・.env で終わる名前・ソースの拡張子に見せかけた別の拡張子は、今までどおり持ち主へ回る', { skip: !gitAvailable && 'git が無い' }, t => {
  for (const name of DATA_SHAPES) {
    const p = product(t);
    p.put(name);
    assert.deepEqual(p.stepFour(`git add ${name}`), { secret: name }, `${name}: 名前を書いた add`);
    assert.deepEqual(p.stepFour('git add -A'), { secret: name }, `${name}: add -A でも見つける`);
  }
});

test('L164 対照: ソースの名前が並んでいても、データの形が 1 つ混ざれば持ち主へ回る。add -A で拾う isSecretPath の判定（.env.* ・secrets/ のフォルダ・.pem・名前が secret だけ）は変わらない', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  for (const name of EVERYDAY) p.put(name);
  p.put('secrets.json');
  assert.deepEqual(p.stepFour('git add secret-manager.ts secrets.json'), { secret: 'secrets.json' }, '名前を並べた add');
  assert.deepEqual(p.stepFour('git add -A'), { secret: 'secrets.json' }, 'add -A');
  for (const [name, found] of [['.env.ts', '.env.ts'], ['secrets/readme.md', 'secrets/readme.md'], ['keys/server.pem', 'keys/server.pem'], ['config/.env.production.ts', 'config/.env.production.ts'], ['secret', 'secret']] as const) {
    const q = product(t);
    q.put(name);
    assert.deepEqual(q.stepFour('git add -A'), { secret: found }, `${name}: add -A でも`);
  }
});

test('L164 対照: isSecretPath に当たる名前を直接書いた add は、順 4 より前の見張りが今までどおり止める（この束で緩めていない）', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  for (const name of ['secret', '.env.ts', 'secrets/readme.md', 'keys/server.pem', 'config/.env.production.ts']) {
    const verdict = checkShellCommand(`git add ${name}`, p.product, { policy: { roots: [{ path: p.product, mode: 'write' }], deny: [], askOnWrite: [], skillsDir: join(dirname(p.product), 'skills') }, outsideRoots: 'ask', shell: 'bash', windows: false });
    assert.equal(verdict.decision, 'deny', name);
  }
});

test('L164 対照: 鍵の入ったコミットメッセージの確かめは、ソースの名前を足した add のあとでも働く', { skip: !gitAvailable && 'git が無い' }, t => {
  const p = product(t);
  p.put('secret-manager.ts');
  assert.deepEqual(p.stepFour('git add secret-manager.ts && git commit -m "key AKIAABCDEFGHIJKLMNOP"'), { secretMessage: true });
});
