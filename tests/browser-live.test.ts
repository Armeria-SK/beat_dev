import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { LAUNCH_TIMEOUT_MS, PlaywrightDriver, playwrightOptions, seedPreferences, systemLocale, type LaunchOptions } from '../src/tools/browser/driver.ts';
import { startEgressProxy } from '../src/tools/browser/egress-proxy.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { testConfig } from './helpers.ts';

// T-44: 本物の Chrome で動かす（Edge は使わない）。ふだんは飛ばす（BEAT_BROWSER_LIVE=1 のときだけ）。
// 中継の外を通る道が増えていないかを、Playwright や Chromium の版を上げるたびに確かめる（README「版を上げたら」）。
// 外のネットワーク（https://example.com/）が要る
const live = process.env.BEAT_BROWSER_LIVE === '1';
const options = { skip: live ? false : 'BEAT_BROWSER_LIVE=1 のときだけ動かす（本物のブラウザと外のネットワークが要る）', timeout: 180_000 };

// この計算機のブラウザのコマンド行のうち、プロファイルの置き場を含むもの
function commandLines(marker: string): string[] {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker.replace(/'/gu, "''")}') } | ForEach-Object { $_.CommandLine }`;
    const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    return out.stdout.split(/\r?\n/u).filter(line => line.trim() && !line.includes('Get-CimInstance'));
  }
  const out = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(line => line.includes(marker));
}

function tmpDir(t: { after: (fn: () => void) => void }, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `beat-live-${name}-`));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 閉じ遅れ */ } });
  return dir;
}

test('T-44(2): ページの中から 127.0.0.1 への画像・fetch・WebSocket・フォームが 1 回も届かない', options, async t => {
  const hits: string[] = [];
  const sink = createServer((req: IncomingMessage, res) => { hits.push(`${req.method} ${req.url}`); res.end('hit'); });
  sink.on('upgrade', (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => { sink.close(); });
  const port = (sink.address() as AddressInfo).port;

  const profileDir = tmpDir(t, 'leak');
  const proxy = await startEgressProxy({ username: 'beat', password: 'x'.repeat(48) });
  t.after(() => proxy.close());
  const { chromium } = await import('playwright-core');
  const launch: LaunchOptions = {
    profileDir, channel: undefined, executablePath: undefined, headless: true,
    proxy: { server: `http://${proxy.host}:${proxy.port}`, username: 'beat', password: 'x'.repeat(48) },
    viewport: { width: 1280, height: 800 }, locale: systemLocale(), actionTimeoutMs: 10_000,
  };
  seedPreferences(profileDir);
  let context;
  try { context = await chromium.launchPersistentContext(profileDir, playwrightOptions({ ...launch, channel: 'chrome' })); } catch { /* 下で知らせる */ }
  assert.ok(context, 'Chrome を起動できなかった');
  t.after(() => context!.close());
  const page = await context.newPage();
  const target = `http://127.0.0.1:${port}`;
  await page.setContent(`<img src="${target}/img.png"><form id="f" method="post" action="${target}/form"><input name="a"></form><script>document.getElementById('f').submit()</script>`);
  const result = await page.evaluate(async (base: string) => {
    const outcome: Record<string, string> = {};
    try { await fetch(`${base}/fetch`, { mode: 'no-cors' }); outcome.fetch = 'reached'; } catch { outcome.fetch = 'failed'; }
    outcome.ws = await new Promise<string>(resolve => {
      try {
        const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
        ws.onopen = () => resolve('opened'); ws.onerror = () => resolve('failed'); ws.onclose = () => resolve('closed');
      } catch { resolve('failed'); }
    });
    const image = new Image();
    outcome.img = await new Promise<string>(resolve => { image.onload = () => resolve('loaded'); image.onerror = () => resolve('failed'); image.src = `${base}/img2.png`; });
    return outcome;
  }, target).catch(() => ({ navigated: 'form submit replaced the page' }));
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.deepEqual(hits, [], `受け口に届いた: ${hits.join(', ')}`);
  // fetch(no-cors) は、中継の 403 を「不透明な応答」として受けて成功に見えるため、答えの形は見ない（受け口に届いたかだけを見る）
  assert.notEqual((result as Record<string, string>).ws, 'opened');
  assert.ok(proxy.stats().blocked >= 1, '中継が断った記録がある');
});

test('T-44(2b): ページの中から 169.254.169.254・[::1]・localhost への画像・fetch が受け口に届かず、中継が断る', options, async t => {
  const hits: string[] = [];
  const handler = (label: string) => (req: IncomingMessage, res: import('node:http').ServerResponse) => { hits.push(`${label} ${req.method} ${req.url}`); res.end('hit'); };
  const sink4 = createServer(handler('v4'));
  await new Promise<void>(resolve => sink4.listen(0, '127.0.0.1', resolve));
  t.after(() => { sink4.close(); });
  const port = (sink4.address() as AddressInfo).port;
  // [::1] の受け口は、同じポートで立てる（立てられない環境ではそのぶんを見ない。169.254.169.254 は受け口を立てられないので中継の blocked の増え方で見る）
  const sink6 = createServer(handler('v6'));
  const v6 = await new Promise<boolean>(resolve => { sink6.once('error', () => resolve(false)); sink6.listen(port, '::1', () => resolve(true)); });
  t.after(() => { if (v6) sink6.close(); });

  const profileDir = tmpDir(t, 'inward');
  const proxy = await startEgressProxy({ username: 'beat', password: 'x'.repeat(48) });
  t.after(() => proxy.close());
  const { chromium } = await import('playwright-core');
  const launch: LaunchOptions = {
    profileDir, channel: undefined, executablePath: undefined, headless: true,
    proxy: { server: `http://${proxy.host}:${proxy.port}`, username: 'beat', password: 'x'.repeat(48) },
    viewport: { width: 1280, height: 800 }, locale: systemLocale(), actionTimeoutMs: 10_000,
  };
  seedPreferences(profileDir);
  let context;
  try { context = await chromium.launchPersistentContext(profileDir, playwrightOptions({ ...launch, channel: 'chrome' })); } catch { /* 下で知らせる */ }
  assert.ok(context, 'Chrome を起動できなかった');
  t.after(() => context!.close());
  const page = await context.newPage();
  await page.setContent('<p>x</p>');
  const probe = (base: string, label: string) => page.evaluate(async ([target, name]: [string, string]) => {
    const outcome: Record<string, string> = {};
    try { await fetch(`${target}/fetch-${name}`, { mode: 'no-cors' }); outcome.fetch = 'resolved'; } catch { outcome.fetch = 'failed'; }
    const image = new Image();
    outcome.img = await new Promise<string>(resolve => { image.onload = () => resolve('loaded'); image.onerror = () => resolve('failed'); image.src = `${target}/img-${name}.png`; });
    return outcome;
  }, [base, label] as [string, string]);

  const before = proxy.stats().blocked;
  const targets: Array<[string, string]> = [
    ['http://169.254.169.254', 'metadata'],
    [`http://localhost:${port}`, 'localhost'],
  ];
  if (v6) targets.push([`http://[::1]:${port}`, 'v6']);
  const blockedAfter: number[] = [];
  for (const [base, label] of targets) {
    await probe(base, label);
    blockedAfter.push(proxy.stats().blocked);
  }
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(hits, [], `受け口に届いた: ${hits.join(', ')}`);
  // 宛先ごとに、中継の断った数が増えている（受け口が無い 169.254.169.254 も、中継が断ったことで見る）
  assert.ok(blockedAfter[0]! > before, '169.254.169.254 を中継が断った');
  for (let i = 1; i < blockedAfter.length; i++) assert.ok(blockedAfter[i]! > blockedAfter[i - 1]!, `${targets[i]![0]} を中継が断った`);
});

// Playwright が標準で付ける --disable-features の名前（Playwright の版ごとに変わる。版を上げたとき、固定の起動引数と食い違っていないかをここで見る）
function playwrightDisabledFeatures(): string[] {
  const bundle = readFileSync(join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'lib', 'coreBundle.js'), 'utf8');
  const start = bundle.indexOf('disabledFeatures = [');
  assert.ok(start >= 0, 'Playwright の既定の無効な機能の一覧が見つからない（読み方を直す）');
  const end = bundle.indexOf('].filter(Boolean)', start);
  return [...bundle.slice(start, end).matchAll(/^\s*"([A-Za-z0-9]+)",?\s*$/gmu)].map(m => m[1]!);
}

test('T-44(1)(3)(4): example.com を開いて本文が読め、押せて、起動したブラウザに --remote-debugging-port が無い', options, async t => {
  const profileDir = tmpDir(t, 'session');
  const config = testConfig();
  config.tools.browser.enabled = true;
  config.tools.browser.sites = ['example.com', 'iana.org'];
  const session = new BrowserSession({ driver: new PlaywrightDriver(), config: () => config, paths: { browserProfile: profileDir } });
  t.after(() => session.close());
  const call = { conversationId: 'live', signal: new AbortController().signal };

  const read = await session.run(call, async api => {
    const tab = await api.openTab();
    await tab.page.goto('https://example.com/', LAUNCH_TIMEOUT_MS);
    return { url: tab.page.url(), text: await tab.page.text(5000), links: (await tab.page.locate({ role: 'link', name: 'Learn more', nth: 0, count: 1 })) !== undefined };
  });
  assert.match(read.url, /^https:\/\/example\.com\//u);
  assert.match(read.text, /documentation examples/u);
  assert.equal(read.links, true, '「Learn more」のリンクが見える');

  // 起動したブラウザのコマンド行（プロファイルの置き場で選ぶ）
  const lines = commandLines(profileDir);
  assert.ok(lines.length > 0, '起動したブラウザのコマンド行が見つからない');
  for (const line of lines) {
    assert.doesNotMatch(line, /--remote-debugging-port/u, line.slice(0, 300));
  }
  const main = lines.filter(line => !line.includes('--type='));
  assert.ok(main.length > 0, '本体のプロセスが見つからない');
  for (const line of main) assert.match(line, /--proxy-server=/u, '中継を指定して起動している');
  // --disable-features は、あとから付けたほうが勝つ（起動したコマンド行では、Playwright の既定のあとに beat の固定の引数が来る）。固定の引数が Playwright の既定（MediaRouter・OptimizationHints など）を潰していないこと
  const wanted = [...playwrightDisabledFeatures(), 'PasswordManagerOnboarding', 'AutofillServerCommunication'];
  assert.ok(wanted.includes('MediaRouter') && wanted.includes('OptimizationHints'), `Playwright の一覧の読み取り: ${wanted.join(',')}`);
  for (const line of main) {
    const given = line.match(/--disable-features=(\S+)/gu) ?? [];
    // Playwright の既定と beat の固定の引数の 2 つが並ぶ。Chromium が読むのは最後の 1 つなので、最後のものを見る
    assert.ok(given.length >= 1, '--disable-features が無い');
    const names = new Set(given.at(-1)!.slice('--disable-features='.length).split(','));
    const missing = wanted.filter(name => !names.has(name));
    assert.deepEqual(missing, [], `起動したブラウザの --disable-features に無い: ${missing.join(',')}`);
  }

  // 押す（リンク先へ移る）
  const clicked = await session.run(call, async api => {
    const tab = api.tab();
    const events = await tab.page.click({ role: 'link', name: 'Learn more', nth: 0, count: 1 }, 10_000);
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { events, url: tab.page.url(), refused: tab.page.lastRefusal() };
  });
  assert.deepEqual(clicked.events, { dialogs: 0, downloads: 0, fileChoosers: 0 });
  assert.match(clicked.url, /iana\.org/u, `押したあとのページ: ${clicked.url}（拒否: ${String(clicked.refused)}）`);
});
