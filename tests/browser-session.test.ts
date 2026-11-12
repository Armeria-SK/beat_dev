import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config/schema.ts';
import { BrowserFailure } from '../src/tools/browser/driver.ts';
import { BrowserSession, type BrowserSessionDeps } from '../src/tools/browser/session.ts';
import { FakeBrowserDriver } from './helpers/fake-browser.ts';
import { testConfig } from './helpers.ts';

// T-04: BrowserSession（起動・アイドル・タブの持ち主・順番待ち・起動の失敗）

interface Rig {
  session: BrowserSession;
  driver: FakeBrowserDriver;
  config: AppConfig;
  notes: Array<{ title: string; dedupKey: string }>;
  clock: { now: number; timers: Array<{ at: number; fn: () => void; live: boolean }> };
  advance(ms: number): void;
}

function rig(t: { after: (fn: () => void | Promise<void>) => void }, change: (config: AppConfig) => void = () => undefined): Rig {
  const config = testConfig();
  config.tools.browser.enabled = true;
  change(config);
  const driver = new FakeBrowserDriver();
  const notes: Rig['notes'] = [];
  const clock: Rig['clock'] = { now: 1_000_000, timers: [] };
  const deps: BrowserSessionDeps = {
    driver, config: () => config, paths: { browserProfile: 'C:\\data\\browser-profile' },
    notify: input => { notes.push({ title: input.title, dedupKey: input.dedupKey }); },
    now: () => clock.now,
    schedule: (fn, ms) => { const timer = { at: clock.now + ms, fn, live: true }; clock.timers.push(timer); return () => { timer.live = false; }; },
  };
  const session = new BrowserSession(deps);
  t.after(() => session.close());
  const advance = (ms: number) => {
    clock.now += ms;
    for (const timer of clock.timers.filter(x => x.live && x.at <= clock.now)) { timer.live = false; timer.fn(); }
  };
  return { session, driver, config, notes, clock, advance };
}

const call = (r: Rig, conversationId = 'c1', signal: AbortSignal = new AbortController().signal) => ({ conversationId, signal });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('1 回目の呼び出しで起動する（それまでは起動しない）。起動の選択は固定の形で渡る', async t => {
  const r = rig(t);
  assert.equal(r.driver.launches, 0);
  await r.session.run(call(r), async api => { await api.openTab(); });
  assert.equal(r.driver.launches, 1);
  const options = r.driver.current!.options;
  assert.equal(options.profileDir, 'C:\\data\\browser-profile');
  assert.match(options.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.ok(options.proxy.password.length >= 32 && options.proxy.username.length > 0);
  assert.deepEqual(options.viewport, { width: 1280, height: 800 });
  assert.equal(options.headless, true);
  assert.equal(options.channel, undefined);
  assert.equal(options.executablePath, undefined);
  assert.equal(options.locale, Intl.DateTimeFormat().resolvedOptions().locale);
  await r.session.run(call(r), async () => undefined);
  assert.equal(r.driver.launches, 1, '2 回目は起動し直さない');
});

test('設定の channel / executablePath / headless と PC の locale を起動の選択へ渡す', async t => {
  const r = rig(t, c => { c.tools.browser.channel = 'path'; c.tools.browser.executablePath = 'C:\\Browser\\b.exe'; c.tools.browser.headless = false; });
  await r.session.run(call(r), async () => undefined);
  const o = r.driver.current!.options;
  assert.equal(o.executablePath, 'C:\\Browser\\b.exe');
  assert.equal(o.headless, false);
  assert.equal(o.locale, Intl.DateTimeFormat().resolvedOptions().locale);
  const r2 = rig(t, c => { c.tools.browser.channel = 'chrome'; });
  await r2.session.run(call(r2), async () => undefined);
  assert.equal(r2.driver.current!.options.channel, 'chrome');
});

test('無効なら起動しない（disabled）', async t => {
  const r = rig(t, c => { c.tools.browser.enabled = false; });
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'disabled');
  assert.equal(r.driver.launches, 0);
});

test('アイドルの時間（idleCloseMinutes）で閉じる。使うたびに数え直す', async t => {
  const r = rig(t, c => { c.tools.browser.limits.idleCloseMinutes = 10; });
  await r.session.run(call(r), async api => { await api.openTab(); });
  r.advance(9 * 60_000);
  assert.equal(r.driver.current!.closed, false);
  await r.session.run(call(r), async () => undefined);
  r.advance(9 * 60_000);
  assert.equal(r.driver.current!.closed, false, '使ったので数え直し');
  r.advance(61_000);
  await tick();
  assert.equal(r.driver.current!.closed, true);
  await r.session.run(call(r), async () => undefined);
  assert.equal(r.driver.launches, 2, '次の呼び出しで起動し直す');
});

test('タブの上限は全会話の合計。超えたら tab_limit', async t => {
  const r = rig(t, c => { c.tools.browser.limits.maxTabs = 2; });
  await r.session.run(call(r, 'c1'), async api => { await api.openTab(); });
  await r.session.run(call(r, 'c2'), async api => { await api.openTab(); });
  await assert.rejects(r.session.run(call(r, 'c3'), async api => { await api.openTab(); }), (e: unknown) => e instanceof BrowserFailure && e.code === 'tab_limit');
  assert.equal(r.driver.current!.pageList.length, 2);
  // 閉じれば開ける
  await r.session.run(call(r, 'c1'), async api => { await api.closeTab(api.tabs()[0]!.id); });
  await r.session.run(call(r, 'c3'), async api => { await api.openTab(); });
  assert.equal(r.driver.current!.pageList.length, 2);
});

test('別の会話のタブは見えない・使えない・閉じられない', async t => {
  const r = rig(t);
  let mine = '';
  await r.session.run(call(r, 'c1'), async api => { mine = (await api.openTab()).id; });
  await r.session.run(call(r, 'c2'), async api => {
    assert.deepEqual(api.tabs(), []);
    assert.throws(() => api.tab(mine), (e: unknown) => e instanceof BrowserFailure && e.code === 'no_tab');
    assert.throws(() => api.tab(), (e: unknown) => e instanceof BrowserFailure && e.code === 'no_tab');
    assert.equal(await api.closeTab(mine), false);
    assert.equal(await api.closeAll(), 0);
  });
  await r.session.run(call(r, 'c1'), async api => {
    assert.deepEqual(api.tabs().map(x => x.id), [mine]);
    assert.equal(api.tab().id, mine);
  });
  assert.equal(r.driver.current!.pageList.length, 1, '別の会話から閉じられていない');
});

test('tab を省くと、その会話でいちばん最近使ったタブ', async t => {
  const r = rig(t);
  await r.session.run(call(r), async api => {
    const first = await api.openTab(); const second = await api.openTab();
    assert.equal(api.tab().id, second.id);
    api.touch(first);
    assert.equal(api.tab().id, first.id);
  });
});

test('呼び出しは 1 つずつ（同時に 2 つ呼んでも重ならない）', async t => {
  const r = rig(t);
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = r.session.run(call(r, 'c1'), async () => { log.push('a-start'); await gate; log.push('a-end'); });
  const second = r.session.run(call(r, 'c2'), async () => { log.push('b-start'); log.push('b-end'); });
  await tick(); await tick();
  assert.deepEqual(log, ['a-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('失敗しても順番待ちは進む（ロックが残らない）', async t => {
  const r = rig(t);
  await assert.rejects(r.session.run(call(r), async () => { throw new Error('boom'); }), /boom/u);
  assert.equal(await r.session.run(call(r), async () => 'ok'), 'ok');
});

test('順番待ちは signal で止まる（待っている呼び出しだけが止まり、先の呼び出しは続く）', async t => {
  const r = rig(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = r.session.run(call(r, 'c1'), async () => { await gate; return 'first'; });
  const abort = new AbortController();
  const waiting = r.session.run(call(r, 'c2', abort.signal), async () => 'second');
  const outcome = assert.rejects(waiting, (e: unknown) => e instanceof BrowserFailure && e.code === 'aborted');
  await tick();
  abort.abort();
  await outcome;
  release();
  assert.equal(await first, 'first');
  assert.equal(await r.session.run(call(r, 'c3'), async () => 'third'), 'third', '止めた待ちがロックを持ち逃げしていない');
});

test('すでに中止された signal の呼び出しは始めない', async t => {
  const r = rig(t);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(r.session.run(call(r, 'c1', abort.signal), async () => 'x'), (e: unknown) => e instanceof BrowserFailure && e.code === 'aborted');
  assert.equal(r.driver.launches, 0);
});

test('ブラウザが落ちたら、タブを捨て、次の呼び出しで起動し直す', async t => {
  const r = rig(t);
  await r.session.run(call(r), async api => { await api.openTab(); });
  r.driver.current!.crash();
  await r.session.run(call(r), async api => { assert.deepEqual(api.tabs(), []); await api.openTab(); });
  assert.equal(r.driver.launches, 2);
  assert.equal(r.driver.browsers.length, 2);
});

test('起動に失敗したらそのまま返し、続けて 3 回失敗したら 10 分は起動しない。お知らせは dedupKey 付きで 1 回', async t => {
  const r = rig(t);
  const boom = () => new BrowserFailure('launch_failed', 'browser.launch_failed');
  r.driver.failures = [boom(), boom(), boom()];
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'launch_failed');
  }
  assert.equal(r.driver.launches, 3);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0]!.dedupKey, 'browser-launch');
  // 止まっているあいだは、起動を試さない
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'paused');
  assert.equal(r.driver.launches, 3);
  r.advance(9 * 60_000);
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'paused');
  r.advance(61_000);
  await r.session.run(call(r), async () => undefined);
  assert.equal(r.driver.launches, 4);
});

test('失敗が続かなければ数えは戻る（2 回失敗 → 成功 → 2 回失敗でも止まらない）', async t => {
  const r = rig(t);
  const boom = () => new BrowserFailure('launch_failed', 'browser.launch_failed');
  r.driver.failures = [boom(), boom()];
  for (let i = 0; i < 2; i += 1) await assert.rejects(r.session.run(call(r), async () => undefined));
  await r.session.run(call(r), async () => undefined);
  r.driver.current!.crash();
  r.driver.failures = [boom(), boom()];
  for (let i = 0; i < 2; i += 1) await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'launch_failed');
  assert.equal(r.notes.length, 0);
});

test('ブラウザの場所が無い・プロファイルを使用中、の失敗はその種類のまま返る', async t => {
  const r = rig(t);
  r.driver.failures = [new BrowserFailure('no_browser', 'browser.no_browser'), new BrowserFailure('profile_busy', 'browser.profile_busy')];
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'no_browser');
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'profile_busy');
});

test('会話の削除で、その会話のタブだけ閉じる', async t => {
  const r = rig(t);
  await r.session.run(call(r, 'c1'), async api => { await api.openTab(); await api.openTab(); });
  await r.session.run(call(r, 'c2'), async api => { await api.openTab(); });
  await r.session.closeConversation(['c1', 'c9']);
  assert.equal(r.driver.current!.pageList.length, 1);
  await r.session.run(call(r, 'c1'), async api => assert.deepEqual(api.tabs(), []));
  await r.session.run(call(r, 'c2'), async api => assert.equal(api.tabs().length, 1));
});

test('enabled を false にしたら閉じる（applyConfig）。起動していなければ何もしない', async t => {
  const r = rig(t);
  await r.session.applyConfig(r.config);
  await r.session.run(call(r), async api => { await api.openTab(); });
  const browser = r.driver.current!;
  const next = structuredClone(r.config);
  next.tools.browser.enabled = false;
  r.config.tools.browser.enabled = false;
  await r.session.applyConfig(next);
  assert.equal(browser.closed, true);
  await assert.rejects(r.session.run(call(r), async () => undefined), (e: unknown) => e instanceof BrowserFailure && e.code === 'disabled');
});

test('close() でブラウザと中継を閉じる。もう一度呼んでも安全', async t => {
  const r = rig(t);
  await r.session.run(call(r), async api => { await api.openTab(); });
  const browser = r.driver.current!;
  const server = new URL(browser.options.proxy.server);
  await r.session.close();
  assert.equal(browser.closed, true);
  await r.session.close();
  assert.equal(browser.closeCalls, 1);
  // 中継はもう聞いていない
  const net = await import('node:net');
  await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(Number(server.port), '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', reject); }));
});

test('ページ側が開いた窓（ポップアップ）は、すぐ閉じる', async t => {
  const r = rig(t);
  await r.session.run(call(r), async api => { await api.openTab(); });
  const popup = r.driver.current!.popup();
  await tick();
  assert.equal(popup.closed, true);
  await r.session.run(call(r), async api => assert.equal(api.tabs().length, 1));
});

test('中継で止めた数は、呼び出しごとの増えた分を返す', async t => {
  const r = rig(t);
  await r.session.run(call(r), async api => {
    assert.deepEqual(api.proxyDelta(), { blocked: 0, busy: 0 });
  });
});

test('会話の削除の連携は、起動していなくても失敗しない', async t => {
  const r = rig(t);
  await r.session.closeConversation(['c1']);
  assert.equal(r.driver.launches, 0);
});

test('R6 追補 3: 起動の選択に sites（毎回 config を読む関数）が入る。ログイン用の窓は空で、守りを付けない', async t => {
  const r = rig(t, c => { c.tools.browser.sites = ['example.com']; });
  await r.session.run(call(r), async () => undefined);
  const sites = r.driver.current!.options.sites;
  assert.ok(sites, 'sites が渡る');
  assert.deepEqual(sites(), ['example.com']);
  r.config.tools.browser.sites = ['example.com', 'example.net'];
  assert.deepEqual(sites(), ['example.com', 'example.net'], '設定を変えると、起動し直さずに効く');
  await r.session.close();
  const login = rig(t, c => { c.tools.browser.sites = ['example.com']; });
  await login.session.openLogin();
  assert.deepEqual(login.driver.current!.options.sites?.(), [], 'ログイン窓は遷移の守りなし');
});
