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
import { BrowserFailure, LAUNCH_TIMEOUT_MS, PlaywrightDriver, playwrightOptions, seedPreferences, systemLocale, type LaunchOptions, type PageHandle } from '../src/tools/browser/driver.ts';
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
  const call = { grant: { conversationId: 'live', runId: 'r1', attended: true, loopback: false }, signal: new AbortController().signal };

  const read = await session.run(call, async api => {
    const tab = await api.openTab('owner');
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
