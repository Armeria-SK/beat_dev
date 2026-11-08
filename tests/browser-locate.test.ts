import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locateBrowser } from '../src/tools/browser/locate.ts';

const win = { platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } };
const has = (...found: string[]) => (file: string) => found.includes(file);

test('doctor 用の探し方: おまかせは Edge → Chrome の順に、既定の場所を調べる（起動はしない）', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(locateBrowser({ channel: 'auto', executablePath: '' }, { ...win, exists: has(edge, chrome) }), { channel: 'msedge', path: edge });
  assert.deepEqual(locateBrowser({ channel: 'auto', executablePath: '' }, { ...win, exists: has(chrome) }), { channel: 'chrome', path: chrome });
  assert.equal(locateBrowser({ channel: 'auto', executablePath: '' }, { ...win, exists: has() }), null);
});

test('doctor 用の探し方: Edge / Chrome を選んでいれば、そちらだけを調べる', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(locateBrowser({ channel: 'chrome', executablePath: '' }, { ...win, exists: has(edge) }), null);
  assert.deepEqual(locateBrowser({ channel: 'msedge', executablePath: '' }, { ...win, exists: has(edge) }), { channel: 'msedge', path: edge });
});

test('doctor 用の探し方: パス指定はそのファイルがあるかだけを見る', () => {
  assert.deepEqual(locateBrowser({ channel: 'path', executablePath: 'D:\\b\\chrome.exe' }, { ...win, exists: has('D:\\b\\chrome.exe') }), { channel: 'path', path: 'D:\\b\\chrome.exe' });
  assert.equal(locateBrowser({ channel: 'path', executablePath: 'D:\\b\\chrome.exe' }, { ...win, exists: has() }), null);
  assert.equal(locateBrowser({ channel: 'path', executablePath: '' }, { ...win, exists: () => true }), null);
});

test('doctor 用の探し方: Linux と macOS の既定の場所', () => {
  assert.deepEqual(locateBrowser({ channel: 'auto', executablePath: '' }, { platform: 'linux', env: {}, exists: has('/usr/bin/google-chrome') }), { channel: 'chrome', path: '/usr/bin/google-chrome' });
  assert.deepEqual(locateBrowser({ channel: 'auto', executablePath: '' }, { platform: 'darwin', env: {}, exists: has('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') }), { channel: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
});
