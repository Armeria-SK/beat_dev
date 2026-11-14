import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkToolchain, VERSION_TIMEOUT_MS, type VersionRunner } from '../src/research/toolchain.ts';
import { tempDir } from './helpers.ts';

const spy = () => {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];
  const run: VersionRunner = async (file, args, options) => { calls.push({ file, args, options }); return 'tool 1.2.3\nmore'; };
  return { calls, run };
};

test('PC の道具の確かめ: 入っていない道具は 3 秒以内に missing を返し、何も動かさない', async t => {
  const empty = tempDir(t);
  const { calls, run } = spy();
  const started = Date.now();
  const [go, cargo] = await checkToolchain(['go', 'cargo'], { platform: 'win32', env: { PATH: empty, PATHEXT: '.EXE' }, run });
  assert.ok(Date.now() - started < VERSION_TIMEOUT_MS);
  assert.deepEqual([go!.state, cargo!.state, go!.path], ['missing', 'missing', null]);
  assert.equal(calls.length, 0);
});

test('PC の道具の確かめ: WindowsApps の別名（Store の python）はパスで見分けて alias とし、動かさない', async t => {
  const root = tempDir(t);
  const apps = join(root, 'Microsoft', 'WindowsApps');
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, 'python.exe'), '');
  const { calls, run } = spy();
  const [python] = await checkToolchain(['python'], { platform: 'win32', env: { Path: apps, PATHEXT: '.COM;.EXE' }, run });
  assert.equal(python!.state, 'alias');
  assert.equal(python!.path, join(apps, 'python.exe'));
  assert.equal(calls.length, 0);
});

test('PC の道具の確かめ: 見つけた .exe は シェルなし・3 秒・--version で動かし、最初の行を版にする。.cmd は動かさず found', async t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'go.exe'), '');
  writeFileSync(join(dir, 'ruby.exe'), '');
  writeFileSync(join(dir, 'npm.cmd'), '@echo off');
  const { calls, run } = spy();
  const [go, ruby, npm] = await checkToolchain(['go', 'ruby', 'npm'], { platform: 'win32', env: { PATH: `relative;${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:/Users/me', GOTOOLCHAIN: 'auto' }, run });
  assert.deepEqual([go!.state, go!.version, ruby!.state], ['installed', 'tool 1.2.3', 'installed']);
  assert.deepEqual([npm!.state, npm!.version], ['found', null]);
  assert.deepEqual(calls, [
    { file: join(dir, 'go.exe'), args: ['version'], options: { timeout: VERSION_TIMEOUT_MS, shell: false, windowsHide: true, cwd: homedir(), env: { PATH: `relative;${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:/Users/me', GOTOOLCHAIN: 'local' } } },
    { file: join(dir, 'ruby.exe'), args: ['--version'], options: { timeout: VERSION_TIMEOUT_MS, shell: false, windowsHide: true, cwd: homedir(), env: { PATH: `relative;${dir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD', USERPROFILE: 'C:/Users/me', GOTOOLCHAIN: 'local' } } },
  ]);
  assert.equal(VERSION_TIMEOUT_MS, 3000);
});

test('PC の道具の確かめ: 決まった形でない名前（パスの区切りなど）は探さない', async t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'go.exe'), '');
  const { calls, run } = spy();
  const [bad] = await checkToolchain(['..\\go'], { platform: 'win32', env: { PATH: join(dir, 'sub'), PATHEXT: '.EXE' }, run });
  assert.equal(bad!.state, 'missing');
  assert.equal(calls.length, 0);
});

test('PC の道具の確かめ: 本物の node を execFile で動かすと版が取れる', async () => {
  const [node] = await checkToolchain(['node'], { env: { PATH: dirname(process.execPath), PATHEXT: '.EXE' } });
  assert.equal(node!.state, 'installed');
  assert.equal(node!.version, process.version);
});

test('PC の道具の確かめ: 今のフォルダも相対のフォルダも探さない（PATH が . や sub でも、そこにある go.exe は missing）', async t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'go.exe'), '');
  writeFileSync(join(dir, 'sub', 'go.exe'), '');
  const before = process.cwd();
  const { calls, run } = spy();
  process.chdir(dir);
  try {
    const [go] = await checkToolchain(['go'], { platform: 'win32', env: { PATH: '.;sub;..', PATHEXT: '.EXE' }, run, readlink: () => null });
    assert.deepEqual([go!.state, go!.path], ['missing', null]);
  } finally { process.chdir(before); }
  assert.equal(calls.length, 0);
});

test('PC の道具の確かめ: リンクの先が WindowsApps の下なら（8.3 の名前などでパスに出なくても）alias とし、動かさない。ほかの先のリンクは動かす', async t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'python.exe'), '');
  writeFileSync(join(dir, 'ruby.exe'), '');
  const { calls, run } = spy();
  const targets: Record<string, string> = {
    [join(dir, 'python.exe')]: 'C:/Program Files/WindowsApps/Microsoft.DesktopAppInstaller_1.0_x64__8wekyb3d8bbwe/AppInstallerPythonRedirector.exe',
    [join(dir, 'ruby.exe')]: 'C:/Ruby/bin/ruby.exe',
  };
  const [python, ruby] = await checkToolchain(['python', 'ruby'], { platform: 'win32', env: { PATH: dir, PATHEXT: '.EXE' }, run, readlink: file => targets[file] ?? null });
  assert.deepEqual([python!.state, ruby!.state], ['alias', 'installed']);
  assert.deepEqual(calls.map(c => c.file), [join(dir, 'ruby.exe')]);
});
