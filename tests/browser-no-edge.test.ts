import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../src/config/store.ts';
import * as driverModule from '../src/tools/browser/driver.ts';
import { BrowserFailure, PlaywrightDriver, type LaunchOptions } from '../src/tools/browser/driver.ts';
import { locateBrowser } from '../src/tools/browser/locate.ts';
import { isEdgeExecutable } from '../src/shared/browser-path.ts';
import { testConfig } from './helpers.ts';

// 持ち主の決定: Edge でブラウザ操作はさせない。Clive は Edge を探さず、起動せず、設定でも通さない

const withBrowser = (browser: unknown) => ({ ...JSON.parse(JSON.stringify(testConfig())), tools: { browser } });
const win = { platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } };
const EDGE_WIN = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'];
const EDGE_OTHER = ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];

test('設定: channel に msedge は書けない（auto / chrome / path だけ）', () => {
  assert.throws(() => parseConfig(withBrowser({ channel: 'msedge' })), ConfigError);
  for (const channel of ['auto', 'chrome']) assert.equal(parseConfig(withBrowser({ channel })).tools.browser.channel, channel);
});

test('設定: path が Edge の実行ファイルなら保存できない（ファイル名で判定。大文字小文字・拡張子・区切りの違いも）', () => {
  const edges = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Edge\\MSEdge.EXE', 'D:/x/msedge', 'C:\\x\\msedge.exe ',
    '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const executablePath of edges) {
    for (const channel of ['path', 'auto']) {
      assert.throws(() => parseConfig(withBrowser({ channel, executablePath })), (e: unknown) => e instanceof ConfigError && e.issues.some(i => i.path === 'tools.browser.executablePath'), `${channel}: ${executablePath}`);
    }
  }
});

test('設定: Chromium 系の別の実行ファイルは通る（Edge という文字がフォルダ名に入っていても、ファイル名が違えば）', () => {
  for (const executablePath of ['C:\\Tools\\Chromium\\chrome.exe', 'C:\\Edgewood\\chromium.exe', 'C:\\msedge\\brave.exe', '/usr/bin/chromium']) {
    assert.equal(parseConfig(withBrowser({ channel: 'path', executablePath })).tools.browser.executablePath, executablePath);
  }
});

test('探し方: おまかせは Edge の場所を一切見ない（Edge だけが入っていても「見つからない」）', () => {
  const asked: string[] = [];
  const exists = (file: string) => { asked.push(file); return EDGE_WIN.includes(file); };
  assert.equal(locateBrowser({ channel: 'auto', executablePath: '' }, { ...win, exists }), null);
  assert.ok(asked.length > 0 && asked.every(file => /chrome/iu.test(file) && !/edge/iu.test(file)), asked.join(', '));
  for (const [platform, file] of [['darwin', EDGE_OTHER[0]!], ['linux', EDGE_OTHER[1]!], ['linux', EDGE_OTHER[2]!], ['linux', EDGE_OTHER[3]!]] as const) {
    assert.equal(locateBrowser({ channel: 'auto', executablePath: '' }, { platform, env: {}, exists: f => f === file }), null, file);
  }
});

test('探し方: path が Edge の実行ファイルなら、ファイルがあっても見つかったことにしない', () => {
  for (const file of [...EDGE_WIN, ...EDGE_OTHER]) assert.equal(locateBrowser({ channel: 'path', executablePath: file }, { ...win, exists: () => true }), null, file);
});

test('起動: 自動は chrome だけを試す（msedge を試さない）', () => {
  const base: LaunchOptions = { profileDir: 'C:\\p', channel: undefined, executablePath: undefined, headless: true, proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' }, viewport: { width: 1280, height: 800 }, locale: 'ja-JP', actionTimeoutMs: 10_000 };
  const attempts = (driverModule as unknown as { launchAttempts?: (o: LaunchOptions) => unknown[] }).launchAttempts;
  assert.equal(typeof attempts, 'function');
  assert.deepEqual(attempts!(base), ['chrome']);
  assert.deepEqual(attempts!({ ...base, channel: 'chrome' }), ['chrome']);
  assert.deepEqual(attempts!({ ...base, executablePath: 'C:\\Tools\\Chromium\\chrome.exe' }), [undefined]);
});

test('起動: path が Edge の実行ファイルなら、プロファイルも作らず起動せずに断る（設定の検証をすり抜けても）', async t => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const parent = mkdtempSync(join(tmpdir(), 'clive-noedge-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const profileDir = join(parent, 'profile');
  const base: LaunchOptions = { profileDir, channel: undefined, executablePath: undefined, headless: true, proxy: { server: 'http://127.0.0.1:9', username: 'u', password: 'p' }, viewport: { width: 1280, height: 800 }, locale: 'ja-JP', actionTimeoutMs: 10_000 };
  for (const executablePath of [EDGE_WIN[0]!, '/usr/bin/microsoft-edge', 'D:/x/MSEDGE']) {
    await assert.rejects(new PlaywrightDriver().launch({ ...base, executablePath }), (e: unknown) => e instanceof BrowserFailure && e.key === 'browser.edge_refused', executablePath);
  }
  assert.equal(existsSync(profileDir), false, 'プロファイルのフォルダを作らない');
});

test('判定: 末尾のドット・空白と .exe を外したあとで Edge と見分ける（msedge.exe. など）', () => {
  for (const name of ['C:\\x\\msedge.exe.', 'C:\\x\\msedge.exe..', 'C:\\x\\msedge.exe . ', 'C:\\x\\MSEdge.', 'C:\\x\\microsoft-edge.exe.', 'C:\\x\\msedge .exe']) assert.equal(isEdgeExecutable(name), true, name);
  for (const name of ['C:\\x\\msedge.exe.bak', 'C:\\x\\chrome.exe.', 'C:\\x\\edge.exe', 'C:\\msedge\\chromium.exe.']) assert.equal(isEdgeExecutable(name), false, name);
});

test('判定: macOS の "Microsoft Edge Beta" など、空白で区切った種類つきの名前も Edge', () => {
  const names = [
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta', '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
    '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary', '/x/microsoft edge stable', '/x/msedge-beta', '/x/msedge dev', '/x/microsoft-edge-canary',
  ];
  for (const name of names) assert.equal(isEdgeExecutable(name), true, name);
  for (const name of ['/x/Microsoft Edgex', '/x/Microsoft Edge Nightly', '/x/microsoft-edge-beta2', '/Applications/Microsoft Edge Beta.app/Contents/MacOS/chrome']) assert.equal(isEdgeExecutable(name), false, name);
  assert.throws(() => parseConfig(withBrowser({ channel: 'path', executablePath: '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta' })), ConfigError);
  assert.throws(() => parseConfig(withBrowser({ channel: 'path', executablePath: 'C:\\x\\msedge.exe.' })), ConfigError);
});

test('設定: 既存の channel: "msedge" のエラーに、直し方（auto か chrome か path）が出る', () => {
  try { parseConfig(withBrowser({ channel: 'msedge' })); assert.fail('通ってはいけない'); } catch (e) {
    assert.ok(e instanceof ConfigError);
    const issue = e.issues.find(i => i.path === 'tools.browser.channel');
    assert.ok(issue, 'channel の指摘がある');
    assert.match(issue.message, /auto.*chrome.*path/u);
    assert.match(e.message, /auto \/ chrome \/ path/u);
  }
});
