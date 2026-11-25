import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { isSecretPath, SECRET_GLOBS } from '../src/tools/hooks/scope.ts';
import { fakeModel, startApp } from './app-setup.ts';
import { tempDir } from './helpers.ts';

// L438・L166: 作業コピーの片付け（merge-watch）が鍵らしいファイルを止める名前の一覧は、isSecretPath と同じ 1 か所（SECRET_GLOBS）から作る

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const put = (root: string, rel: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), 'only-copy\n');
};

// isSecretPath が秘密とみなす名前の見本（SECRET_PATTERNS の 1 つ 1 つと、secret・secrets のフォルダに 1 つ以上）
const SECRET_SAMPLES = [
  '.env', '.env.local', 'config/.env', 'a.pem', 'a.key', 'a.p12', 'a.pfx', 'a.keystore', 'a.jks',
  'id_rsa', 'id_rsa.pub', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.ssh/config', '.aws/credentials', '.gnupg/key', '.docker/config.json', '.kube/config',
  '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '_netrc', '.envrc', '.pgpass', '.yarnrc.yml', '.vault-token', '.s3cfg', '.boto', 'deploy.ppk', 'id_ecdsa_sk', 'id_ed25519_sk',
  'prod.tfvars', 'prod.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup', '.config/gh/hosts.yml',
  'secret/a.txt', 'secrets/token.txt',
];
// 片付けだけが止める名前（HELD_NAME か service-account*.json。beat の道具の読み書きは断らない）
const CLEANUP_ONLY_SAMPLES = ['app.env', 'credentials.json', 'secrets.yaml', 'service-account-prod.json', 'infra/Service-Account.json'];

const specOf = (glob: string): string => `:(glob,icase)${glob}`;
const foundBy = (root: string, ...globs: string[]): string[] => git(root, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...globs.map(specOf)).split('\0').filter(Boolean);

function ignoredRepo(t: Parameters<typeof tempDir>[0], names: readonly string[]): string {
  const root = realpathSync.native(tempDir(t));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '*\n');
  for (const name of names) put(root, name);
  return root;
}

function secretRegexes(): RegExp[] {
  const source = readFileSync(new URL('../src/tools/hooks/scope.ts', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  const block = /const SECRET_PATTERNS = \[\n([\s\S]*?)\n\];/u.exec(source)?.[1];
  assert.ok(block, 'SECRET_PATTERNS の定義が読める');
  const lines = block.split('\n').filter(line => line.trim() !== '');
  const parsed = lines.map(line => /^\s*\/(.+)\/([a-z]*),\s*$/u.exec(line));
  const skipped = lines.filter((_, i) => parsed[i] === null || /\/[a-z]*,\s*\//u.test(parsed[i]![1]!));
  assert.deepEqual(skipped, [], 'SECRET_PATTERNS の行は、1 行に正規表現 1 つ + 末尾のカンマで書く（読めない行がある）');
  return parsed.map(m => new RegExp(m![1]!, m![2]));
}

test('L438: isSecretPath の正規表現 1 つ 1 つに見本の名前があり、その名前は SECRET_GLOBS の pathspec でも git が見つける（片方だけ足すと落ちる）', { skip: !gitAvailable }, t => {
  const regexes = secretRegexes();
  assert.ok(regexes.length >= 11, `正規表現が読めた: ${regexes.length}`);
  for (const re of regexes) assert.ok(SECRET_SAMPLES.some(name => re.test(name)), `この正規表現に当たる見本の名前が無い（見本と glob を足す）: ${re}`);
  for (const name of SECRET_SAMPLES) assert.equal(isSecretPath(name), true, `${name} は isSecretPath で秘密`);

  const root = ignoredRepo(t, [...SECRET_SAMPLES, ...CLEANUP_ONLY_SAMPLES]);
  const found = new Set(foundBy(root, ...SECRET_GLOBS));
  for (const name of [...SECRET_SAMPLES, ...CLEANUP_ONLY_SAMPLES]) assert.ok(found.has(name), `${name} が SECRET_GLOBS の pathspec で見つからない`);
  for (const glob of SECRET_GLOBS) assert.ok(foundBy(root, glob).length > 0, `${glob} に当たる見本の名前が無い（足すか、いらなければ消す）`);
});

test('L166: service-account*.json は片付けの一覧には入るが、isSecretPath（道具の読み書きを断る側）には入れない', () => {
  assert.ok(SECRET_GLOBS.includes('**/service-account*.json'));
  for (const name of CLEANUP_ONLY_SAMPLES) assert.equal(isSecretPath(name), false, `${name} は道具の読み書きを断らない`);
});

async function rig(t: Parameters<typeof startApp>[0]) {
  const products = realpathSync.native(tempDir(t as never));
  const s = await startApp(t, { models: [fakeModel('m1')], projectFolderExempt: [products], tools: builtinTools() });
  const product = async (name: string, ignore: string) => {
    const root = join(products, name);
    mkdirSync(root, { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    writeFileSync(join(root, '.gitignore'), ignore);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'first');
    const made = await s.json('/api/projects', 'POST', { root });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return { id: made.body.project.id as string, root };
  };
  const branchTask = async (p: { id: string; root: string }, title: string) => {
    const task = s.app.tasks.create({ title, origin: 'user', actor: 'user', projectId: p.id, ownerRequest: true });
    const made = await s.app.worktrees.createWorktree({ projectId: p.id, root: p.root, kind: 'task', taskId: task.id, title });
    assert.ok(made.ok, JSON.stringify(made));
    writeFileSync(join(made.row.path!, `${title.replace(/\W/gu, '')}.txt`), 'fixed\n');
    const done = await s.app.worktrees.finishWorktree(made.row.id, { commitLeftovers: true, message: title });
    assert.ok(done.ok && done.committed, JSON.stringify(done));
    s.app.tasks.finish(task.id, 'done', 'finished', 'beat');
    return { task: s.app.tasks.get(task.id)!, row: s.app.worktrees.get(made.row.id)! };
  };
  return { ...s, product, branchTask };
}

test('L438: git が無視している .envrc・*.tfstate・*.ppk・.config/gh/hosts.yml があれば、Mark merged は作業コピーを消さず、理由（鍵らしいファイルがある）を返す', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop', '.envrc\n*.tfstate\n*.ppk\n.config/\n_netrc\n*.tfvars\n');
  const names = ['.envrc', 'infra/terraform.tfstate', 'keys/deploy.ppk', '.config/gh/hosts.yml', '_netrc', 'infra/prod.tfvars'];
  for (const name of names) {
    const { task, row } = await s.branchTask(p, `Task for ${name.replace(/\W/gu, ' ')}`);
    put(row.path!, name);
    git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge', row.branch);
    const marked = await s.json(`/api/tasks/${task.id}/merged`, 'POST', {});
    assert.deepEqual([marked.status, marked.body.code], [409, 'http.branch_dirty'], `${name}: ${JSON.stringify(marked.body)}`);
    assert.equal(existsSync(join(row.path!, name)), true, `${name} は消えない`);
    assert.equal(s.app.worktrees.get(row.id)!.state, 'branch');
    assert.equal((await s.app.mergeWatch.localFiles(row))!.secrets, 1, `${name} を鍵らしいファイルとして数える`);
  }
});

test('L166: git が無視している service-account-prod.json があれば、片付けは作業コピーを消さずに止まる。ふつうの名前の無視されるファイルだけなら片付く', { skip: !gitAvailable }, async t => {
  const s = await rig(t);
  const p = await s.product('shop', 'service-account*.json\nnotes.log\n');
  const keyed = await s.branchTask(p, 'With service account');
  put(keyed.row.path!, 'service-account-prod.json');
  const plain = await s.branchTask(p, 'With plain ignored');
  put(plain.row.path!, 'notes.log');
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge keyed', keyed.row.branch);
  git(p.root, 'merge', '-q', '--no-ff', '-m', 'merge plain', plain.row.branch);
  assert.equal(await s.app.mergeWatch.check(p.id), 1, 'ふつうの名前だけの方が片付く');
  assert.equal(s.app.worktrees.get(plain.row.id)!.state, 'merged');
  assert.equal(s.app.worktrees.get(keyed.row.id)!.state, 'branch');
  assert.equal(existsSync(join(keyed.row.path!, 'service-account-prod.json')), true);
  const marked = await s.json(`/api/tasks/${keyed.task.id}/merged`, 'POST', {});
  assert.deepEqual([marked.status, marked.body.code], [409, 'http.branch_dirty']);
});
