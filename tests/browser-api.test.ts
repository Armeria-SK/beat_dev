import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './app-setup.ts';
import { FakeBrowserDriver } from './helpers/fake-browser.ts';
import { BrowserFailure, type LaunchOptions } from '../src/tools/browser/driver.ts';
import { headedAvailable } from '../src/tools/browser/session.ts';

// T-41: ブラウザの API（状態・ログイン用の窓・閉じる・ログイン情報を消す）

const enable = (config: { tools: { browser: { enabled: boolean } } }) => { config.tools.browser.enabled = true; };
const call = (conversationId = 'c1') => ({ conversationId, signal: new AbortController().signal });

test('headedAvailable: 画面の無い Linux だけが false', () => {
  assert.equal(headedAvailable('linux', {}), false);
  assert.equal(headedAvailable('linux', { DISPLAY: '' }), false);
  assert.equal(headedAvailable('linux', { DISPLAY: ':0' }), true);
  assert.equal(headedAvailable('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(headedAvailable('win32', {}), true);
  assert.equal(headedAvailable('darwin', {}), true);
});

test('認証: 設定の保存と同じ（別の Origin からは通らず、ブラウザも動かない）', async t => {
  const driver = new FakeBrowserDriver();
  const { app, web, api } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  void web;
  const evil = { Origin: 'http://evil.example' };
  for (const [method, path] of [['GET', '/api/browser/status'], ['POST', '/api/browser/login'], ['POST', '/api/browser/close'], ['POST', '/api/browser/profile/reset']] as const) {
    const res = await api(path, { method, headers: evil, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.ok(res.status === 403 || res.status === 401, `${method} ${path} → ${res.status}`);
  }
  assert.equal(driver.launches, 0);
  assert.equal(app.browser.status().loginOpen, false);
});

test('状態: 無効・有効・起動中が分かる', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  const first = await json('/api/browser/status', 'GET');
  assert.equal(first.status, 200);
  assert.deepEqual({ ...first.body }, { enabled: true, running: false, loginOpen: false, tabs: 0, pausedMinutes: 0, canShowWindow: true });
  await app.browser.run(call(), async api => { await api.openTab(); });
  const second = await json('/api/browser/status', 'GET');
  assert.equal(second.body.running, true);
  assert.equal(second.body.tabs, 1);
});

test('login: 無効のときは 409', async t => {
  const driver = new FakeBrowserDriver();
  const { json } = await startApp(t, { browserDriver: driver, browserDisplay: true });
  const res = await json('/api/browser/login', 'POST', {});
  assert.equal(res.status, 409);
  assert.equal(driver.launches, 0);
});

test('login: 画面の無い Linux は 409（理由を返し、ブラウザは起動しない）', async t => {
  const driver = new FakeBrowserDriver();
  const { json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: false });
  const res = await json('/api/browser/login', 'POST', {});
  assert.equal(res.status, 409);
  assert.match(String(res.body.message), /画面/u);
  assert.equal(driver.launches, 0);
});

test('login: 見えるブラウザを同じプロファイルで開き、窓のあいだ道具は断り、閉じれば戻る', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  // 先に自動操作のブラウザが動いていたら、止めてから窓を開く
  await app.browser.run(call(), async api => { await api.openTab(); });
  const automatic = driver.current!;
  const opened = await json('/api/browser/login', 'POST', {});
  assert.equal(opened.status, 200);
  assert.equal(automatic.closed, true, '同じプロファイルを同時に開かないよう、自動操作のほうを先に止める');
  assert.equal(driver.launches, 2);
  const options: LaunchOptions = driver.current!.options;
  assert.equal(options.headless, false);
  assert.equal(options.profileDir, app.paths.browserProfile);
  assert.ok(options.proxy.server.startsWith('http://127.0.0.1:'), '同じ中継を通す');
  assert.equal((await json('/api/browser/status', 'GET')).body.loginOpen, true);
  // 2 回目は何もしない
  const again = await json('/api/browser/login', 'POST', {});
  assert.equal(again.status, 200);
  assert.equal(driver.launches, 2);
  // 窓のあいだ、道具は断る
  await assert.rejects(app.browser.run(call(), async () => 'x'), (e: unknown) => e instanceof BrowserFailure && e.code === 'login_open' && /ログイン用/u.test(e.text('ja')));
  // 閉じれば戻る
  const closed = await json('/api/browser/close', 'POST', {});
  assert.equal(closed.status, 200);
  assert.equal(driver.current!.closed, true);
  assert.equal((await json('/api/browser/status', 'GET')).body.loginOpen, false);
  assert.equal(await app.browser.run(call(), async () => 'ok'), 'ok');
});

test('login: 持ち主が窓を閉じたら、道具が使える（ログイン用の窓は無いことになる）', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  await json('/api/browser/login', 'POST', {});
  driver.current!.crash();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(app.browser.status().loginOpen, false);
  assert.equal(await app.browser.run(call(), async () => 'ok'), 'ok');
});

test('login: 起動の失敗は 500 でなく画面に返せる形で、失敗を数えない', async t => {
  const driver = new FakeBrowserDriver();
  driver.failures = [new BrowserFailure('no_browser', 'browser.no_browser'), new BrowserFailure('no_browser', 'browser.no_browser'), new BrowserFailure('no_browser', 'browser.no_browser')];
  const { app, json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  for (let i = 0; i < 3; i += 1) {
    const res = await json('/api/browser/login', 'POST', {});
    assert.equal(res.status, 409);
    assert.ok(String(res.body.message).length > 0);
  }
  assert.equal(app.browser.status().pausedMinutes, 0, '窓の失敗は、道具の休みに数えない');
});

test('profile/reset: ブラウザを止めてから、プロファイルだけを消す', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json, paths } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  mkdirSync(app.paths.browserProfile, { recursive: true });
  writeFileSync(join(app.paths.browserProfile, 'Cookies'), 'x');
  const sibling = join(paths.data, 'keep.txt');
  writeFileSync(sibling, 'keep');
  await app.browser.run(call(), async api => { await api.openTab(); });
  const browser = driver.current!;
  const res = await json('/api/browser/profile/reset', 'POST', {});
  assert.equal(res.status, 200);
  assert.equal(browser.closed, true, '消す前にブラウザを止める');
  assert.equal(existsSync(app.paths.browserProfile), false);
  assert.equal(existsSync(sibling), true, 'プロファイル以外は消さない');
  // 消したあとも、また使える
  assert.equal(await app.browser.run(call(), async () => 'ok'), 'ok');
});

test('profile/reset: 置き場所が data の下でなければ消さない', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json, paths } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  const outside = join(paths.data, '..', 'outside-profile');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'file.txt'), 'x');
  (app.paths as { browserProfile: string }).browserProfile = outside;
  const res = await json('/api/browser/profile/reset', 'POST', {});
  assert.equal(res.status, 409);
  assert.equal(existsSync(join(outside, 'file.txt')), true);
  // data そのものも消さない
  (app.paths as { browserProfile: string }).browserProfile = paths.data;
  const same = await json('/api/browser/profile/reset', 'POST', {});
  assert.equal(same.status, 409);
  assert.equal(existsSync(paths.data), true);
});
