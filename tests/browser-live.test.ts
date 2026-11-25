import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { test, type TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import { rereadTab } from '../src/tools/browser/checks.ts';
import { BrowserFailure, LAUNCH_TIMEOUT_MS, PlaywrightDriver, playwrightOptions, seedPreferences, systemLocale, type ElementTarget, type LaunchOptions, type PageHandle } from '../src/tools/browser/driver.ts';
import { startEgressProxy } from '../src/tools/browser/egress-proxy.ts';
import { BrowserSession } from '../src/tools/browser/session.ts';
import { actSteps, browserClick, browserFind, browserOpen, browserRead, browserType } from '../src/tools/builtin/browser.ts';
import type { ToolContext } from '../src/tools/types.ts';
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
  const call = { grant: { conversationId: 'live', runId: 'r1', attended: true, loopback: false }, signal: new AbortController().signal };
  let learn: ElementTarget | undefined;

  const read = await session.run(call, async api => {
    const tab = await api.openTab('owner');
    await tab.page.goto('https://example.com/', LAUNCH_TIMEOUT_MS);
    const table = await rereadTab(tab, tab.page.url(), api.signal, { kind: 'show' });
    const item = table?.items.find(e => e.name === 'Learn more');
    learn = item && { ref: item.pwRef, role: item.role, name: item.name };
    return { url: tab.page.url(), text: await tab.page.text(5000), links: learn !== undefined && (await tab.page.locate(learn)) !== undefined };
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
    const events = await tab.page.click(learn!, 10_000);
    await new Promise(resolve => setTimeout(resolve, 3000));
    return { events, url: tab.page.url(), refused: tab.page.lastRefusal() };
  });
  assert.deepEqual(clicked.events, { dialogs: 0, downloads: 0, fileChoosers: 0 });
  assert.match(clicked.url, /iana\.org/u, `押したあとのページ: ${clicked.url}（拒否: ${String(clicked.refused)}）`);
});

// ---------------------------------------------------------------- 9-1a: 作業用の文脈とループバック（A-1・A-2・A-6・T1・T4d）

interface LiveHit { at: string; method: string; url: string; site: string | undefined; origin: string | undefined; dest: string | undefined }
const PUBLIC_ADDRESS = '93.184.216.34';
const PUBLIC_HOST = 'pub.beat-live-test.com';

async function listenOn(t: TestContext, server: Server, host = '127.0.0.1'): Promise<number | undefined> {
  const port = await new Promise<number | undefined>(resolve => { server.once('error', () => resolve(undefined)); server.listen(0, host, () => resolve((server.address() as AddressInfo).port)); });
  if (port !== undefined) t.after(() => { server.close(); server.closeAllConnections(); });
  return port;
}

// 開発サーバーに見立てた受け口。届いた要求の Sec-Fetch-Site・Origin を記録する。/app は中から同じ出どころの fetch・別のループバックの fetch・WebSocket・ワーカーの fetch・断るポートへの fetch をするページ
function devSink(t: TestContext, at: string, hits: LiveHit[], page: () => string): Server {
  const upgraded = new Set<Duplex>();
  const server = createServer((req, res) => {
    hits.push({ at, method: req.method ?? '', url: req.url ?? '', site: req.headers['sec-fetch-site'] as string | undefined, origin: req.headers.origin, dest: req.headers['sec-fetch-dest'] as string | undefined });
    if (req.url?.startsWith('/app')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page()); return; }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end(`${at} ok`);
  });
  server.on('upgrade', (req, socket) => {
    hits.push({ at, method: 'UPGRADE', url: req.url ?? '', site: req.headers['sec-fetch-site'] as string | undefined, origin: req.headers.origin, dest: undefined });
    upgraded.add(socket);
    socket.on('error', () => {});
    const accept = createHash('sha1').update(`${String(req.headers['sec-websocket-key'])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // 無通信の時間を越えてから、サーバーから 1 通送る（トンネルが切れていなければ届く）
    const timer = setTimeout(() => { const body = Buffer.from('late'); socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body])); }, 3500);
    socket.on('close', () => clearTimeout(timer));
  });
  t.after(() => { for (const socket of upgraded) socket.destroy(); });
  return server;
}

const rawPage = (handle: PageHandle): Page => (handle as unknown as { page: Page }).page;
// 開けなかった遷移のあと、Chrome は誤りの画面（chrome-error://）へ移る。次の goto がそれに割り込まれないよう、落ち着くのを待つ
const settle = async (handle: PageHandle): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 500));
  await rawPage(handle).waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
};

const appPage = (crossPort: number, deniedPort: number): string => `<a id="lnk" href="/app2">next</a><script>
window.done = (async () => {
  const out = {};
  try { await fetch('/f-same'); out.same = 'ok'; } catch { out.same = 'fail'; }
  try { await fetch('http://127.0.0.1:${crossPort}/f-cross', { mode: 'no-cors' }); out.cross = 'ok'; } catch { out.cross = 'fail'; }
  try { await fetch('http://localhost:${deniedPort}/f-denied', { mode: 'no-cors' }); out.denied = 'ok'; } catch { out.denied = 'fail'; }
  out.ws = await new Promise(r => { const w = new WebSocket('ws://' + location.host + '/ws-same'); window.ws = w; window.late = ''; w.onmessage = e => { window.late = e.data; }; w.onopen = () => r('open'); w.onerror = () => r('err'); });
  const wk = new Worker(URL.createObjectURL(new Blob(["fetch('" + location.origin + "/f-worker').then(()=>postMessage('ok'),()=>postMessage('fail'))"], { type: 'text/javascript' })));
  out.worker = await new Promise(r => { wk.onmessage = e => r(e.data); setTimeout(() => r('timeout'), 3000); });
  return out;
})();
</script>`;

const publicPage = (port: number): string => `<a id="lnk" href="http://127.0.0.1:${port}/pub-link">link</a><script>
window.done = (async () => {
  const out = {};
  try { await fetch('http://127.0.0.1:${port}/pub-fetch', { mode: 'no-cors' }); out.fetch = 'ok'; } catch { out.fetch = 'fail'; }
  try { await fetch('http://localhost:${port}/pub-post', { method: 'POST', mode: 'no-cors', body: 'x' }); out.post = 'ok'; } catch { out.post = 'fail'; }
  out.img = await new Promise(r => { const i = new Image(); i.onload = () => r('ok'); i.onerror = () => r('fail'); i.src = 'http://127.0.0.1:${port}/pub-img.png'; });
  out.ws = await new Promise(r => { try { const w = new WebSocket('ws://localhost:${port}/pub-ws'); w.onopen = () => r('open'); w.onerror = () => r('err'); } catch { r('throw'); } });
  const wk = new Worker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:${port}/pub-worker',{mode:'no-cors'}).then(()=>postMessage('ok'),()=>postMessage('fail'))"], { type: 'text/javascript' })));
  out.worker = await new Promise(r => { wk.onmessage = e => r(e.data); setTimeout(() => r('timeout'), 3000); });
  return out;
})();
</script>`;

test('9-1a A-1・A-2: 作業用の文脈の中継にループバックが通る（localhost は ::1 にも）。断るポートは中継が断る。土台の中継はループバックを見ない。ループバックのトンネルは無通信でも切れない', options, async t => {
  const hits: LiveHit[] = [];
  let port = 0;
  const sink = devSink(t, 'v4', hits, () => appPage(port, deniedPort));
  port = (await listenOn(t, sink))!;
  const sink6 = devSink(t, 'v6', hits, () => 'v6');
  const port6 = await listenOn(t, sink6, '::1');
  const deny = devSink(t, 'denied', hits, () => 'denied');
  const deniedPort = (await listenOn(t, deny))!;
  const baseLog: string[] = [];
  const base = await startEgressProxy({ username: 'beat', password: 'b'.repeat(48), log: line => baseLog.push(line), resolve: async () => { throw new Error('no dns in this test'); } });
  t.after(() => base.close());
  const proxy = await startEgressProxy({ username: 'beat', password: 'c'.repeat(48), idleMs: 2000, loopback: { denyPorts: () => new Set([deniedPort]) }, resolve: async () => { throw new Error('no dns in this test'); } });
  t.after(() => proxy.close());
  const work = await new PlaywrightDriver().launchWork!({ channel: 'chrome', executablePath: undefined, headless: true, proxy: { server: `http://127.0.0.1:${base.port}`, username: 'beat', password: 'b'.repeat(48) } });
  t.after(() => work.close());
  // 横取り（副の守り）はループバックを全部通す形にして、中継（本体）だけを見る
  const context = await work.newContext({ proxy: { server: `http://127.0.0.1:${proxy.port}`, username: 'beat', password: 'c'.repeat(48) }, viewport: { width: 1280, height: 800 }, locale: systemLocale(), actionTimeoutMs: 10_000, sites: () => [], loopback: () => true, sendGuard: 'attended' });
  const page = await context.newPage();

  const before = proxy.stats();
  await page.goto(`http://localhost:${port}/hello`, 15_000);
  assert.ok(hits.some(hit => hit.at === 'v4' && hit.url === '/hello'), 'A-1: localhost の受け口に届く');
  assert.ok(proxy.stats().accepted > before.accepted, 'A-1: 文脈の中継が通した');
  const shot = await page.screenshot();
  assert.ok(shot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && shot.length > 1000, '見えない形の作業用のブラウザでも、欄に映す 1 枚が撮れる');
  const blockedBefore = proxy.stats().blocked;
  const refused = await page.goto(`http://127.0.0.1:${deniedPort}/x`, 15_000).catch((e: unknown) => e);
  await settle(page);
  assert.ok(!hits.some(hit => hit.at === 'denied'), 'A-1: 断るポートの受け口に届かない');
  assert.ok(proxy.stats().blocked > blockedBefore, 'A-1: 文脈の中継が断った');
  t.diagnostic(`A-1 denied goto: ${JSON.stringify(refused instanceof Error ? refused.message : refused)}`);
  assert.deepEqual(baseLog.filter(line => line.includes(String(port)) || line.includes(String(deniedPort)) || /localhost|127\.0\.0\.1/u.test(line)), [], 'A-1: 土台の中継はループバックを見ない');
  t.diagnostic(`A-1 base proxy log: ${JSON.stringify(baseLog.slice(0, 10))}`);

  if (port6 !== undefined) {
    await page.goto(`http://localhost:${port6}/v6`, 15_000);
    assert.ok(hits.some(hit => hit.at === 'v6' && hit.url === '/v6'), 'A-2: ::1 だけの受け口に localhost で届く');
    await page.goto(`http://[::1]:${port6}/v6b`, 15_000);
    assert.ok(hits.some(hit => hit.at === 'v6' && hit.url === '/v6b'));
  } else {
    t.diagnostic('A-2: ::1 で待ち受けられないので ::1 の確かめは飛ばした');
  }

  // ループバックのトンネル（WebSocket）は、中継の無通信の時間（2 秒）を越えても切れない
  await page.goto(`http://localhost:${port}/app`, 15_000);
  const result = await rawPage(page).evaluate(() => (window as unknown as { done: Promise<Record<string, string>> }).done);
  t.diagnostic(`A-2 app page: ${JSON.stringify(result)}`);
  assert.equal(result.ws, 'open');
  await new Promise(resolve => setTimeout(resolve, 4500));
  const late = await rawPage(page).evaluate(() => ({ state: (window as unknown as { ws: WebSocket }).ws.readyState, late: (window as unknown as { late: string }).late }));
  assert.deepEqual(late, { state: 1, late: 'late' }, 'A-2: 無通信 2 秒を越えても WebSocket は開いたまま、あとから送ったものが届く');
  await context.close();
});

test('9-1a A-6・T1・T4d: 本物の Chrome で、受け口が受けた見出しを記録する。公開のページからループバックへは何も届かず、beat のポートにも届かない', options, async t => {
  const hits: LiveHit[] = [];
  let port = 0;
  let deniedPort = 0;
  const sink = devSink(t, 'dev', hits, () => appPage(port, deniedPort));
  port = (await listenOn(t, sink))!;
  const deny = devSink(t, 'beat', hits, () => 'beat');
  deniedPort = (await listenOn(t, deny))!;
  // 公開の見本のページ（中継の resolve / connect を差し替え、手元のサーバーを公開の名前に見せる）
  const pub = createServer((req, res) => {
    hits.push({ at: 'public', method: req.method ?? '', url: req.url ?? '', site: undefined, origin: undefined, dest: undefined });
    if (req.url === '/redir') { res.writeHead(302, { location: `http://127.0.0.1:${port}/pub-redirect` }); res.end(); return; }
    if (req.url === '/redir-beat') { res.writeHead(302, { location: `http://127.0.0.1:${deniedPort}/pub-redirect-beat` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(publicPage(port));
  });
  const pubPort = (await listenOn(t, pub))!;
  const config = testConfig();
  config.tools.browser.enabled = true;
  // beat 自身のポートに見立てる
  config.server.port = deniedPort;
  const session = new BrowserSession({
    driver: new PlaywrightDriver(), config: () => config, paths: { browserProfile: tmpDir(t, 'work') },
    startProxy: proxyOptions => startEgressProxy({
      ...proxyOptions,
      resolve: async () => [PUBLIC_ADDRESS],
      connect: (address, target, family): Socket => (address === PUBLIC_ADDRESS ? netConnect(pubPort, '127.0.0.1') : netConnect({ host: address, port: target, family })),
    }),
  });
  t.after(() => session.close());
  const call = { grant: { conversationId: 'live-product', runId: 'r1', attended: false, loopback: true, productId: 'p1' }, signal: new AbortController().signal };

  const outcome = await session.run(call, async api => {
    const tab = await api.openTab('work');
    const page = rawPage(tab.page);
    const out: Record<string, unknown> = {};
    // T1: AI の goto で beat のポート
    out.t1 = await tab.page.goto(`http://localhost:${deniedPort}/`, 15_000).then(r => r.status, (e: unknown) => (e instanceof BrowserFailure ? e.code : String(e)));
    await settle(tab.page);
    // A-6: AI の goto・ページの中の fetch・WebSocket・ワーカー・リンク
    await tab.page.goto(`http://localhost:${port}/app`, 15_000);
    out.app = await page.evaluate(() => (window as unknown as { done: Promise<unknown> }).done);
    await Promise.all([page.waitForURL(/\/app2$/u, { timeout: 10_000 }).catch(() => undefined), page.click('#lnk')]);
    out.afterLink = page.url();
    // T4d: 公開の見本のページから
    await tab.page.goto(`http://${PUBLIC_HOST}/page`, 15_000);
    out.public = await page.evaluate(() => (window as unknown as { done: Promise<unknown> }).done);
    await page.click('#lnk').catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));
    out.afterPublicLink = page.url();
    out.redirect = await tab.page.goto(`http://${PUBLIC_HOST}/redir`, 15_000).then(r => r.status, (e: unknown) => (e instanceof BrowserFailure ? e.code : String(e)));
    out.redirectUrl = page.url();
    await settle(tab.page);
    out.redirectBeat = await tab.page.goto(`http://${PUBLIC_HOST}/redir-beat`, 15_000).then(r => r.status, (e: unknown) => (e instanceof BrowserFailure ? e.code : String(e)));
    return out;
  });
  await new Promise(resolve => setTimeout(resolve, 1000));
  t.diagnostic(`outcome: ${JSON.stringify(outcome)}`);
  for (const hit of hits) t.diagnostic(`hit ${hit.at} ${hit.method} ${hit.url} sec-fetch-site=${String(hit.site)} origin=${String(hit.origin)} dest=${String(hit.dest)}`);

  assert.equal(outcome.t1, 'blocked', 'T1: beat のポートは開けない');
  assert.deepEqual(hits.filter(hit => hit.at === 'beat'), [], 'T1: beat のポートの受け口に 1 回も届かない');
  const dev = hits.filter(hit => hit.at === 'dev');
  assert.equal(dev.find(hit => hit.url === '/app')?.site, 'none', 'A-6: AI の goto は Sec-Fetch-Site: none');
  assert.equal(dev.find(hit => hit.url === '/f-same')?.site, 'same-origin', 'A-6: 同じ出どころの fetch');
  assert.ok(dev.some(hit => hit.method === 'UPGRADE' && hit.url === '/ws-same' && hit.origin === `http://localhost:${port}`), 'A-6: 開発サーバーの WebSocket は届き、Origin はループバック');
  assert.match(String(outcome.afterLink), /\/app2$/u, 'A-6: 開発サーバーの中のリンクで移れる');
  // AI の goto で開いた公開の URL のリダイレクトの先（/pub-redirect）は、受け入れる残り（PLAN.md「受け入れる残り」3 つ目）。
  // Playwright の route はリダイレクトの 2 つ目からを呼ばず、Chrome はリダイレクトの先にも Sec-Fetch-Site: none を付けるので、どちらの守りも見分けられない
  assert.deepEqual(dev.filter(hit => hit.url.startsWith('/pub-') && hit.url !== '/pub-redirect'), [], 'T4d: 公開のページからのループバックへの要求は 1 つも届かない');
  assert.doesNotMatch(String(outcome.afterPublicLink), /127\.0\.0\.1/u);
  assert.notEqual(outcome.redirectBeat, 200, 'T1: 公開の URL から beat のポートへのリダイレクトは中継が断る');
  assert.deepEqual(hits.filter(hit => hit.at === 'beat'), [], 'T1: リダイレクトでも beat のポートの受け口に届かない');
});

// ---------------------------------------------------------------- P3a: 番号は要素そのもの（Playwright の印）に結ぶ

// 手元の開発サーバーに見立てたページを道具（browser_open / browser_click）で開いて押す。押した要素は document.title に残る
async function refRig(t: TestContext, pages: Record<string, string>) {
  const server = createServer((req, res) => {
    const body = pages[new URL(req.url ?? '/', 'http://x').pathname];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>start</title></head><body>${body}<script>document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) document.title = 'clicked ' + b.dataset.id; }, true);</script></body></html>`);
  });
  const port = (await listenOn(t, server))!;
  const config = testConfig();
  config.tools.browser.enabled = true;
  const session = new BrowserSession({ driver: new PlaywrightDriver(), config: () => config, paths: { browserProfile: tmpDir(t, 'refs') } });
  t.after(() => session.close());
  const ctx = {
    runId: 'r1', conversationId: 'live-refs', kind: 'chat', signal: new AbortController().signal, config, log: () => undefined,
    project: { id: 'p-live', root: tmpDir(t, 'refs-root') }, services: { browser: session }, ownerText: () => [`http://127.0.0.1:${port}/`],
  } as unknown as ToolContext;
  const base = `http://127.0.0.1:${port}`;
  const open = async (path: string): Promise<string> => {
    const out = await browserOpen.execute({ url: `${base}${path}` }, ctx);
    assert.equal(out.isError, undefined, out.content);
    return out.content;
  };
  const raw = (): Promise<Page> => session.run({ grant: { conversationId: 'live-refs', runId: 'r1', attended: true, loopback: true, productId: 'p-live' }, signal: new AbortController().signal }, async api => rawPage(api.tab().page));
  const title = async (): Promise<string> => (await raw()).title();
  const refs = (content: string, name: string): string[] => [...content.matchAll(new RegExp(`^(e\\d+) button "${name}"`, 'gmu'))].map(m => m[1]!);
  return { ctx, open, raw, title, refs };
}

const SLOT = `<x-swap><button slot="b" data-id="dom-first">S</button><button slot="a" data-id="dom-second">S</button></x-swap>
<script>customElements.define('x-swap', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<slot name="a"></slot><slot name="b"></slot>'; } });</script>`;
const OWNS = `<div role="list" aria-owns="i2 i1"></div><div role="listitem" id="i1"><button data-id="dom-first">Go</button></div><div role="listitem" id="i2"><button data-id="dom-second">Go</button></div>`;
const ROWS = `<table><tbody><tr><td id="t1">Order 1</td><td><button data-id="row-1">Delete</button></td></tr><tr><td id="t2">Order 2</td><td><button data-id="row-2">Delete</button></td></tr></tbody></table>`;

test('P3a: slot・aria-owns で表の並びと DOM の順が違う画面でも、表の 1 つ目の番号を押すと、表で 1 つ目に見えた要素が押される', options, async t => {
  const r = await refRig(t, { '/slot': SLOT, '/owns': OWNS });
  for (const [path, name] of [['/slot', 'S'], ['/owns', 'Go']] as const) {
    const content = await r.open(path);
    const shown = r.refs(content, name);
    assert.equal(shown.length, 2, content);
    // 表の 1 つ目に当たる要素（DOM の順では 2 つ目）を、ページの中の Playwright の表から確かめる
    const first = await (await r.raw()).evaluate(() => document.querySelectorAll('button')[1]!.dataset.id);
    assert.equal(first, 'dom-second');
    const out = await browserClick.execute({ ref: shown[0]! }, r.ctx);
    assert.equal(out.isError, undefined, out.content);
    assert.equal(await r.title(), 'clicked dom-second', `${path}: 表で 1 つ目に見えた要素を押す（DOM の順の 1 つ目ではない）`);
  }
});

test('P4: 350 個のボタンのページで、表に出ない 300 件より後ろの要素を browser_find で見つけ、その番号で押せる。文は前後 1 行つき', options, async t => {
  const many = Array.from({ length: 350 }, (_, i) => `<p>note ${i + 1}</p><button data-id="item-${i + 1}">Ｉｔｅｍ ${i + 1}</button>`).join('');
  const r = await refRig(t, { '/many': many });
  const content = await r.open('/many');
  assert.doesNotMatch(content, /"Ｉｔｅｍ 345"/u, '前提: 300 件より後ろは表に出ない');
  const found = await browserFind.execute({ query: 'item 345' }, r.ctx);
  assert.equal(found.isError, undefined, found.content);
  const ref = /^(e\d+) button "Ｉｔｅｍ 345"$/mu.exec(found.content)?.[1];
  assert.ok(ref, found.content);
  const text = await browserFind.execute({ query: 'NOTE 200', where: 'text' }, r.ctx);
  assert.match(text.content, /Ｉｔｅｍ 199\nnote 200\nＩｔｅｍ 200/u, text.content);
  const out = await browserClick.execute({ ref }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.equal(await r.title(), 'clicked item-345');
});

test('P3a: 読んだあと・押す前に、ページの中で行の文だけが入れ替わる（要素はそのまま）と、押さない', options, async t => {
  const r = await refRig(t, { '/rows': ROWS });
  const shown = r.refs(await r.open('/rows'), 'Delete');
  assert.equal(shown.length, 2);
  await (await r.raw()).evaluate(() => { const a = document.getElementById('t1')!; const b = document.getElementById('t2')!; [a.textContent, b.textContent] = [b.textContent, a.textContent]; });
  const out = await browserClick.execute({ ref: shown[0]! }, r.ctx);
  assert.equal(out.isError, true);
  assert.match(out.content, /can no longer be used/u);
  assert.equal(await r.title(), 'start', 'どちらの行も押さない');
});

test('P3a: 読んだあとに消された要素の番号は、待たずに（2 秒以内に）断る', options, async t => {
  const r = await refRig(t, { '/rows': ROWS });
  const shown = r.refs(await r.open('/rows'), 'Delete');
  await (await r.raw()).evaluate(() => { document.querySelector('[data-id="row-1"]')!.remove(); });
  const started = Date.now();
  const out = await browserClick.execute({ ref: shown[0]! }, r.ctx);
  const took = Date.now() - started;
  t.diagnostic(`refused in ${took} ms`);
  assert.equal(out.isError, true);
  assert.match(out.content, /can no longer be used/u);
  assert.ok(took < 2000, `${took} ms`);
  assert.equal(await r.title(), 'start');
});

const ICONS = `<a href="/home" data-id="logo"><img alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
<button data-id="close"><img alt="Close" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></button>
<button data-id="trash"><img alt="Trash" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="> Delete</button>`;

test('P3a: 名前が子（画像）から来るボタン・リンクも、表に名前つきで出て、その番号で押せる', options, async t => {
  const r = await refRig(t, { '/icons': ICONS });
  const content = await r.open('/icons');
  assert.match(content, /^e\d+ link "Logo"/mu, content);
  assert.match(content, /^e\d+ button "Trash Delete"/mu, content);
  const [close] = r.refs(content, 'Close');
  assert.ok(close, content);
  const out = await browserClick.execute({ ref: close }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.equal(await r.title(), 'clicked close');
});

test('P3a: 押す要素が動いているあいだに行の文が入れ替わると、動きが止まるのを待ったあとで確かめるので、押さない', options, async t => {
  const r = await refRig(t, { '/rows': ROWS });
  const shown = r.refs(await r.open('/rows'), 'Delete');
  assert.equal(shown.length, 2);
  await (await r.raw()).evaluate(() => {
    document.querySelector('[data-id="row-1"]')!.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(40px)' }], { duration: 1500 });
    setTimeout(() => { const a = document.getElementById('t1')!; const b = document.getElementById('t2')!; [a.textContent, b.textContent] = [b.textContent, a.textContent]; }, 600);
  });
  const started = Date.now();
  const out = await browserClick.execute({ ref: shown[0]! }, r.ctx);
  t.diagnostic(`answered in ${Date.now() - started} ms: ${out.content.slice(0, 120)}`);
  assert.equal(out.isError, true, out.content);
  assert.equal(await r.title(), 'start', '入れ替わったあとの行を押さない');
});

// ---------------------------------------------------------------- P6: select / press（本物の Chrome）

const PICK_PAGE = `<select aria-label="Size" id="size" onchange="document.title = 'picked ' + this.value + ' ' + this.selectedOptions.length"><option value="1">One</option><option value="2">Two words</option><option value="3" disabled>Off</option></select>
<select aria-label="Tags" id="tags" multiple onchange="document.title = 'tags ' + [...this.selectedOptions].map(o => o.value).join('+')"><option value="a">Red</option><option value="b">Blue</option></select>
<div role="combobox" aria-label="Fake menu" tabindex="0">Fake</div>
<script>document.addEventListener('focusin', e => { document.title = 'focus ' + (e.target.id || e.target.tagName); });</script>`;
const FOCUS_PAGE = `<input id="first" aria-label="First"><input id="second" aria-label="Second"><input id="pw" type="password" aria-label="Secret">
<iframe id="frame" tabindex="0" srcdoc="<input id='inside'>"></iframe>
<script>document.addEventListener('focusin', e => { document.title = 'focus ' + (e.target.id || e.target.tagName); });</script>`;

const refOf = (content: string, role: string, name: string): string => {
  const ref = new RegExp(`^(e\\d+) ${role} "${name}"`, 'mu').exec(content)?.[1];
  assert.ok(ref, content);
  return ref;
};

test('P6 select: 本物の <select> をラベルで選び、change が起きる。大小違い・無効な選択肢・自前のコンボボックスは選ばない。複数選択の <select> も 1 つに置き換えて選べる', options, async t => {
  const r = await refRig(t, { '/pick': PICK_PAGE });
  const content = await r.open('/pick');
  const size = refOf(content, 'combobox', 'Size');
  const fake = refOf(content, 'combobox', 'Fake menu');
  const ok = await actSteps({ steps: [{ select: size, option: 'Two words' }] }, r.ctx);
  assert.equal(ok.isError, undefined, ok.content);
  assert.match(ok.content, /^1\. Selected an option in e\d+\./u);
  assert.doesNotMatch(ok.content.split('\n')[0]!, /Two words/u, '選んだラベルは結果の行に写さない');
  assert.equal(await r.title(), 'picked 2 1', 'change が起き、値は 2');
  for (const option of ['two words', 'Two words ', 'Off', '2']) {
    const refused = await actSteps({ steps: [{ select: size, option }] }, r.ctx);
    assert.equal(refused.isError, true, option);
    assert.match(refused.content, /^1\. Failed: The select box has no enabled option with that label/u, `${option}: ${refused.content}`);
  }
  assert.equal(await r.title(), 'picked 2 1', '断ったあとも選びは変わらない');
  const notSelect = await actSteps({ steps: [{ select: fake, option: 'Fake' }] }, r.ctx);
  assert.match(notSelect.content, /^1\. Not done: e\d+ \(combobox\) is not a select box/u, notSelect.content);
  // 1 つ目の選びで要素の状態が変わるので、2 つ目からは番号でなく名前で指す（開発サーバーだけ）
  const multi = await actSteps({ steps: [{ select: { role: 'listbox', name: 'Tags' }, option: 'Red' }, { select: { role: 'listbox', name: 'Tags' }, option: 'Blue' }] }, r.ctx);
  assert.equal(multi.isError, undefined, multi.content);
  assert.equal(await r.title(), 'tags b', '2 回目は 1 つに置き換わる');
  const named = await actSteps({ steps: [{ select: { role: 'combobox', name: 'Size' }, option: 'One' }] }, r.ctx);
  assert.equal(named.isError, undefined, named.content);
  assert.equal(await r.title(), 'picked 1 1', '名前で指しても、開発サーバーでは進む');
});

test('P6 press: Tab は焦点を進める。Enter・Space・修飾つきは入力の確かめで断る。パスワード欄・枠（iframe）の中に焦点があれば鍵を送らない', options, async t => {
  const r = await refRig(t, { '/focus': FOCUS_PAGE });
  await r.open('/focus');
  const page = await r.raw();
  const moved = await actSteps({ steps: [{ press: 'Tab' }, { press: 'Tab' }] }, r.ctx);
  assert.equal(moved.isError, undefined, moved.content);
  assert.match(moved.content, /^1\. Pressed Tab\.\n2\. Pressed Tab\./u);
  assert.equal(await page.title(), 'focus second');
  for (const key of ['Enter', 'Space', ' ', 'Shift+Tab', 'Control+a', 'a']) {
    const out = await actSteps({ steps: [{ press: key }] } as never, r.ctx);
    assert.equal(out.isError, true, key);
    assert.equal(await page.title(), 'focus second', `${key}: 何も押されない`);
  }
  await page.evaluate(() => document.getElementById('pw')!.focus());
  const secret = await actSteps({ steps: [{ press: 'Tab' }] }, r.ctx);
  assert.match(secret.content, /^1\. Not done: The keyboard focus is on a password, verification code or card number field/u, secret.content);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pw', '鍵を送っていないので焦点はそのまま');
  await page.evaluate(() => document.getElementById('frame')!.focus());
  const inFrame = await actSteps({ steps: [{ press: 'Tab' }] }, r.ctx);
  assert.match(inFrame.content, /^1\. Not done: The keyboard focus is inside a frame/u, inFrame.content);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'frame');
});

test('P6 press: 焦点が <select> の上なら、矢印キーで選択が動く（select と同じ通り方）', options, async t => {
  const r = await refRig(t, { '/pick': PICK_PAGE });
  await r.open('/pick');
  const page = await r.raw();
  await page.evaluate(() => document.getElementById('size')!.focus());
  const out = await actSteps({ steps: [{ press: 'ArrowDown' }] }, r.ctx);
  assert.equal(out.isError, undefined, out.content);
  assert.equal(await page.evaluate(() => (document.getElementById('size') as HTMLSelectElement).value), '2', 'ArrowDown で 1 つ進む');
});

// 閉じた shadow DOM の中の入力欄・枠は、ページの外から見ると host（div・section・body）が焦点に見える。keydown は window の手前で数える（枠の中は、枠の中の keydown を親の配列へ）
const KEYS_SEEN = `window.__keys = []; window.addEventListener('keydown', e => window.__keys.push(e.key), true);`;
const CLOSED_PAGE = `<div id="d"></div><section id="s"></section><div id="host" tabindex="0">plain host</div><input id="plain" aria-label="Plain">
<script>${KEYS_SEEN}
const dRoot = document.getElementById('d').attachShadow({ mode: 'closed' });
dRoot.innerHTML = '<input id="pw" type="password" aria-label="Host">';
const sRoot = document.getElementById('s').attachShadow({ mode: 'closed' });
const frame = document.createElement('iframe');
frame.srcdoc = '<input id="in"><scr' + 'ipt>addEventListener("keydown", e => parent.__keys.push("frame:" + e.key), true)</scr' + 'ipt>';
sRoot.appendChild(frame);
window.__focus = { pw: () => dRoot.getElementById('pw').focus(), frame: () => frame.focus() };</script>`;
const BODY_PAGE = `<script>${KEYS_SEEN}
const root = document.body.attachShadow({ mode: 'closed' });
root.innerHTML = '<input id="pw" type="password" aria-label="Body">';
window.__focus = { pw: () => root.getElementById('pw').focus() };</script>`;

test('P6 press（M1）: 閉じた shadow DOM を持つ標準の要素（div・section・body）の中の入力欄・枠に焦点があれば、鍵を送らない。ふつうの要素・tabindex のある div には送る', options, async t => {
  const r = await refRig(t, { '/closed': CLOSED_PAGE, '/body': BODY_PAGE });
  const keys = async (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __keys: string[] }).__keys);
  const focus = (page: Page, name: string): Promise<void> => page.evaluate((n: string) => (window as unknown as { __focus: Record<string, () => void> }).__focus[n]!(), name);
  await r.open('/closed');
  const page = await r.raw();
  for (const [name, key, refusal] of [['pw', 'ArrowLeft', /^1\. Not done: The keyboard focus is inside a frame, or inside a part of the page whose inside cannot be read/u], ['frame', 'ArrowDown', /^1\. Not done: The keyboard focus is inside a frame, or inside a part of the page whose inside cannot be read/u]] as const) {
    await focus(page, name);
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), name === 'pw' ? 'DIV' : 'SECTION', `${name}: ページの外からは host（div・section）が焦点に見える`);
    const out = await actSteps({ steps: [{ press: key }] }, r.ctx);
    assert.equal(out.isError, true, `${name}: ${out.content}`);
    assert.match(out.content, refusal, name);
    assert.deepEqual(await keys(page), [], `${name}: 鍵は 1 つも届いていない`);
  }
  await page.evaluate(() => document.getElementById('plain')!.focus());
  const plain = await actSteps({ steps: [{ press: 'ArrowLeft' }] }, r.ctx);
  assert.equal(plain.isError, undefined, plain.content);
  await page.evaluate(() => document.getElementById('host')!.focus());
  const host = await actSteps({ steps: [{ press: 'ArrowDown' }] }, r.ctx);
  assert.equal(host.isError, undefined, `tabindex のある ふつうの div は、閉じた shadow DOM が無いので通る: ${host.content}`);
  assert.deepEqual(await keys(page), ['ArrowLeft', 'ArrowDown'], '許した 2 つだけが届いた（対照: 数える仕組みは働いている）');
  await r.open('/body');
  const body = await r.raw();
  await focus(body, 'pw');
  assert.equal(await body.evaluate(() => document.activeElement?.tagName), 'BODY', 'ページの外からは body が焦点に見える（焦点なしと同じ）');
  const refused = await actSteps({ steps: [{ press: 'End' }] }, r.ctx);
  assert.equal(refused.isError, true, refused.content);
  assert.match(refused.content, /^1\. Not done: The keyboard focus is inside a frame, or inside a part of the page whose inside cannot be read/u);
  assert.deepEqual(await keys(body), [], 'body の閉じた shadow DOM の中の入力欄に、鍵は届いていない');
});

// ---------------------------------------------------------------- P7: 暗証番号の欄（本物の Chrome。A6）

// ページは、入れた値を本文・ボタンの名前・（送信のあと）URL に出す。入れた値は、そのあとのどの出力にも出ない
const LOGIN_PAGE = `<form action="/after" method="get"><input id="pw" type="password" aria-label="Password" name="q"><input id="who" aria-label="Name"><p id="echo">Echo: none</p><button type="button" data-id="hello" id="hello">Hello none</button><button type="submit" data-id="go">Go</button></form>
<script>const pw = document.getElementById('pw'); pw.addEventListener('input', () => { document.getElementById('echo').textContent = 'Echo: ' + pw.value; document.getElementById('hello').textContent = 'Hello ' + pw.value; });</script>`;
const AFTER_PAGE = `<h1>Signed in</h1><p id="note">You are in</p><button data-id="out">Log out</button>`;

test('P7（A6）: 本物の Chrome で password の欄に入れる。ページが値を本文・ボタンの名前・URL に出しても、結果・差分・表・本文・探すに値が出ない', options, async t => {
  const PASS = 'test-pass-1234';
  const r = await refRig(t, { '/login': LOGIN_PAGE, '/after': AFTER_PAGE });
  const port = Number(new URL(r.ctx.ownerText!()[0]!).port);
  (r.ctx.services as unknown as { background: unknown }).background = { printedPorts: () => new Set<number>(), ownsPort: async (_owner: unknown, asked: number) => asked === port, stoppedPort: () => undefined };
  const content = await r.open('/login');
  const ref = refOf(content, 'textbox', 'Password');
  const page = await r.raw();
  const check = await browserType.preCheck!({ ref, password: PASS }, r.ctx);
  assert.equal(check.decision, 'allow', JSON.stringify(check));
  const typed = await browserType.execute({ ref, password: PASS }, r.ctx);
  assert.equal(typed.isError, undefined, typed.content);
  assert.equal(await page.inputValue('#pw'), PASS, '本物の欄に値が入った');
  assert.equal(await page.textContent('#echo'), `Echo: ${PASS}`, '前提: ページは入れた値を本文に出している');
  // Playwright の ariaSnapshot が password の欄の値を出すか（A6）。出しても出さなくても、下の出口はどれも値を出さない
  const raw = await page.locator('body').ariaSnapshot();
  t.diagnostic(`A6 ariaSnapshot が password の値を出す: ${raw.includes(PASS)} / 本文・ボタンの名前に値が出る: ${raw.includes(`Hello ${PASS}`)}`);
  assert.match(typed.content.split('\n')[0]!, /^Typed a password or verification code into e\d+ \(tab t1\)\.$/u);
  const outputs: Array<[string, string]> = [['browser_type の結果（差分）', typed.content]];
  for (const mode of ['elements', 'text'] as const) outputs.push([`browser_read ${mode}`, (await browserRead.execute({ mode }, r.ctx)).content]);
  for (const query of ['Echo', 'Hello']) outputs.push([`browser_find ${query}`, (await browserFind.execute({ query } as never, r.ctx)).content]);
  for (const [name, text] of outputs) assert.ok(!text.includes(PASS), `${name}: ${text}`);
  assert.ok(typed.content.includes('[REDACTED]'), '差分には、ページが出した値の所が伏せ字で出る: ' + typed.content);
  // Enter で送る（GET で /after?q=<値> へ移る）。行き着いたページの見出し・URL・差分にも値が出ない
  const sent = await browserType.execute({ ref, password: PASS, submit: true }, r.ctx);
  assert.equal(sent.isError, undefined, sent.content);
  assert.equal((await r.raw()).url(), `http://127.0.0.1:${port}/after?q=${PASS}`, '前提: 本物のページは URL に値を載せて移った');
  assert.ok(!sent.content.includes(PASS), sent.content);
  assert.match(sent.content, /Signed in/u, '移ったあとの画面は返っている');
  assert.ok(!(await browserRead.execute({ mode: 'text' }, r.ctx)).content.includes(PASS));
  // text で暗証番号の欄に入れる・ふつうの欄に password で入れるのは、本物のページでも断る（値は入らない）
  await r.open('/login');
  const fresh = await r.raw();
  const login = await browserRead.execute({ mode: 'elements' }, r.ctx);
  const pwRef = refOf(login.content, 'textbox', 'Password');
  const nameRef = refOf(login.content, 'textbox', 'Name');
  const asText = await browserType.execute({ ref: pwRef, text: 'abc' }, r.ctx);
  assert.equal(asText.isError, true, asText.content);
  const asPassword = await browserType.execute({ ref: nameRef, password: PASS }, r.ctx);
  assert.equal(asPassword.isError, true, asPassword.content);
  assert.equal(await fresh.inputValue('#pw'), '', '断ったので欄は空のまま');
  assert.equal(await fresh.inputValue('#who'), '', 'ふつうの欄にも入っていない');
});
