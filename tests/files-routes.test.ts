import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startApp } from './app-setup.ts';
import { removeDir } from './helpers.ts';

// beat 8-5a: Files の欄の口（読むだけ）。製品のフォルダと知識のフォルダ（data/projects/<id>/）の中だけを、1 段ずつ見せる

const WINDOWS = process.platform === 'win32';
const gitAvailable = spawnSync('git', ['--version']).status === 0;
const SECRET = 'TOP-SECRET-VALUE';

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(t: Parameters<typeof startApp>[0], options: { deny?: (dir: string) => string[]; backupsInside?: boolean } = {}) {
  const products = realpathSync.native(mkdtempSync(join(tmpdir(), 'beat-files-')));
  t.after(() => removeDir(products));
  const shop = join(products, 'shop');
  mkdirSync(join(shop, 'src', 'upload'), { recursive: true });
  const outside = join(products, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), SECRET);
  const s = await startApp(t, {
    projectFolderExempt: [products],
    ...(options.backupsInside ? { paths: p => ({ ...p, backups: join(shop, 'bk') }) } : {}),
  });
  const made = await s.json('/api/projects', 'POST', { root: shop });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const id = (made.body.project as { id: string }).id;
  if (options.deny) s.app.configStore.save({ ...s.app.config(), tools: { ...s.app.config().tools, deny: options.deny(shop) } });
  const list = (dir: string, tree = 'product') => s.json(`/api/projects/${id}/files?tree=${tree}&dir=${encodeURIComponent(dir)}`, 'GET');
  const read = (path: string, tree = 'product') => s.json(`/api/projects/${id}/file?tree=${tree}&path=${encodeURIComponent(path)}`, 'GET');
  return { ...s, id, shop, outside, products, list, read };
}

const names = (body: { entries: Array<{ name: string }> }) => body.entries.map(e => e.name);

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

async function refusedEverywhere(s: Setup, path: string, status: number, label: string) {
  const read = await s.read(path);
  assert.equal(read.status, status, `${label}: read ${JSON.stringify(read.body)}`);
  assert.ok(!JSON.stringify(read.body).includes(SECRET), `${label}: 外の中身が返らない`);
}

test('8-5a: 1 段ずつの一覧。フォルダが先・名前順（大文字小文字を問わない）、.git と node_modules は出さず、秘密らしい名前は hidden', async t => {
  const s = await setup(t);
  writeFileSync(join(s.shop, 'b.md'), 'b');
  writeFileSync(join(s.shop, 'A.md'), 'a');
  writeFileSync(join(s.shop, '.env'), `KEY=${SECRET}`);
  mkdirSync(join(s.shop, '.git'));
  mkdirSync(join(s.shop, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(s.shop, 'Docs'));
  writeFileSync(join(s.shop, 'src', 'upload', 'queue.ts'), 'export {}\n');
  const root = await s.list('');
  assert.equal(root.status, 200, JSON.stringify(root.body));
  assert.deepEqual(names(root.body), ['Docs', 'src', '.env', 'A.md', 'b.md']);
  assert.deepEqual(root.body.entries.find((e: { name: string }) => e.name === '.env'), { name: '.env', path: '.env', kind: 'file', hidden: true });
  assert.equal(root.body.dir, '');
  const inner = await s.list('src');
  assert.deepEqual(inner.body.entries, [{ name: 'upload', path: 'src/upload', kind: 'dir' }], '1 段だけ（孫は読まない）');
  assert.deepEqual(names((await s.list('src/upload')).body), ['queue.ts']);
  assert.equal((await s.list('node_modules')).status, 403, 'node_modules の中は見せない');
  assert.equal((await s.list('.git')).status, 403, '.git の中は見せない');
  assert.equal((await s.read('.git/config')).status, 403);
  assert.equal((await s.list('src/upload/queue.ts')).status, 400, 'ファイルは一覧にできない');
  assert.equal((await s.list('nope')).status, 404);
});

test('8-5a: ファイルの中身。.env は hidden で中身を返さない。512KB を超えるものは頭だけと印、2 進のファイルは binary', async t => {
  const s = await setup(t);
  writeFileSync(join(s.shop, '.env'), `KEY=${SECRET}`);
  writeFileSync(join(s.shop, '.env.local'), `KEY=${SECRET}`);
  mkdirSync(join(s.shop, 'secrets'));
  writeFileSync(join(s.shop, 'secrets', 'token.txt'), SECRET);
  writeFileSync(join(s.shop, 'main.ts'), 'line 1\nline 2\n');
  writeFileSync(join(s.shop, 'big.txt'), `${'x'.repeat(512 * 1024)}TAIL`);
  writeFileSync(join(s.shop, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  const main = await s.read('main.ts');
  assert.equal(main.status, 200);
  assert.equal(main.body.text, 'line 1\nline 2\n');
  assert.equal(main.body.size, 14);
  assert.equal(main.body.hidden, false);
  assert.equal(main.body.truncated, false);
  assert.equal(typeof main.body.modifiedAt, 'number');
  for (const path of ['.env', '.env.local', 'secrets/token.txt']) {
    const env = await s.read(path);
    assert.equal(env.status, 200, path);
    assert.equal(env.body.hidden, true, path);
    assert.equal(env.body.text, null, path);
    assert.ok(!JSON.stringify(env.body).includes(SECRET), `${path}: 中身が返らない`);
  }
  assert.equal((await s.list('secrets')).status, 403, '秘密らしいフォルダは開かない');
  const big = await s.read('big.txt');
  assert.equal(big.body.truncated, true);
  assert.equal(big.body.text.length, 512 * 1024);
  assert.ok(!big.body.text.includes('TAIL'));
  assert.equal(big.body.size, 512 * 1024 + 4);
  const png = await s.read('pic.png');
  assert.equal(png.body.binary, true);
  assert.equal(png.body.text, null);
  assert.equal((await s.read('src')).status, 400, 'フォルダは読めない');
  assert.equal((await s.read('')).status, 400);
});

test('8-5a: 外へ出るパスは断る（..・絶対パス・\\・ストリーム・デバイス・末尾の . と空白）。外の中身は返らない', async t => {
  const s = await setup(t);
  writeFileSync(join(s.shop, 'a.txt'), 'a');
  const bad = [
    '..', '../outside/secret.txt', 'src/../../outside/secret.txt', 'src/..', './a.txt', 'src//a.txt', '/a.txt',
    join(s.outside, 'secret.txt'), join(s.outside, 'secret.txt').replaceAll('\\', '/'), 'C:/Windows/win.ini', '\\\\server\\share\\x',
    '..\\outside\\secret.txt', 'a.txt::$DATA', 'a.txt:x', 'CON', 'src/NUL.txt', 'a.txt.', 'a.txt ', 'a\u0000.txt',
  ];
  for (const path of bad) {
    await refusedEverywhere(s, path, 400, JSON.stringify(path));
    assert.equal((await s.list(path)).status, 400, `list ${JSON.stringify(path)}`);
  }
  assert.equal((await s.list('..', 'knowledge')).status, 400);
});

test('8-5a: リンク・ジャンクションは段のどこにあっても断る。リンクは一覧にも出ない', async t => {
  const s = await setup(t);
  symlinkSync(s.outside, join(s.shop, 'jump'), WINDOWS ? 'junction' : 'dir');
  symlinkSync(s.outside, join(s.shop, 'src', 'deep'), WINDOWS ? 'junction' : 'dir');
  assert.deepEqual(names((await s.list('')).body), ['src'], 'ジャンクションは一覧に出ない');
  for (const path of ['jump/secret.txt', 'src/deep/secret.txt']) await refusedEverywhere(s, path, 403, path);
  assert.equal((await s.list('jump')).status, 403);
  assert.equal((await s.list('src/deep')).status, 403);
  let fileLink = true;
  try { symlinkSync(join(s.outside, 'secret.txt'), join(s.shop, 'link.txt'), 'file'); } catch { fileLink = false; }
  if (fileLink) await refusedEverywhere(s, 'link.txt', 403, 'file symlink');
  else t.diagnostic('file symlinks need developer mode here; checked junctions only');
});

test('8-5a: 別の名前（大文字小文字・Windows の短い名前）とハードリンクは断る', async t => {
  const s = await setup(t);
  writeFileSync(join(s.shop, 'src', 'Main.ts'), 'main');
  writeFileSync(join(s.shop, '.env.local'), `KEY=${SECRET}`);
  linkSync(join(s.outside, 'secret.txt'), join(s.shop, 'hard.txt'));
  await refusedEverywhere(s, 'hard.txt', 403, 'hard link');
  assert.equal((await s.read('src/Main.ts')).status, 200);
  if (WINDOWS) {
    await refusedEverywhere(s, 'SRC/Main.ts', 403, 'folder case');
    await refusedEverywhere(s, 'src/main.ts', 403, 'file case');
    await refusedEverywhere(s, '.ENV.LOCAL', 403, 'secret name in other case');
    assert.equal((await s.list('SRC')).status, 403);
    const short = execFileSync('cmd', ['/c', 'dir', '/x', '/a'], { cwd: s.shop, encoding: 'utf8' }).split(/\r?\n/u).map(line => /\s(\S+~\d\S*)\s+\.env\.local$/u.exec(line)?.[1]).find(Boolean);
    if (short) await refusedEverywhere(s, short, 403, `8.3 name ${short}`);
    else t.diagnostic('this volume has no 8.3 names; the short-name case was not exercised');
  }
});

test('8-5a: beat が道具から隠す場所と tools.deny は一覧に出ず、読めない', async t => {
  const s = await setup(t, { deny: shop => [join(shop, 'private')], backupsInside: true });
  mkdirSync(join(s.shop, 'private'));
  writeFileSync(join(s.shop, 'private', 'p.txt'), SECRET);
  mkdirSync(join(s.shop, 'bk'), { recursive: true });
  writeFileSync(join(s.shop, 'bk', 'beat.db.bak'), SECRET);
  writeFileSync(join(s.shop, 'ok.txt'), 'ok');
  assert.deepEqual(names((await s.list('')).body), ['src', 'ok.txt']);
  for (const path of ['private/p.txt', 'bk/beat.db.bak']) await refusedEverywhere(s, path, 403, path);
  assert.equal((await s.list('private')).status, 403);
  assert.equal((await s.list('bk')).status, 403);
});

test('8-5a: Knowledge の木は data/projects/<id>/ の中だけ。ほかの製品の知識・データのフォルダへは出られない', async t => {
  const s = await setup(t);
  const other = await s.json('/api/projects', 'POST', { root: s.outside });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const otherId = (other.body.project as { id: string }).id;
  const mine = join(s.paths.projects, s.id);
  writeFileSync(join(mine, 'STATE.md'), '# State\n');
  mkdirSync(join(mine, 'memory'), { recursive: true });
  writeFileSync(join(mine, 'memory', 'note.md'), 'note');
  writeFileSync(join(s.paths.projects, otherId, 'STATE.md'), SECRET);
  const root = await s.list('', 'knowledge');
  assert.equal(root.status, 200, JSON.stringify(root.body));
  assert.ok(names(root.body).includes('STATE.md') && names(root.body).includes('memory'), JSON.stringify(root.body));
  assert.equal((await s.read('STATE.md', 'knowledge')).body.text, '# State\n');
  assert.equal((await s.read('memory/note.md', 'knowledge')).body.text, 'note');
  for (const path of [`../${otherId}/STATE.md`, '../../beat.db', '../../config.json']) {
    const res = await s.read(path, 'knowledge');
    assert.equal(res.status, 400, path);
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
  }
  assert.equal((await s.list('', 'other')).status, 400, '知らない木は 400');
  assert.equal((await s.json('/api/projects/nope/files', 'GET')).status, 404);
});

test('8-5a: git の製品では .gitignore の中を出さず読ませない。前のコミットから変えたファイルに M、足したファイルに A', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  git(s.shop, 'init', '-q', '-b', 'main');
  writeFileSync(join(s.shop, '.gitignore'), 'build/\n*.log\n!keep.log\n');
  writeFileSync(join(s.shop, 'src', 'upload', 'queue.ts'), 'v1\n');
  writeFileSync(join(s.shop, 'src', 'upload', 'chunk.ts'), 'same\n');
  writeFileSync(join(s.shop, 'tracked.log'), 'tracked though ignored\n');
  git(s.shop, 'add', '-A');
  git(s.shop, 'add', '-f', 'tracked.log');
  git(s.shop, 'commit', '-q', '-m', 'first');
  writeFileSync(join(s.shop, 'src', 'upload', 'queue.ts'), 'v2\n');
  writeFileSync(join(s.shop, 'src', 'upload', 'backoff.ts'), 'new\n');
  mkdirSync(join(s.shop, 'build', 'x'), { recursive: true });
  writeFileSync(join(s.shop, 'build', 'x', 'out.js'), SECRET);
  writeFileSync(join(s.shop, 'debug.log'), SECRET);
  writeFileSync(join(s.shop, 'keep.log'), 'kept\n');
  writeFileSync(join(s.shop, 'src', 'trace.log'), SECRET);
  const root = await s.list('');
  assert.equal(root.status, 200, JSON.stringify(root.body));
  assert.deepEqual(names(root.body), ['src', '.gitignore', 'keep.log', 'tracked.log'], '無視したもの（build/・debug.log）は出ない。追っているファイルは出る');
  assert.equal(root.body.entries.find((e: { name: string }) => e.name === 'keep.log').mark, 'A');
  assert.deepEqual(names((await s.list('src')).body), ['upload'], '下のフォルダの無視したファイルも出ない');
  const upload = (await s.list('src/upload')).body.entries;
  assert.deepEqual(upload, [
    { name: 'backoff.ts', path: 'src/upload/backoff.ts', kind: 'file', mark: 'A' },
    { name: 'chunk.ts', path: 'src/upload/chunk.ts', kind: 'file' },
    { name: 'queue.ts', path: 'src/upload/queue.ts', kind: 'file', mark: 'M' },
  ]);
  assert.equal((await s.read('src/upload/queue.ts')).body.mark, 'M');
  assert.equal((await s.read('src/upload/chunk.ts')).body.mark, null);
  for (const path of ['debug.log', 'build/x/out.js', 'src/trace.log']) await refusedEverywhere(s, path, 403, path);
  assert.equal((await s.list('build')).status, 403);
  assert.equal((await s.list('build/x')).status, 403);
  assert.equal((await s.read('tracked.log')).status, 200);
});

test('8-5a: 製品のフォルダが無くなったら 409', async t => {
  const s = await setup(t);
  await removeDir(s.shop);
  assert.equal((await s.list('')).status, 409);
  assert.equal((await s.read('a.txt')).status, 409);
});

test('8-5a: この欄だけで隠す秘密らしい名前（credentials.json・_netrc・.envrc・*.ppk・*.tfvars など）は中身を出さない', async t => {
  const s = await setup(t);
  const names = ['credentials.json', 'service-account.json', '_netrc', '.envrc', 'key.ppk', 'id_ed25519_sk', 'id_ecdsa_sk.pub', '.pgpass', '.yarnrc.yml', 'terraform.tfvars', 'terraform.tfstate', '.vault-token', '.s3cfg', '.boto'];
  for (const name of names) writeFileSync(join(s.shop, name), SECRET);
  mkdirSync(join(s.shop, '.config', 'gh'), { recursive: true });
  writeFileSync(join(s.shop, '.config', 'gh', 'hosts.yml'), SECRET);
  const root = (await s.list('')).body.entries as Array<{ name: string; hidden?: true }>;
  for (const name of names) assert.equal(root.find(e => e.name === name)?.hidden, true, name);
  for (const path of [...names, '.config/gh/hosts.yml']) {
    const res = await s.read(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.body.hidden, true, path);
    assert.ok(!JSON.stringify(res.body).includes(SECRET), path);
  }
});

test('8-5a: 1 つのフォルダは 1000 件まで返し、残りがあれば truncated', async t => {
  const s = await setup(t);
  mkdirSync(join(s.shop, 'many'));
  for (let i = 0; i < 1001; i++) writeFileSync(join(s.shop, 'many', `f${String(i).padStart(4, '0')}.txt`), '');
  const res = await s.list('many');
  assert.equal(res.body.entries.length, 1000);
  assert.equal(res.body.truncated, true);
  assert.equal((await s.list('src')).body.truncated, false);
});

test('8-5a: 知識のフォルダ（data/projects/<id>）がリンクなら、外を指しても data/projects の中を指しても断る', async t => {
  const s = await setup(t);
  const mine = join(s.paths.projects, s.id);
  await removeDir(mine);
  const sibling = join(s.paths.projects, 'zz-sibling');
  mkdirSync(sibling);
  for (const dir of [s.outside, sibling]) writeFileSync(join(dir, 'STATE.md'), SECRET);
  for (const target of [s.outside, sibling]) {
    symlinkSync(target, mine, WINDOWS ? 'junction' : 'dir');
    const listed = await s.list('', 'knowledge');
    assert.equal(listed.status, 403, `${target} ${JSON.stringify(listed.body)}`);
    const res = await s.read('STATE.md', 'knowledge');
    assert.equal(res.status, 403, target);
    assert.ok(!JSON.stringify(res.body).includes(SECRET), target);
    unlinkSync(mine);
  }
});

test('8-5a: git の製品で無視の決まりを確かめられないとき、一覧は ignoreChecked: false、ファイルの中身は読ませない。git でない製品は true', { skip: !gitAvailable }, async t => {
  const s = await setup(t);
  writeFileSync(join(s.shop, 'a.txt'), SECRET);
  assert.equal((await s.list('')).body.ignoreChecked, true, 'git でない製品');
  assert.equal((await s.read('a.txt')).body.text, SECRET);
  git(s.shop, 'init', '-q', '-b', 'main');
  git(s.shop, 'config', 'core.sshCommand', 'x');
  const root = await s.list('');
  assert.equal(root.status, 200);
  assert.equal(root.body.ignoreChecked, false);
  const res = await s.read('a.txt');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'unchecked');
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
});

test('8-5a: パスの中の壊れた %（%E0）は 404 で、サーバーは落ちない', async t => {
  const s = await setup(t);
  const bad = await s.api('/api/projects/%E0/files');
  assert.equal(bad.status, 404);
  assert.equal((await s.list('')).status, 200, 'そのあとも答える');
});
