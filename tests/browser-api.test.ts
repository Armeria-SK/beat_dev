import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from './app-setup.ts';
import { FakeBrowserDriver } from './helpers/fake-browser.ts';
import { BrowserFailure, type LaunchOptions } from '../src/tools/browser/driver.ts';
import { headedAvailable } from '../src/tools/browser/session.ts';
import { rootKeyOf } from '../src/projects/work-folder.ts';

// T-41: ブラウザの API（状態・ログイン用の窓・閉じる・ログイン情報を消す）

const enable = (config: { tools: { browser: { enabled: boolean } } }) => { config.tools.browser.enabled = true; };
const call = (conversationId = 'c1') => ({ grant: { conversationId, runId: 'r1', attended: true, loopback: false }, signal: new AbortController().signal });

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
  await app.browser.run(call(), async api => { await api.openTab('owner'); });
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
  assert.match(String(res.body.message), /no display/u);
  assert.equal(driver.launches, 0);
});

test('login: 見えるブラウザを同じプロファイルで開き、窓のあいだ道具は断り、閉じれば戻る', async t => {
  const driver = new FakeBrowserDriver();
  const { app, json } = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  // 先に自動操作のブラウザが動いていたら、止めてから窓を開く
  await app.browser.run(call(), async api => { await api.openTab('owner'); });
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
  // 窓のあいだ、持ち主のブラウザを使う道具は断る
  await assert.rejects(app.browser.run(call(), async api => { await api.openTab('owner'); }), (e: unknown) => e instanceof BrowserFailure && e.code === 'login_open' && /for logging in/u.test(e.text('en')));
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
  await app.browser.run(call(), async api => { await api.openTab('owner'); });
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

// 9-2a: Browser の欄の口（GET /api/browser/view・/api/browser/frame）
async function mirrorSetup(t: Parameters<typeof startApp>[0]) {
  const driver = new FakeBrowserDriver();
  driver.site('https://a.example.com/', { title: 'Shop', png: Buffer.from('png-a') });
  driver.site('https://b.example.com/', { title: 'Other', png: Buffer.from('png-b') });
  const s = await startApp(t, { configure: enable, browserDriver: driver, browserDisplay: true });
  const project = (name: string) => {
    const root = join(s.paths.workspace, name);
    mkdirSync(root, { recursive: true });
    return s.app.projects.create({ name, root, rootKey: rootKeyOf(root), checkCommand: null });
  };
  const shop = project('shop');
  const other = project('other');
  const open = (conversationId: string, productId: string | undefined, url: string) => s.app.browser.run(
    { grant: { conversationId, runId: `run-${conversationId}`, attended: true, loopback: false, ...(productId ? { productId } : {}) }, signal: new AbortController().signal },
    async api => { const tab = await api.openTab('owner'); await tab.page.goto(url, 1000); return tab.id; },
  );
  return { ...s, driver, shop, other, open };
}

test('view / frame: 認証は ほかの口と同じ（別の Origin からは 403）', async t => {
  const s = await mirrorSetup(t);
  const evil = { Origin: 'http://evil.example' };
  for (const path of [`/api/browser/view?product=${s.shop.id}`, `/api/browser/frame?product=${s.shop.id}&tab=t1`]) {
    const res = await s.api(path, { headers: evil });
    assert.equal(res.status, 403, path);
  }
});

test('view / frame: 製品の ID は DB の製品だけ、タブの ID は t<数> の形だけ', async t => {
  const s = await mirrorSetup(t);
  assert.equal((await s.api('/api/browser/view')).status, 400);
  assert.equal((await s.api('/api/browser/view?product=../x')).status, 400);
  assert.equal((await s.api('/api/browser/view?product=p-nothere')).status, 404);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=x1`)).status, 400);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=t1&seq=-1`)).status, 400);
  assert.equal((await s.api('/api/browser/frame?product=p-nothere&tab=t1')).status, 404);
  const empty = await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET');
  assert.deepEqual(empty, { status: 200, body: { view: null } });
});

test('view / frame: 製品のタブの様子と画像。同じ seq は 304、no-store。ほかの製品・製品に属さない会話のタブは出さない', async t => {
  const s = await mirrorSetup(t);
  const chat = s.app.conversations.create({ title: 'Build the shop', projectId: s.shop.id });
  const elsewhere = s.app.conversations.create({ title: 'Other', projectId: s.other.id });
  const free = s.app.conversations.create({ title: 'Free' });
  const tab = await s.open(chat.id, s.shop.id, 'https://a.example.com/');
  const view = await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET');
  assert.equal(view.status, 200);
  assert.equal(view.body.view.tab, tab);
  assert.equal(view.body.view.url, 'https://a.example.com/');
  assert.equal(view.body.view.title, 'Shop');
  assert.equal(view.body.view.runId, `run-${chat.id}`);
  assert.deepEqual(view.body.view.by, { kind: 'conversation', id: chat.id, title: 'Build the shop' });
  const frame = await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${tab}`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.equal(frame.headers.get('x-frame-seq'), String(view.body.view.seq));
  assert.equal(Buffer.from(await frame.arrayBuffer()).toString(), 'png-a');
  const same = await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${tab}&seq=${view.body.view.seq}`);
  assert.equal(same.status, 304);
  assert.equal((await same.arrayBuffer()).byteLength, 0);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${tab}&seq=${view.body.view.seq + 1}`)).status, 200);
  // ほかの製品の会話・製品に属さない会話のタブ（どちらも新しい）は、この製品に出ない
  const otherTab = await s.open(elsewhere.id, s.other.id, 'https://b.example.com/');
  const freeTab = await s.open(free.id, undefined, 'https://b.example.com/');
  assert.equal((await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET')).body.view.tab, tab);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${otherTab}`)).status, 404);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${freeTab}`)).status, 404);
  assert.equal((await s.json(`/api/browser/view?product=${s.other.id}`, 'GET')).body.view.tab, otherTab);
  // 会話の製品を DB が知らない・DB ではほかの製品の会話のタブ（grant だけ製品を名乗る）も出さない
  const lying = await s.open(free.id, s.shop.id, 'https://b.example.com/');
  const crossed = await s.app.browser.run({ grant: { conversationId: elsewhere.id, runId: 'run-x', attended: true, loopback: false, productId: s.shop.id }, signal: new AbortController().signal },
    async api => { const made = await api.openTab('work'); await made.page.goto('https://b.example.com/', 1000); return made.id; });
  assert.equal((await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET')).body.view.tab, tab);
  for (const id of [lying, crossed]) assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${id}`)).status, 404);
  const stray = await s.open('aaaaaaaa-0000-4000-8000-00000000ffff', s.shop.id, 'https://b.example.com/');
  assert.equal((await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET')).body.view.tab, tab);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${stray}`)).status, 404);
});

test('view: タスクのタブは、だれのタブかにタスクの題を出す', async t => {
  const s = await mirrorSetup(t);
  const task = s.app.tasks.create({ title: 'Check the upload page', origin: 'user', actor: 'user', projectId: s.shop.id });
  const conversation = s.app.conversations.create({ kind: 'task', title: 'task', projectId: s.shop.id });
  s.app.db.prepare('UPDATE tasks SET conversation_id = ? WHERE id = ?').run(conversation.id, task.id);
  await s.app.browser.run({ grant: { conversationId: conversation.id, runId: 'run-task', attended: false, loopback: true, productId: s.shop.id }, signal: new AbortController().signal },
    async api => { const tab = await api.openTab('work'); await tab.page.goto('https://a.example.com/', 1000); });
  const view = await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET');
  assert.deepEqual(view.body.view.by, { kind: 'task', id: task.id, title: 'Check the upload page' });
  assert.deepEqual(view.body.view.profile, { kind: 'work' });
  // タスクの会話（DB で持ち主が見ている会話でない）に持ち主のプロファイルのタブがあっても、出さない
  const owner = await s.app.browser.run({ grant: { conversationId: conversation.id, runId: 'run-task', attended: true, loopback: true, productId: s.shop.id }, signal: new AbortController().signal },
    async api => { const tab = await api.openTab('owner'); await tab.page.goto('https://b.example.com/', 1000); return tab.id; });
  assert.equal((await s.json(`/api/browser/view?product=${s.shop.id}`, 'GET')).body.view.tab, view.body.view.tab);
  assert.equal((await s.api(`/api/browser/frame?product=${s.shop.id}&tab=${owner}`)).status, 404);
});
